'use strict';

const access = require('./access');
const events = require('./events');
const assessments = require('./assessments');
const questionnaires = require('./questionnaires');
const { TprmError } = require('./errors');

const STATUSES = Object.freeze(['not_reviewed', 'present_satisfactory', 'present_gap', 'missing', 'not_required']);
const STATUS_LABELS = Object.freeze({
  not_reviewed: 'Not reviewed',
  present_satisfactory: 'Present - satisfactory',
  present_gap: 'Present - gap',
  missing: 'Missing',
  not_required: 'Not required',
});
const GAP_STATUSES = Object.freeze(['present_gap', 'missing']);
const ALL_CLIENTS = 'All clients (good practice)';
const CONDITIONAL = 'Conditional';
const LIMITS = Object.freeze({ reference: 300, comment: 2000 });
const CONTROL_REF = 'A.5.20';
const EVENT_LABELS = Object.freeze({
  'contract_review.started': 'Contract checklist started',
  'contract_review.updated': 'Contract checklist updated',
  'contract_review.finding_raised': 'Finding raised from the contract checklist',
  'contract_review.clauses_added': 'Rulebook clauses added to the contract checklist',
  'contract_review.vendor_started': 'Contract checklist opened by the third party',
  'contract_review.vendor_saved': 'Contract clauses marked by the third party',
});
const FIELDS = ['status', 'contract_reference', 'comment', 'finding_id'];

const notFound = () => new TprmError(404, 'This contract checklist row does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed the contract checklist after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

function requireManage(actor) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, 'tp.manage')) {
    throw new TprmError(403, 'Your role does not allow changes to this assessment\'s contract checklist.');
  }
}

function frozenMessage(a) {
  const m = assessments.evidenceFrozenMessage(a);
  return m ? m.replace('evidence and findings', 'evidence, findings and contract checklist') : null;
}

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const clientName = ws => (ws && (ws.brand_display_name || ws.client_name)) || 'the client';
const withClient = (text, ws) => (text == null ? text : String(text).replace(/<Client>/g, clientName(ws)));

function checklistOf(bank) {
  return bank && Array.isArray(bank.contract_checklist) ? bank.contract_checklist : [];
}

function clausesInScope(bank, { rulebooks = [] } = {}) {
  const tags = new Set([ALL_CLIENTS, ...rulebooks]);
  return checklistOf(bank).filter(c => c && c.id && tags.has(c.applies_to));
}

function isVisible(row, modules, tags = null) {
  if (row.status && row.status !== 'not_reviewed') return true;
  if (tags && row.applies_to !== ALL_CLIENTS && !tags.includes(row.applies_to)) return false;
  if (!row.conditional) return true;
  if (modules == null) return true;
  return modules.some(m => require('./questionnaire-assembly').sameModule(m, row.module));
}

function visibleRows(rows, modules, tags = null) {
  return rows.filter(r => isVisible(r, modules, tags));
}

function counts(rows) {
  const out = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of rows) out[r.status] += 1;
  return out;
}

const COLUMNS = `c.id, c.workspace_id, c.assessment_id, c.bank_version_id, c.bank_version, c.clause_id, c.position,
  c.applies_to, c.conditional, c.module, c.status, c.contract_reference, c.comment, c.finding_id, c.reviewed_by,
  c.reviewed_at, c.created_by, c.created_at, c.updated_at, c.row_version, c.vendor_status, c.vendor_reference, c.vendor_saved_at`;
const VENDOR_STATUSES = Object.freeze(['in_contract', 'partly', 'not_in_contract', 'no_contract_yet']);
const VENDOR_STATUS_LABELS = Object.freeze({
  in_contract: 'In the contract',
  partly: 'Partly covered',
  not_in_contract: 'Not in the contract',
  no_contract_yet: 'No signed contract yet',
});
const SUGGESTED_STATUS = Object.freeze({ in_contract: 'present_satisfactory', partly: 'present_gap', not_in_contract: 'missing' });
const CLIENT_LABELS = Object.freeze({ present_satisfactory: 'In contract', present_gap: 'Weak', missing: 'Missing', not_required: 'Not required' });
const VENDOR_OPEN_Q = Object.freeze(['draft', 'sent', 'in_progress']);

async function listRows(db, workspaceId, assessmentId, { forUpdate = false } = {}) {
  return await db.prepare(forUpdate
    ? `SELECT ${COLUMNS} FROM tp_contract_reviews c WHERE c.workspace_id = ? AND c.assessment_id = ? ORDER BY c.position, c.id FOR UPDATE`
    : `SELECT ${COLUMNS}, u.name AS reviewed_by_name, f.title AS finding_title, f.severity AS finding_severity
      FROM tp_contract_reviews c
      LEFT JOIN users u ON u.id = c.reviewed_by
      LEFT JOIN tp_findings f ON f.workspace_id = c.workspace_id AND f.id = c.finding_id
      WHERE c.workspace_id = ? AND c.assessment_id = ? ORDER BY c.position, c.id`).all(workspaceId, assessmentId);
}

async function modulesOf(db, actor, assessment) {
  const q = await questionnaires.getQuestionnaire(db, actor, assessment);
  if (!q) return { questionnaire: null, modules: null };
  return { questionnaire: q, modules: (q.modules || []).filter(m => m.included).map(m => m.module) };
}

async function bankFor(db, actor, assessment) {
  const q = await questionnaires.getQuestionnaire(db, actor, assessment);
  if (q) {
    const row = await db.prepare('SELECT id, version, content_sha256 FROM tp_question_bank_versions WHERE id = ?').get(q.bank_version_id);
    return { id: Number(row.id), version: Number(row.version), sha256: row.content_sha256, from: 'questionnaire' };
  }
  const latest = await questionnaires.latestBankVersion(db);
  if (!latest) throw new TprmError(409, 'No question bank version is published yet.');
  return { id: latest.id, version: latest.version, sha256: latest.content_sha256, from: 'latest' };
}

function withClause(row, clause, ws) {
  const c = clause || {};
  return {
    ...row,
    category: c.category || null,
    requirement: withClient(c.requirement, ws) || row.clause_id,
    basis: withClient(c.basis, ws) || null,
    required: c.required || null,
    note: c.note || null,
  };
}

async function reportSummary(db, ws, assessment) {
  const actor = { ws };
  const raw = await listRows(db, ws.id, assessment.id);
  if (!raw.length) return null;
  const { modules } = await modulesOf(db, actor, assessment);
  const effective = await rulebooksLib().forAssessment(db, actor, assessment);
  const c = counts(visibleRows(raw, modules, rulebooksLib().tagsOf(effective.rulebooks)));
  const clauses = Object.values(c).reduce((a, b) => a + b, 0);
  if (!clauses) return null;
  return { clauses, satisfactory: c.present_satisfactory, gaps: c.present_gap, missing: c.missing, not_required: c.not_required, not_reviewed: c.not_reviewed };
}

async function panel(db, actor, assessment) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, 'tp.view') || !access.isFirmUser(actor.user)) return null;
  const raw = await listRows(db, actor.ws.id, assessment.id);
  const { questionnaire, modules } = await modulesOf(db, actor, assessment);
  const effective = await rulebooksLib().forAssessment(db, actor, assessment);
  const tags = rulebooksLib().tagsOf(effective.rulebooks);
  const changeable = assessments.evidenceChangeable(assessment);
  const canManage = access.can(actor.user, actor.perms, 'tp.manage');
  let bank = null;
  let rows = [];
  if (raw.length) {
    const content = await questionnaires.bankContent(db, raw[0].bank_version_id);
    const byId = new Map(checklistOf(content).map(c => [c.id, c]));
    rows = raw.map(r => withClause(r, byId.get(r.clause_id), actor.ws));
    bank = { id: Number(raw[0].bank_version_id), version: Number(raw[0].bank_version) };
  }
  const visible = visibleRows(rows, modules, tags);
  return {
    started: raw.length > 0,
    rows: visible,
    hiddenCount: rows.length - visible.length,
    hidden: rows.filter(r => !visible.includes(r)).map(r => ({ clause_id: r.clause_id, module: r.conditional ? r.module : null, applies_to: r.applies_to })),
    counts: counts(visible),
    total: visible.length,
    reviewed: visible.filter(r => r.status !== 'not_reviewed').length,
    gaps: visible.filter(r => GAP_STATUSES.includes(r.status)),
    bank,
    questionnaire: questionnaire ? { status: questionnaire.status, modules } : null,
    rulebooks: { source: effective.source, names: effective.rulebooks.map(r => r.name), tags },
    changeable,
    canEdit: changeable && canManage,
    canStart: changeable && canManage && !raw.length,
    frozenMessage: changeable ? null : frozenMessage(assessment),
    findings: raw.length ? await db.prepare(`SELECT id, title, severity, status FROM tp_findings
      WHERE workspace_id = ? AND assessment_id = ? ORDER BY id`).all(actor.ws.id, assessment.id) : [],
  };
}

async function getRow(db, actor, assessment, rowId, { forUpdate = false } = {}) {
  const id = Number(rowId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const row = await db.prepare(`SELECT ${COLUMNS} FROM tp_contract_reviews c
    WHERE c.workspace_id = ? AND c.assessment_id = ? AND c.id = ?${forUpdate ? ' FOR UPDATE' : ''}`).get(actor.ws.id, assessment.id, id);
  if (!row) throw notFound();
  return row;
}

async function openForChange(db, actor, thirdPartyId, assessmentId) {
  const assessment = await assessments.getAssessment(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
  if (!assessments.evidenceChangeable(assessment)) throw new TprmError(409, frozenMessage(assessment));
  return assessment;
}

async function append(db, actor, assessment, action, before, after) {
  await events.appendEvent(db, {
    workspaceId: actor.ws.id, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id,
    actorId: actor.user.id, action, before, after,
  });
}

async function start(db, actor, thirdPartyId, assessmentId) {
  requireManage(actor);
  return await db.transaction(async () => {
    const assessment = await openForChange(db, actor, thirdPartyId, assessmentId);
    const existing = await db.prepare('SELECT COUNT(*)::integer AS c FROM tp_contract_reviews WHERE workspace_id = ? AND assessment_id = ?')
      .get(actor.ws.id, assessment.id);
    if (existing.c) throw new TprmError(409, 'The contract checklist of this assessment is already started. Reload the page to see it.');
    const bank = await bankFor(db, actor, assessment);
    const content = await questionnaires.bankContent(db, bank.id);
    const effective = await rulebooksLib().forAssessment(db, actor, assessment);
    const tags = rulebooksLib().tagsOf(effective.rulebooks);
    const clauses = clausesInScope(content, { rulebooks: tags });
    if (!clauses.length) throw new TprmError(409, `Question bank version ${bank.version} has no contract checklist.`);
    await insertClauses(db, actor, assessment, bank, content, clauses);
    await append(db, actor, assessment, 'contract_review.started', null, {
      bank_version: bank.version, bank_sha256: bank.sha256, bank_from: bank.from, clause_count: clauses.length,
      conditional_count: clauses.filter(c => c.required === CONDITIONAL).length, applies_to: [ALL_CLIENTS, ...tags],
      rulebooks: effective.rulebooks.map(r => ({ key: r.key, version: r.version })), rulebooks_from: effective.source,
    });
    return { assessment, clauseCount: clauses.length, bank };
  })();
}

const rulebooksLib = () => require('./rulebooks');

async function insertClauses(db, actor, assessment, bank, content, clauses) {
  const order = new Map(checklistOf(content).map((c, i) => [c.id, i]));
  for (const c of clauses) {
    const conditional = c.required === CONDITIONAL;
    const module = c.module && c.module !== '-' ? String(c.module) : null;
    await db.prepare(`INSERT INTO tp_contract_reviews
      (workspace_id, assessment_id, bank_version_id, bank_version, clause_id, position, applies_to, conditional, module, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(actor.ws.id, assessment.id, bank.id, bank.version, c.id, order.get(c.id), c.applies_to, conditional && !!module, module, actor.user.id);
  }
}

async function addRulebookClauses(db, actor, assessment, tags) {
  if (!tags || !tags.length || !assessments.evidenceChangeable(assessment)) return 0;
  const rows = await db.prepare('SELECT clause_id, bank_version_id, bank_version FROM tp_contract_reviews WHERE workspace_id = ? AND assessment_id = ?')
    .all(actor.ws.id, assessment.id);
  if (!rows.length) return 0;
  const bank = { id: Number(rows[0].bank_version_id), version: Number(rows[0].bank_version) };
  const content = await questionnaires.bankContent(db, bank.id);
  const have = new Set(rows.map(r => r.clause_id));
  const missing = clausesInScope(content, { rulebooks: tags }).filter(c => !have.has(c.id));
  if (!missing.length) return 0;
  await insertClauses(db, actor, assessment, bank, content, missing);
  await append(db, actor, assessment, 'contract_review.clauses_added', null, {
    bank_version: bank.version, clause_ids: missing.map(c => c.id), applies_to: tags, reason: 'Rulebooks pinned with the questionnaire',
  });
  return missing.length;
}

function parseRows(input) {
  const raw = input && input.rows && typeof input.rows === 'object' ? input.rows : {};
  const errors = [];
  const out = [];
  for (const [key, v] of Object.entries(raw)) {
    const id = /^r\d{1,15}$/.test(key) ? Number(key.slice(1)) : NaN;
    if (!Number.isSafeInteger(id) || id < 1 || !v || typeof v !== 'object') { errors.push('A checklist row is not valid. Reload the page.'); continue; }
    const status = str(v.status);
    const reference = str(v.contract_reference) || null;
    const comment = str(v.comment) || null;
    const findingRaw = str(v.finding_id);
    const findingId = findingRaw ? Number(findingRaw) : null;
    if (!STATUSES.includes(status)) errors.push('Choose a status for every clause.');
    if (reference && reference.length > LIMITS.reference) errors.push(`A contract reference must be ${LIMITS.reference} characters or fewer.`);
    if (comment && comment.length > LIMITS.comment) errors.push(`A comment must be ${LIMITS.comment} characters or fewer.`);
    if (findingRaw && (!Number.isSafeInteger(findingId) || findingId < 1)) errors.push('Choose the linked finding from the list.');
    out.push({ id, status, contract_reference: reference, comment, finding_id: findingId, row_version: Number(v.row_version) });
  }
  if (!out.length && !errors.length) errors.push('Nothing to save.');
  if (errors.length) throw invalid([...new Set(errors)]);
  return out;
}

async function save(db, actor, thirdPartyId, assessmentId, input = {}) {
  requireManage(actor);
  const values = parseRows(input);
  return await db.transaction(async () => {
    const assessment = await openForChange(db, actor, thirdPartyId, assessmentId);
    const findingIds = new Set((await db.prepare('SELECT id FROM tp_findings WHERE workspace_id = ? AND assessment_id = ?')
      .all(actor.ws.id, assessment.id)).map(r => Number(r.id)));
    const changes = [];
    for (const v of values) {
      const row = await getRow(db, actor, assessment, v.id, { forUpdate: true });
      if (!Number.isInteger(v.row_version) || v.row_version !== row.row_version) throw conflict();
      if (v.finding_id != null && !findingIds.has(v.finding_id)) {
        throw invalid(['A linked finding is not part of this assessment. Choose it from this assessment\'s findings.']);
      }
      const before = {};
      const after = {};
      for (const f of FIELDS) {
        const x = row[f] == null ? null : (f === 'finding_id' ? Number(row[f]) : row[f]);
        if (x !== v[f]) { before[f] = x; after[f] = v[f]; }
      }
      if (!Object.keys(after).length) continue;
      const reviewed = v.status !== 'not_reviewed' || row.reviewed_by != null;
      const res = await db.prepare(`UPDATE tp_contract_reviews SET status = ?, contract_reference = ?, comment = ?, finding_id = ?,
          reviewed_by = CASE WHEN ? THEN ?::bigint ELSE reviewed_by END, reviewed_at = CASE WHEN ? THEN now() ELSE reviewed_at END,
          updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ? AND row_version = ?`)
        .run(v.status, v.contract_reference, v.comment, v.finding_id, reviewed, actor.user.id, reviewed,
          actor.ws.id, row.id, row.row_version);
      if (res.changes !== 1) throw conflict();
      changes.push({ row_id: Number(row.id), clause_id: row.clause_id, before, after });
    }
    if (!changes.length) return { unchanged: true, changed: 0 };
    await append(db, actor, assessment, 'contract_review.updated', { rows: changes.map(c => ({ clause_id: c.clause_id, ...c.before })) },
      { rows: changes.map(c => ({ row_id: c.row_id, clause_id: c.clause_id, ...c.after })) });
    return { changed: changes.length };
  })();
}

async function findingDraft(db, actor, assessment, rowId) {
  requireManage(actor);
  const row = await getRow(db, actor, assessment, rowId);
  const content = await questionnaires.bankContent(db, row.bank_version_id);
  const clause = withClause(row, checklistOf(content).find(c => c.id === row.clause_id), actor.ws);
  const lines = [
    `Contract checklist ${row.clause_id} (${clause.category || 'clause'}): ${clause.requirement}`,
    `Contract review: ${STATUS_LABELS[row.status]}.`,
  ];
  if (row.contract_reference) lines.push(`Contract reference: ${row.contract_reference}`);
  if (row.comment) lines.push(`Reviewer comment: ${row.comment}`);
  const title = `Contract clause ${row.clause_id}${clause.category ? `: ${clause.category}` : ''}`;
  return {
    row: clause,
    values: {
      control_ref: CONTROL_REF,
      severity: assessment.final_tier || 'medium',
      title: title.slice(0, 200),
      description: lines.join('\n').slice(0, 4000),
      impact: '',
      evidence: [],
    },
  };
}

async function raiseFinding(db, actor, thirdPartyId, assessmentId, rowId, input = {}) {
  requireManage(actor);
  const findings = require('./findings');
  return await db.transaction(async () => {
    const assessment = await openForChange(db, actor, thirdPartyId, assessmentId);
    const row = await getRow(db, actor, assessment, rowId, { forUpdate: true });
    const rowVersion = Number(input.contract_row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== row.row_version) throw conflict();
    if (row.finding_id != null) throw new TprmError(409, 'This clause already has a linked finding. Unlink it first to raise another one.');
    const finding = await findings.addFinding(db, actor, thirdPartyId, assessmentId, input);
    const res = await db.prepare(`UPDATE tp_contract_reviews SET finding_id = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(finding.id, actor.ws.id, row.id, row.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, 'contract_review.finding_raised', { row_id: Number(row.id), clause_id: row.clause_id, finding_id: null },
      { row_id: Number(row.id), clause_id: row.clause_id, finding_id: Number(finding.id) });
    return { finding, row };
  })();
}

async function vendorScope(db, vctx) {
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(vctx.workspaceId);
  const assessment = await db.prepare(`SELECT id, workspace_id, third_party_id, status, lead_consultant_id, created_by
    FROM tp_assessments WHERE workspace_id = ? AND id = ?`).get(vctx.workspaceId, vctx.assessmentId);
  const q = await db.prepare(`SELECT id, status, bank_version_id, bank_version, modules FROM tp_questionnaires
    WHERE workspace_id = ? AND assessment_id = ?`).get(vctx.workspaceId, vctx.assessmentId);
  if (!ws || !assessment || !q) return null;
  const actor = { ws };
  const effective = await rulebooksLib().forAssessment(db, actor, assessment);
  const tags = rulebooksLib().tagsOf(effective.rulebooks);
  const modules = (Array.isArray(q.modules) ? q.modules : []).filter(m => m.included).map(m => m.module);
  return { ws, assessment, q, tags, modules };
}

async function ensureForVendor(db, vctx) {
  const scope = await vendorScope(db, vctx);
  if (!scope) return null;
  const { ws, assessment, q, tags } = scope;
  const have = await db.prepare('SELECT COUNT(*)::integer AS c FROM tp_contract_reviews WHERE workspace_id = ? AND assessment_id = ?').get(ws.id, assessment.id);
  if (have.c || !assessments.evidenceChangeable(assessment) || !VENDOR_OPEN_Q.includes(q.status)) return scope;
  const content = await questionnaires.bankContent(db, q.bank_version_id);
  const clauses = clausesInScope(content, { rulebooks: tags });
  if (!clauses.length) return scope;
  const owner = Number(assessment.lead_consultant_id || assessment.created_by);
  await db.transaction(async () => {
    const again = await db.prepare('SELECT COUNT(*)::integer AS c FROM tp_contract_reviews WHERE workspace_id = ? AND assessment_id = ?').get(ws.id, assessment.id);
    if (again.c) return;
    const bank = { id: Number(q.bank_version_id), version: Number(q.bank_version) };
    await insertClauses(db, { ws, user: { id: owner } }, assessment, bank, content, clauses);
    await events.appendEvent(db, { workspaceId: ws.id, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id, actorId: null,
      action: 'contract_review.vendor_started', before: null, after: { bank_version: bank.version, bank_from: 'questionnaire', clause_count: clauses.length, by: 'third_party' } });
  })();
  return scope;
}

function vendorRow(r, clause, ws) {
  const c = withClause(r, clause, ws);
  return { clause_id: c.clause_id, category: c.category, requirement: c.requirement,
    vendor_status: r.vendor_status || null, vendor_reference: r.vendor_reference || null, vendor_saved_at: r.vendor_saved_at || null };
}

async function vendorPage(db, vctx) {
  const scope = await vendorScope(db, vctx);
  if (!scope) return null;
  const { ws, assessment, q, tags, modules } = scope;
  const raw = await listRows(db, ws.id, assessment.id);
  let rows;
  if (raw.length) {
    const content = await questionnaires.bankContent(db, raw[0].bank_version_id);
    const byId = new Map(checklistOf(content).map(c => [c.id, c]));
    rows = visibleRows(raw, modules, tags).map(r => vendorRow(r, byId.get(r.clause_id), ws));
  } else {
    const content = await questionnaires.bankContent(db, q.bank_version_id);
    const draft = clausesInScope(content, { rulebooks: tags }).map(c => ({
      clause_id: c.id, applies_to: c.applies_to, status: 'not_reviewed',
      conditional: c.required === CONDITIONAL && !!(c.module && c.module !== '-'), module: c.module && c.module !== '-' ? String(c.module) : null,
    }));
    const byId = new Map(checklistOf(content).map(c => [c.id, c]));
    rows = visibleRows(draft, modules, tags).map(r => vendorRow(r, byId.get(r.clause_id), ws));
  }
  const open = assessments.evidenceChangeable(assessment) && VENDOR_OPEN_Q.includes(q.status) && !vctx.assessmentClosed;
  return { rows, open, answered: rows.filter(r => r.vendor_status).length, total: rows.length };
}

async function vendorSave(db, vctx, input = {}, { person = null } = {}) {
  const page = await vendorPage(db, vctx);
  if (!page) throw notFound();
  if (!page.open) throw new TprmError(409, 'The questionnaire has been sent, so the contract clauses can no longer be changed.');
  const raw = input.rows && typeof input.rows === 'object' ? input.rows : {};
  const allowed = new Map(page.rows.map(r => [r.clause_id, r]));
  const errors = [];
  const values = [];
  for (const [id, v] of Object.entries(raw)) {
    const row = allowed.get(String(id));
    if (!row || !v || typeof v !== 'object') continue;
    const status = str(v.status);
    const reference = str(v.reference);
    if (status && !VENDOR_STATUSES.includes(status)) { errors.push(`Choose one of the answers for ${row.clause_id}.`); continue; }
    if (reference.length > LIMITS.reference) errors.push(`The clause reference for ${row.clause_id} must be ${LIMITS.reference} characters or fewer.`);
    if ((row.vendor_status || null) === (status || null) && (row.vendor_reference || null) === (reference || null)) continue;
    values.push({ clauseId: row.clause_id, status: status || null, reference: reference || null });
  }
  if (errors.length) throw invalid(errors);
  if (!values.length) return { changed: 0 };
  await ensureForVendor(db, vctx);
  await db.transaction(async () => {
    for (const v of values) {
      await db.prepare(`UPDATE tp_contract_reviews SET vendor_status = ?, vendor_reference = ?, vendor_saved_at = now(), vendor_request_id = ?,
          vendor_person_id = ?, updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND assessment_id = ? AND clause_id = ?`)
        .run(v.status, v.reference, vctx.requestId || null, person ? person.id : null, vctx.workspaceId, vctx.assessmentId, v.clauseId);
    }
    await events.appendEvent(db, { workspaceId: vctx.workspaceId, thirdPartyId: vctx.thirdPartyId, assessmentId: vctx.assessmentId, actorId: null,
      action: 'contract_review.vendor_saved', before: null, after: { changed: values.length, by: 'third_party', ...(person ? { by_person_id: person.id, by_name: person.name } : {}) } });
  })();
  return { changed: values.length };
}

async function clientRows(db, ws, assessmentId) {
  const raw = await listRows(db, ws.id, assessmentId);
  if (!raw.length || !raw.some(r => r.vendor_saved_at)) return null;
  const content = await questionnaires.bankContent(db, raw[0].bank_version_id);
  const byId = new Map(checklistOf(content).map(c => [c.id, c]));
  const rows = raw.filter(r => r.status !== 'not_reviewed').map(r => {
    const c = withClause(r, byId.get(r.clause_id), ws);
    return { clause_id: r.clause_id, category: c.category, requirement: c.requirement, status: r.status, label: CLIENT_LABELS[r.status] || r.status,
      reference: r.contract_reference || null };
  });
  const tally = s => rows.filter(r => r.status === s).length;
  return { rows, inContract: tally('present_satisfactory'), weak: tally('present_gap'), missing: tally('missing'),
    notRequired: tally('not_required'), notChecked: raw.filter(r => r.status === 'not_reviewed' && r.vendor_status).length };
}

module.exports = {
  VENDOR_STATUSES, VENDOR_STATUS_LABELS, SUGGESTED_STATUS, CLIENT_LABELS, ensureForVendor, vendorPage, vendorSave, clientRows,
  STATUSES, STATUS_LABELS, GAP_STATUSES, ALL_CLIENTS, LIMITS, CONTROL_REF, EVENT_LABELS,
  checklistOf, clausesInScope, isVisible, visibleRows, counts, frozenMessage, reportSummary,
  panel, getRow, start, save, findingDraft, raiseFinding, addRulebookClauses,
};
