'use strict';

const fs = require('fs');
const crypto = require('crypto');
const access = require('./access');
const events = require('./events');
const assessments = require('./assessments');
const findings = require('./findings');
const { TprmError } = require('./errors');

const LIMITS = Object.freeze({ description: 1000, filesPerUpload: 20 });
const SOURCES = Object.freeze(['consultant', 'vendor']);

const notFound = () => new TprmError(404, 'This file does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed this file after you opened the page. Nothing was saved: reload the page and try again.');
const closed = a => new TprmError(409, assessments.evidenceFrozenMessage(a));
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

function requirePermission(actor, permission, message) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, permission)) {
    throw new TprmError(403, message || 'Your role does not allow changes to this assessment\'s evidence.');
  }
}

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();

const PUBLIC_FIELDS = ['id', 'workspace_id', 'assessment_id', 'original_name', 'size_bytes', 'mime_type', 'sha256',
  'description', 'source', 'uploaded_by', 'uploaded_at', 'released_to_client', 'released_by', 'released_at',
  'created_at', 'updated_at', 'row_version'];
const PUBLIC_COLUMNS = PUBLIC_FIELDS.map(f => `e.${f}`).join(', ');

function publicRow(row) {
  if (!row) return row;
  const { stored_path: _hidden, ...rest } = row;
  return rest;
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('error', reject).on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function append(db, actor, assessment, action, before, after) {
  await events.appendEvent(db, {
    workspaceId: actor.ws.id, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id,
    actorId: actor.user.id, action, before, after,
  });
}

async function openForChange(db, actor, thirdPartyId, assessmentId) {
  const assessment = await assessments.getAssessment(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
  if (!assessments.evidenceChangeable(assessment)) throw closed(assessment);
  return assessment;
}

async function assertCanUpload(db, actor, thirdPartyId, assessmentId) {
  requirePermission(actor, 'tp.manage');
  const assessment = await assessments.getAssessment(db, actor, thirdPartyId, assessmentId);
  if (!assessments.evidenceChangeable(assessment)) throw closed(assessment);
  return assessment;
}

const canRelease = a => !!a && a.status !== 'cancelled';

async function lockEvidence(db, actor, assessment, evidenceId) {
  const id = Number(evidenceId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const row = await db.prepare(`SELECT * FROM tp_evidence WHERE workspace_id = ? AND assessment_id = ? AND id = ? FOR UPDATE`)
    .get(actor.ws.id, assessment.id, id);
  if (!row) throw notFound();
  return row;
}

function checkVersion(row, input) {
  const rowVersion = Number(input && input.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion !== row.row_version) throw conflict();
}

async function listEvidence(db, actor, assessment) {
  requirePermission(actor, 'tp.view');
  return await db.prepare(`SELECT ${PUBLIC_COLUMNS}, uu.name AS uploaded_by_name, ru.name AS released_by_name,
      (SELECT COUNT(*)::int FROM tp_finding_evidence l WHERE l.workspace_id = e.workspace_id AND l.evidence_id = e.id) AS finding_count
    FROM tp_evidence e
    LEFT JOIN users uu ON uu.id = e.uploaded_by
    LEFT JOIN users ru ON ru.id = e.released_by
    WHERE e.workspace_id = ? AND e.assessment_id = ? ORDER BY e.uploaded_at, e.id`).all(actor.ws.id, assessment.id);
}

async function evidenceFile(db, actor, thirdPartyId, assessmentId, evidenceId) {
  requirePermission(actor, 'tp.view');
  if (!access.isFirmUser(actor.user)) throw notFound();
  const assessment = await assessments.getAssessment(db, actor, thirdPartyId, assessmentId);
  const id = Number(evidenceId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const row = await db.prepare(`SELECT id, original_name, stored_path, mime_type FROM tp_evidence
    WHERE workspace_id = ? AND assessment_id = ? AND id = ?`).get(actor.ws.id, assessment.id, id);
  if (!row) throw notFound();
  return row;
}

async function listReleasedEvidence(db, ws, assessmentId) {
  const workspaceId = Number(ws && typeof ws === 'object' ? ws.id : ws);
  const id = Number(assessmentId);
  if (!Number.isSafeInteger(workspaceId) || !Number.isSafeInteger(id)) return [];
  return await db.prepare(`SELECT e.id, e.assessment_id, e.original_name, e.size_bytes, e.mime_type, e.sha256,
      e.description, e.released_at
    FROM tp_evidence e
    WHERE e.workspace_id = ? AND e.assessment_id = ? AND e.released_to_client
    ORDER BY e.released_at, e.id`).all(workspaceId, id);
}

async function releasedEvidenceFile(db, ws, assessmentId, evidenceId) {
  const workspaceId = Number(ws && typeof ws === 'object' ? ws.id : ws);
  const aid = Number(assessmentId);
  const id = Number(evidenceId);
  if (![workspaceId, aid, id].every(n => Number.isSafeInteger(n) && n > 0)) return null;
  return await db.prepare(`SELECT id, original_name, stored_path, mime_type FROM tp_evidence
    WHERE workspace_id = ? AND assessment_id = ? AND id = ? AND released_to_client`).get(workspaceId, aid, id) || null;
}

async function addEvidence(db, actor, thirdPartyId, assessmentId, files, input = {}) {
  requirePermission(actor, 'tp.manage');
  const list = (files || []).filter(Boolean);
  const description = str(input.description) || null;
  const errors = [];
  if (!list.length) errors.push('Choose at least one file to upload.');
  if (list.length > LIMITS.filesPerUpload) errors.push(`Upload at most ${LIMITS.filesPerUpload} files at a time.`);
  if (description && description.length > LIMITS.description) errors.push(`The description must be ${LIMITS.description} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  const hashed = [];
  for (const file of list) hashed.push({ file, sha256: await sha256File(file.path) });

  return await db.transaction(async () => {
    const assessment = await openForChange(db, actor, thirdPartyId, assessmentId);
    const existing = new Set((await db.prepare('SELECT sha256 FROM tp_evidence WHERE workspace_id = ? AND assessment_id = ?')
      .all(actor.ws.id, assessment.id)).map(r => r.sha256));
    const created = [];
    const skipped = [];
    for (const { file, sha256 } of hashed) {
      if (existing.has(sha256)) {
        skipped.push({ file, reason: 'already_uploaded' });
        continue;
      }
      existing.add(sha256);
      const name = String(file.originalname || '').trim().slice(0, 255) || 'file';
      const row = await db.prepare(`INSERT INTO tp_evidence
        (workspace_id, assessment_id, original_name, stored_path, size_bytes, mime_type, sha256, description, source, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'consultant', ?) RETURNING ${PUBLIC_FIELDS.join(', ')}`)
        .get(actor.ws.id, assessment.id, name, file.filename, Number(file.size) || 0,
          file.mimetype ? String(file.mimetype).slice(0, 200) : null, sha256, description, actor.user.id);
      await append(db, actor, assessment, 'evidence.uploaded', null, {
        evidence_id: Number(row.id), name: row.original_name, size_bytes: Number(row.size_bytes), sha256: row.sha256,
        description: row.description, source: row.source,
      });
      created.push(row);
    }
    return { created, skipped };
  })();
}

async function releaseEvidence(db, actor, thirdPartyId, assessmentId, evidenceId, input = {}) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow releasing files to the client.');
  return await db.transaction(async () => {
    const assessment = await assessments.getAssessment(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
    if (!canRelease(assessment)) {
      throw new TprmError(409, 'This assessment is cancelled, so its files are no longer released to the client.');
    }
    const row = await lockEvidence(db, actor, assessment, evidenceId);
    if (row.released_to_client) return { evidence: publicRow(row), unchanged: true };
    checkVersion(row, input);
    const res = await db.prepare(`UPDATE tp_evidence SET released_to_client = true, released_by = ?, released_at = now(),
        updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.user.id, actor.ws.id, row.id, row.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, 'evidence.released', { evidence_id: Number(row.id), released_to_client: false },
      { evidence_id: Number(row.id), name: row.original_name, released_to_client: true });
    return { evidence: publicRow(await lockEvidence(db, actor, assessment, row.id)) };
  })();
}

async function deleteEvidence(db, actor, thirdPartyId, assessmentId, evidenceId, input = {}) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow deleting files.');
  return await db.transaction(async () => {
    const assessment = await openForChange(db, actor, thirdPartyId, assessmentId);
    const row = await lockEvidence(db, actor, assessment, evidenceId);
    if (row.released_to_client) {
      throw new TprmError(409, `"${row.original_name}" has been released to the client, so it cannot be deleted.`);
    }
    if (row.source === 'vendor') {
      throw new TprmError(409, `"${row.original_name}" was uploaded by the third party with its answers, so the firm cannot delete it.`);
    }
    checkVersion(row, input);
    const citing = await db.prepare(`SELECT f.title FROM tp_finding_evidence l
      JOIN tp_findings f ON f.workspace_id = l.workspace_id AND f.id = l.finding_id
      WHERE l.workspace_id = ? AND l.evidence_id = ? ORDER BY f.id`).all(actor.ws.id, row.id);
    if (citing.length) {
      throw new TprmError(409, `"${row.original_name}" is cited by ${citing.length === 1 ? 'the finding' : 'the findings'} `
        + `${citing.map(f => `"${f.title}"`).join(', ')}. Remove it from ${citing.length === 1 ? 'that finding' : 'those findings'} first.`);
    }
    const res = await db.prepare('DELETE FROM tp_evidence WHERE workspace_id = ? AND id = ? AND row_version = ?')
      .run(actor.ws.id, row.id, row.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, 'evidence.deleted', {
      evidence_id: Number(row.id), name: row.original_name, size_bytes: Number(row.size_bytes), sha256: row.sha256,
    }, null);
    return { evidence: publicRow(row), storedPath: row.stored_path };
  })();
}

const ACTION_LABELS = Object.freeze({
  'evidence.uploaded': 'File uploaded',
  'evidence.released': 'File released to the client',
  'evidence.deleted': 'File deleted',
});

async function panel(db, actor, assessment) {
  const canManage = access.can(actor.user, actor.perms, 'tp.manage');
  const changeable = assessments.evidenceChangeable(assessment);
  return {
    evidence: await listEvidence(db, actor, assessment),
    findings: await findings.listFindings(db, actor, assessment),
    canChange: canManage && changeable,
    canRelease: canManage && canRelease(assessment),
    frozenMessage: changeable ? null : assessments.evidenceFrozenMessage(assessment),
    severities: findings.SEVERITIES,
    severityLabels: findings.SEVERITY_LABELS,
    findingStatusLabels: findings.STATUS_LABELS,
    actionLabels: { ...ACTION_LABELS, ...findings.ACTION_LABELS },
    limits: LIMITS,
  };
}

module.exports = {
  LIMITS, SOURCES, ACTION_LABELS,
  sha256File, assertCanUpload, listEvidence, evidenceFile, listReleasedEvidence, releasedEvidenceFile,
  addEvidence, releaseEvidence, deleteEvidence, panel,
};
