'use strict';

const crypto = require('crypto');
const events = require('./events');
const questionnaires = require('./questionnaires');
const evidence = require('./evidence');
const rulesLib = require('./answer-rules');
const { TprmError } = require('./errors');

const RESPONSES = rulesLib.LEGACY_RESPONSES;
const RESPONSE_LABELS = rulesLib.RESPONSE_LABELS;
const DETAIL_REQUIRED = Object.freeze(['partial', 'no', 'na']);
const EVIDENCE_RESPONSES = Object.freeze(['yes', 'partial']);
const LIMITS = Object.freeze({
  detail: 4000, evidenceRef: 1000, response: 4000, scope: 2000, description: 1000,
  filesPerRequest: 5, fileBytes: 20 * 1024 * 1024,
  formAgeMs: 24 * 60 * 60 * 1000,
});
const AI_MODULE = 'AI Services';
const AI_SCREENING = 'AIS-01';
const AI_SOURCE = 'third_party_answer';
const AI_ADDED_BECAUSE = 'The third party answered Yes to AIS-01 (AI is used to provide the services)';
const AI_KEPT_FLAG = 'The third party changed AIS-01 to No after answering AI Services questions, so the questions were kept.';
const QUESTION_ID = /^[A-Z]{2,6}-[0-9]{1,4}$/;
const ANSWERING = Object.freeze(['sent', 'in_progress']);
const CLARIFYING = Object.freeze(['submitted', 'under_review']);

const EVENT_LABELS = Object.freeze({
  'questionnaire.answering_started': 'The third party started answering',
  'questionnaire.answers_saved': 'The third party saved answers',
  'questionnaire.prefilled': 'Answers prefilled from the last questionnaire',
  'questionnaire.module_kept': 'AI Services kept after AIS-01 changed to No',
  'questionnaire.submitted': 'The third party submitted the questionnaire',
  'vendor_link.used': 'Link used up by the submission',
  'clarification.answered': 'The third party answered a clarification',
  'assurance_report.uploaded': 'The third party added an assurance report',
  'assurance_report.updated': 'The third party changed an assurance report',
  'assurance_report.removed': 'The third party removed an assurance report',
  'evidence.described': 'The third party described a document',
});

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const json = v => JSON.stringify(v);
const bad = (message, extra) => new TprmError(400, message, extra);
const foreign = () => bad('This form does not belong to this questionnaire. Reload the page and try again.', { foreign: true });

function formKey() {
  if (!formKey.fallback) formKey.fallback = crypto.randomBytes(32).toString('hex');
  return crypto.createHash('sha256').update(`tprm-vendor-form\0${process.env.SESSION_SECRET || formKey.fallback}`).digest();
}

function mac(tokenHash, issued, nonce) {
  return crypto.createHmac('sha256', formKey()).update(`${tokenHash}.${issued}.${nonce}`).digest('base64url');
}

function formToken(tokenHash, now = Date.now()) {
  const issued = Number(now).toString(36);
  const nonce = crypto.randomBytes(12).toString('base64url');
  return `${issued}.${nonce}.${mac(tokenHash, issued, nonce)}`;
}

function verifyFormToken(tokenHash, value, now = Date.now()) {
  const parts = str(value).split('.');
  if (parts.length !== 3 || !/^[0-9a-z]{1,12}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{16}$/.test(parts[1])) return false;
  const issued = parseInt(parts[0], 36);
  if (!Number.isFinite(issued) || issued > now + 5 * 60 * 1000 || now - issued > LIMITS.formAgeMs) return false;
  const expected = Buffer.from(mac(tokenHash, parts[0], parts[1]));
  const given = Buffer.from(parts[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

async function linkContext(db, token) {
  const raw = String(token || '');
  if (!questionnaires.TOKEN_PATTERN.test(raw)) return null;
  const tokenHash = questionnaires.hashToken(raw);
  const row = await db.prepare(`SELECT r.id AS request_id, r.workspace_id, r.assessment_id, r.questionnaire_id, r.expires_at,
      r.last_opened_at, r.recipient_name, q.status AS q_status, a.third_party_id, a.type AS a_type, w.firm_id, w.client_name, w.brand_display_name,
      cu.name AS issuer_name, cu.email AS issuer_email
    FROM tp_vendor_requests r
    LEFT JOIN users cu ON cu.id = r.created_by AND cu.active = 1
    JOIN tp_questionnaires q ON q.workspace_id = r.workspace_id AND q.id = r.questionnaire_id
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN workspaces w ON w.id = r.workspace_id
    JOIN tp_client_settings s ON s.workspace_id = r.workspace_id
    WHERE r.token_hash = ? AND r.status = 'active' AND r.expires_at > now()
      AND q.status IN ('sent', 'in_progress', 'submitted', 'under_review')
      AND a.confirmed_at IS NOT NULL AND a.status IN ('tier_confirmed', 'recommendation_draft') AND s.enabled`).get(tokenHash);
  if (!row) return null;
  return {
    tokenHash,
    requestId: Number(row.request_id),
    workspaceId: Number(row.workspace_id),
    assessmentId: Number(row.assessment_id),
    questionnaireId: Number(row.questionnaire_id),
    thirdPartyId: Number(row.third_party_id),
    firmId: Number(row.firm_id),
    assessmentType: row.a_type,
    status: row.q_status,
    mode: ANSWERING.includes(row.q_status) ? 'answering' : 'clarifying',
    expiresAt: row.expires_at,
    lastOpenedAt: row.last_opened_at,
    clientName: row.brand_display_name || row.client_name,
    recipientName: row.recipient_name || null,
    issuer: row.issuer_email ? { name: row.issuer_name || null, email: row.issuer_email } : null,
  };
}

async function submittedLink(db, token) {
  const raw = String(token || '');
  if (!questionnaires.TOKEN_PATTERN.test(raw)) return null;
  const row = await db.prepare(`SELECT q.submitted_at, w.client_name, w.brand_display_name
    FROM tp_vendor_requests r
    JOIN tp_questionnaires q ON q.workspace_id = r.workspace_id AND q.id = r.questionnaire_id
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN workspaces w ON w.id = r.workspace_id
    JOIN tp_client_settings s ON s.workspace_id = r.workspace_id
    WHERE r.token_hash = ? AND r.status = 'submitted' AND r.expires_at > now()
      AND q.submitted_at IS NOT NULL AND a.status <> 'cancelled' AND s.enabled`).get(questionnaires.hashToken(raw));
  if (!row) return null;
  return { clientName: row.brand_display_name || row.client_name, submittedAt: row.submitted_at };
}

const Q_COLUMNS = `id, workspace_id, assessment_id, bank_version_id, bank_version, tier, delivery_model, delivery_model_source,
  modules, dynamic_modules, sections, consultant_check_ids, vendor_question_count, status, submitted_at, row_version, rulebooks`;

async function lockLink(db, token) {
  const first = await linkContext(db, token);
  if (!first) return null;
  const ws = first.workspaceId;
  await db.prepare('SELECT id FROM tp_third_parties WHERE workspace_id = ? AND id = ? FOR UPDATE').get(ws, first.thirdPartyId);
  await db.prepare('SELECT id FROM tp_assessments WHERE workspace_id = ? AND id = ? FOR UPDATE').get(ws, first.assessmentId);
  const questionnaire = await db.prepare(`SELECT ${Q_COLUMNS} FROM tp_questionnaires WHERE workspace_id = ? AND id = ? FOR UPDATE`)
    .get(ws, first.questionnaireId);
  await db.prepare('SELECT id FROM tp_vendor_requests WHERE workspace_id = ? AND id = ? FOR UPDATE').get(ws, first.requestId);
  const ctx = await linkContext(db, token);
  if (!ctx || ctx.requestId !== first.requestId || !questionnaire) return null;
  return { ...ctx, questionnaire };
}

async function append(db, ctx, action, before, after) {
  await events.appendEvent(db, {
    workspaceId: ctx.workspaceId, thirdPartyId: ctx.thirdPartyId, assessmentId: ctx.assessmentId, actorId: null,
    action, before, after: after == null ? null : { ...after, by: 'third_party', request_id: ctx.requestId },
  });
}

const sectionIds = q => (q.sections || []).flatMap(s => s.ids);

const A_COLUMNS = `a.id, a.question_id, a.response, a.detail, a.fields, a.evidence_ref, to_char(a.evidence_date, 'YYYY-MM-DD') AS evidence_date,
  a.saved_at, a.prefilled_from_answer_id, a.prefill_confirmed_at, a.submitted_at, a.row_version`;

async function answersOf(db, workspaceId, questionnaireId) {
  const rows = await db.prepare(`SELECT ${A_COLUMNS} FROM tp_answers a WHERE a.workspace_id = ? AND a.questionnaire_id = ?`)
    .all(workspaceId, questionnaireId);
  return new Map(rows.map(r => [r.question_id, r]));
}

async function filesOf(db, workspaceId, questionnaireId) {
  const rows = await db.prepare(`SELECT a.question_id, e.id, e.original_name, e.size_bytes, e.released_to_client,
      (SELECT COUNT(*)::int FROM tp_finding_evidence f WHERE f.workspace_id = e.workspace_id AND f.evidence_id = e.id) AS finding_count
    FROM tp_answer_evidence l
    JOIN tp_answers a ON a.workspace_id = l.workspace_id AND a.id = l.answer_id
    JOIN tp_evidence e ON e.workspace_id = l.workspace_id AND e.id = l.evidence_id
    JOIN tp_vendor_requests r ON r.workspace_id = e.workspace_id AND r.id = e.vendor_request_id
    WHERE l.workspace_id = ? AND a.questionnaire_id = ? AND e.source = 'vendor' AND r.questionnaire_id = a.questionnaire_id
    ORDER BY e.id`).all(workspaceId, questionnaireId);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.question_id)) map.set(r.question_id, []);
    map.get(r.question_id).push({ id: Number(r.id), name: r.original_name, size: Number(r.size_bytes), locked: !!r.released_to_client || r.finding_count > 0 });
  }
  return map;
}

async function clarificationsOf(db, workspaceId, questionnaireId) {
  return await db.prepare(`SELECT c.id, c.question_id, c.body, c.asked_at, c.status, c.response, c.responded_at, c.raised_for,
      e.original_name AS response_file_name
    FROM tp_clarifications c
    LEFT JOIN tp_evidence e ON e.workspace_id = c.workspace_id AND e.id = c.response_evidence_id AND e.source = 'vendor'
    WHERE c.workspace_id = ? AND c.questionnaire_id = ? AND c.status <> 'closed'
    ORDER BY CASE c.status WHEN 'open' THEN 0 ELSE 1 END, c.asked_at, c.id`).all(workspaceId, questionnaireId);
}

async function previousSubmission(db, workspaceId, answers) {
  const ids = [...answers.values()].map(a => a.prefilled_from_answer_id).filter(Boolean).map(Number);
  if (!ids.length) return null;
  const row = await db.prepare(`SELECT q.submitted_at FROM tp_answers a
    JOIN tp_questionnaires q ON q.workspace_id = a.workspace_id AND q.id = a.questionnaire_id
    WHERE a.workspace_id = ? AND a.id = ?`).get(workspaceId, ids[0]);
  return row ? row.submitted_at : null;
}

const clientText = (text, clientName) => String(text || '').replace(/<Client>/g, clientName);

const MESSAGES = Object.freeze({
  unanswered: 'Not answered yet.',
  confirm: 'Your answer from last time: confirm it is still correct, or change it.',
  explain: 'Add an explanation for your answer.',
  evidence: 'Evidence is required: attach a file or give an evidence reference.',
  fields: 'Fill in each field of your answer.',
});

function rulesMap(bank, clientName = null) {
  return new Map(bank.questions.map(row => {
    const r = rulesLib.questionRules(row);
    if (clientName == null) return [row.id, r];
    return [row.id, { ...r, fields: r.fields.map(f => ({ ...f, label: clientText(f.label, clientName) })),
      detailsOnYes: r.detailsOnYes ? clientText(r.detailsOnYes, clientName) : r.detailsOnYes }];
  }));
}

function requestMap(clarifications) {
  const map = new Map();
  for (const c of clarifications || []) {
    if (!c.raised_for) continue;
    const prev = map.get(c.question_id);
    const now = { status: c.status, responded: !!c.responded_at };
    if (!prev || now.responded || (prev.status === 'closed' && now.status !== 'closed')) map.set(c.question_id, now);
  }
  return map;
}

function stateOf(rules, id, a, files, reports, { requests = null } = {}) {
  return rulesLib.evidenceState({
    rules, questionId: id, response: a ? a.response : null,
    ownEvidence: !!(a && (a.evidence_ref || (files.get(id) || []).length)),
    reports, request: requests ? requests.get(id) || null : null,
  });
}

function fieldsMissing(rules, a) {
  if (!a || !a.response || a.response !== rulesLib.fieldsResponse(rules)) return false;
  if (rules.fields.length) {
    const values = a.fields && typeof a.fields === 'object' ? a.fields : {};
    return rules.fields.some(f => !f.optional && !String(values[f.key] || '').trim());
  }
  return !!rules.detailsOnYes && !String(a.detail || '').trim();
}

function submissionProblems(questionnaire, bank, answers, files, reports = []) {
  const rules = rulesMap(bank);
  const problems = [];
  for (const id of sectionIds(questionnaire)) {
    const a = answers.get(id);
    const r = rules.get(id) || rulesLib.questionRules({});
    if (!a || !a.response) {
      problems.push({ id, kind: 'unanswered', message: MESSAGES.unanswered });
      continue;
    }
    if (a.prefilled_from_answer_id && !a.prefill_confirmed_at) problems.push({ id, kind: 'confirm', message: MESSAGES.confirm });
    if (r.typed && rulesLib.explanationNeeded(r, a.response) && !String(a.detail || '').trim()) {
      problems.push({ id, kind: 'explain', message: MESSAGES.explain });
    }
    if (r.typed && fieldsMissing(r, a)) problems.push({ id, kind: 'fields', message: MESSAGES.fields });
    if (stateOf(r, id, a, files, reports).required) problems.push({ id, kind: 'evidence', message: MESSAGES.evidence });
  }
  return problems;
}

function valuesOf(rules, a) {
  if (!a) return { response: '', detail: '', answer_text: '', fields: {}, yes_details: '', evidence_ref: '', evidence_date: '', confirm: false };
  const text = rules.typed && rules.type === 'free_text';
  const own = !!a.response && a.response === rulesLib.fieldsResponse(rules);
  return {
    response: a.response || '',
    detail: (text && a.response === 'text') || own ? '' : a.detail || '',
    answer_text: text && a.response === 'text' && !rules.fields.length ? a.detail || '' : '',
    fields: own && a.fields && typeof a.fields === 'object' ? { ...a.fields } : {},
    yes_details: own && rules.detailsOnYes && !rules.fields.length ? a.detail || '' : '',
    evidence_ref: a.evidence_ref || '',
    evidence_date: a.evidence_date || '',
    confirm: false,
  };
}

function sectionSummary(themes, clientName) {
  const list = [...new Set(themes.filter(Boolean))].map(t => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t));
  if (!list.length) return '';
  const shown = list.slice(0, 5).map(t => clientText(t, clientName));
  const more = list.length - shown.length;
  const join = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
  return more ? `Covers ${shown.join(', ')} and ${more} more topic${more === 1 ? '' : 's'}.` : `Covers ${join(shown)}.`;
}

const sectionSlug = (s, index) => (s.kind === 'module' && s.title === AI_MODULE ? 'ai-services' : `section-${index + 1}`);

async function pageData(db, ctx, { values = null } = {}) {
  const questionnaire = await db.prepare(`SELECT ${Q_COLUMNS} FROM tp_questionnaires WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, ctx.questionnaireId);
  const bank = await questionnaires.bankContent(db, questionnaire.bank_version_id);
  const byId = new Map(bank.questions.map(row => [row.id, row]));
  const rules = rulesMap(bank, ctx.clientName);
  const typed = rulesLib.bankTyped(bank);
  const answers = await answersOf(db, ctx.workspaceId, ctx.questionnaireId);
  const files = await filesOf(db, ctx.workspaceId, ctx.questionnaireId);
  const clarifications = await clarificationsOf(db, ctx.workspaceId, ctx.questionnaireId);
  const reportsLib = require('./assurance-reports');
  const reports = typed ? await reportsLib.loadReports(db, ctx.workspaceId, ctx.questionnaireId) : [];
  const problems = submissionProblems(questionnaire, bank, answers, files, reports);
  const problemsOf = new Map();
  for (const x of problems) {
    if (!problemsOf.has(x.id)) problemsOf.set(x.id, []);
    problemsOf.get(x.id).push(x);
  }
  const ai = (questionnaire.modules || []).find(m => m.module === AI_MODULE) || null;
  const aiAddedByAnswer = !!(ai && ai.included && ai.source === AI_SOURCE);
  const sections = (questionnaire.sections || []).map((s, index) => {
    const slug = sectionSlug(s, index);
    const questions = s.ids.map(id => {
      const row = byId.get(id) || {};
      const r = rules.get(id) || rulesLib.questionRules({});
      const a = answers.get(id) || null;
      const posted = values && values[id];
      return {
        id,
        theme: clientText(row.theme, ctx.clientName),
        question: clientText(row.question, ctx.clientName),
        guidance: clientText(row.guidance, ctx.clientName),
        evidence: clientText(row.evidence, ctx.clientName),
        evidenceRequired: !!row.evidence_mandatory,
        acronyms: (Array.isArray(row.acronyms) ? row.acronyms : []).filter(t => bank.glossary && bank.glossary[t])
          .map(t => ({ term: t, meaning: clientText(bank.glossary[t], ctx.clientName) })),
        document: row.document && row.document.name ? { name: clientText(row.document.name, ctx.clientName), group: row.document.group || 'Other documents' } : null,
        rules: { ...r, benchmark: null },
        badge: (() => {
          const state = stateOf(r, id, a, files, reports).key;
          if (state === 'provided') return { key: 'ok', label: 'Evidence added' };
          if (state === 'not_needed' && r.evidenceMandatory) return { key: 'optional', label: 'No evidence needed for this answer' };
          return rulesLib.vendorBadge(r, id, reports);
        })(),
        answer: a,
        value: posted || valuesOf(r, a),
        fromLastTime: !!(a && a.prefilled_from_answer_id && !a.prefill_confirmed_at),
        files: files.get(id) || [],
        problems: (problemsOf.get(id) || []).filter(x => x.kind !== 'unanswered'),
      };
    });
    const answered = questions.filter(x => x.answer && x.answer.response).length;
    const attention = questions.filter(x => x.problems.length).length;
    return {
      index: index + 1,
      anchor: slug,
      slug,
      kind: s.kind,
      title: s.title,
      summary: sectionSummary(s.ids.map(id => (byId.get(id) || {}).theme), ctx.clientName),
      questions,
      answered,
      total: questions.length,
      complete: answered === questions.length && !attention,
      attention,
      aiAdded: s.kind === 'module' && s.title === AI_MODULE && aiAddedByAnswer,
    };
  });
  const sectionOf = new Map();
  for (const s of sections) for (const q of s.questions) sectionOf.set(q.id, s.index);
  const total = sections.reduce((n, s) => n + s.questions.length, 0);
  const answered = sections.reduce((n, s) => n + s.answered, 0);
  const savedTimes = [...answers.values()].map(a => a.saved_at).filter(Boolean).map(d => new Date(d).getTime());
  const reportRows = (questionnaire.sections || []).flatMap(s => s.ids).map(id => byId.get(id)).filter(Boolean);
  const counts = rulesLib.coverageCounts(reportRows, reports);
  const letterhead = require('./letterhead');
  const lh = await letterhead.getLetterhead(db, ctx.firmId).catch(() => null);
  const flat = sections.flatMap(s => s.questions.map(q => ({ q, s })));
  const isWritten = q => !!(q.rules.typed && q.rules.type === 'free_text');
  const answerCounts = questionCounts(flat.map(({ q }) => ({ written: isWritten(q), document: !!q.rules.evidenceMandatory && q.badge.key !== 'covered' })));
  const coveredDocuments = flat.filter(({ q }) => q.rules.evidenceMandatory && q.badge.key === 'covered').length;
  const documentsNeeded = documentGroups(flat.filter(({ q }) => q.rules.evidenceMandatory && q.badge.key !== 'covered' && (q.document || q.evidence))
    .map(({ q, s }) => ({ group: q.document ? q.document.group : s.title, name: q.document ? q.document.name : docName(q.evidence), questionId: q.id })));
  const shelf = ctx.mode === 'answering' ? await shelfRows(db, ctx) : [];
  return {
    ctx,
    questionnaire,
    typed,
    firm: {
      name: lh ? lh.displayName : '',
      logo: lh && lh.logo ? await letterhead.logoDataUri(db, ctx.firmId).catch(() => null) : null,
    },
    sections,
    sectionOf,
    total,
    answered,
    lastSavedAt: savedTimes.length ? new Date(Math.max(...savedTimes)) : null,
    reports: {
      enabled: typed && (rulesLib.wouldCover(reportRows, 'iso27001') + rulesLib.wouldCover(reportRows, 'soc2_type2')) > 0,
      byKind: Object.fromEntries(rulesLib.KINDS.map(k => [k, reports.find(r => r.kind === k) || null])),
      counts,
      would: Object.fromEntries(rulesLib.KINDS.map(k => [k, rulesLib.wouldCover(reportRows, k)])),
      labels: rulesLib.KIND_LABELS,
    },
    clarifications: clarifications.map(c => ({ ...c, question: clientText((byId.get(c.question_id) || {}).question, ctx.clientName),
      answer: answers.get(c.question_id) || null,
      answerText: (() => { const a = answers.get(c.question_id); return a && a.response === 'text' ? a.detail : null; })() })),
    aiAddedByAnswer,
    aiFlag: ai && ai.flag ? ai.flag : null,
    lastTime: await previousSubmission(db, ctx.workspaceId, answers),
    problems: problems.map(x => ({ ...x, section: sectionOf.get(x.id) || 1 })),
    responses: RESPONSES,
    responseLabels: RESPONSE_LABELS,
    detailRequired: DETAIL_REQUIRED,
    limits: LIMITS,
    counts: answerCounts,
    coveredDocuments,
    documentsNeeded,
    shelf,
  };
}

function pick(obj, id) {
  if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, id)) return undefined;
  return obj[id];
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

const LEGACY_RULES = rulesLib.questionRules({});

function parseAnswerForm(body, files, allowed, rulesOf = () => LEGACY_RULES) {
  const allowedSet = new Set(allowed);
  const groups = ['r', 'd', 't', 'ref', 'date', 'confirm', 'remove', 'pick', 'f', 'y'].map(k => (body && typeof body[k] === 'object' && body[k]) || {});
  const ids = new Set();
  for (const g of groups) {
    for (const id of Object.keys(g)) {
      if (!QUESTION_ID.test(id) || !allowedSet.has(id)) throw foreign();
      ids.add(id);
    }
  }
  const uploads = new Map();
  for (const file of files || []) {
    const m = String(file.fieldname || '').match(/^file__([A-Z]{2,6}-[0-9]{1,4})$/);
    if (!m || !allowedSet.has(m[1])) throw foreign();
    if (!uploads.has(m[1])) uploads.set(m[1], []);
    uploads.get(m[1]).push(file);
    ids.add(m[1]);
  }
  const [r, d, t, ref, date, confirm, remove, pickGroup, fieldGroup, yesGroup] = groups;
  const posted = new Map();
  const removals = new Map();
  const picks = new Map();
  const errors = [];
  const values = {};
  for (const id of ids) {
    const rules = rulesOf(id) || LEGACY_RULES;
    const freeText = rules.typed && rules.type === 'free_text';
    let response = str(pick(r, id));
    const detail = str(pick(d, id));
    const text = str(pick(t, id));
    const postedFields = pick(fieldGroup, id);
    if (postedFields !== undefined && (!rules.fields.length || typeof postedFields !== 'object' || Array.isArray(postedFields))) throw foreign();
    const fieldValues = {};
    for (const key of Object.keys(postedFields || {})) {
      if (!rules.fields.some(f => f.key === key)) throw foreign();
      fieldValues[key] = str(postedFields[key]);
    }
    const yesDetails = str(pick(yesGroup, id));
    if (pick(yesGroup, id) !== undefined && !rules.detailsOnYes) throw foreign();
    const shown = {
      response, detail, answer_text: text, fields: fieldValues, yes_details: yesDetails,
      evidence_ref: str(pick(ref, id)),
      evidence_date: str(pick(date, id)),
      confirm: str(pick(confirm, id)) === '1',
    };
    values[id] = shown;
    if (pick(t, id) !== undefined && !freeText) throw foreign();
    const anyField = Object.values(fieldValues).some(Boolean);
    if (freeText) {
      if (response && response !== 'na') throw foreign();
      if (response !== 'na') response = (rules.fields.length ? anyField : text) ? 'text' : '';
    } else if (response && !rules.responses.includes(response)) {
      if (rules.typed && response === 'partial') {
        errors.push({ id, message: 'Partially is not an answer to this question: choose Yes, No or Not applicable, and explain a No.' });
      } else {
        throw foreign();
      }
    }
    const own = !!response && response === rulesLib.fieldsResponse(rules);
    for (const f of rules.fields) {
      const value = fieldValues[f.key] || '';
      if (!own || !value) continue;
      if (value.length > f.max) errors.push({ id, message: `${f.label}: at most ${f.max} characters.` });
      if (f.kind === 'date' && !isRealDate(value)) errors.push({ id, message: `${f.label}: give a real date.` });
      if (f.kind === 'number' && !/^\d+(?:[.,]\d+)?$/.test(value)) errors.push({ id, message: `${f.label}: give a number.` });
    }
    const v = {
      response,
      fields: own && rules.fields.length ? Object.fromEntries(rules.fields.filter(f => fieldValues[f.key]).map(f => [f.key, fieldValues[f.key]])) : null,
      detail: own && rules.fields.length ? rulesLib.renderFields(rules.fields, fieldValues)
        : own && rules.detailsOnYes ? yesDetails
          : freeText && response === 'text' ? text : detail,
      evidence_ref: shown.evidence_ref,
      evidence_date: shown.evidence_date,
      confirm: shown.confirm,
    };
    if (rules.typed) {
      if (!(freeText && response === 'text') && !own && !rulesLib.explanationNeeded(rules, response)) v.detail = '';
      if (!rulesLib.evidenceApplies(rules, response)) { v.evidence_ref = ''; v.evidence_date = ''; }
    }
    if (v.detail.length > LIMITS.detail) {
      errors.push({ id, message: freeText && response === 'text' ? `The answer must be ${LIMITS.detail} characters or fewer.` : `The detail must be ${LIMITS.detail} characters or fewer.` });
    }
    if (rules.typed) {
      if (rulesLib.explanationNeeded(rules, response) && !v.detail) {
        errors.push({ id, message: `Explain your answer "${RESPONSE_LABELS[response]}".` });
      }
    } else if (DETAIL_REQUIRED.includes(response) && !v.detail) {
      errors.push({ id, message: `Give supporting detail for "${RESPONSE_LABELS[response]}".` });
    }
    if (v.evidence_ref.length > LIMITS.evidenceRef) errors.push({ id, message: `The evidence reference must be ${LIMITS.evidenceRef} characters or fewer.` });
    if (v.evidence_date && (!isRealDate(v.evidence_date) || v.evidence_date > tomorrow())) {
      errors.push({ id, message: 'The evidence date must be a real date, not in the future.' });
    }
    posted.set(id, v);
    const rm = pick(remove, id);
    const list = (Array.isArray(rm) ? rm : rm == null || rm === '' ? [] : [rm]).map(x => Number(str(x)));
    if (list.some(n => !Number.isSafeInteger(n) || n < 1)) throw foreign();
    if (list.length) removals.set(id, [...new Set(list)]);
    const pk = pick(pickGroup, id);
    const chosen = (Array.isArray(pk) ? pk : pk == null || pk === '' ? [] : [pk]).map(x => Number(str(x)));
    if (chosen.some(n => !Number.isSafeInteger(n) || n < 1)) throw foreign();
    if (chosen.length) picks.set(id, [...new Set(chosen)]);
  }
  if (errors.length) throw bad(errors.map(e => `${e.id}: ${e.message}`).join(' '), { errors, values });
  return { posted, uploads, removals, picks, values };
}

function normalisedCopy(rules, row) {
  if (!rulesLib.responseValid(rules, row.response)) return null;
  const out = { response: row.response, detail: row.detail, fields: row.fields || null, evidence_ref: row.evidence_ref, evidence_date: row.evidence_date };
  const ownResponse = rulesLib.fieldsResponse(rules);
  if (rules.typed && ownResponse && row.response === ownResponse && rules.fields.length) {
    const keys = new Set(rules.fields.map(f => f.key));
    const kept = row.fields && typeof row.fields === 'object' ? Object.fromEntries(Object.entries(row.fields).filter(([k]) => keys.has(k))) : {};
    out.fields = Object.keys(kept).length ? kept : null;
    out.detail = rulesLib.renderFields(rules.fields, kept) || null;
    if (ownResponse === 'yes') return out;
    return out.detail ? out : null;
  }
  if (rules.typed && ownResponse && row.response === ownResponse && rules.detailsOnYes) {
    out.fields = null;
    out.detail = String(row.detail || '').trim() ? row.detail : null;
    return out;
  }
  out.fields = null;
  if (rules.typed) {
    if (row.response !== 'text' && !rulesLib.explanationNeeded(rules, row.response)) out.detail = null;
    if (!rulesLib.evidenceApplies(rules, row.response)) { out.evidence_ref = null; out.evidence_date = null; }
    if (row.response === 'text' && !String(row.detail || '').trim()) return null;
    if (rulesLib.explanationNeeded(rules, row.response) && !String(out.detail || '').trim()) return null;
  }
  return out;
}

const hasContent = v => !!(v.response || v.detail || v.evidence_ref || v.evidence_date);
const sameFields = (x, y) => JSON.stringify(x && Object.keys(x).length ? x : null) === JSON.stringify(y && Object.keys(y).length ? y : null);
const differs = (a, v) => (a.response || '') !== v.response || (a.detail || '') !== v.detail || !sameFields(a.fields, v.fields)
  || (a.evidence_ref || '') !== v.evidence_ref || (a.evidence_date || '') !== v.evidence_date;

async function markOpened(db, ctx) {
  if (!ctx.lastOpenedAt) {
    await db.prepare(`UPDATE tp_vendor_requests SET last_opened_at = now(), updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND status = 'active'`).run(ctx.workspaceId, ctx.requestId);
  }
  if (ctx.questionnaire.status === 'sent') {
    await db.prepare(`UPDATE tp_questionnaires SET status = 'in_progress', updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ?`).run(ctx.workspaceId, ctx.questionnaireId);
    ctx.questionnaire.status = 'in_progress';
    await append(db, ctx, 'questionnaire.answering_started', { status: 'sent' },
      { status: 'in_progress', questionnaire_id: ctx.questionnaireId });
  }
}

async function storeFile(db, ctx, file, sha256) {
  const same = await db.prepare(`SELECT e.id, e.source, r.questionnaire_id FROM tp_evidence e
    LEFT JOIN tp_vendor_requests r ON r.workspace_id = e.workspace_id AND r.id = e.vendor_request_id
    WHERE e.workspace_id = ? AND e.assessment_id = ? AND e.sha256 = ?`).get(ctx.workspaceId, ctx.assessmentId, sha256);
  if (same) {
    if (same.source === 'vendor' && Number(same.questionnaire_id) === ctx.questionnaireId) {
      return { evidenceId: Number(same.id), staged: file, skipped: false };
    }
    return { evidenceId: null, staged: file, skipped: true };
  }
  const name = String(file.originalname || '').trim().slice(0, 255) || 'file';
  const row = await db.prepare(`INSERT INTO tp_evidence
    (workspace_id, assessment_id, original_name, stored_path, size_bytes, mime_type, sha256, source, uploaded_by, vendor_request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'vendor', NULL, ?) RETURNING id`)
    .get(ctx.workspaceId, ctx.assessmentId, name, file.filename, Number(file.size) || 0,
      file.mimetype ? String(file.mimetype).slice(0, 200) : null, sha256, ctx.requestId);
  await append(db, ctx, 'evidence.uploaded', null, {
    evidence_id: Number(row.id), name, size_bytes: Number(file.size) || 0, sha256, source: 'vendor',
  });
  return { evidenceId: Number(row.id), staged: null, skipped: false };
}

async function linkFile(db, ctx, answerId, evidenceId) {
  await db.prepare(`INSERT INTO tp_answer_evidence (workspace_id, assessment_id, answer_id, evidence_id) VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING`).run(ctx.workspaceId, ctx.assessmentId, answerId, evidenceId);
}

async function removeFile(db, ctx, answer, evidenceId) {
  const row = await db.prepare(`SELECT e.id, e.original_name, e.released_to_client
    FROM tp_answer_evidence l JOIN tp_evidence e ON e.workspace_id = l.workspace_id AND e.id = l.evidence_id
    JOIN tp_vendor_requests r ON r.workspace_id = e.workspace_id AND r.id = e.vendor_request_id
    WHERE l.workspace_id = ? AND l.answer_id = ? AND l.evidence_id = ? AND e.source = 'vendor' AND r.questionnaire_id = ?
    FOR UPDATE OF e`).get(ctx.workspaceId, answer.id, evidenceId, ctx.questionnaireId);
  if (!row) throw foreign();
  const used = await usesOf(db, ctx.workspaceId, row.id);
  if (row.released_to_client || used.findings || used.clarifications) {
    throw new TprmError(409, `"${row.original_name}" is already being used by ${ctx.clientName}'s reviewers, so it can no longer be removed.`);
  }
  await db.prepare('DELETE FROM tp_answer_evidence WHERE workspace_id = ? AND answer_id = ? AND evidence_id = ?')
    .run(ctx.workspaceId, answer.id, row.id);
  return null;
}

async function usesOf(db, workspaceId, evidenceId) {
  return await db.prepare(`SELECT
      (SELECT COUNT(*)::int FROM tp_finding_evidence WHERE workspace_id = ? AND evidence_id = ?) AS findings,
      (SELECT COUNT(*)::int FROM tp_clarifications WHERE workspace_id = ? AND response_evidence_id = ?) AS clarifications,
      (SELECT COUNT(*)::int FROM tp_answer_evidence WHERE workspace_id = ? AND evidence_id = ?) AS answers,
      (SELECT COUNT(*)::int FROM tp_assurance_reports WHERE workspace_id = ?
        AND (evidence_id = ? OR soa_evidence_id = ? OR bridge_evidence_id = ?)) AS reports`)
    .get(workspaceId, evidenceId, workspaceId, evidenceId, workspaceId, evidenceId, workspaceId, evidenceId, evidenceId, evidenceId);
}

async function shelfRows(db, ctx) {
  const rows = await db.prepare(`SELECT e.id, e.original_name, e.size_bytes, e.description, e.uploaded_at, e.released_to_client,
      (SELECT COUNT(*)::int FROM tp_answer_evidence l WHERE l.workspace_id = e.workspace_id AND l.evidence_id = e.id) AS answers,
      (SELECT COUNT(*)::int FROM tp_finding_evidence f WHERE f.workspace_id = e.workspace_id AND f.evidence_id = e.id) AS findings,
      (SELECT COUNT(*)::int FROM tp_clarifications c WHERE c.workspace_id = e.workspace_id AND c.response_evidence_id = e.id) AS clarifications,
      (SELECT COUNT(*)::int FROM tp_assurance_reports a WHERE a.workspace_id = e.workspace_id
        AND (a.evidence_id = e.id OR a.soa_evidence_id = e.id OR a.bridge_evidence_id = e.id)) AS reports
    FROM tp_evidence e
    JOIN tp_vendor_requests r ON r.workspace_id = e.workspace_id AND r.id = e.vendor_request_id
    WHERE e.workspace_id = ? AND e.assessment_id = ? AND e.source = 'vendor' AND r.questionnaire_id = ?
    ORDER BY lower(e.original_name), e.id`).all(ctx.workspaceId, ctx.assessmentId, ctx.questionnaireId);
  return rows.map(d => ({
    id: Number(d.id), name: d.original_name, size: Number(d.size_bytes), description: d.description || '',
    uploadedAt: d.uploaded_at, answers: Number(d.answers), report: Number(d.reports) > 0,
    locked: !!d.released_to_client || Number(d.findings) > 0 || Number(d.clarifications) > 0,
    deletable: !d.released_to_client && !Number(d.findings) && !Number(d.clarifications) && !Number(d.answers) && !Number(d.reports),
  }));
}

async function addDocuments(db, token, body, files) {
  const pre = await linkContext(db, token);
  if (!pre || pre.mode !== 'answering') return null;
  const named = [];
  for (const file of files || []) {
    const m = String(file.fieldname || '').match(/^doc_file_([1-5])$/);
    if (!m) throw foreign();
    const description = str(body && body[`desc_${m[1]}`]);
    if (description.length > LIMITS.description) throw bad(`A description must be ${LIMITS.description} characters or fewer.`, { errors: [`A description must be ${LIMITS.description} characters or fewer.`] });
    named.push({ file, description });
  }
  if (!named.length) throw bad('Choose at least one file to add.', { errors: ['Choose at least one file to add.'] });
  const hashes = new Map();
  for (const { file } of named) hashes.set(file, await evidence.sha256File(file.path));
  return await db.transaction(async () => {
    const ctx = await lockLink(db, token);
    if (!ctx || ctx.mode !== 'answering') return null;
    const staged = [];
    let added = 0;
    let skipped = 0;
    for (const { file, description } of named) {
      const stored = await storeFile(db, ctx, file, hashes.get(file));
      if (stored.staged) staged.push(stored.staged);
      if (stored.skipped) { skipped += 1; continue; }
      if (!stored.staged) added += 1;
      if (description) await describe(db, ctx, stored.evidenceId, description);
    }
    await markOpened(db, ctx);
    return { added, skipped, staged };
  })();
}

async function describe(db, ctx, evidenceId, description) {
  const row = await db.prepare('SELECT description FROM tp_evidence WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, evidenceId);
  if ((row.description || '') === description) return false;
  await db.prepare(`UPDATE tp_evidence SET description = ?, updated_at = now(), row_version = row_version + 1
    WHERE workspace_id = ? AND id = ?`).run(description || null, ctx.workspaceId, evidenceId);
  await append(db, ctx, 'evidence.described', null, { evidence_id: Number(evidenceId), described_by: 'third_party' });
  return true;
}

async function updateDocument(db, token, evidenceId, body) {
  const id = Number(evidenceId);
  if (!Number.isSafeInteger(id) || id < 1) throw foreign();
  return await db.transaction(async () => {
    const ctx = await lockLink(db, token);
    if (!ctx || ctx.mode !== 'answering') return null;
    const doc = (await shelfRows(db, ctx)).find(d => d.id === id);
    if (!doc) throw foreign();
    if (str(body && body.delete) === '1') {
      if (!doc.deletable) {
        throw new TprmError(409, doc.answers || doc.report
          ? `"${doc.name}" is still chosen for an answer or a report. Remove it there first.`
          : `"${doc.name}" is already being used by ${ctx.clientName}'s reviewers, so it can no longer be deleted.`);
      }
      const row = await db.prepare(`SELECT original_name, stored_path, size_bytes, sha256 FROM tp_evidence WHERE workspace_id = ? AND id = ? FOR UPDATE`)
        .get(ctx.workspaceId, id);
      await db.prepare('DELETE FROM tp_evidence WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, id);
      await append(db, ctx, 'evidence.deleted', { evidence_id: id, name: row.original_name, size_bytes: Number(row.size_bytes),
        sha256: row.sha256, source: 'vendor' }, { removed_by: 'third_party' });
      return { deleted: doc.name, path: row.stored_path };
    }
    const description = str(body && body.description);
    if (description.length > LIMITS.description) throw bad(`A description must be ${LIMITS.description} characters or fewer.`, { errors: [`A description must be ${LIMITS.description} characters or fewer.`] });
    return { described: await describe(db, ctx, id, description), name: doc.name };
  })();
}

async function invitationFacts(db, ids) {
  const p = await pageData(db, { ...ids, mode: 'answering' });
  const named = p.sections.some(s => s.questions.some(q => q.document));
  return {
    total: p.total,
    sections: p.sections.length,
    documentRequests: p.counts.documents,
    documentGroups: named ? p.documentsNeeded.map(g => ({ group: g.group, count: g.documents.length })) : [],
  };
}

function questionCounts(items) {
  const n = { choice: 0, written: 0, documents: 0 };
  for (const it of items) {
    if (it.written) n.written += 1; else n.choice += 1;
    if (it.document) n.documents += 1;
  }
  return n;
}

function documentGroups(items) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.group)) groups.set(it.group, new Map());
    const docs = groups.get(it.group);
    if (!docs.has(it.name)) docs.set(it.name, []);
    docs.get(it.name).push(it.questionId);
  }
  return [...groups].map(([group, docs]) => ({ group, documents: [...docs].map(([name, questions]) => ({ name, questions })) }));
}
const docName = text => String(text || '').trim().replace(/[.]$/, '');

async function prefillFromPrevious(db, { workspaceId, assessment, questionnaireId, ids, actorId = null, byThirdParty = null }) {
  if (!assessment || assessment.type !== 'reassessment' || !ids.length) return 0;
  const prev = await db.prepare(`SELECT q.id FROM tp_questionnaires q
    JOIN tp_assessments a ON a.workspace_id = q.workspace_id AND a.id = q.assessment_id
    WHERE q.workspace_id = ? AND a.third_party_id = ? AND q.id <> ? AND q.submitted_at IS NOT NULL
    ORDER BY q.submitted_at DESC, q.id DESC LIMIT 1`).get(workspaceId, assessment.third_party_id, questionnaireId);
  if (!prev) return 0;
  const rows = await db.prepare(`SELECT id, question_id, response, detail, fields, evidence_ref, to_char(evidence_date, 'YYYY-MM-DD') AS evidence_date FROM tp_answers
    WHERE workspace_id = ? AND questionnaire_id = ? AND response IS NOT NULL
      AND question_id IN (${ids.map(() => '?').join(',')})`).all(workspaceId, prev.id, ...ids);
  const existing = new Set((await db.prepare('SELECT question_id FROM tp_answers WHERE workspace_id = ? AND questionnaire_id = ?')
    .all(workspaceId, questionnaireId)).map(r => r.question_id));
  const target = await db.prepare(`SELECT q.bank_version_id, COALESCE(NULLIF(w.brand_display_name, ''), w.client_name) AS client_name FROM tp_questionnaires q
    JOIN workspaces w ON w.id = q.workspace_id WHERE q.workspace_id = ? AND q.id = ?`).get(workspaceId, questionnaireId);
  const rules = rulesMap(await questionnaires.bankContent(db, target.bank_version_id), target.client_name);
  let copied = 0;
  let skipped = 0;
  for (const r of rows) {
    if (existing.has(r.question_id)) continue;
    const copy = normalisedCopy(rules.get(r.question_id) || LEGACY_RULES, r);
    if (!copy) { skipped += 1; continue; }
    await db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response, detail, fields,
        evidence_ref, evidence_date, prefilled_from_answer_id) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)`)
      .run(workspaceId, assessment.id, questionnaireId, r.question_id, copy.response, copy.detail,
        copy.fields && Object.keys(copy.fields).length ? JSON.stringify(copy.fields) : null, copy.evidence_ref, copy.evidence_date, r.id);
    copied += 1;
  }
  if (copied) {
    const after = { questionnaire_id: Number(questionnaireId), from_questionnaire_id: Number(prev.id), count: copied,
      ...(skipped ? { not_copied: skipped } : {}) };
    if (byThirdParty) await append(db, byThirdParty, 'questionnaire.prefilled', null, after);
    else {
      await events.appendEvent(db, { workspaceId, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id, actorId,
        action: 'questionnaire.prefilled', before: null, after });
    }
  }
  return copied;
}

async function applyAiScreening(db, ctx, bank) {
  const q = ctx.questionnaire;
  const before = { modules: (q.modules || []).filter(m => m.included).map(m => m.module), vendor_question_count: q.vendor_question_count };
  const screening = await db.prepare(`SELECT response FROM tp_answers WHERE workspace_id = ? AND questionnaire_id = ? AND question_id = ?`)
    .get(ctx.workspaceId, ctx.questionnaireId, AI_SCREENING);
  const response = screening ? screening.response : null;
  const modules = (q.modules || []).map(m => ({ ...m }));
  let entry = modules.find(m => m.module === AI_MODULE) || null;
  if (entry && entry.source !== AI_SOURCE) return null;
  if (!assemblyOffers(bank, AI_MODULE)) return null;
  const stamp = { changed_by: null, changed_by_name: 'the third party', changed_at: new Date().toISOString() };
  let outcome = null;
  if (response === 'yes') {
    if (entry && entry.included) {
      if (!entry.flag) return null;
      delete entry.flag;
      outcome = 'flag_cleared';
    } else {
      if (!entry) { entry = { module: AI_MODULE }; modules.push(entry); }
      Object.assign(entry, { source: AI_SOURCE, because: AI_ADDED_BECAUSE, included: true, reason: 'Answered Yes to AIS-01', ...stamp });
      delete entry.flag;
      outcome = 'added';
    }
  } else if (response === 'no' && entry && entry.included) {
    const aiSection = (q.sections || []).find(s => s.kind === 'module' && s.title === AI_MODULE);
    const aiIds = aiSection ? aiSection.ids : [];
    const saved = aiIds.length ? await db.prepare(`SELECT COUNT(*)::int AS c FROM tp_answers WHERE workspace_id = ? AND questionnaire_id = ?
        AND saved_at IS NOT NULL AND question_id IN (${aiIds.map(() => '?').join(',')})`).get(ctx.workspaceId, ctx.questionnaireId, ...aiIds) : { c: 0 };
    if (saved.c > 0) {
      if (entry.flag) return null;
      entry.flag = AI_KEPT_FLAG;
      outcome = 'kept';
    } else {
      if (aiIds.length) {
        await db.prepare(`DELETE FROM tp_answers WHERE workspace_id = ? AND questionnaire_id = ? AND saved_at IS NULL
          AND question_id IN (${aiIds.map(() => '?').join(',')})`).run(ctx.workspaceId, ctx.questionnaireId, ...aiIds);
      }
      Object.assign(entry, { included: false, reason: 'Answered No to AIS-01', ...stamp });
      delete entry.flag;
      outcome = 'removed';
    }
  } else {
    return null;
  }
  const content = questionnaires.contentFor(bank, { tier: q.tier, deliveryModel: q.delivery_model, modules, rulebooks: q.rulebooks });
  await db.prepare(`UPDATE tp_questionnaires SET modules = ?::jsonb, dynamic_modules = ?::jsonb, sections = ?::jsonb,
      vendor_question_count = ?, updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
    .run(json(modules), json(content.dynamic_modules), json(content.sections), content.vendor_question_count, ctx.workspaceId, ctx.questionnaireId);
  Object.assign(q, { modules, dynamic_modules: content.dynamic_modules, sections: content.sections, vendor_question_count: content.vendor_question_count });
  if (outcome === 'flag_cleared') return null;
  const action = { added: 'questionnaire.module_added', removed: 'questionnaire.module_removed', kept: 'questionnaire.module_kept' }[outcome];
  await append(db, ctx, action, before, {
    questionnaire_id: ctx.questionnaireId, module: AI_MODULE, source: AI_SOURCE,
    reason: outcome === 'added' ? 'Answered Yes to AIS-01' : outcome === 'removed' ? 'Answered No to AIS-01' : AI_KEPT_FLAG,
    modules: modules.filter(m => m.included).map(m => m.module), vendor_question_count: content.vendor_question_count,
  });
  if (outcome === 'added') {
    const aiSection = content.sections.find(s => s.kind === 'module' && s.title === AI_MODULE);
    const assessment = { id: ctx.assessmentId, third_party_id: ctx.thirdPartyId, type: ctx.assessmentType };
    await prefillFromPrevious(db, { workspaceId: ctx.workspaceId, assessment, questionnaireId: ctx.questionnaireId,
      ids: aiSection ? aiSection.ids : [], byThirdParty: ctx });
  }
  return outcome;
}

function assemblyOffers(bank, name) {
  return require('./questionnaire-assembly').offeredModules(bank).includes(name);
}

async function saveAnswers(db, token, body, files) {
  const pre = await linkContext(db, token);
  if (!pre || pre.mode !== 'answering') return null;
  const qRow = await db.prepare('SELECT sections, bank_version_id FROM tp_questionnaires WHERE workspace_id = ? AND id = ?').get(pre.workspaceId, pre.questionnaireId);
  const rules = rulesMap(await questionnaires.bankContent(db, qRow.bank_version_id), pre.clientName);
  const parsed = parseAnswerForm(body, files, sectionIds(qRow), id => rules.get(id));
  const hashes = new Map();
  for (const list of parsed.uploads.values()) for (const f of list) hashes.set(f, await evidence.sha256File(f.path));

  return await db.transaction(async () => {
    const ctx = await lockLink(db, token);
    if (!ctx || ctx.mode !== 'answering') return null;
    const allowed = new Set(sectionIds(ctx.questionnaire));
    for (const id of parsed.posted.keys()) {
      if (!allowed.has(id)) throw new TprmError(409, 'The questions changed while you were answering. Reload the page: your saved answers are kept.');
    }
    const bank = await questionnaires.bankContent(db, ctx.questionnaire.bank_version_id);
    const existing = await answersOf(db, ctx.workspaceId, ctx.questionnaireId);
    const shelf = new Set((await shelfRows(db, ctx)).map(d => d.id));
    const changed = [];
    const removedPaths = [];
    const staged = [];
    let skipped = 0;
    let touched = false;
    for (const [id, v] of parsed.posted) {
      const old = existing.get(id) || null;
      const uploads = parsed.uploads.get(id) || [];
      const removals = parsed.removals.get(id) || [];
      const picks = parsed.picks.get(id) || [];
      for (const evidenceId of picks) if (!shelf.has(evidenceId)) throw foreign();
      const isChange = old ? differs(old, v) : hasContent(v);
      const files = uploads.length || picks.length || removals.length;
      const confirmsPrefill = !!(old && old.prefilled_from_answer_id && !old.prefill_confirmed_at && (isChange || v.confirm || files));
      if (!isChange && !confirmsPrefill && !files) continue;
      if (!old && !isChange && !uploads.length && !picks.length) continue;
      touched = true;
      let answer = old;
      if (!old) {
        answer = await db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response, detail, fields,
            evidence_ref, evidence_date, saved_at, saved_by_request_id) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, now(), ?) RETURNING id`)
          .get(ctx.workspaceId, ctx.assessmentId, ctx.questionnaireId, id, v.response || null, v.detail || null,
            v.fields && Object.keys(v.fields).length ? JSON.stringify(v.fields) : null, v.evidence_ref || null, v.evidence_date || null, ctx.requestId);
      } else {
        await db.prepare(`UPDATE tp_answers SET response = ?, detail = ?, fields = ?::jsonb, evidence_ref = ?, evidence_date = ?, saved_at = now(),
            saved_by_request_id = ?, prefill_confirmed_at = CASE WHEN prefilled_from_answer_id IS NOT NULL
              THEN COALESCE(prefill_confirmed_at, now()) ELSE NULL END,
            updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
          .run(v.response || null, v.detail || null, v.fields && Object.keys(v.fields).length ? JSON.stringify(v.fields) : null,
            v.evidence_ref || null, v.evidence_date || null, ctx.requestId, ctx.workspaceId, old.id);
      }
      for (const evidenceId of removals) {
        const path = await removeFile(db, ctx, answer, evidenceId);
        if (path) removedPaths.push(path);
      }
      for (const file of uploads) {
        const stored = await storeFile(db, ctx, file, hashes.get(file));
        if (stored.staged) staged.push(stored.staged);
        if (stored.skipped) skipped += 1;
        if (stored.evidenceId) await linkFile(db, ctx, answer.id, stored.evidenceId);
      }
      for (const evidenceId of picks) await linkFile(db, ctx, answer.id, evidenceId);
      changed.push({ question_id: id, response: v.response || null, ...(confirmsPrefill && !isChange ? { confirmed: true } : {}),
        ...(uploads.length ? { files_added: uploads.length } : {}), ...(picks.length ? { documents_chosen: picks.length } : {}),
        ...(removals.length ? { files_removed: removals.length } : {}) });
    }
    if (!touched) {
      await markOpened(db, ctx);
      return { changed: 0, ai: null, removedPaths, staged, skipped };
    }
    await markOpened(db, ctx);
    await append(db, ctx, 'questionnaire.answers_saved', null, { questionnaire_id: ctx.questionnaireId, count: changed.length, changed });
    const ai = changed.some(c => c.question_id === AI_SCREENING) ? await applyAiScreening(db, ctx, bank) : null;
    return { changed: changed.length, ai, removedPaths, staged, skipped };
  })();
}

async function sectionList(db, ctx) {
  const q = await db.prepare('SELECT sections FROM tp_questionnaires WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, ctx.questionnaireId);
  return q && Array.isArray(q.sections) ? q.sections : [];
}

async function sectionCount(db, ctx) {
  return (await sectionList(db, ctx)).length;
}

async function reviewSubmission(db, token) {
  const ctx = await linkContext(db, token);
  if (!ctx || ctx.mode !== 'answering') return null;
  return await pageData(db, ctx);
}

async function submit(db, token) {
  return await db.transaction(async () => {
    const ctx = await lockLink(db, token);
    if (!ctx || ctx.mode !== 'answering') return null;
    const bank = await questionnaires.bankContent(db, ctx.questionnaire.bank_version_id);
    const answers = await answersOf(db, ctx.workspaceId, ctx.questionnaireId);
    const files = await filesOf(db, ctx.workspaceId, ctx.questionnaireId);
    const reports = rulesLib.bankTyped(bank) ? await require('./assurance-reports').loadReports(db, ctx.workspaceId, ctx.questionnaireId) : [];
    const problems = submissionProblems(ctx.questionnaire, bank, answers, files, reports);
    if (problems.length) return { problems };
    await markOpened(db, ctx);
    await db.prepare(`UPDATE tp_answers SET submitted_at = now(), updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND questionnaire_id = ? AND submitted_at IS NULL`).run(ctx.workspaceId, ctx.questionnaireId);
    const row = await db.prepare(`UPDATE tp_questionnaires SET status = 'submitted', submitted_at = now(), updated_at = now(),
        row_version = row_version + 1 WHERE workspace_id = ? AND id = ? RETURNING submitted_at`).get(ctx.workspaceId, ctx.questionnaireId);
    await db.prepare(`UPDATE tp_vendor_requests SET status = 'submitted', updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND status = 'active'`).run(ctx.workspaceId, ctx.requestId);
    const counts = {};
    for (const a of answers.values()) if (a.response) counts[a.response] = (counts[a.response] || 0) + 1;
    await append(db, ctx, 'questionnaire.submitted', { status: ctx.questionnaire.status }, {
      status: 'submitted', questionnaire_id: ctx.questionnaireId, vendor_question_count: ctx.questionnaire.vendor_question_count,
      responses: counts, files: [...files.values()].reduce((n, l) => n + l.length, 0),
      ...(reports.length ? { reports: reports.map(r => ({ report_id: Number(r.id), kind: r.kind })) } : {}),
    });
    await append(db, ctx, 'vendor_link.used', { status: 'active' }, { status: 'submitted', questionnaire_id: ctx.questionnaireId });
    await require('./ai-review').enqueueOnSubmission(db, {
      workspaceId: ctx.workspaceId, thirdPartyId: ctx.thirdPartyId, assessmentId: ctx.assessmentId, questionnaireId: ctx.questionnaireId,
    });
    return { submittedAt: row.submitted_at, clientName: ctx.clientName, workspaceId: ctx.workspaceId, assessmentId: ctx.assessmentId,
      requestId: ctx.requestId, questionnaireId: ctx.questionnaireId };
  })();
}

async function answerClarification(db, token, clarificationId, body, file) {
  const id = Number(clarificationId);
  if (!Number.isSafeInteger(id) || id < 1) throw foreign();
  const response = str(body && body.response);
  if (!response) throw bad('Write your response to the clarification.', { clarificationId: id });
  if (response.length > LIMITS.response) throw bad(`The response must be ${LIMITS.response} characters or fewer.`, { clarificationId: id });
  const sha256 = file ? await evidence.sha256File(file.path) : null;
  return await db.transaction(async () => {
    const ctx = await lockLink(db, token);
    if (!ctx) return null;
    const c = await db.prepare(`SELECT id, question_id, status FROM tp_clarifications
      WHERE workspace_id = ? AND questionnaire_id = ? AND id = ? FOR UPDATE`).get(ctx.workspaceId, ctx.questionnaireId, id);
    if (!c) throw foreign();
    if (c.status !== 'open') throw new TprmError(409, 'This clarification has already been answered.');
    let evidenceId = null;
    let staged = null;
    if (file) {
      const stored = await storeFile(db, ctx, file, sha256);
      evidenceId = stored.evidenceId;
      staged = stored.staged;
    }
    await db.prepare(`UPDATE tp_clarifications SET response = ?, response_evidence_id = ?, responded_at = now(),
        responded_by_request_id = ?, status = 'answered', updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ?`).run(response, evidenceId, ctx.requestId, ctx.workspaceId, c.id);
    if (!ctx.lastOpenedAt) {
      await db.prepare(`UPDATE tp_vendor_requests SET last_opened_at = now(), updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ?`).run(ctx.workspaceId, ctx.requestId);
    }
    await append(db, ctx, 'clarification.answered', { clarification_id: Number(c.id), status: 'open' }, {
      clarification_id: Number(c.id), question_id: c.question_id, status: 'answered', evidence_id: evidenceId,
    });
    return { staged, clarificationId: Number(c.id), workspaceId: ctx.workspaceId, assessmentId: ctx.assessmentId };
  })();
}

const REPORT_FILES = Object.freeze({
  iso27001: Object.freeze({ report_file: 'evidence_id', soa_file: 'soa_evidence_id' }),
  soc2_type2: Object.freeze({ report_file: 'evidence_id', bridge_file: 'bridge_evidence_id' }),
});
const REPORT_FILE_LABELS = Object.freeze({ report_file: { iso27001: 'the certificate', soc2_type2: 'the report' }, soa_file: 'the Statement of Applicability', bridge_file: 'the bridge letter' });

async function dropFileIfUnused(db, ctx, evidenceId) {
  if (!evidenceId) return null;
  const row = await db.prepare(`SELECT e.id, e.original_name, e.stored_path, e.size_bytes, e.sha256, e.released_to_client
    FROM tp_evidence e JOIN tp_vendor_requests r ON r.workspace_id = e.workspace_id AND r.id = e.vendor_request_id
    WHERE e.workspace_id = ? AND e.id = ? AND e.source = 'vendor' AND r.questionnaire_id = ? FOR UPDATE OF e`)
    .get(ctx.workspaceId, evidenceId, ctx.questionnaireId);
  if (!row || row.released_to_client) return null;
  const used = await db.prepare(`SELECT
      (SELECT COUNT(*)::int FROM tp_finding_evidence WHERE workspace_id = ? AND evidence_id = ?)
    + (SELECT COUNT(*)::int FROM tp_clarifications WHERE workspace_id = ? AND response_evidence_id = ?)
    + (SELECT COUNT(*)::int FROM tp_answer_evidence WHERE workspace_id = ? AND evidence_id = ?)
    + (SELECT COUNT(*)::int FROM tp_assurance_reports WHERE workspace_id = ? AND (evidence_id = ? OR soa_evidence_id = ? OR bridge_evidence_id = ?)) AS n`)
    .get(ctx.workspaceId, row.id, ctx.workspaceId, row.id, ctx.workspaceId, row.id, ctx.workspaceId, row.id, row.id, row.id);
  if (used.n > 0) return null;
  await db.prepare('DELETE FROM tp_evidence WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, row.id);
  await append(db, ctx, 'evidence.deleted', { evidence_id: Number(row.id), name: row.original_name, size_bytes: Number(row.size_bytes),
    sha256: row.sha256, source: 'vendor' }, { removed_by: 'third_party' });
  return row.stored_path;
}

function parseReportForm(body, files) {
  const kind = str(body && body.kind);
  if (!rulesLib.KINDS.includes(kind)) throw foreign();
  const allowed = REPORT_FILES[kind];
  const chosen = {};
  for (const f of files || []) {
    if (!Object.prototype.hasOwnProperty.call(allowed, f.fieldname) || chosen[f.fieldname]) throw foreign();
    chosen[f.fieldname] = f;
  }
  const remove = str(body && body.remove) === '1';
  const fields = {
    expires_on: str(body && body.expires_on),
    scope: str(body && body.scope),
    period_end: str(body && body.period_end),
  };
  return { kind, remove, fields, files: chosen };
}

async function saveReport(db, token, body, files) {
  const pre = await linkContext(db, token);
  if (!pre || pre.mode !== 'answering') return null;
  const parsed = parseReportForm(body, files);
  const hashes = new Map();
  for (const f of Object.values(parsed.files)) hashes.set(f, await evidence.sha256File(f.path));
  return await db.transaction(async () => {
    const ctx = await lockLink(db, token);
    if (!ctx || ctx.mode !== 'answering') return null;
    const bank = await questionnaires.bankContent(db, ctx.questionnaire.bank_version_id);
    if (!rulesLib.bankTyped(bank)) {
      throw new TprmError(409, 'Reports cannot be used to cover evidence on this questionnaire.');
    }
    const { kind, fields } = parsed;
    const existing = await db.prepare(`SELECT * FROM tp_assurance_reports WHERE workspace_id = ? AND questionnaire_id = ? AND kind = ? FOR UPDATE`)
      .get(ctx.workspaceId, ctx.questionnaireId, kind);
    const removedPaths = [];
    const staged = [];
    const label = rulesLib.KIND_LABELS[kind];
    if (parsed.remove) {
      for (const f of Object.values(parsed.files)) staged.push(f);
      if (!existing) return { kind, outcome: 'unchanged', removedPaths, staged };
      await db.prepare('DELETE FROM tp_assurance_reports WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, existing.id);
      for (const col of ['evidence_id', 'soa_evidence_id', 'bridge_evidence_id']) {
        const p = await dropFileIfUnused(db, ctx, existing[col]);
        if (p) removedPaths.push(p);
      }
      await markOpened(db, ctx);
      await append(db, ctx, 'assurance_report.removed', { report_id: Number(existing.id), kind }, { kind, questionnaire_id: ctx.questionnaireId });
      return { kind, outcome: 'removed', removedPaths, staged };
    }
    const errors = [];
    const need = (field, message) => { if (!existing && !parsed.files[field]) errors.push(message); };
    if (kind === 'iso27001') {
      need('report_file', 'Attach the ISO 27001 certificate.');
      need('soa_file', 'Attach the Statement of Applicability.');
      if (!isRealDate(fields.expires_on)) errors.push('Give the date the certificate expires.');
      else if (fields.expires_on < today()) errors.push('The certificate has already expired, so it cannot cover any evidence. Ask your certification body for the current certificate.');
      if (!fields.scope) errors.push('Copy the scope statement from the certificate.');
      else if (fields.scope.length > LIMITS.scope) errors.push(`The scope must be ${LIMITS.scope} characters or fewer.`);
    } else {
      need('report_file', 'Attach the SOC 2 Type II report.');
      if (!isRealDate(fields.period_end)) errors.push('Give the date the report period ended.');
      else if (fields.period_end > tomorrow()) errors.push('The report period end cannot be in the future.');
    }
    if (errors.length) throw bad(errors.join(' '), { errors, reportKind: kind, reportValues: fields });
    const ids = {};
    for (const [field, col] of Object.entries(REPORT_FILES[kind])) {
      const file = parsed.files[field];
      if (!file) continue;
      const stored = await storeFile(db, ctx, file, hashes.get(file));
      if (stored.staged) staged.push(stored.staged);
      if (!stored.evidenceId) {
        const what = field === 'report_file' ? REPORT_FILE_LABELS.report_file[kind] : REPORT_FILE_LABELS[field];
        throw bad(`The file for ${what} is already one of the firm's own files. Choose the file from your own records.`, { reportKind: kind, reportValues: fields });
      }
      ids[col] = stored.evidenceId;
    }
    const values = kind === 'iso27001'
      ? { certificate_expires_on: fields.expires_on, scope: fields.scope, period_end: null }
      : { certificate_expires_on: null, scope: null, period_end: fields.period_end };
    let reportId;
    let outcome;
    if (!existing) {
      const row = await db.prepare(`INSERT INTO tp_assurance_reports (workspace_id, assessment_id, questionnaire_id, kind, evidence_id,
          soa_evidence_id, bridge_evidence_id, certificate_expires_on, scope, period_end, uploaded_by_request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(ctx.workspaceId, ctx.assessmentId, ctx.questionnaireId, kind, ids.evidence_id, ids.soa_evidence_id || null,
          ids.bridge_evidence_id || null, values.certificate_expires_on, values.scope, values.period_end, ctx.requestId);
      reportId = Number(row.id);
      outcome = 'added';
    } else {
      const next = {
        evidence_id: ids.evidence_id || existing.evidence_id,
        soa_evidence_id: kind === 'iso27001' ? ids.soa_evidence_id || existing.soa_evidence_id : null,
        bridge_evidence_id: kind === 'soc2_type2' ? ids.bridge_evidence_id || existing.bridge_evidence_id : null,
      };
      const day = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
      const same = Number(next.evidence_id) === Number(existing.evidence_id)
        && Number(next.soa_evidence_id || 0) === Number(existing.soa_evidence_id || 0)
        && Number(next.bridge_evidence_id || 0) === Number(existing.bridge_evidence_id || 0)
        && values.certificate_expires_on === day(existing.certificate_expires_on) && values.period_end === day(existing.period_end)
        && (values.scope || null) === (existing.scope || null);
      if (same) return { kind, outcome: 'unchanged', removedPaths, staged };
      await db.prepare(`UPDATE tp_assurance_reports SET evidence_id = ?, soa_evidence_id = ?, bridge_evidence_id = ?, certificate_expires_on = ?,
          scope = ?, period_end = ?, uploaded_by_request_id = ?, uploaded_at = now(), updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ?`)
        .run(next.evidence_id, next.soa_evidence_id, next.bridge_evidence_id, values.certificate_expires_on, values.scope, values.period_end,
          ctx.requestId, ctx.workspaceId, existing.id);
      for (const col of ['evidence_id', 'soa_evidence_id', 'bridge_evidence_id']) {
        if (existing[col] && Number(existing[col]) !== Number(next[col] || 0)) {
          const p = await dropFileIfUnused(db, ctx, existing[col]);
          if (p) removedPaths.push(p);
        }
      }
      reportId = Number(existing.id);
      outcome = 'updated';
    }
    await markOpened(db, ctx);
    const rows = sectionIds(ctx.questionnaire).map(id => bank.questions.find(q => q.id === id)).filter(Boolean);
    await append(db, ctx, `assurance_report.${outcome === 'added' ? 'uploaded' : 'updated'}`, existing ? { report_id: reportId, kind } : null, {
      report_id: reportId, kind, label, questionnaire_id: ctx.questionnaireId, ...values,
      evidence_ids: Object.values(ids).map(Number), covers: rulesLib.wouldCover(rows, kind),
    });
    return { kind, outcome, removedPaths, staged };
  })();
}

module.exports = {
  RESPONSES, RESPONSE_LABELS, DETAIL_REQUIRED, EVIDENCE_RESPONSES, LIMITS, AI_MODULE, AI_SCREENING, AI_SOURCE, AI_KEPT_FLAG,
  EVENT_LABELS, ANSWERING, CLARIFYING, REPORT_FILES,
  formToken, verifyFormToken, linkContext, submittedLink, pageData, parseAnswerForm, submissionProblems, normalisedCopy, rulesMap,
  requestMap, stateOf, sectionList, sectionCount, saveAnswers, reviewSubmission, submit, answerClarification, prefillFromPrevious, saveReport,
  questionCounts, documentGroups, addDocuments, updateDocument, invitationFacts,
};
