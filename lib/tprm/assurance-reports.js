'use strict';

const access = require('./access');
const questionnaires = require('./questionnaires');
const rules = require('./answer-rules');
const { TprmError } = require('./errors');

const LIMITS = Object.freeze({ reason: 2000, exceptions: 400 });
const QUESTION_ID = /^[A-Z]{2,6}-[0-9]{1,4}$/;
const EVENT_LABELS = Object.freeze({
  'assurance_report.accepted': 'Assurance report accepted',
  'assurance_report.rejected': 'Assurance report rejected',
  'evidence_waiver.added': 'Evidence waived on a further question (SOC 2)',
  'evidence_waiver.withdrawn': 'Extra evidence waiver withdrawn',
});
const REQUEST_TEXT = Object.freeze({
  report_rejected: kind => `We could not rely on your ${rules.KIND_LABELS[kind]} for this question, so we need evidence for it after all. `
    + 'Please attach a file, or tell us which document shows it (name, version and date).',
  report_exception: () => 'Your SOC 2 report notes an exception that affects this question, so we need evidence for it after all. '
    + 'Please attach a file, or tell us which document shows it (name, version and date).',
});

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const ticked = value => ['1', 'on', 'true', 'yes'].includes(str(value).toLowerCase());
const invalid = errors => new TprmError(400, errors.join(' '), { errors });
const notFound = () => new TprmError(404, 'This report does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed this after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.');

function requireManage(actor) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, 'tp.manage')) {
    throw new TprmError(403, 'Your role does not allow checking the third party\'s reports.');
  }
}

async function loadReports(db, workspaceId, questionnaireId, { forUpdate = false } = {}) {
  const rows = await db.prepare(`SELECT r.id, r.kind, r.evidence_id, r.soa_evidence_id, r.bridge_evidence_id,
      to_char(r.certificate_expires_on, 'YYYY-MM-DD') AS certificate_expires_on, r.scope, to_char(r.period_end, 'YYYY-MM-DD') AS period_end,
      r.uploaded_at, r.check_status, r.check_in_date, r.check_scope, r.check_opinion, r.check_period, r.check_reason,
      r.exception_question_ids, r.checked_by, r.checked_at, r.row_version
    FROM tp_assurance_reports r WHERE r.workspace_id = ? AND r.questionnaire_id = ? ORDER BY r.kind${forUpdate ? ' FOR UPDATE' : ''}`)
    .all(workspaceId, questionnaireId);
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap(r => [r.evidence_id, r.soa_evidence_id, r.bridge_evidence_id]).filter(Boolean).map(Number))];
  const files = new Map((await db.prepare(`SELECT id, original_name, size_bytes FROM tp_evidence WHERE workspace_id = ?
    AND id IN (${ids.map(() => '?').join(',')})`).all(workspaceId, ...ids)).map(f => [Number(f.id), { id: Number(f.id), name: f.original_name, size: Number(f.size_bytes) }]));
  const file = id => (id ? files.get(Number(id)) || null : null);
  return rows.map(r => ({
    ...r,
    id: Number(r.id),
    exception_question_ids: Array.isArray(r.exception_question_ids) ? r.exception_question_ids : [],
    file: file(r.evidence_id),
    soaFile: file(r.soa_evidence_id),
    bridgeFile: file(r.bridge_evidence_id),
  }));
}

async function evidenceContext(db, workspaceId, questionnaire, bank) {
  const answers = new Map((await db.prepare(`SELECT id, question_id, response, detail, evidence_ref FROM tp_answers
    WHERE workspace_id = ? AND questionnaire_id = ?`).all(workspaceId, questionnaire.id)).map(a => [a.question_id, a]));
  const files = new Map();
  for (const l of await db.prepare(`SELECT a.question_id, l.evidence_id FROM tp_answer_evidence l
      JOIN tp_answers a ON a.workspace_id = l.workspace_id AND a.id = l.answer_id
      WHERE l.workspace_id = ? AND a.questionnaire_id = ?`).all(workspaceId, questionnaire.id)) {
    if (!files.has(l.question_id)) files.set(l.question_id, []);
    files.get(l.question_id).push(Number(l.evidence_id));
  }
  const clarifications = await db.prepare(`SELECT id, question_id, status, responded_at, raised_for FROM tp_clarifications
    WHERE workspace_id = ? AND questionnaire_id = ?`).all(workspaceId, questionnaire.id);
  const requests = require('./vendor-answers').requestMap(clarifications);
  const rulesOf = new Map(bank.questions.map(row => [row.id, rules.questionRules(row)]));
  const ids = (questionnaire.sections || []).flatMap(s => s.ids);
  return { answers, files, requests, rulesOf, ids, byId: new Map(bank.questions.map(r => [r.id, r])) };
}

function statesFor(ec, reports) {
  const out = new Map();
  for (const id of ec.ids) {
    const r = ec.rulesOf.get(id) || rules.questionRules({});
    out.set(id, require('./vendor-answers').stateOf(r, id, ec.answers.get(id) || null, ec.files, reports,
      { requests: ec.requests }));
  }
  return out;
}

async function panelData(db, actor, assessment, questionnaire, bank, { canReview = false } = {}) {
  if (!rules.bankTyped(bank)) return null;
  const reports = await loadReports(db, actor.ws.id, questionnaire.id);
  const ids = (questionnaire.sections || []).flatMap(s => s.ids);
  const byId = new Map(bank.questions.map(r => [r.id, r]));
  const rows = ids.map(id => byId.get(id)).filter(Boolean);
  const names = new Map((await db.prepare(`SELECT id, name FROM users WHERE id IN (SELECT checked_by FROM tp_assurance_reports
    WHERE workspace_id = ? AND questionnaire_id = ? AND checked_by IS NOT NULL)`).all(actor.ws.id, questionnaire.id)).map(u => [Number(u.id), u.name]));
  const now = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return {
    reports: reports.map(r => ({
      ...r,
      label: rules.KIND_LABELS[r.kind],
      covers: rules.wouldCover(rows, r.kind),
      checkedByName: r.checked_by ? names.get(Number(r.checked_by)) || 'Unknown user' : null,
      hints: {
        inDate: r.kind === 'iso27001' ? r.certificate_expires_on >= now : null,
        periodRecent: r.kind === 'soc2_type2' ? r.period_end >= yearAgo : null,
        bridge: !!r.bridgeFile,
      },
    })),
    canCheck: canReview,
    unchecked: reports.filter(r => r.check_status === 'pending').length,
    limits: LIMITS,
    kindLabels: rules.KIND_LABELS,
  };
}

function parseExceptions(raw, allowed) {
  const items = (Array.isArray(raw) ? raw.join(',') : str(raw)).toUpperCase().split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  const errors = [];
  for (const id of items) {
    if (!QUESTION_ID.test(id) || !allowed.has(id)) errors.push(`${id.slice(0, 20)} is not a question of this questionnaire.`);
    else if (!out.includes(id)) out.push(id);
  }
  if (out.length > LIMITS.exceptions) errors.push(`List at most ${LIMITS.exceptions} questions.`);
  return { ids: out, errors };
}

async function raiseRequests(db, actor, assessment, questionnaire, ec, before, after, report, raisedFor) {
  const raised = [];
  for (const id of ec.ids) {
    const was = before.get(id);
    const now = after.get(id);
    if (!was || !now || !rules.isWaived(was.key) || now.key !== 'missing') continue;
    if (!was.covered.includes(report.kind)) continue;
    const body = REQUEST_TEXT[raisedFor](report.kind);
    const row = await db.prepare(`INSERT INTO tp_clarifications (workspace_id, assessment_id, questionnaire_id, question_id, body, asked_by,
        raised_for, report_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(actor.ws.id, assessment.id, questionnaire.id, id, body, actor.user.id, raisedFor, report.id);
    await questionnaires.append(db, actor, assessment, 'clarification.asked', null, {
      clarification_id: Number(row.id), question_id: id, questionnaire_id: Number(questionnaire.id), body,
      raised_for: raisedFor, report_id: Number(report.id),
    });
    raised.push(id);
  }
  if (raised.length) {
    await db.prepare('UPDATE tp_questionnaires SET updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?')
      .run(actor.ws.id, questionnaire.id);
  }
  return raised;
}

async function needsLink(db, actor, questionnaire) {
  const active = await db.prepare(`SELECT id FROM tp_vendor_requests WHERE workspace_id = ? AND questionnaire_id = ? AND status = 'active'
    AND expires_at > now() LIMIT 1`).get(actor.ws.id, questionnaire.id);
  return !active;
}

async function checkReport(db, actor, thirdPartyId, assessmentId, reportId, input = {}) {
  requireManage(actor);
  const review = require('./questionnaire-review');
  const id = Number(reportId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const decision = str(input.decision);
  const reason = str(input.reason);
  const checks = { in_date: ticked(input.in_date), scope: ticked(input.scope), opinion: ticked(input.opinion), period: ticked(input.period) };
  const errors = [];
  if (!['accept', 'reject'].includes(decision)) errors.push('Choose whether to accept or reject the report.');
  if (!reason) errors.push('Give the reason for your decision.');
  else if (reason.length > LIMITS.reason) errors.push(`The reason must be ${LIMITS.reason} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await review.loadForReview(db, actor, thirdPartyId, assessmentId);
    const bank = await questionnaires.bankContent(db, questionnaire.bank_version_id);
    const reports = await loadReports(db, actor.ws.id, questionnaire.id, { forUpdate: true });
    const report = reports.find(r => r.id === id);
    if (!report) throw notFound();
    questionnaires.checkVersion(report, input);
    if (report.check_status !== 'pending') throw new TprmError(409, `This ${rules.KIND_LABELS[report.kind]} has already been checked.`);
    const iso = report.kind === 'iso27001';
    const ec = await evidenceContext(db, actor.ws.id, questionnaire, bank);
    const exc = parseExceptions(input.exceptions, new Set(ec.ids));
    const problems = [];
    if (decision === 'accept') {
      const failed = [
        !checks.in_date && (iso ? 'the certificate is in date' : 'the report is in date'),
        !checks.scope && 'its scope covers this service',
        !iso && !checks.opinion && 'the auditor\'s opinion is unqualified',
        !iso && !checks.period && 'the period ended within the last 12 months, or a bridge letter covers the gap',
      ].filter(Boolean);
      if (failed.length) problems.push(`To accept the report, confirm every check: ${failed.join('; ')}. Otherwise reject it.`);
      if (iso && exc.ids.length) problems.push('Exceptions are listed for a SOC 2 report only.');
      problems.push(...exc.errors);
    } else if (exc.ids.length || exc.errors.length) {
      problems.push('A rejected report covers nothing, so it has no exceptions to list.');
    }
    if (problems.length) throw invalid(problems);
    const before = statesFor(ec, reports);
    const status = decision === 'accept' ? 'accepted' : 'rejected';
    const exceptions = decision === 'accept' && !iso ? exc.ids : [];
    const res = await db.prepare(`UPDATE tp_assurance_reports SET check_status = ?, check_in_date = ?, check_scope = ?, check_opinion = ?,
        check_period = ?, check_reason = ?, exception_question_ids = ?::jsonb, checked_by = ?, checked_at = now(), updated_at = now(),
        row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(status, checks.in_date, checks.scope, iso ? null : checks.opinion, iso ? null : checks.period, reason, JSON.stringify(exceptions),
        actor.user.id, actor.ws.id, report.id, report.row_version);
    if (res.changes !== 1) throw conflict();
    await review.startReview(db, actor, assessment, questionnaire);
    const updated = reports.map(r => (r.id === report.id ? { ...r, check_status: status, exception_question_ids: exceptions } : r));
    const after = statesFor(ec, updated);
    await questionnaires.append(db, actor, assessment, `assurance_report.${status}`,
      { report_id: report.id, kind: report.kind, check_status: 'pending' },
      { report_id: report.id, kind: report.kind, check_status: status, reason, checks: iso ? { in_date: checks.in_date, scope: checks.scope } : checks,
        exception_question_ids: exceptions, questionnaire_id: Number(questionnaire.id) });
    const raised = await raiseRequests(db, actor, assessment, questionnaire, ec, before, after, report,
      status === 'rejected' ? 'report_rejected' : 'report_exception');
    return { report: { ...report, check_status: status }, status, raised, needsLink: raised.length ? await needsLink(db, actor, questionnaire) : false };
  })();
}

module.exports = {
  LIMITS, EVENT_LABELS, REQUEST_TEXT,
  loadReports, evidenceContext, statesFor, panelData, checkReport,
};
