'use strict';

const access = require('./access');
const events = require('./events');
const assessments = require('./assessments');
const { TprmError } = require('./errors');

const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const SEVERITY_LABELS = Object.freeze({ critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' });
const STATUSES = Object.freeze(['open', 'closed']);
const SOURCES = Object.freeze(['consultant', 'ai_accepted']);
const SOURCE_LABELS = Object.freeze({ consultant: 'Consultant', ai_accepted: 'Accepted from an AI suggestion' });
const STATUS_LABELS = Object.freeze({ open: 'Open', closed: 'Closed' });
const LIMITS = Object.freeze({ controlRef: 40, title: 200, description: 4000, impact: 2000 });
const FIELDS = ['control_ref', 'severity', 'title', 'description', 'impact', 'status', 'evidence_ids'];

const ACTION_LABELS = Object.freeze({
  'finding.added': 'Finding added',
  'finding.updated': 'Finding updated',
  'finding.removed': 'Finding removed',
});

const notFound = () => new TprmError(404, 'This finding does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed this finding after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.');
const closed = a => new TprmError(409, assessments.evidenceFrozenMessage(a));
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

function requirePermission(actor, permission) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, permission)) {
    throw new TprmError(403, 'Your role does not allow changes to this assessment\'s findings.');
  }
}

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const list = raw => (Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]).map(v => String(v).trim()).filter(Boolean);

function parse(input, { editing = false } = {}) {
  const errors = [];
  const values = {
    control_ref: str(input.control_ref) || null,
    severity: str(input.severity),
    title: str(input.title),
    description: str(input.description) || null,
    impact: str(input.impact) || null,
    status: editing ? str(input.status) : 'open',
    evidence_ids: [],
  };
  if (values.control_ref && values.control_ref.length > LIMITS.controlRef) {
    errors.push(`The control reference must be ${LIMITS.controlRef} characters or fewer.`);
  }
  if (!SEVERITIES.includes(values.severity)) errors.push('Choose a severity.');
  if (!values.title) errors.push('Give the finding a title.');
  else if (values.title.length > LIMITS.title) errors.push(`The title must be ${LIMITS.title} characters or fewer.`);
  if (values.description && values.description.length > LIMITS.description) {
    errors.push(`The description must be ${LIMITS.description} characters or fewer.`);
  }
  if (values.impact && values.impact.length > LIMITS.impact) errors.push(`Why it matters must be ${LIMITS.impact} characters or fewer.`);
  if (!STATUSES.includes(values.status)) errors.push('Choose whether the finding is open or closed.');
  const ids = list(input.evidence);
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1) { errors.push('Choose the linked files from the list.'); break; }
    if (!values.evidence_ids.includes(id)) values.evidence_ids.push(id);
  }
  values.evidence_ids.sort((a, b) => a - b);
  if (errors.length) throw invalid(errors);
  return values;
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

async function checkEvidence(db, actor, assessment, ids) {
  if (!ids.length) return;
  const rows = await db.prepare(`SELECT id FROM tp_evidence WHERE workspace_id = ? AND assessment_id = ?
    AND id IN (${ids.map(() => '?').join(',')})`).all(actor.ws.id, assessment.id, ...ids);
  if (rows.length !== ids.length) {
    throw invalid(['A linked file is not part of this assessment. Choose the files from this assessment\'s evidence list.']);
  }
}

async function writeLinks(db, actor, assessment, findingId, ids) {
  await db.prepare('DELETE FROM tp_finding_evidence WHERE workspace_id = ? AND finding_id = ?').run(actor.ws.id, findingId);
  for (const evidenceId of ids) {
    await db.prepare(`INSERT INTO tp_finding_evidence (workspace_id, assessment_id, finding_id, evidence_id)
      VALUES (?, ?, ?, ?)`).run(actor.ws.id, assessment.id, findingId, evidenceId);
  }
}

const COLUMNS = `f.id, f.workspace_id, f.assessment_id, f.control_ref, f.severity, f.title, f.description, f.impact, f.source,
  f.status, f.created_by, f.updated_by, f.created_at, f.updated_at, f.row_version`;

async function loadLinks(db, workspaceId, findingIds) {
  if (!findingIds.length) return new Map();
  const rows = await db.prepare(`SELECT l.finding_id, e.id, e.original_name, e.released_to_client
    FROM tp_finding_evidence l JOIN tp_evidence e ON e.workspace_id = l.workspace_id AND e.id = l.evidence_id
    WHERE l.workspace_id = ? AND l.finding_id IN (${findingIds.map(() => '?').join(',')})
    ORDER BY e.id`).all(workspaceId, ...findingIds);
  const byFinding = new Map();
  for (const r of rows) {
    const key = Number(r.finding_id);
    if (!byFinding.has(key)) byFinding.set(key, []);
    byFinding.get(key).push({ id: Number(r.id), original_name: r.original_name, released_to_client: r.released_to_client });
  }
  return byFinding;
}

function withLinks(row, links) {
  const evidence = links.get(Number(row.id)) || [];
  return { ...row, evidence, evidence_ids: evidence.map(e => e.id) };
}

async function listFindings(db, actor, assessment) {
  requirePermission(actor, 'tp.view');
  const rows = await db.prepare(`SELECT ${COLUMNS}, cu.name AS created_by_name
    FROM tp_findings f LEFT JOIN users cu ON cu.id = f.created_by
    WHERE f.workspace_id = ? AND f.assessment_id = ?
    ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, f.id`)
    .all(actor.ws.id, assessment.id);
  const links = await loadLinks(db, actor.ws.id, rows.map(r => Number(r.id)));
  return rows.map(r => withLinks(r, links));
}

async function getFinding(db, actor, assessment, findingId, { forUpdate = false } = {}) {
  requirePermission(actor, 'tp.view');
  const id = Number(findingId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const row = await db.prepare(`SELECT ${COLUMNS} FROM tp_findings f
    WHERE f.workspace_id = ? AND f.assessment_id = ? AND f.id = ?${forUpdate ? ' FOR UPDATE' : ''}`)
    .get(actor.ws.id, assessment.id, id);
  if (!row) throw notFound();
  return withLinks(row, await loadLinks(db, actor.ws.id, [id]));
}

async function addFinding(db, actor, thirdPartyId, assessmentId, input = {}, { source = 'consultant' } = {}) {
  requirePermission(actor, 'tp.manage');
  if (!SOURCES.includes(source)) throw new TypeError('Unknown finding source.');
  const values = parse(input);
  return await db.transaction(async () => {
    const assessment = await openForChange(db, actor, thirdPartyId, assessmentId);
    await checkEvidence(db, actor, assessment, values.evidence_ids);
    const row = await db.prepare(`INSERT INTO tp_findings
      (workspace_id, assessment_id, control_ref, severity, title, description, impact, source, status, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(actor.ws.id, assessment.id, values.control_ref, values.severity, values.title, values.description, values.impact, source,
        values.status, actor.user.id, actor.user.id);
    const id = Number(row.id);
    await writeLinks(db, actor, assessment, id, values.evidence_ids);
    await append(db, actor, assessment, 'finding.added', null, { finding_id: id, ...values, source });
    return await getFinding(db, actor, assessment, id);
  })();
}

async function updateFinding(db, actor, thirdPartyId, assessmentId, findingId, input = {}) {
  requirePermission(actor, 'tp.manage');
  const values = parse(input, { editing: true });
  return await db.transaction(async () => {
    const assessment = await openForChange(db, actor, thirdPartyId, assessmentId);
    const finding = await getFinding(db, actor, assessment, findingId, { forUpdate: true });
    const rowVersion = Number(input.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== finding.row_version) throw conflict();
    await checkEvidence(db, actor, assessment, values.evidence_ids);
    const before = {};
    const after = {};
    for (const f of FIELDS) {
      const x = f === 'evidence_ids' ? finding.evidence_ids : finding[f] ?? null;
      if (JSON.stringify(x) !== JSON.stringify(values[f])) { before[f] = x; after[f] = values[f]; }
    }
    if (!Object.keys(after).length) return { finding, unchanged: true };
    const res = await db.prepare(`UPDATE tp_findings SET control_ref = ?, severity = ?, title = ?, description = ?, impact = ?, status = ?,
        updated_by = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(values.control_ref, values.severity, values.title, values.description, values.impact, values.status, actor.user.id,
        actor.ws.id, finding.id, finding.row_version);
    if (res.changes !== 1) throw conflict();
    if (after.evidence_ids) await writeLinks(db, actor, assessment, Number(finding.id), values.evidence_ids);
    await append(db, actor, assessment, 'finding.updated', { finding_id: Number(finding.id), ...before }, { finding_id: Number(finding.id), ...after });
    return { finding: await getFinding(db, actor, assessment, finding.id) };
  })();
}

async function removeFinding(db, actor, thirdPartyId, assessmentId, findingId, input = {}) {
  requirePermission(actor, 'tp.manage');
  return await db.transaction(async () => {
    const assessment = await openForChange(db, actor, thirdPartyId, assessmentId);
    const finding = await getFinding(db, actor, assessment, findingId, { forUpdate: true });
    const rowVersion = Number(input.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== finding.row_version) throw conflict();
    const citing = await db.prepare(`SELECT c.position, r.version FROM tp_conditions c
        JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id
      WHERE c.workspace_id = ? AND c.finding_id = ? AND r.status NOT IN ('draft', 'changes_requested') ORDER BY r.version, c.position LIMIT 1`)
      .get(actor.ws.id, finding.id);
    if (citing) {
      throw new TprmError(409, `This finding is addressed by condition ${citing.position} of recommendation version ${citing.version}, so it cannot be removed. Close it instead.`);
    }
    const shared = await db.prepare("SELECT 1 FROM tp_issues WHERE workspace_id = ? AND finding_id = ? AND status <> 'withdrawn'").get(actor.ws.id, finding.id);
    if (shared) throw new TprmError(409, 'This finding is shared with the third party. Withdraw the shared issue first, or close the finding instead.');
    await db.prepare(`UPDATE tp_conditions SET finding_id = NULL, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND finding_id = ?`).run(actor.ws.id, finding.id);
    const res = await db.prepare('DELETE FROM tp_findings WHERE workspace_id = ? AND id = ? AND row_version = ?')
      .run(actor.ws.id, finding.id, finding.row_version);
    if (res.changes !== 1) throw conflict();
    const before = { finding_id: Number(finding.id) };
    for (const f of FIELDS) before[f] = f === 'evidence_ids' ? finding.evidence_ids : finding[f] ?? null;
    await append(db, actor, assessment, 'finding.removed', before, null);
    return { finding };
  })();
}

module.exports = {
  SEVERITIES, SEVERITY_LABELS, STATUSES, STATUS_LABELS, SOURCES, SOURCE_LABELS, LIMITS, ACTION_LABELS,
  parse, listFindings, getFinding, addFinding, updateFinding, removeFinding,
};
