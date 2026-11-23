'use strict';

const crypto = require('crypto');
const { parseCSV } = require('../csv-import');
const events = require('./events');
const placement = require('./placement');
const register = require('./register');
const clientSettings = require('./client-settings');
const { TprmError } = require('./errors');

const MAX_ROWS = 2000;

const COLUMNS = [
  { key: 'name', label: 'name', required: true, hint: 'The third party\'s name. Duplicates are allowed but flagged.', synonyms: ['third party', 'third party name', 'vendor', 'vendor name', 'supplier', 'supplier name'] },
  { key: 'status', label: 'status', required: true, hint: 'proposed, in_use or exited ("In use" also accepted).', synonyms: [] },
  { key: 'last_assessment_date', label: 'last_assessment_date', hint: 'YYYY-MM-DD, not in the future. Used for the next due date.', synonyms: ['last assessment', 'last assessed', 'last review date', 'last assessed date'] },
  { key: 'client_label', label: 'client_label', hint: 'The client\'s own criticality label, mapped to a tier in the client settings.', synonyms: ['client criticality', 'criticality', 'client rating', 'label'] },
  { key: 'legal_name', label: 'legal_name', hint: 'Registered legal name.', synonyms: [] },
  { key: 'registration_number', label: 'registration_number', hint: 'Company or tax registration number.', synonyms: ['registration no', 'company number'] },
  { key: 'website', label: 'website', hint: '', synonyms: ['url', 'web site'] },
  { key: 'category', label: 'category', hint: 'For example "Cloud hosting" or "Payroll".', synonyms: ['type', 'service category'] },
  { key: 'country', label: 'country', hint: 'Country of the third party\'s head office.', synonyms: [] },
  { key: 'primary_contact_name', label: 'primary_contact_name', hint: '', synonyms: ['contact', 'contact name', 'primary contact'] },
  { key: 'primary_contact_email', label: 'primary_contact_email', hint: '', synonyms: ['contact email', 'email'] },
  { key: 'service_description', label: 'service_description', hint: 'What they provide for this client. Creates the third party\'s first service; add its other details later on the Services tab.', synonyms: ['service', 'what they provide'] },
];

const normHeader = h => String(h || '').trim().toLowerCase().replace(/[_\-/]+/g, ' ').replace(/\s+/g, ' ');

function canonicalText(raw) {
  let text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw == null ? '' : raw);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function template() {
  return COLUMNS.map(c => c.label).join(',') + '\r\n';
}

function mapHeaders(headers) {
  const byName = new Map();
  for (const c of COLUMNS) {
    byName.set(normHeader(c.label), c.key);
    for (const s of c.synonyms) byName.set(normHeader(s), c.key);
  }
  const mapping = {};
  const unknown = [];
  const errors = [];
  for (const h of headers) {
    const key = byName.get(normHeader(h));
    if (!key) { if (String(h).trim()) unknown.push(h); continue; }
    if (mapping[key]) { errors.push(`Two columns map to "${key}" ("${mapping[key]}" and "${h}"). Keep one.`); continue; }
    mapping[key] = h;
  }
  for (const c of COLUMNS.filter(col => col.required)) {
    if (!mapping[c.key]) errors.push(`The file has no "${c.label}" column.`);
  }
  return { mapping, unknown, errors };
}

async function analyse(db, actor, rawText) {
  const text = canonicalText(rawText);
  const hash = sha256(text);
  const fileErrors = [];
  const { headers, rows: records } = parseCSV(text);
  if (!headers.length) fileErrors.push('The file is empty. Download the template, add one row per third party and upload it again.');
  const { mapping, unknown, errors: headerErrors } = mapHeaders(headers);
  fileErrors.push(...headerErrors);
  if (headers.length && !records.length) fileErrors.push('The file has a header row but no third parties.');
  if (records.length > MAX_ROWS) fileErrors.push(`The file has ${records.length} rows; import at most ${MAX_ROWS} at a time.`);

  const todayYmd = register.today(actor);
  const settings = await clientSettings.get(db, actor.ws.id);
  const intervals = (await clientSettings.intervals(db, actor.ws, settings)).effective;
  const existing = await db.prepare(`SELECT lower(btrim(name)) AS key, COUNT(*)::integer AS n
    FROM tp_third_parties WHERE workspace_id = ? GROUP BY 1`).all(actor.ws.id);
  const existingNames = new Map(existing.map(r => [r.key, r.n]));
  const fileNames = new Map();

  const rows = fileErrors.length ? [] : records.map((record, i) => {
    const input = {};
    for (const [key, header] of Object.entries(mapping)) input[key] = record[header];
    const { values, errors } = register.validateThirdParty(input, { today: todayYmd });
    let service = null;
    if (input.service_description != null && String(input.service_description).trim()) {
      const checked = register.validateService({ description: input.service_description });
      errors.push(...checked.errors);
      service = checked.values;
    }
    values.client_designated_critical = placement.tierForLabel(settings.label_tier_map, values.client_label) === 'critical';
    const warnings = [];
    let place = null;
    if (!errors.length) {
      place = placement.provisionalPlacement({
        status: values.status, clientLabel: values.client_label, lastAssessmentDate: values.last_assessment_date,
        designatedCritical: values.client_designated_critical, labelMap: settings.label_tier_map, intervals, today: todayYmd,
      });
      if (place.labelUnmapped) warnings.push(`Tier needed: the label "${values.client_label}" is not mapped to a tier in this client's settings.`);
      else if (place.tierNeeded) warnings.push('Tier needed: no client label.');
      const key = values.name.trim().toLowerCase();
      if (existingNames.has(key)) warnings.push('A third party with this name is already in the register.');
      if (fileNames.has(key)) warnings.push(`Same name as row ${fileNames.get(key)} of this file.`);
      else fileNames.set(key, i + 2);
    }
    return { line: i + 2, values, service, errors, warnings, placement: place };
  });
  const invalid = rows.filter(r => r.errors.length).length;
  return {
    hash,
    text,
    rows,
    fileErrors,
    unknownColumns: unknown,
    summary: {
      total: rows.length,
      invalid,
      warnings: rows.filter(r => r.warnings.length).length,
      tierNeeded: rows.filter(r => r.placement && r.placement.tierNeeded).length,
      services: rows.filter(r => r.service).length,
      dueNow: rows.filter(r => r.placement && r.placement.nextDueDate && r.placement.nextDueDate <= todayYmd).length,
    },
    ok: !fileErrors.length && rows.length > 0 && invalid === 0,
    today: todayYmd,
  };
}

async function committedBatchFor(db, workspaceId, hash) {
  return await db.prepare(`SELECT id, committed_at, imported_count FROM tp_import_batches
    WHERE workspace_id = ? AND file_sha256 = ? AND status = 'committed'`).get(workspaceId, hash);
}

async function preview(db, actor, rawText, filename) {
  register.requirePermission(actor, 'tp.manage');
  const analysis = await analyse(db, actor, rawText);
  const alreadyImported = analysis.text ? await committedBatchFor(db, actor.ws.id, analysis.hash) : null;
  let batch = null;
  if (analysis.ok && !alreadyImported) {
    const info = await db.prepare(`INSERT INTO tp_import_batches (workspace_id, file_sha256, filename, row_count, previewed_by)
      VALUES (?, ?, ?, ?, ?)`).run(actor.ws.id, analysis.hash, String(filename || 'upload.csv').slice(0, 200), analysis.rows.length, actor.user.id);
    batch = { id: Number(info.lastInsertRowid), file_sha256: analysis.hash };
  }
  return { analysis, batch, alreadyImported };
}

async function commit(db, actor, batchId, rawText) {
  register.requirePermission(actor, 'tp.manage');
  const id = Number(batchId);
  if (!Number.isSafeInteger(id) || id < 1) throw new TprmError(404, 'This import preview does not exist. Upload the file again.');
  return await db.transaction(async () => {
    const batch = await db.prepare(`SELECT id, file_sha256, status, imported_count FROM tp_import_batches
      WHERE workspace_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, id);
    if (!batch) throw new TprmError(404, 'This import preview does not exist. Upload the file again.');
    if (batch.status === 'committed') return { imported: 0, alreadyImported: true, batchId: batch.id, previous: batch.imported_count };
    const text = canonicalText(rawText);
    if (sha256(text) !== batch.file_sha256) {
      throw new TprmError(409, 'The file changed after it was previewed, so nothing was imported. Upload the file again to preview the current version.');
    }
    await db.lockChain(`tp_import:${actor.ws.id}:${batch.file_sha256}`);
    const earlier = await committedBatchFor(db, actor.ws.id, batch.file_sha256);
    if (earlier) return { imported: 0, alreadyImported: true, batchId: earlier.id, previous: earlier.imported_count };

    const analysis = await analyse(db, actor, text);
    if (!analysis.ok) {
      const bad = analysis.rows.filter(r => r.errors.length).map(r => r.line);
      throw new TprmError(400, analysis.fileErrors.length
        ? `Nothing was imported: ${analysis.fileErrors.join(' ')}`
        : `Nothing was imported: row${bad.length === 1 ? '' : 's'} ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? '…' : ''} ${bad.length === 1 ? 'has' : 'have'} errors. Fix the file and upload it again.`);
    }
    for (const row of analysis.rows) {
      const v = row.values;
      const p = row.placement;
      const info = await db.prepare(`INSERT INTO tp_third_parties
        (workspace_id, name, legal_name, registration_number, website, category, country,
         primary_contact_name, primary_contact_email, status, client_label, last_assessment_date,
         client_designated_critical, current_tier, tier_source, next_due_date, import_batch_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?, ?::date, ?, ?)`).run(
        actor.ws.id, v.name, v.legal_name, v.registration_number, v.website, v.category, v.country,
        v.primary_contact_name, v.primary_contact_email, v.status, v.client_label, v.last_assessment_date,
        v.client_designated_critical, p.tier, p.tierSource, p.nextDueDate, batch.id, actor.user.id);
      const after = register.pick({ ...v, current_tier: p.tier, tier_source: p.tierSource, next_due_date: p.nextDueDate }, register.THIRD_PARTY_FIELDS);
      const thirdPartyId = Number(info.lastInsertRowid);
      await events.appendEvent(db, {
        workspaceId: actor.ws.id, thirdPartyId, actorId: actor.user.id,
        action: 'third_party.imported', after: { ...after, import_batch_id: batch.id, file_line: row.line },
      });
      if (row.service) await register.insertService(db, actor, thirdPartyId, row.service, { import_batch_id: batch.id, file_line: row.line });
    }
    const done = await db.prepare(`UPDATE tp_import_batches SET status = 'committed', committed_by = ?, committed_at = now(),
        imported_count = ? WHERE workspace_id = ? AND id = ? AND status = 'previewed'`)
      .run(actor.user.id, analysis.rows.length, actor.ws.id, batch.id);
    if (done.changes !== 1) throw new TprmError(409, 'This import was committed by someone else at the same time. Nothing more was imported.');
    return { imported: analysis.rows.length, services: analysis.summary.services, alreadyImported: false, batchId: batch.id };
  })();
}

module.exports = { COLUMNS, MAX_ROWS, canonicalText, sha256, template, analyse, preview, commit };
