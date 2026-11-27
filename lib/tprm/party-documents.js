'use strict';

const access = require('./access');
const events = require('./events');
const { TprmError } = require('./errors');
const { sha256File } = require('./evidence');
const { isYmd } = require('./placement');

const KINDS = Object.freeze(['iso27001_certificate', 'soc2_report', 'contract', 'dpa', 'insurance_certificate', 'policy', 'other']);
const KIND_LABELS = Object.freeze({
  iso27001_certificate: 'ISO 27001 certificate', soc2_report: 'SOC 2 report', contract: 'Contract', dpa: 'Data processing agreement',
  insurance_certificate: 'Insurance certificate', policy: 'Policy', other: 'Other',
});
const ASSURANCE_KIND = Object.freeze({ iso27001_certificate: 'iso27001', soc2_report: 'soc2_type2' });
const SOON_DAYS = 60;
const ACTION_LABELS = Object.freeze({
  'party_document.added': 'Document filed', 'party_document.shared': 'Document shared with the client',
  'party_document.unshared': 'Document no longer shared with the client', 'party_document.deleted': 'Document deleted',
});

const COLUMNS = `d.id, d.workspace_id, d.third_party_id, d.kind, d.title, d.issued_on::text AS issued_on, d.expires_on::text AS expires_on,
  d.original_name, d.size_bytes, d.mime_type, d.sha256, d.shared_with_client, d.shared_at, d.uploaded_by, d.created_at, d.updated_at,
  d.deleted_at, d.row_version, u.name AS uploaded_by_name`;
const FROM = 'FROM tp_party_documents d LEFT JOIN users u ON u.id = d.uploaded_by';

const notFound = () => new TprmError(404, 'This document does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409, 'Someone else changed this document after you opened the page. Nothing was saved: reload the page and try again.');
const str = v => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v)).trim();
const plusDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function requireManage(actor) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, 'tp.manage')) {
    throw new TprmError(403, 'Your role does not allow changes to this supplier\'s documents.');
  }
}

function expiry(doc, today) {
  if (!doc.expires_on) return null;
  if (doc.expires_on < today) return { key: 'expired', label: 'Expired' };
  if (doc.expires_on <= plusDays(today, SOON_DAYS)) return { key: 'soon', label: 'Expires soon' };
  return { key: 'valid', label: 'Valid' };
}

function validate(input, file) {
  const errors = [];
  const kind = str(input.kind);
  const title = str(input.title);
  const issuedOn = str(input.issued_on) || null;
  const expiresOn = str(input.expires_on) || null;
  if (!KINDS.includes(kind)) errors.push('Choose what the document is from the list.');
  if (!title) errors.push('Give the document a title.');
  else if (title.length > 200) errors.push('The title must be 200 characters or fewer.');
  if (issuedOn && !isYmd(issuedOn)) errors.push('The issue date must be a real date.');
  if (expiresOn && !isYmd(expiresOn)) errors.push('The expiry date must be a real date.');
  if (issuedOn && expiresOn && isYmd(issuedOn) && isYmd(expiresOn) && expiresOn < issuedOn) errors.push('The expiry date cannot be before the issue date.');
  if (!file || !file.path) errors.push('Choose a file to upload.');
  if (errors.length) throw new TprmError(400, errors.join(' '), { errors });
  return { kind, title, issuedOn, expiresOn };
}

async function append(db, actor, thirdPartyId, action, before, after) {
  await events.appendEvent(db, { workspaceId: actor.ws.id, thirdPartyId, actorId: actor.user.id, action, before, after });
}

async function add(db, actor, thirdPartyId, file, input = {}) {
  requireManage(actor);
  const v = validate(input, file);
  const sha256 = await sha256File(file.path);
  return await db.transaction(async () => {
    const party = await db.prepare('SELECT id FROM tp_third_parties WHERE workspace_id = ? AND id = ? FOR UPDATE').get(actor.ws.id, Number(thirdPartyId) || 0);
    if (!party) throw notFound();
    const name = String(file.originalname || '').trim().slice(0, 255) || 'file';
    const row = await db.prepare(`INSERT INTO tp_party_documents
      (workspace_id, third_party_id, kind, title, issued_on, expires_on, original_name, stored_path, size_bytes, mime_type, sha256, uploaded_by)
      VALUES (?, ?, ?, ?, ?::date, ?::date, ?, ?, ?, ?, ?, ?) RETURNING id`).get(actor.ws.id, party.id, v.kind, v.title, v.issuedOn, v.expiresOn,
      name, file.filename, Number(file.size) || 0, file.mimetype ? String(file.mimetype).slice(0, 200) : null, sha256, actor.user.id);
    await append(db, actor, party.id, 'party_document.added', null, {
      document_id: Number(row.id), kind: v.kind, title: v.title, issued_on: v.issuedOn, expires_on: v.expiresOn, name, sha256,
    });
    return { id: Number(row.id), title: v.title };
  })();
}

async function lock(db, actor, thirdPartyId, documentId) {
  const id = Number(documentId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const row = await db.prepare(`SELECT * FROM tp_party_documents WHERE workspace_id = ? AND third_party_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE`)
    .get(actor.ws.id, Number(thirdPartyId) || 0, id);
  if (!row) throw notFound();
  return row;
}

async function setShared(db, actor, thirdPartyId, documentId, input = {}) {
  requireManage(actor);
  const shared = str(input.shared) === '1';
  return await db.transaction(async () => {
    const row = await lock(db, actor, thirdPartyId, documentId);
    if (!!row.shared_with_client === shared) return { id: Number(row.id), title: row.title, shared, unchanged: true };
    if (Number(input.row_version) !== Number(row.row_version)) throw conflict();
    await db.prepare(`UPDATE tp_party_documents SET shared_with_client = ?, shared_by = ?, shared_at = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ?`).run(shared, shared ? actor.user.id : null, shared ? new Date().toISOString() : null, actor.ws.id, row.id);
    await append(db, actor, row.third_party_id, shared ? 'party_document.shared' : 'party_document.unshared',
      { document_id: Number(row.id), shared_with_client: !shared }, { document_id: Number(row.id), title: row.title, shared_with_client: shared });
    return { id: Number(row.id), title: row.title, shared };
  })();
}

async function remove(db, actor, thirdPartyId, documentId, input = {}) {
  requireManage(actor);
  return await db.transaction(async () => {
    const row = await lock(db, actor, thirdPartyId, documentId);
    if (Number(input.row_version) !== Number(row.row_version)) throw conflict();
    await db.prepare(`UPDATE tp_party_documents SET deleted_at = now(), deleted_by = ?, shared_with_client = false, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ?`).run(actor.user.id, actor.ws.id, row.id);
    await append(db, actor, row.third_party_id, 'party_document.deleted',
      { document_id: Number(row.id), title: row.title, kind: row.kind, shared_with_client: !!row.shared_with_client }, null);
    return { id: Number(row.id), title: row.title };
  })();
}

async function list(db, workspaceId, thirdPartyId, today) {
  const rows = await db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE d.workspace_id = ? AND d.third_party_id = ? AND d.deleted_at IS NULL
    ORDER BY d.expires_on ASC NULLS LAST, d.created_at DESC, d.id DESC`).all(Number(workspaceId), Number(thirdPartyId));
  return rows.map(r => ({ ...r, id: Number(r.id), kindLabel: KIND_LABELS[r.kind] || r.kind, expiry: today ? expiry(r, today) : null }));
}

async function forFirm(db, ws, thirdPartyId, today) {
  const documents = await list(db, ws.id, thirdPartyId, today);
  return {
    documents,
    expiring: documents.filter(d => d.expiry && d.expiry.key === 'soon'),
    expired: documents.filter(d => d.expiry && d.expiry.key === 'expired'),
    kinds: KINDS, kindLabels: KIND_LABELS, soonDays: SOON_DAYS,
  };
}

function certificates(documents) {
  const out = [];
  const newest = [...(documents || [])].sort((a, b) => Number(!!b.expires_on) - Number(!!a.expires_on)
    || String(b.expires_on || '').localeCompare(String(a.expires_on || ''))
    || new Date(b.created_at) - new Date(a.created_at) || Number(b.id) - Number(a.id));
  for (const d of newest) {
    const kind = ASSURANCE_KIND[d.kind];
    if (!kind || out.some(c => c.kind === kind)) continue;
    out.push({ kind, expires_on: d.expires_on || null, document_id: d.id, name: d.title, source: 'document' });
  }
  return out;
}

async function firmFile(db, actor, thirdPartyId, documentId) {
  const id = Number(documentId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const row = await db.prepare(`SELECT id, original_name, stored_path, mime_type FROM tp_party_documents
    WHERE workspace_id = ? AND third_party_id = ? AND id = ? AND deleted_at IS NULL`).get(actor.ws.id, Number(thirdPartyId) || 0, id);
  if (!row) throw notFound();
  return row;
}

async function forClient(db, ws, thirdPartyId, today) {
  const rows = await db.prepare(`SELECT d.id, d.kind, d.title, d.issued_on::text AS issued_on, d.expires_on::text AS expires_on, d.original_name, d.size_bytes
    FROM tp_party_documents d WHERE d.workspace_id = ? AND d.third_party_id = ? AND d.deleted_at IS NULL AND d.shared_with_client = true
    ORDER BY d.expires_on ASC NULLS LAST, d.id DESC`).all(Number(ws.id), Number(thirdPartyId));
  return rows.map(r => ({ ...r, id: Number(r.id), kindLabel: KIND_LABELS[r.kind] || r.kind, expiry: today ? expiry(r, today) : null }));
}

async function clientFile(db, ws, thirdPartyId, documentId) {
  const id = Number(documentId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return await db.prepare(`SELECT id, original_name, stored_path FROM tp_party_documents
    WHERE workspace_id = ? AND third_party_id = ? AND id = ? AND deleted_at IS NULL AND shared_with_client = true`)
    .get(Number(ws.id), Number(thirdPartyId) || 0, id) || null;
}

module.exports = {
  KINDS, KIND_LABELS, SOON_DAYS, ACTION_LABELS,
  expiry, add, setShared, remove, list, forFirm, certificates, firmFile, forClient, clientFile,
};
