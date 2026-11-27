'use strict';

const access = require('./access');
const assessments = require('./assessments');
const questionnaires = require('./questionnaires');
const vendorAnswers = require('./vendor-answers');
const answerRules = require('./answer-rules');
const { TprmError } = require('./errors');

const CONCLUSIONS = Object.freeze(['not_reviewed', 'satisfactory', 'partially_satisfactory', 'unsatisfactory']);
const CONCLUSION_LABELS = Object.freeze({
  not_reviewed: 'Not reviewed',
  satisfactory: 'Satisfactory',
  partially_satisfactory: 'Partially satisfactory',
  unsatisfactory: 'Unsatisfactory',
});
const CLARIFICATION_STATUS_LABELS = Object.freeze({ open: 'Waiting for the third party', answered: 'Answered', closed: 'Closed' });
const REVIEWABLE = Object.freeze(['submitted', 'under_review']);
const FILTERS = Object.freeze(['unexpected', 'ai', 'all', 'not_reviewed']);
const FILTER_LABELS = Object.freeze({ unexpected: 'Needs judgement', ai: 'Brevis to decide', all: 'All answers', not_reviewed: 'Not reviewed yet' });
const TYPED_FILTER_LABELS = Object.freeze({ ...FILTER_LABELS });
const REASON_LABELS = Object.freeze({
  no: 'Answered No', na: 'Not applicable', partial: 'Answered Partially', text: 'Written answer', value: 'An answer to read', none: 'Not answered',
  evidence_missing: 'Evidence missing', evidence_requested: 'Evidence asked for again', clarification: 'Clarification not closed',
  ai: 'Brevis suggests', details: 'Yes with details to read',
});
const BULK_CONCLUSION = 'satisfactory';
const RESPONSE_ORDER = Object.freeze({ no: 0, partial: 1, na: 2, text: 3, value: 3, yes: 4 });
const UNEXPECTED = Object.freeze(['no', 'partial', 'na']);
const TYPED_UNEXPECTED = Object.freeze(['no', 'na', 'text', 'value']);
const REVIEWED_REASON = 'Reviewed';
const LIMITS = Object.freeze({ comment: 2000, clarification: 2000, note: 1000 });

const changedSince = () => new TprmError(409,
  'The plain answers changed since the page was loaded (someone reviewed one, or a clarification was asked). Nothing was saved: reload the page and accept again.');
const notFound = () => new TprmError(404, 'This answer does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed this after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });
const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();

function requireManage(actor) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, 'tp.manage')) {
    throw new TprmError(403, 'Your role does not allow reviewing the third party\'s answers.');
  }
}

function reviewBlocked(assessment, questionnaire) {
  if (!questionnaire) return 'The questionnaire has not been prepared yet.';
  if (!REVIEWABLE.includes(questionnaire.status)) {
    return questionnaire.status === 'closed' ? 'The review of the answers is closed.' : 'The third party has not submitted its answers yet.';
  }
  return questionnaires.blockedMessage(assessment);
}

async function loadAnswerRows(db, workspaceId, questionnaireId) {
  return await db.prepare(`SELECT a.id, a.question_id, a.response, a.detail, a.fields, a.evidence_ref,
      to_char(a.evidence_date, 'YYYY-MM-DD') AS evidence_date, a.saved_at, a.prefilled_from_answer_id, a.prefill_confirmed_at,
      a.submitted_at, a.review_conclusion, a.review_comment, a.reviewed_by, a.reviewed_at, a.row_version, u.name AS reviewed_by_name,
      eu.name AS entered_by_firm_name
    FROM tp_answers a LEFT JOIN users u ON u.id = a.reviewed_by LEFT JOIN users eu ON eu.id = a.saved_by_user_id
    WHERE a.workspace_id = ? AND a.questionnaire_id = ?`).all(workspaceId, questionnaireId);
}

async function loadFiles(db, workspaceId, questionnaireId) {
  const rows = await db.prepare(`SELECT l.answer_id, e.id, e.original_name, e.released_to_client
    FROM tp_answer_evidence l
    JOIN tp_answers a ON a.workspace_id = l.workspace_id AND a.id = l.answer_id
    JOIN tp_evidence e ON e.workspace_id = l.workspace_id AND e.id = l.evidence_id
    WHERE l.workspace_id = ? AND a.questionnaire_id = ? ORDER BY e.id`).all(workspaceId, questionnaireId);
  const map = new Map();
  for (const r of rows) {
    const key = Number(r.answer_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: Number(r.id), original_name: r.original_name, released_to_client: r.released_to_client });
  }
  return map;
}

async function loadClarifications(db, workspaceId, questionnaireId) {
  return await db.prepare(`SELECT c.id, c.question_id, c.body, c.asked_by, c.asked_at, c.response, c.response_evidence_id,
      c.responded_at, c.status, c.closed_by, c.closed_at, c.close_note, c.row_version, c.raised_for, c.report_id,
      au.name AS asked_by_name, cu.name AS closed_by_name, e.original_name AS response_file_name
    FROM tp_clarifications c
    LEFT JOIN users au ON au.id = c.asked_by
    LEFT JOIN users cu ON cu.id = c.closed_by
    LEFT JOIN tp_evidence e ON e.workspace_id = c.workspace_id AND e.id = c.response_evidence_id
    WHERE c.workspace_id = ? AND c.questionnaire_id = ? ORDER BY c.asked_at, c.id`).all(workspaceId, questionnaireId);
}

async function closeBlockers(db, workspaceId, questionnaireId) {
  const row = await db.prepare(`SELECT
      (SELECT COUNT(*)::int FROM tp_answers WHERE workspace_id = ? AND questionnaire_id = ? AND review_conclusion = 'not_reviewed' AND response IS NOT NULL) AS unreviewed,
      (SELECT COUNT(*)::int FROM tp_clarifications WHERE workspace_id = ? AND questionnaire_id = ? AND status <> 'closed') AS unclosed,
      (SELECT COUNT(*)::int FROM tp_assurance_reports WHERE workspace_id = ? AND questionnaire_id = ? AND check_status = 'pending') AS unchecked,
      (SELECT COUNT(*)::int FROM tp_clarification_drafts WHERE workspace_id = ? AND questionnaire_id = ?) AS unsent`)
    .get(workspaceId, questionnaireId, workspaceId, questionnaireId, workspaceId, questionnaireId, workspaceId, questionnaireId);
  return { unreviewed: row.unreviewed, unclosed: row.unclosed, unchecked: row.unchecked, unsent: row.unsent };
}

async function classify(db, actor, assessment, questionnaire, bank) {
  const byId = new Map(bank.questions.map(r => [r.id, r]));
  const sectionOf = new Map();
  const allAnswers = await loadAnswerRows(db, actor.ws.id, questionnaire.id);
  const byQ = new Map(allAnswers.map(a => [a.question_id, a]));
  const asked = require('./questionnaire-assembly').askedIds(questionnaire, id => { const a = byQ.get(id); return a && a.response ? { response: a.response, fields: a.fields || null } : null; });
  (questionnaire.sections || []).forEach((sec, index) => asked[index].forEach((id, pos) => sectionOf.set(id, { index, title: sec.title, pos })));
  const clientName = actor.ws.brand_display_name || actor.ws.client_name;
  const typed = answerRules.bankTyped(bank);
  const answers = allAnswers.filter(a => sectionOf.has(a.question_id) && a.response);
  const files = await loadFiles(db, actor.ws.id, questionnaire.id);
  const clarifications = await loadClarifications(db, actor.ws.id, questionnaire.id);
  const drafts = await db.prepare(`SELECT d.id, d.question_id, d.body, d.created_at, u.name AS created_by_name FROM tp_clarification_drafts d
    LEFT JOIN users u ON u.id = d.created_by WHERE d.workspace_id = ? AND d.questionnaire_id = ? ORDER BY d.id`).all(actor.ws.id, questionnaire.id);
  const comments = await vendorAnswers.commentsOf(db, actor.ws.id, questionnaire.id);
  const reports = typed ? await require('./assurance-reports').loadReports(db, actor.ws.id, questionnaire.id) : [];
  const requests = vendorAnswers.requestMap(clarifications);
  const pendingAi = await require('./ai-review').pendingConclusions(db, actor.ws.id, assessment.id);
  const aiItems = access.isFirmUser(actor.user) ? await require('./ai-review').suggestionsByAnswer(db, actor.ws.id, assessment.id) : new Map();
  const inUse = a => answerRules.evidenceApplies(answerRules.questionRules(byId.get(a.question_id) || {}), a.response);
  const byQuestionFiles = new Map(answers.map(a => [a.question_id, inUse(a) ? files.get(Number(a.id)) || [] : []]));
  const rows = answers.map(a => {
    const q = byId.get(a.question_id) || {};
    const rules = answerRules.questionRules(q);
    const state = vendorAnswers.stateOf(rules, a.question_id, a, byQuestionFiles, reports, { requests });
    const sec = sectionOf.get(a.question_id);
    const mine = clarifications.filter(c => c.question_id === a.question_id);
    const aiSuggestion = pendingAi.get(Number(a.id)) || null;
    const reasons = [];
    if (a.response !== 'yes') reasons.push(['no', 'na', 'partial', 'text', 'value'].includes(a.response) ? a.response : 'none');
    if (typed && state.key === 'missing') reasons.push('evidence_missing');
    if (typed && state.key === 'requested') reasons.push('evidence_requested');
    if (mine.some(c => c.status !== 'closed') || drafts.some(d => d.question_id === a.question_id)) reasons.push('clarification');
    const aiList = aiItems.get(Number(a.id)) || [];
    const aiPending = aiList.filter(x => x.status === 'pending').length;
    if ((aiSuggestion && aiSuggestion.conclusion !== BULK_CONCLUSION) || aiList.some(x => x.status === 'pending' && x.kind !== 'conclusion')) reasons.push('ai');
    if (a.response === 'yes' && rules.typed && (rules.fieldsOn === 'yes' || rules.detailsOnYes)) reasons.push('details');
    return {
      ...a,
      question: clientText(q.question, clientName),
      theme: clientText(q.theme, clientName),
      domain: q.set === 'Base' ? q.domain : q.pack,
      iso27001: q.iso27001 || '',
      evidenceRequired: !!q.evidence_mandatory,
      rules,
      benchmark: rules.benchmark,
      guidance: q.guidance ? clientText(q.guidance, clientName) : null,
      answerText: a.response === 'text' || a.response === 'value' ? a.detail : null,
      evidenceState: state,
      files: byQuestionFiles.get(a.question_id) || [],
      clarifications: mine,
      drafts: drafts.filter(d => d.question_id === a.question_id),
      comments: comments.get(a.question_id) || [],
      aiSuggestion,
      aiList,
      aiPending,
      sectionIndex: sec.index,
      sectionTitle: sec.title,
      position: sec.pos,
      reasons,
      plain: reasons.length === 0,
    };
  }).sort((x, y) => x.sectionIndex - y.sectionIndex || x.position - y.position);
  if (actor.ws.firm_id && access.isFirmUser(actor.user)) {
    const guides = await require('./marking-guides').forFirm(db, actor.ws.firm_id, rows.map(r => r.question_id));
    const meta = typeof questionnaire.template === 'string' ? JSON.parse(questionnaire.template) : questionnaire.template;
    for (const r of rows) {
      const own = byId.get(r.question_id) || {};
      const fromTemplate = own.set === require('./q-templates').SET_NAME;
      r.guide = (!fromTemplate && guides.get(r.question_id)) || require('./marking-guides').fromQuestion(own) || null;
      r.guideHref = fromTemplate ? (meta ? `/tprm/settings/questionnaires/${Number(meta.template_id)}/questions/${encodeURIComponent(r.question_id)}` : null)
        : `/tprm/settings/question-bank/questions/${encodeURIComponent(r.question_id)}#reviewers`;
    }
  }
  let aiRunAt = null;
  if (access.isFirmUser(actor.user)) {
    const today = require('../dates').todayFor(actor.ws);
    const checks = await require('./document-checks').forRows(db, actor.ws.id, rows, { bankById: byId, reports, today });
    const aiReview = require('./ai-review');
    const marks = await aiReview.aiMarks(db, actor.ws.id, assessment.id);
    const reads = await aiReview.documentReads(db, actor.ws.id, assessment.id);
    aiRunAt = marks.runAt;
    for (const r of rows) {
      r.aiMark = marks.byAnswer.get(Number(r.id)) || null;
      for (const f of (r.files || [])) {
        f.checks = checks.get(Number(f.id)) || [];
        const read = reads.byEvidence.get(Number(f.id));
        if (read) f.checks = [...f.checks, ...require('./document-checks').fromAiReading(read, today)];
      }
    }
  }
  return { rows, clarifications, aiRunAt };
}

function summariseMarks(rows, runAt) {
  const checks = { answers_question: 0, partly_answers: 0, does_not_answer: 0 };
  const conclusions = { satisfactory: 0, partially_satisfactory: 0, unsatisfactory: 0 };
  let marked = 0;
  for (const r of rows) {
    if (!r.aiMark) continue;
    marked += 1;
    if (r.aiMark.answerCheck) checks[r.aiMark.answerCheck] += 1;
    conclusions[r.aiMark.conclusion] += 1;
  }
  const evidenceMissing = rows.filter(r => r.evidenceState && r.evidenceState.key === 'missing').length;
  return { runAt, marked, total: rows.length, checks, conclusions, evidenceMissing };
}

const KEEP = Object.freeze({ all: () => true, unexpected: r => !r.plain, ai: r => r.aiPending > 0, not_reviewed: r => r.review_conclusion === 'not_reviewed' });
const countFilters = rows => Object.fromEntries(FILTERS.map(f => [f, rows.filter(KEEP[f]).length]));

async function filterCounts(db, actor, thirdPartyId, assessmentId) {
  const tp = await require('./register').getThirdParty(db, actor, thirdPartyId);
  const assessment = await assessments.getAssessment(db, actor, tp.id, assessmentId);
  const questionnaire = await questionnaires.getQuestionnaire(db, actor, assessment);
  if (!questionnaire) throw notFound();
  const { rows } = await classify(db, actor, assessment, questionnaire, await questionnaires.bankFor(db, questionnaire));
  return countFilters(rows);
}

async function reviewData(db, actor, assessment, questionnaire, bank, { filter = null, raise = null } = {}) {
  const status = questionnaire.status;
  const answers = await loadAnswerRows(db, actor.ws.id, questionnaire.id);
  const ids = require('./questionnaire-assembly').askedIds(questionnaire, id => { const a = answers.find(x => x.question_id === id); return a && a.response ? { response: a.response, fields: a.fields || null } : null; }).flat();
  const answered = answers.filter(a => a.response && ids.includes(a.question_id)).length;
  const canManage = access.can(actor.user, actor.perms, 'tp.manage');
  const ai = (questionnaire.modules || []).find(m => m.module === vendorAnswers.AI_MODULE) || null;
  const typed = answerRules.bankTyped(bank);
  const base = {
    typed,
    status,
    total: ids.length,
    answered,
    submitted: ['submitted', 'under_review', 'closed'].includes(status) && !!questionnaire.submitted_at,
    aiFlag: ai && ai.flag ? ai.flag : null,
    conclusions: CONCLUSIONS,
    conclusionLabels: CONCLUSION_LABELS,
    responseLabels: vendorAnswers.RESPONSE_LABELS,
    clarificationStatusLabels: CLARIFICATION_STATUS_LABELS,
    filters: FILTERS,
    filterLabels: typed ? TYPED_FILTER_LABELS : FILTER_LABELS,
    limits: LIMITS,
    states: answerRules.STATES,
  };
  if (!base.submitted) return base;
  const chosen = FILTERS.includes(filter) ? filter : 'unexpected';
  const blockedReview = reviewBlocked(assessment, questionnaire);
  const canReview = canManage && !blockedReview;
  const reportPanel = await require('./assurance-reports').panelData(db, actor, assessment, questionnaire, bank, { canReview });
  const { rows, clarifications, aiRunAt } = await classify(db, actor, assessment, questionnaire, bank);
  const aiSummary = aiRunAt ? summariseMarks(rows, aiRunAt) : null;
  const shown = rows.filter(KEEP[chosen]);
  const filterCounts = countFilters(rows);
  const shownIds = new Set(shown.map(r => r.id));
  const toAccept = r => r.plain && r.review_conclusion === 'not_reviewed';
  const sections = (questionnaire.sections || []).map((sec, index) => {
    const mine = rows.filter(r => r.sectionIndex === index);
    return {
      index, title: sec.title, total: mine.length,
      rows: mine.filter(r => shownIds.has(r.id)),
      hiddenPlain: mine.filter(r => r.plain && !shownIds.has(r.id)).length,
      acceptIds: mine.filter(toAccept).map(r => Number(r.id)),
    };
  }).filter(sec => sec.total);
  const counts = { yes: 0, partial: 0, no: 0, na: 0, text: 0, value: 0 };
  for (const r of rows) if (counts[r.response] != null) counts[r.response] += 1;
  const evidenceCounts = {};
  for (const r of rows) evidenceCounts[r.evidenceState.key] = (evidenceCounts[r.evidenceState.key] || 0) + 1;
  const blockers = await closeBlockers(db, actor.ws.id, questionnaire.id);
  const canRaiseFinding = canManage && assessments.evidenceChangeable(assessment);
  const raiseId = Number(raise);
  let findingForm = null;
  if (canRaiseFinding && Number.isSafeInteger(raiseId) && rows.some(r => Number(r.id) === raiseId)) {
    const findingsLib = require('./findings');
    findingForm = { answerId: raiseId, values: await findingDraft(db, actor, assessment, raiseId),
      severities: findingsLib.SEVERITIES, severityLabels: findingsLib.SEVERITY_LABELS, limits: findingsLib.LIMITS };
  }
  return {
    ...base,
    findingForm,
    reportPanel,
    evidenceCounts,
    filter: chosen,
    filterCounts,
    rows: shown,
    sections,
    allCount: rows.length,
    plainCount: rows.filter(r => r.plain).length,
    hiddenPlain: rows.filter(r => r.plain && !shownIds.has(r.id)).length,
    acceptIds: rows.filter(toAccept).map(r => Number(r.id)),
    reasonLabels: REASON_LABELS,
    aiSummary,
    answerCheckLabels: require('./ai-review').ANSWER_CHECK_LABELS,
    counts,
    clarifications,
    openClarifications: clarifications.filter(c => c.status === 'open').length,
    blockers,
    reviewBlocked: blockedReview,
    canReview,
    canClose: canManage && REVIEWABLE.includes(status) && assessment.status !== 'cancelled',
    canRaiseFinding,
  };
}

async function reviewState(db, actor, questionnaireId) {
  const q = await db.prepare('SELECT id, status, row_version FROM tp_questionnaires WHERE workspace_id = ? AND id = ?').get(actor.ws.id, questionnaireId);
  if (!q) throw notFound();
  return { questionnaire: { id: Number(q.id), status: q.status, row_version: Number(q.row_version) }, blockers: await closeBlockers(db, actor.ws.id, q.id) };
}

async function acceptPlain(db, actor, thirdPartyId, assessmentId, input = {}) {
  requireManage(actor);
  const rawSection = str(input.section);
  const section = rawSection === '' || rawSection === 'all' ? null : Number(rawSection);
  if (section !== null && !(Number.isSafeInteger(section) && section >= 0)) throw invalid(['Choose the section to accept.']);
  const seen = [...new Set(String(Array.isArray(input.ids) ? input.ids.join(',') : input.ids || '').split(',')
    .map(x => Number(String(x).trim())).filter(n => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
  if (!seen.length) throw invalid(['There are no plain answers to accept.']);
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForReview(db, actor, thirdPartyId, assessmentId);
    const bank = await questionnaires.bankFor(db, questionnaire);
    const { rows } = await classify(db, actor, assessment, questionnaire, bank);
    const pool = rows.filter(r => r.plain && r.review_conclusion === 'not_reviewed' && (section === null || r.sectionIndex === section));
    const ids = pool.map(r => Number(r.id)).sort((a, b) => a - b);
    if (ids.length !== seen.length || ids.some((id, i) => id !== seen[i])) throw changedSince();
    const where = section === null ? 'all sections' : (questionnaire.sections[section] || {}).title || 'a section';
    await startReview(db, actor, assessment, questionnaire);
    for (const r of pool) {
      const res = await db.prepare(`UPDATE tp_answers SET review_conclusion = ?, reviewed_by = ?, reviewed_at = now(),
          updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ? AND review_conclusion = 'not_reviewed'`)
        .run(BULK_CONCLUSION, actor.user.id, actor.ws.id, r.id, r.row_version);
      if (res.changes !== 1) throw changedSince();
      await questionnaires.append(db, actor, assessment, 'answer.accepted_in_bulk',
        { answer_id: Number(r.id), question_id: r.question_id, conclusion: 'not_reviewed' },
        { answer_id: Number(r.id), question_id: r.question_id, conclusion: BULK_CONCLUSION, accepted_with: pool.length, scope: where });
    }
    await require('./ai-review').acceptMatchingConclusions(db, actor, assessment, pool.filter(r => r.aiSuggestion).map(r => r.aiSuggestion), BULK_CONCLUSION);
    return { count: pool.length, scope: where, questionIds: pool.map(r => r.question_id) };
  })();
}

async function loadForReview(db, actor, thirdPartyId, assessmentId, { allowFrozen = false } = {}) {
  const loaded = await questionnaires.loadForWrite(db, actor, thirdPartyId, assessmentId);
  const { assessment, questionnaire } = loaded;
  if (!questionnaire) throw notFound();
  const message = reviewBlocked(assessment, questionnaire);
  if (message && !(allowFrozen && REVIEWABLE.includes(questionnaire.status) && assessment.status !== 'cancelled')) {
    throw new TprmError(409, message);
  }
  return loaded;
}

async function startReview(db, actor, assessment, questionnaire) {
  if (questionnaire.status !== 'submitted') return;
  await db.prepare(`UPDATE tp_questionnaires SET status = 'under_review', review_started_at = now(), updated_at = now(),
      row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(actor.ws.id, questionnaire.id);
  questionnaire.status = 'under_review';
  await questionnaires.append(db, actor, assessment, 'questionnaire.review_started', { status: 'submitted' },
    { status: 'under_review', questionnaire_id: Number(questionnaire.id) });
}

async function lockAnswer(db, actor, questionnaire, answerId) {
  const id = Number(answerId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const row = await db.prepare(`SELECT id, question_id, response, review_conclusion, review_comment, row_version FROM tp_answers
    WHERE workspace_id = ? AND questionnaire_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, questionnaire.id, id);
  if (!row) throw notFound();
  return row;
}

async function setConclusion(db, actor, thirdPartyId, assessmentId, answerId, input = {}) {
  requireManage(actor);
  const conclusion = str(input.conclusion);
  const comment = str(input.comment) || null;
  const errors = [];
  if (!CONCLUSIONS.includes(conclusion) || conclusion === 'not_reviewed') errors.push('Choose a conclusion for the answer.');
  if (comment && comment.length > LIMITS.comment) errors.push(`The comment must be ${LIMITS.comment} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForReview(db, actor, thirdPartyId, assessmentId);
    const answer = await lockAnswer(db, actor, questionnaire, answerId);
    questionnaires.checkVersion(answer, input);
    if (answer.review_conclusion === conclusion && (answer.review_comment || null) === comment) return { answer, unchanged: true, questionnaireId: Number(questionnaire.id) };
    await startReview(db, actor, assessment, questionnaire);
    const res = await db.prepare(`UPDATE tp_answers SET review_conclusion = ?, review_comment = ?, reviewed_by = ?, reviewed_at = now(),
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(conclusion, comment, actor.user.id, actor.ws.id, answer.id, answer.row_version);
    if (res.changes !== 1) throw conflict();
    await questionnaires.append(db, actor, assessment, 'answer.reviewed',
      { answer_id: Number(answer.id), question_id: answer.question_id, conclusion: answer.review_conclusion },
      { answer_id: Number(answer.id), question_id: answer.question_id, conclusion, comment });
    return { answer: { ...answer, review_conclusion: conclusion, review_comment: comment, row_version: Number(answer.row_version) + 1 }, questionnaireId: Number(questionnaire.id) };
  })();
}

async function askClarification(db, actor, thirdPartyId, assessmentId, input = {}) {
  requireManage(actor);
  const questionId = str(input.question_id);
  const body = str(input.body);
  const errors = [];
  if (!body) errors.push('Write the clarification you need from the third party.');
  else if (body.length > LIMITS.clarification) errors.push(`The clarification must be ${LIMITS.clarification} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForReview(db, actor, thirdPartyId, assessmentId);
    if (!(questionnaire.sections || []).some(s => s.ids.includes(questionId))
      && !require('./questionnaire-assembly').followupsOf(questionnaire).some(f => f.id === questionId)) throw notFound();
    await startReview(db, actor, assessment, questionnaire);
    const row = await db.prepare(`INSERT INTO tp_clarification_drafts (workspace_id, assessment_id, questionnaire_id, question_id, body, created_by)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(actor.ws.id, assessment.id, questionnaire.id, questionId, body, actor.user.id);
    const waiting = (await db.prepare('SELECT COUNT(*)::int AS n FROM tp_clarification_drafts WHERE workspace_id = ? AND questionnaire_id = ?')
      .get(actor.ws.id, questionnaire.id)).n;
    return { draftId: Number(row.id), questionId, waiting };
  })();
}

async function removeDraftClarification(db, actor, thirdPartyId, assessmentId, draftId) {
  requireManage(actor);
  const id = Number(draftId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  return await db.transaction(async () => {
    const { questionnaire } = await loadForReview(db, actor, thirdPartyId, assessmentId, { allowFrozen: true });
    const row = await db.prepare(`DELETE FROM tp_clarification_drafts WHERE workspace_id = ? AND questionnaire_id = ? AND id = ? RETURNING question_id`)
      .get(actor.ws.id, questionnaire.id, id);
    if (!row) throw notFound();
    return { questionId: row.question_id };
  })();
}

async function sendClarifications(db, actor, thirdPartyId, assessmentId) {
  requireManage(actor);
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForReview(db, actor, thirdPartyId, assessmentId);
    const drafts = await db.prepare(`SELECT id, question_id, body, created_by FROM tp_clarification_drafts
      WHERE workspace_id = ? AND questionnaire_id = ? ORDER BY id FOR UPDATE`).all(actor.ws.id, questionnaire.id);
    if (!drafts.length) throw new TprmError(409, 'There are no follow-ups waiting to be sent.');
    await startReview(db, actor, assessment, questionnaire);
    const ids = [];
    for (const d of drafts) {
      const row = await db.prepare(`INSERT INTO tp_clarifications (workspace_id, assessment_id, questionnaire_id, question_id, body, asked_by)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(actor.ws.id, assessment.id, questionnaire.id, d.question_id, d.body, d.created_by || actor.user.id);
      ids.push(Number(row.id));
      await questionnaires.append(db, actor, assessment, 'clarification.asked', null,
        { clarification_id: Number(row.id), question_id: d.question_id, questionnaire_id: Number(questionnaire.id), body: d.body, sent_together: drafts.length });
    }
    await db.prepare('DELETE FROM tp_clarification_drafts WHERE workspace_id = ? AND questionnaire_id = ?').run(actor.ws.id, questionnaire.id);
    await db.prepare(`UPDATE tp_questionnaires SET updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
      .run(actor.ws.id, questionnaire.id);
    const active = await db.prepare(`SELECT id FROM tp_vendor_requests WHERE workspace_id = ? AND questionnaire_id = ? AND status = 'active'
      AND expires_at > now() LIMIT 1`).get(actor.ws.id, questionnaire.id);
    return { ids, count: ids.length, needsLink: !active };
  })();
}

async function closeClarification(db, actor, thirdPartyId, assessmentId, clarificationId, input = {}) {
  requireManage(actor);
  const note = str(input.note) || null;
  if (note && note.length > LIMITS.note) throw invalid([`The note must be ${LIMITS.note} characters or fewer.`]);
  const id = Number(clarificationId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForReview(db, actor, thirdPartyId, assessmentId, { allowFrozen: true });
    const c = await db.prepare(`SELECT id, question_id, status, row_version FROM tp_clarifications
      WHERE workspace_id = ? AND questionnaire_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, questionnaire.id, id);
    if (!c) throw notFound();
    questionnaires.checkVersion(c, input);
    if (c.status === 'closed') throw new TprmError(409, 'This clarification is already closed.');
    await db.prepare(`UPDATE tp_clarifications SET status = 'closed', closed_by = ?, closed_at = now(), close_note = ?, updated_at = now(),
        row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(actor.user.id, note, actor.ws.id, c.id);
    await questionnaires.append(db, actor, assessment, 'clarification.closed', { clarification_id: Number(c.id), status: c.status },
      { clarification_id: Number(c.id), question_id: c.question_id, status: 'closed', note });
    return { questionId: c.question_id, wasAnswered: c.status === 'answered' };
  })();
}

async function closeReview(db, actor, thirdPartyId, assessmentId, input = {}) {
  requireManage(actor);
  return await db.transaction(async () => {
    const { assessment, questionnaire } = await loadForReview(db, actor, thirdPartyId, assessmentId, { allowFrozen: true });
    questionnaires.checkVersion(questionnaire, input);
    const blockers = await closeBlockers(db, actor.ws.id, questionnaire.id);
    const errors = [];
    if (blockers.unreviewed) errors.push(`${blockers.unreviewed} answer${blockers.unreviewed === 1 ? ' has' : 's have'} no reviewer conclusion yet.`);
    if (blockers.unclosed) errors.push(`${blockers.unclosed} clarification${blockers.unclosed === 1 ? ' is' : 's are'} not closed yet.`);
    if (blockers.unchecked) errors.push(`${blockers.unchecked} assurance report${blockers.unchecked === 1 ? ' is' : 's are'} not checked yet.`);
    if (blockers.unsent) errors.push(`${blockers.unsent} follow-up${blockers.unsent === 1 ? ' is' : 's are'} written but not sent: send ${blockers.unsent === 1 ? 'it' : 'them'} or remove ${blockers.unsent === 1 ? 'it' : 'them'}.`);
    if (errors.length) throw new TprmError(409, `The review cannot be closed: ${errors.join(' ')}`);
    const revoked = await questionnaires.revokeActive(db, actor, assessment, questionnaire, questionnaires.REVOKE_REASONS.reviewed);
    if (questionnaire.status === 'submitted') {
      await db.prepare(`UPDATE tp_questionnaires SET status = 'under_review', review_started_at = now(), updated_at = now(),
        row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(actor.ws.id, questionnaire.id);
    }
    await db.prepare(`UPDATE tp_questionnaires SET status = 'closed', closed_at = now(), closed_reason = ?, closed_by = ?, updated_at = now(),
        row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(REVIEWED_REASON, actor.user.id, actor.ws.id, questionnaire.id);
    const counts = await db.prepare(`SELECT review_conclusion AS k, COUNT(*)::int AS c FROM tp_answers
      WHERE workspace_id = ? AND questionnaire_id = ? GROUP BY review_conclusion`).all(actor.ws.id, questionnaire.id);
    await questionnaires.append(db, actor, assessment, 'questionnaire.reviewed', { status: questionnaire.status }, {
      status: 'closed', reason: REVIEWED_REASON, questionnaire_id: Number(questionnaire.id),
      conclusions: Object.fromEntries(counts.map(r => [r.k, r.c])), revoked_request_ids: revoked,
    });
    return { revoked };
  })();
}

async function reviewQueue(deps, user) {
  if (!access.isFirmUser(user) || !access.firmCan(user, 'tp.view')) return [];
  const { enabled } = await access.listFirmClients(deps, user);
  const reachable = [];
  for (const c of enabled) {
    if (await access.loadFirmWorkspace(deps, user, c.id)) reachable.push({ id: Number(c.id), name: c.name });
  }
  if (!reachable.length) return [];
  const names = new Map(reachable.map(c => [c.id, c.name]));
  const ids = reachable.map(c => c.id);
  const rows = await deps.db.prepare(`SELECT q.id, q.workspace_id, q.assessment_id, q.status, q.submitted_at, q.vendor_question_count,
      a.third_party_id, a.type, a.final_tier, t.name AS third_party_name,
      (SELECT COUNT(*)::int FROM tp_clarifications c
        WHERE c.workspace_id = q.workspace_id AND c.questionnaire_id = q.id AND c.status = 'open') AS open_clarifications,
      (SELECT COUNT(*)::int FROM tp_answers x
        WHERE x.workspace_id = q.workspace_id AND x.questionnaire_id = q.id AND x.review_conclusion = 'not_reviewed' AND x.response IS NOT NULL) AS unreviewed
    FROM tp_questionnaires q
    JOIN tp_assessments a ON a.workspace_id = q.workspace_id AND a.id = q.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    WHERE q.status IN ('submitted', 'under_review') AND a.status NOT IN ('cancelled', 'completed')
      AND q.workspace_id IN (${ids.map(() => '?').join(',')})
    ORDER BY q.submitted_at ASC, q.id`).all(...ids);
  return (await require('./scope').keep(deps.db, user, rows)).map(r => ({ ...r, client_name: names.get(Number(r.workspace_id)) }));
}

async function findingDraft(db, actor, assessment, answerId) {
  requireManage(actor);
  const questionnaire = await questionnaires.getQuestionnaire(db, actor, assessment);
  if (!questionnaire) throw notFound();
  const id = Number(answerId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const answer = await db.prepare(`SELECT id, question_id, response, detail, evidence_ref, to_char(evidence_date, 'YYYY-MM-DD') AS evidence_date
    FROM tp_answers WHERE workspace_id = ? AND questionnaire_id = ? AND id = ?`).get(actor.ws.id, questionnaire.id, id);
  if (!answer) throw notFound();
  const bank = await questionnaires.bankFor(db, questionnaire);
  const q = bank.questions.find(r => r.id === answer.question_id) || {};
  const files = (await loadFiles(db, actor.ws.id, questionnaire.id)).get(Number(answer.id)) || [];
  const control = controlRef(q.iso27001);
  const label = vendorAnswers.RESPONSE_LABELS[answer.response] || 'No answer';
  const description = [
    `Raised from the third party's answer to ${answer.question_id}: ${clientText(q.question, actor.ws.brand_display_name || actor.ws.client_name)}`,
    `Answer: ${label}.`,
    answer.detail ? `${answer.response === 'text' || answer.response === 'value' ? 'Their answer' : 'Their detail'}: ${answer.detail}` : null,
    answer.evidence_ref ? `Evidence reference: ${answer.evidence_ref}${answer.evidence_date ? ` (${answer.evidence_date})` : ''}` : null,
  ].filter(Boolean).join('\n').slice(0, 4000);
  return {
    control_ref: control,
    severity: questionnaire.tier,
    title: String(q.theme ? clientText(q.theme, actor.ws.brand_display_name || actor.ws.client_name) : answer.question_id).slice(0, 200),
    description,
    status: 'open',
    evidence: files.map(f => String(f.id)),
    fromAnswer: { id: Number(answer.id), question_id: answer.question_id, response: answer.response },
  };
}

const clientText = (text, clientName) => String(text || '').replace(/<Client>/g, clientName || 'the client');

function controlRef(iso) {
  const raw = String(iso || '').trim();
  if (!raw) return '';
  const value = /^\d/.test(raw) ? raw.split(/;\s*/).map(part => (/^\d/.test(part) ? `A.${part}` : part)).join('; ') : raw;
  return value.slice(0, 40);
}

module.exports = {
  CONCLUSIONS, CONCLUSION_LABELS, CLARIFICATION_STATUS_LABELS, REVIEWABLE, FILTERS, FILTER_LABELS, TYPED_FILTER_LABELS, REVIEWED_REASON, LIMITS,
  REASON_LABELS, BULK_CONCLUSION,
  loadForReview, startReview, reviewBlocked, reviewData, reviewState, filterCounts, acceptPlain, classify, setConclusion, askClarification, closeClarification, closeReview, findingDraft, controlRef, reviewQueue,
  removeDraftClarification, sendClarifications,
};
