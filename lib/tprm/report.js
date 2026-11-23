'use strict';

const crypto = require('crypto');
const events = require('./events');
const placement = require('./placement');
const recommendations = require('./recommendations');
const findings = require('./findings');
const decisions = require('./decisions');
const assessments = require('./assessments');
const letterhead = require('./letterhead');
const format = require('./format');
const { TprmError } = require('./errors');
const { todayFor } = require('../dates');

const EVENT = 'recommendation.report_generated';
const EVENT_LABELS = Object.freeze({ [EVENT]: 'Recommendation report downloaded' });
const AUDIENCES = Object.freeze(['firm', 'client']);
const CONDITION_STATUS_LABELS = Object.freeze({ open: 'Open' });

let renderPdf = (html, opts) => require('../audit-pack').renderPDF(html, opts);
const APP_FONT = require('../audit-pack').APP_FONT_STACK;
function configure({ renderPdf: fn } = {}) {
  if (typeof fn === 'function') renderPdf = fn;
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const notFound = () => new TprmError(404, 'This report does not exist, or it is not available to your account.');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function day(value) {
  if (!value) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(text);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function when(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return '';
  return `${day(d)}, ${d.toISOString().slice(11, 16)} UTC`;
}
const capitalise = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const statusLabel = s => CONDITION_STATUS_LABELS[s] || capitalise(String(s || '').replace(/_/g, ' '));

const REC_SQL = `SELECT r.id, r.assessment_id, r.version, r.status, r.outcome, r.residual_rating, r.rationale,
      r.valid_until::text AS valid_until, r.issued_at, rv.name AS issued_by_name, rv.firm_role AS issued_by_role,
      r.submitted_at, r.author_id, r.reviewer_id, au.name AS prepared_by_name, au.firm_role AS prepared_by_role
    FROM tp_recommendations r LEFT JOIN users rv ON rv.id = r.reviewer_id LEFT JOIN users au ON au.id = r.author_id
    WHERE r.workspace_id = ? AND r.id = ? AND r.status = 'issued' AND r.issued_at IS NOT NULL`;
const ASSESSMENT_SQL = `SELECT a.id, a.third_party_id, a.type, a.status, a.scored_tier, a.final_tier,
      a.tier_explanation, a.override_direction, a.override_reason,
      a.services_in_scope, a.answers, a.criticality_model_id, a.deciding_question_id
    FROM tp_assessments a WHERE a.workspace_id = ? AND a.id = ?`;
const tierLabel = k => (k ? placement.TIER_LABELS[k] || capitalise(k) : '');

async function liveVersion(db, ws, recommendationId) {
  const rid = Number(recommendationId);
  if (!ws || !Number.isSafeInteger(rid) || rid < 1) return null;
  const rec = await db.prepare(REC_SQL).get(ws.id, rid);
  if (!rec) return null;
  const assessment = await db.prepare(ASSESSMENT_SQL).get(ws.id, rec.assessment_id);
  if (!assessment || assessment.status === 'cancelled') return null;
  return { rec, assessment };
}

async function snapshotContent(db, ws, rec, assessment) {
  const thirdParty = await db.prepare('SELECT t.id, t.name FROM tp_third_parties t WHERE t.workspace_id = ? AND t.id = ?')
    .get(ws.id, assessment.third_party_id);
  const conditions = await db.prepare(`SELECT c.position, c.description, c.owner, c.due_date::text AS due_date, c.automatic
    FROM tp_conditions c WHERE c.workspace_id = ? AND c.recommendation_id = ? ORDER BY c.position, c.id`).all(ws.id, rec.id);
  const exitPlanLines = await require('./exit-plans').reportLines(db, ws.id, assessment.id);
  const findingRows = await db.prepare(`SELECT f.title, f.severity, f.control_ref, f.status FROM tp_findings f
    WHERE f.workspace_id = ? AND f.assessment_id = ?
    ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, f.id`).all(ws.id, assessment.id);
  const files = await db.prepare(`SELECT e.original_name, e.released_at FROM tp_evidence e
    WHERE e.workspace_id = ? AND e.assessment_id = ? AND e.released_to_client ORDER BY e.released_at, e.id`).all(ws.id, assessment.id);
  const q = await db.prepare(`SELECT q.id, q.status, q.sent_at, q.submitted_at, q.not_returned, q.vendor_question_count, q.sections, q.rulebooks, q.delivery_model
    FROM tp_questionnaires q WHERE q.workspace_id = ? AND q.assessment_id = ?`).get(ws.id, assessment.id);

  let questionnaire;
  if (!q || q.status === 'draft') questionnaire = 'No questionnaire was sent to the third party.';
  else if (q.not_returned) questionnaire = 'Questionnaire not returned by the third party.';
  else if (q.submitted_at) questionnaire = `Questionnaire submitted by the third party on ${day(q.submitted_at)}.`;
  else questionnaire = 'Questionnaire sent to the third party, not returned yet.';

  const override = assessment.override_direction && assessment.override_direction !== 'none'
    ? `${assessment.override_direction === 'raise' ? 'Raised' : 'Lowered'} from ${tierLabel(assessment.scored_tier)} to ${tierLabel(assessment.final_tier)}: ${assessment.override_reason || ''}`.trim()
    : null;
  return {
    clientName: ws.brand_display_name || ws.client_name,
    thirdPartyName: thirdParty ? thirdParty.name : '',
    assessmentId: Number(assessment.id),
    thirdPartyId: Number(assessment.third_party_id),
    assessmentType: assessments.TYPE_LABELS[assessment.type] || assessment.type,
    recommendation: {
      id: Number(rec.id),
      version: Number(rec.version),
      outcome: rec.outcome,
      outcomeLabel: recommendations.outcomeLabel(assessment.type, rec.outcome),
      residual: tierLabel(rec.residual_rating),
      rationale: rec.rationale || '',
      validUntil: rec.valid_until ? day(rec.valid_until) : null,
      issuedOn: when(rec.issued_at),
      issuedDay: day(rec.issued_at),
      issuedBy: rec.issued_by_name || 'the firm',
    },
    tier: {
      label: tierLabel(assessment.final_tier),
      reason: capitalise(assessment.tier_explanation || ''),
      override,
    },
    conditions: conditions.map((c, i) => ({
      n: i + 1,
      description: c.description || '',
      owner: recommendations.CONDITION_OWNER_LABELS[c.owner] || c.owner || '',
      due: day(c.due_date),
      status: statusLabel('open'),
      ...(c.automatic ? { automatic: true } : {}),
    })),
    findings: findingRows.map(f => ({
      title: f.title,
      severity: findings.SEVERITY_LABELS[f.severity] || f.severity,
      control: f.control_ref || '',
      status: findings.STATUS_LABELS[f.status] || f.status,
    })),
    evidence: files.map(e => ({ name: e.original_name, sharedOn: day(e.released_at) })),
    questionnaire,
    ...(exitPlanLines ? { exitPlans: exitPlanLines } : {}),
    ...(await reportContentV2(db, ws, rec, assessment, q)),
  };
}

const RESPONSE_NA = 'na';
const GAP_CONCLUSIONS = ['partially_satisfactory', 'unsatisfactory'];
const roleLabel = role => (require('../rbac').ROLE_LABELS[role] || '');
const iso = v => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

async function reportContentV2(db, ws, rec, assessment, q) {
  const firm = await db.prepare('SELECT timezone FROM firms WHERE id = ?').get(ws.firm_id);
  const zone = format.zoneOf(ws, firm);

  const findingRows = await db.prepare(`SELECT f.id, f.title, f.severity, f.control_ref, f.status, f.description, f.impact
    FROM tp_findings f WHERE f.workspace_id = ? AND f.assessment_id = ?
    ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, f.id`).all(ws.id, assessment.id);
  const findingNo = new Map(findingRows.map((f, i) => [Number(f.id), i + 1]));
  const conditionRows = await db.prepare(`SELECT c.position, c.description, c.owner, c.due_date::text AS due_date, c.automatic, c.finding_id
    FROM tp_conditions c WHERE c.workspace_id = ? AND c.recommendation_id = ? ORDER BY c.position, c.id`).all(ws.id, rec.id);
  const conditionDetails = conditionRows.map((c, i) => ({
    n: i + 1,
    description: c.description || '',
    owner: recommendations.CONDITION_OWNER_LABELS[c.owner] || c.owner || '',
    due: c.due_date || null,
    automatic: !!c.automatic,
    finding: c.finding_id ? findingNo.get(Number(c.finding_id)) || null : null,
  }));
  const findingDetails = findingRows.map((f, i) => ({
    n: i + 1,
    title: f.title,
    severity: findings.SEVERITY_LABELS[f.severity] || f.severity,
    control: f.control_ref || '',
    status: findings.STATUS_LABELS[f.status] || f.status,
    description: f.description || '',
    impact: f.impact || '',
    conditions: conditionDetails.filter(c => c.finding === i + 1).map(c => c.n),
  }));

  const files = await db.prepare(`SELECT e.id, e.original_name, e.uploaded_at, e.source, e.released_to_client, e.released_at
    FROM tp_evidence e WHERE e.workspace_id = ? AND e.assessment_id = ? ORDER BY e.uploaded_at, e.id`).all(ws.id, assessment.id);
  const supportsAnswer = await db.prepare(`SELECT l.evidence_id, a.question_id FROM tp_answer_evidence l
      JOIN tp_answers a ON a.workspace_id = l.workspace_id AND a.id = l.answer_id
    WHERE l.workspace_id = ? AND l.assessment_id = ? ORDER BY a.question_id`).all(ws.id, assessment.id);
  const supportsFinding = await db.prepare(`SELECT l.evidence_id, l.finding_id FROM tp_finding_evidence l
    WHERE l.workspace_id = ? AND l.assessment_id = ?`).all(ws.id, assessment.id);
  const sections = q && Array.isArray(q.sections) ? q.sections : [];
  const areaOf = new Map();
  for (const sec of sections) for (const id of sec.ids || []) if (!areaOf.has(id)) areaOf.set(id, sec.title);
  const documents = files.map(e => ({
    name: e.original_name,
    date: iso(e.uploaded_at),
    from: e.source === 'vendor' ? 'third_party' : 'firm',
    released: !!e.released_to_client,
    releasedOn: e.released_to_client ? iso(e.released_at) : null,
    questions: [...new Set(supportsAnswer.filter(x => Number(x.evidence_id) === Number(e.id)).map(x => x.question_id))],
    areas: [...new Set(supportsAnswer.filter(x => Number(x.evidence_id) === Number(e.id)).map(x => areaOf.get(x.question_id)).filter(Boolean))],
    findings: [...new Set(supportsFinding.filter(x => Number(x.evidence_id) === Number(e.id)).map(x => findingNo.get(Number(x.finding_id))).filter(Boolean))].sort((a, b) => a - b),
  }));

  let questionnaire = null;
  let results = [];
  if (q && q.status !== 'draft') {
    const submittedBy = await db.prepare(`SELECT v.recipient_name FROM tp_vendor_requests v
      WHERE v.workspace_id = ? AND v.questionnaire_id = ? AND v.status = 'submitted' ORDER BY v.id DESC LIMIT 1`).get(ws.id, q.id);
    const clar = await db.prepare(`SELECT COUNT(*)::integer AS asked, COUNT(*) FILTER (WHERE c.responded_at IS NOT NULL)::integer AS answered
      FROM tp_clarifications c WHERE c.workspace_id = ? AND c.questionnaire_id = ?`).get(ws.id, q.id);
    questionnaire = {
      questions: Number(q.vendor_question_count) || 0,
      sentAt: iso(q.sent_at),
      submittedAt: q.not_returned ? null : iso(q.submitted_at),
      notReturned: !!q.not_returned,
      answeredBy: submittedBy ? submittedBy.recipient_name || null : null,
      clarificationsAsked: clar ? clar.asked : 0,
      clarificationsAnswered: clar ? clar.answered : 0,
    };
    if (q.submitted_at && !q.not_returned) {
      const answers = new Map((await db.prepare(`SELECT a.question_id, a.response, a.review_conclusion FROM tp_answers a
        WHERE a.workspace_id = ? AND a.questionnaire_id = ?`).all(ws.id, q.id)).map(a => [a.question_id, a]));
      results = sections.map(sec => {
        const row = { area: sec.title, questions: 0, satisfactory: 0, gaps: 0, notApplicable: 0, notReviewed: 0 };
        for (const id of sec.ids || []) {
          row.questions += 1;
          const a = answers.get(id);
          if (a && a.response === RESPONSE_NA) row.notApplicable += 1;
          else if (a && a.review_conclusion === 'satisfactory') row.satisfactory += 1;
          else if (a && GAP_CONCLUSIONS.includes(a.review_conclusion)) row.gaps += 1;
          else row.notReviewed += 1;
        }
        return row;
      });
    }
  }

  const contract = await require('./contract-review').reportSummary(db, ws, assessment);

  const pinned = q && Array.isArray(q.rulebooks) ? q.rulebooks : [];
  const rulebooks = [];
  for (const r of pinned) {
    if (r && r.name && !rulebooks.includes(r.name)) rulebooks.push(r.name);
  }

  const scope = await scopeData(db, ws, assessment);
  if (q && q.delivery_model) scope.deliveryModel = q.delivery_model;
  return {
    layoutVersion: 2,
    zone,
    issuedAt: iso(rec.issued_at),
    validUntilYmd: rec.valid_until || null,
    scopeFacts: scope,
    questionnaireFacts: questionnaire,
    documents,
    results,
    contract,
    rulebooks,
    findingDetails,
    conditionDetails,
    signoff: {
      preparedBy: rec.prepared_by_name || null,
      preparedRole: roleLabel(rec.prepared_by_role),
      preparedAt: iso(rec.submitted_at),
      issuedBy: rec.issued_by_name || null,
      issuedRole: roleLabel(rec.issued_by_role),
      issuedAt: iso(rec.issued_at),
      samePerson: !!rec.author_id && Number(rec.author_id) === Number(rec.reviewer_id),
    },
  };
}

const SNAPSHOT_COLUMNS = 's.id, s.content, s.content_sha256, s.taken_after_issue, s.taken_at';

async function getSnapshot(db, workspaceId, recommendationId) {
  return await db.prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM tp_recommendation_snapshots s
    WHERE s.workspace_id = ? AND s.recommendation_id = ?`).get(workspaceId, recommendationId) || null;
}

async function takeSnapshot(db, ws, recommendationId, { actorId = null, afterIssue = false } = {}) {
  const live = await liveVersion(db, ws, recommendationId);
  if (!live) return null;
  const existing = await getSnapshot(db, ws.id, live.rec.id);
  if (existing) return existing;
  const content = JSON.stringify(await snapshotContent(db, ws, live.rec, live.assessment));
  await db.prepare(`INSERT INTO tp_recommendation_snapshots
      (workspace_id, assessment_id, recommendation_id, content, content_sha256, taken_after_issue, taken_by)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, recommendation_id) DO NOTHING`)
    .run(ws.id, live.assessment.id, live.rec.id, content, sha256(content), !!afterIssue, actorId);
  return await getSnapshot(db, ws.id, live.rec.id);
}

async function statusData(db, ws, rec, assessment) {
  const conditionsLib = require('./conditions');
  const firm = await db.prepare('SELECT timezone FROM firms WHERE id = ?').get(ws.firm_id);
  const today = todayFor(ws, firm);
  const decision = await db.prepare(`SELECT d.outcome, d.rationale, d.diverges, d.risk_acceptance_until::text AS risk_acceptance_until,
      d.decided_at, u.name AS decided_by_name
    FROM tp_client_decisions d LEFT JOIN users u ON u.id = d.decided_by
    WHERE d.workspace_id = ? AND d.recommendation_id = ?`).get(ws.id, rec.id);
  const rows = await db.prepare(`SELECT c.position, c.description, c.owner, c.due_date::text AS due_date, c.status,
      c.waive_until::text AS waive_until
    FROM tp_conditions c WHERE c.workspace_id = ? AND c.recommendation_id = ? ORDER BY c.position, c.id`).all(ws.id, rec.id);
  const tracked = !!decision && decision.outcome === 'approve_with_conditions';
  const approval = await decisions.currentApproval(db, ws, assessment.third_party_id, { today });
  return {
    asOf: day(today),
    asOfYmd: today,
    decision: decision ? {
      outcomeLabel: decisions.outcomeLabel(assessment.type, decision.outcome),
      decidedBy: decision.decided_by_name || 'the client',
      decidedOn: day(decision.decided_at),
      decidedAt: iso(decision.decided_at),
      rationale: decision.rationale || '',
      diverges: !!decision.diverges,
      riskAcceptanceUntil: decision.risk_acceptance_until ? day(decision.risk_acceptance_until) : null,
      riskAcceptanceUntilYmd: decision.risk_acceptance_until || null,
    } : null,
    tracked,
    conditions: rows.map((c, i) => {
      const state = conditionsLib.stateOf(c, today);
      return {
        n: i + 1,
        description: c.description || '',
        status: tracked ? state.label : decision ? 'Not followed up' : statusLabel(c.status),
        overdue: tracked && state.overdue,
      };
    }),
    approval: approval ? approval.label : '',
    conditionsSummary: tracked && rows.length ? conditionsLib.summarize(rows, today).label : null,
  };
}

async function scopeData(db, ws, assessment) {
  const ids = (Array.isArray(assessment.services_in_scope) ? assessment.services_in_scope : [])
    .map(x => Number(x && x.id)).filter(n => Number.isSafeInteger(n) && n > 0);
  const services = [];
  for (const id of ids) {
    const sv = await db.prepare(`SELECT sv.description, sv.data_access, sv.hosting_countries FROM tp_services sv
      WHERE sv.workspace_id = ? AND sv.third_party_id = ? AND sv.id = ?`).get(ws.id, assessment.third_party_id, id);
    if (sv) services.push({ description: sv.description || '', data: sv.data_access || '', hosting: sv.hosting_countries || '' });
  }
  const model = assessment.criticality_model_id
    ? await db.prepare('SELECT m.questions FROM tp_criticality_models m WHERE m.firm_id = ? AND m.id = ?').get(ws.firm_id, assessment.criticality_model_id)
    : null;
  const questions = model && Array.isArray(model.questions) ? model.questions : [];
  const given = assessment.answers && typeof assessment.answers === 'object' ? assessment.answers : {};
  const answers = {};
  for (const q of questions) {
    const id = given[q.id];
    const a = (q.answers || []).find(x => x.id === id);
    if (a) answers[q.id] = { id: a.id, label: a.label || '' };
  }
  return { services, answers, decidingQuestionId: assessment.deciding_question_id || null };
}

async function reportData(db, ws, recommendationId, { actorId = null } = {}) {
  const live = await liveVersion(db, ws, recommendationId);
  if (!live) return null;
  const snap = await getSnapshot(db, ws.id, live.rec.id)
    || await takeSnapshot(db, ws, live.rec.id, { actorId, afterIssue: true });
  if (!snap) return null;
  return {
    ...JSON.parse(snap.content),
    snapshot: {
      id: Number(snap.id), sha256: snap.content_sha256, takenAfterIssue: !!snap.taken_after_issue, takenOn: day(snap.taken_at), takenAt: iso(snap.taken_at),
    },
    status: await statusData(db, ws, live.rec, live.assessment),
    ...(JSON.parse(snap.content).layoutVersion ? {} : { scope: await scopeData(db, ws, live.assessment) }),
  };
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const para = s => esc(s).replace(/\r\n?/g, '\n').split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

function table(headers, rows, cls, keep = [], rowAttrs = null, cellAttrs = null) {
  const k = i => (keep.includes(i) ? ' class="keep"' : '');
  return `<table class="${cls}"><thead><tr>${headers.map((h, i) => `<th${k(i)}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r, ri) => `<tr${rowAttrs ? ` ${rowAttrs(ri)}` : ''}>${r.map((c, i) => `<td${k(i)}${cellAttrs ? (cellAttrs(ri, i) ? ` ${cellAttrs(ri, i)}` : '') : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
const attr = v => esc(v == null ? '' : String(v));

let interFont = null;
function interDataUri() {
  if (interFont === null) {
    try {
      const file = require('path').join(__dirname, '..', '..', 'public', 'fonts', 'inter', 'font-files', 'InterVariable.woff2');
      interFont = `data:font/woff2;base64,${require('fs').readFileSync(file).toString('base64')}`;
    } catch (_) { interFont = ''; }
  }
  return interFont;
}

const SHORT_MONTHS = MONTHS.map(m => m.slice(0, 3));
const shortDay = text => String(text || '').replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/,
  m => SHORT_MONTHS[MONTHS.indexOf(m)]);
const sentence = t => { const x = String(t || '').trim(); return x ? (/[.!?]$/.test(x) ? x : `${x}.`) : ''; };

const SCOPE_SENTENCES = Object.freeze({
  system_access: { none: c => `It has no access to ${c}'s systems.`, user: c => `It has user-level access to ${c}'s systems.`,
    privileged: c => `It has privileged, admin or network-connected access to ${c}'s systems.` },
  service_stops: { minor: () => 'If the service stopped, it would be a minor inconvenience.', slows: () => 'If the service stopped, a process would slow down.',
    key_process_stops: () => 'If the service stopped, a key process would stop.' },
  replaceability: { easily: () => 'It could be replaced easily.', with_effort: () => 'It could be replaced with some effort.',
    sole_source: () => 'It is a sole source and could not easily be replaced.' },
  regulated: { no: () => 'The service is not itself regulated.', yes: () => 'The service is subject to regulation.' },
});

function scopeParagraph(data) {
  const sc = data.scope || { services: [], answers: {}, decidingQuestionId: null };
  const tp = data.thirdPartyName;
  const client = data.clientName;
  const quote = t => `“${String(t || '').trim().replace(/[.]$/, '')}”`;
  const parts = [];
  const services = (sc.services || []).filter(x => String(x.description || '').trim());
  if (services.length === 1) parts.push(esc(`${tp} was assessed for ${client} for one service, recorded as ${quote(services[0].description)}.`));
  else if (services.length > 1) parts.push(esc(`${tp} was assessed for ${client} for ${services.length} services, recorded as ${services.map(x => quote(x.description)).join(', ')}.`));
  else parts.push(esc(`${tp} was assessed for ${client}.`));
  const handled = (sc.services || []).map(x => String(x.data || '').trim()).filter(Boolean);
  if (handled.length) parts.push(esc(`The data it handles: ${handled.map(quote).join(', ')}.`));
  const hosting = [...new Set((sc.services || []).map(x => String(x.hosting || '').trim()).filter(Boolean))];
  if (hosting.length) parts.push(esc(`${services.length > 1 ? 'The services are' : 'The service is'} hosted in ${hosting.join(', ')}.`));
  const t = data.tier || {};
  if (t.label) {
    const label = String(t.label);
    const reason = String(t.reason || '');
    const deciding = sc.decidingQuestionId && sc.answers ? sc.answers[sc.decidingQuestionId] : null;
    if (t.override) {
      parts.push(`It is rated <strong>${esc(label)}</strong>.`);
      parts.push(esc(sentence(t.override)));
    } else if (sc.decidingQuestionId === 'data_handled' && deciding && deciding.id !== 'none') {
      parts.push(`It is rated <strong>${esc(label)}</strong> because it handles ${esc(String(deciding.label).toLowerCase())}.`);
    } else if (reason.toLowerCase().startsWith(`${label.toLowerCase()} because`)) {
      parts.push(`It is rated <strong>${esc(label)}</strong> ${esc(sentence(reason.slice(label.length).trim()))}`);
    } else {
      parts.push(`It is rated <strong>${esc(label)}</strong>.`);
    }
  }
  for (const [qid, forms] of Object.entries(SCOPE_SENTENCES)) {
    const a = sc.answers && sc.answers[qid];
    if (a && forms[a.id]) parts.push(esc(forms[a.id](client)));
  }
  return parts.join(' ');
}

function pageHead(title, extra = '') {
  const font = interDataUri();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>
  ${font ? `@font-face { font-family: "Report Inter"; font-style: normal; font-weight: 100 900; src: url("${font}") format("woff2"); }` : ''}
  @page { size: A4; }
  * { box-sizing: border-box; }
  body { font-family: "Report Inter", ${APP_FONT}; font-size: 14px; font-weight: 400; line-height: 1.55; color: #1b1f24; background: #ffffff; margin: 0; }
  p { margin: 0 0 8px; }
  strong, b { font-weight: 600; }
  .letterhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding-bottom: 12px; border-bottom: 1px solid #d9dce0; margin-bottom: 40px; }
  .firm { font-size: 12px; line-height: 1.5; color: #5c636c; }
  .firm-name { font-size: 14px; font-weight: 600; color: #1b1f24; margin-bottom: 2px; }
  .logo { max-height: 16mm; max-width: 56mm; object-fit: contain; }
  .kicker { font-size: 13px; color: #5c636c; margin: 0 0 4px; }
  h1 { font-size: 28px; line-height: 1.25; font-weight: 600; margin: 0 0 4px; }
  .deck { font-size: 16px; color: #5c636c; margin: 0 0 24px; }
  .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 32px; margin: 0 0 32px; padding: 12px 0; border-top: 1px solid #d9dce0; border-bottom: 1px solid #d9dce0; }
  .facts dt { font-size: 12px; color: #5c636c; margin: 0; }
  .facts dd { margin: 0; font-weight: 500; }
  .decision { border: 1px solid #d9dce0; border-radius: 4px; padding: 20px 24px; margin: 0 0 32px; break-inside: avoid; }
  .decision .label { margin-bottom: 4px; }
  .outcome { font-size: 20px; line-height: 1.3; font-weight: 600; color: #1f3a5f; margin: 0 0 4px; }
  .decision-facts { font-size: 13px; color: #5c636c; margin: 0 0 12px; }
  .decision-facts b { font-weight: 500; color: #1b1f24; }
  .scope { max-width: 160mm; }
  .rest { break-before: page; }
  h2 { font-size: 16px; line-height: 1.3; font-weight: 600; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d9dce0; break-after: avoid; }
  .rest > h2:first-child { margin-top: 0; }
  .kv { display: flex; flex-wrap: wrap; gap: 6px 28px; margin: 4px 0 8px; }
  .kv span, .label { display: block; color: #5c636c; font-size: 12px; }
  table.list { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.list th, table.list td { border-bottom: 1px solid #d9dce0; padding: 6px 8px 6px 0; text-align: left; vertical-align: top; }
  table.list th { font-size: 12px; font-weight: 500; color: #5c636c; }
  table.list .keep { white-space: nowrap; width: 1%; }
  tr { break-inside: avoid; }
  .muted { color: #5c636c; }
  .note { margin-top: 24px; font-size: 12px; color: #5c636c; border-top: 1px solid #d9dce0; padding-top: 6px; }
${extra}</style></head><body>
`;
}

function letterheadHtml(lh, logo) {
  return `<header class="letterhead">
    <div class="firm"><div class="firm-name" data-report-firm-name>${esc(lh.displayName)}</div>
      ${lh.addressLines.map(l => `<div>${esc(l)}</div>`).join('')}
      ${lh.contactLine ? `<div>${esc(lh.contactLine)}</div>` : ''}</div>
    ${logo && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(logo) ? `<img class="logo" src="${logo}" alt="">` : ''}
  </header>`;
}

function coverHtml(data, lh, logo, facts, validUntil, scopeHtml) {
  const r = data.recommendation;
  const conditionCount = data.conditions.length;
  return `${letterheadHtml(lh, logo)}
<p class="kicker">Third-party risk assessment</p>
<h1>${esc(data.thirdPartyName)}</h1>
<p class="deck">Prepared for ${esc(data.clientName)}. Confidential.</p>
<dl class="facts">${facts.map(([key, k, v]) => `<div><dt>${esc(k)}</dt><dd data-report-fact="${key}">${esc(v)}</dd></div>`).join('')}</dl>

<section class="decision" aria-label="Our recommendation">
  <p class="label">Our recommendation</p>
  <p class="outcome" data-report-outcome>${esc(r.outcomeLabel)}</p>
  <p class="decision-facts"><span data-report-residual="${esc(r.residual || '')}">Residual risk <b>${esc(r.residual || 'not set')}</b>.</span> <span data-report-valid-until="${esc(r.validUntil || '')}">${validUntil ? `Valid until <b>${esc(validUntil)}</b>.` : 'No end date set.'}</span> <span data-report-condition-count>${conditionCount ? `<b>${conditionCount}</b> condition${conditionCount === 1 ? '' : 's'}, listed below.` : 'No conditions.'}</span></p>
  ${para(r.rationale)}
</section>

<h2>What was assessed</h2>
<p class="scope" data-report-scope>${scopeHtml}</p>
`;
}

function statusHtml(st, heading, F = null) {
  const d0 = st.decision;
  const dec = d0 && F ? { ...d0, decidedOn: F.day(d0.decidedAt) || d0.decidedOn,
    riskAcceptanceUntil: d0.riskAcceptanceUntilYmd ? F.day(d0.riskAcceptanceUntilYmd) : null } : d0;
  const asOf = F ? F.day(st.asOfYmd) : st.asOf;
  const decision = dec
    ? `<div class="kv"><div data-report-status-decision="${attr(dec.outcomeLabel)}"><span>Decision</span>${esc(dec.outcomeLabel)}</div>
        <div data-report-status-recorded="${attr(`${dec.decidedOn} by ${dec.decidedBy}`)}"><span>Recorded</span>${esc(dec.decidedOn)} by ${esc(dec.decidedBy)}</div>
        ${dec.diverges ? `<div data-report-status-diverges="${attr(`Yes${dec.riskAcceptanceUntil ? `, risk accepted until ${dec.riskAcceptanceUntil}` : ''}`)}"><span>Differs from the recommendation</span>Yes${dec.riskAcceptanceUntil ? `, risk accepted until ${esc(dec.riskAcceptanceUntil)}` : ''}</div>` : ''}</div>
      ${dec.rationale ? `<div class="label">The client's rationale</div>${para(dec.rationale)}` : ''}`
    : '<p class="muted">The client has not recorded its decision on this version yet.</p>';
  const approval = `<div class="kv"><div data-report-status-approval="${attr(st.approval)}"><span>Approval</span>${esc(st.approval || '-')}</div>${
    st.conditionsSummary ? `<div data-report-status-conditions="${attr(st.conditionsSummary)}"><span>Conditions</span>${esc(st.conditionsSummary)}</div>` : ''}</div>`;
  const statusNow = c => (c.overdue ? `${c.status}, overdue` : c.status);
  const statusConditions = st.conditions.length
    ? table(['#', 'Condition', 'Status now'], st.conditions.map(c => [c.n, c.description, statusNow(c)]), 'list', [0, 2],
      i => `data-report-status-condition="${st.conditions[i].n}" data-report-now="${attr(statusNow(st.conditions[i]))}"`,
      (i, j) => (j === 1 ? 'data-report-status-condition-text' : ''))
    : '';
  return `<h2 data-report-status-section data-report-as-of="${attr(asOf)}">${esc(heading)}</h2>
<p class="muted">The sections above are the recommendation as issued. This section shows where things stand on the date of this report.</p>
<div class="label">Client decision</div>
${decision}
${approval}
${statusConditions}
`;
}

function exitPlansHtml(data) {
  return Array.isArray(data.exitPlans) && data.exitPlans.length ? `
<h2 data-report-exit-plans>Exit plans</h2>
${table(['Material service', 'Exit plan'], data.exitPlans.map(e => [e.service, `Exit plan: ${String(e.status).toLowerCase()}`]), 'list', [1])}` : '';
}

function renderHtml(data, lh, logo = null) {
  return data.layoutVersion >= 2 ? renderLayout2(data, lh, logo) : renderLayout1(data, lh, logo);
}

function renderLayout1(data, lh, logo) {
  const r = data.recommendation;
  const issuedDay = shortDay(r.issuedDay || String(r.issuedOn || '').replace(/,.*$/, ''));
  const facts = [
    ['client', 'Client', data.clientName],
    ['third-party', 'Third party', data.thirdPartyName],
    ['assessment', 'Assessment', data.assessmentType],
    ['version', 'Version', `Version ${r.version}, issued ${issuedDay} by ${r.issuedBy}`],
  ];
  const st = data.status;
  const snapNote = data.snapshot && data.snapshot.takenAfterIssue
    ? ` Snapshot taken on ${esc(data.snapshot.takenOn)}, after issue.`
    : '';
  return `${pageHead(`Recommendation report: ${data.thirdPartyName}, version ${r.version}`)}${coverHtml(data, lh, logo, facts, r.validUntil ? shortDay(r.validUntil) : null, scopeParagraph(data))}
<div class="rest">
<h2>Conditions</h2>
${data.conditions.length
    ? table(['#', 'Condition', 'Owner', 'Due date', 'Status'], data.conditions.map(c => [c.n, c.automatic ? `${c.description} (automatic: exit plan required by the client's rulebooks)` : c.description, c.owner, c.due, c.status]), 'list', [0, 2, 3, 4],
      i => { const c = data.conditions[i]; return `data-report-condition="${c.n}" data-report-owner="${attr(c.owner)}" data-report-due="${attr(c.due)}" data-report-condition-status="${attr(c.status)}"`; },
      (i, j) => (j === 1 ? 'data-report-condition-text' : ''))
    : '<p class="muted">No conditions.</p>'}
${exitPlansHtml(data)}

<h2>Key findings</h2>
${data.findings.length
    ? table(['Finding', 'Severity', 'Control', 'Status'], data.findings.map(f => [f.title, f.severity, f.control || '-', f.status]), 'list', [1, 2, 3],
      i => { const f = data.findings[i]; return `data-report-finding="${i + 1}" data-report-severity="${attr(f.severity)}" data-report-control="${attr(f.control)}" data-report-finding-status="${attr(f.status)}"`; },
      (i, j) => (j === 0 ? 'data-report-finding-title' : ''))
    : '<p class="muted">No findings were recorded.</p>'}

<h2>Evidence shared with the client</h2>
${data.evidence.length
    ? table(['File', 'Shared on'], data.evidence.map(e => [e.name, e.sharedOn]), 'list', [1],
      i => `data-report-document="${attr(data.evidence[i].name)}" data-report-released="${attr(data.evidence[i].sharedOn)}"`)
    : '<p class="muted">No files were shared with the client.</p>'}

<h2>Questionnaire</h2>
<p>${esc(data.questionnaire)}</p>

${statusHtml(st, `Status as of ${st.asOf}`)}
<p class="note">Version ${esc(r.version)} issued on ${esc(r.issuedOn)} by ${esc(r.issuedBy)}. The recommendation sections are as issued (snapshot ${esc(data.snapshot ? data.snapshot.sha256.slice(0, 12) : '')}).${snapNote} This report is the firm's recommendation; the decision is the client's own.</p>
</div>
</body></html>`;
}

const LAYOUT2_STYLES = `
  .finding { padding: 12px 0; border-bottom: 1px solid #d9dce0; break-inside: avoid; }
  .finding:first-of-type { padding-top: 4px; }
  .finding-title { font-weight: 600; margin: 0 0 2px; }
  .finding-meta { font-size: 13px; color: #5c636c; margin: 0 0 8px; }
  .finding .label { margin: 8px 0 2px; }
  .finding-link { font-size: 13px; margin: 8px 0 0; }
  .signoff { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 32px; margin: 4px 0 0; break-inside: avoid; }
  .signoff dt { font-size: 12px; color: #5c636c; margin: 0 0 2px; }
  .signoff dd { margin: 0; }
  .signoff .who { font-weight: 500; }
  .signoff .role { font-size: 13px; color: #5c636c; }
  table.list td.num, table.list th.num { text-align: right; padding-right: 0; padding-left: 12px; }
  .limits { color: #5c636c; }
`;

const DELIVERY_SENTENCES = Object.freeze({
  vendor_hosted: (tp) => `The service is hosted or managed by ${tp}.`,
  client_hosted: (tp, c) => `The software is installed in ${c}'s environment.`,
  non_technology: () => 'It is not a technology service.',
  staff_in_client_environment: (tp, c) => `${tp}'s staff work inside ${c}'s environment.`,
});

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listWords = items => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function numberTable(headers, rows, numeric, rowAttrs = null, cols = []) {
  const c = i => (numeric.includes(i) ? ' class="num"' : '');
  const h = i => (cols[i] ? ` data-report-col="${cols[i]}"` : '');
  return `<table class="list"><thead><tr>${headers.map((x, i) => `<th${c(i)}${h(i)}>${esc(x)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r, ri) => `<tr${rowAttrs ? ` ${rowAttrs(ri)}` : ''}>${r.map((v, i) => `<td${c(i)}${h(i)}>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderLayout2(data, lh, logo) {
  const r = data.recommendation;
  const F = format.forZone(data.zone);
  const dayOf = v => (v ? F.day(v) : '');
  const tp = data.thirdPartyName;
  const client = data.clientName;
  const so = data.signoff || {};
  const facts = [
    ['client', 'Client', client],
    ['third-party', 'Third party', tp],
    ['assessment', 'Assessment', data.assessmentType],
    ['issued', 'Issued', `${dayOf(data.issuedAt)}, version ${r.version}`],
  ];

  const sc = data.scopeFacts || { services: [], answers: {}, decidingQuestionId: null };
  let scopeHtml = scopeParagraph({ ...data, scope: sc });
  const delivery = sc.deliveryModel && DELIVERY_SENTENCES[sc.deliveryModel];
  if (delivery) scopeHtml += ` ${esc(delivery(tp, client))}`;

  const qf = data.questionnaireFacts;
  const did = [];
  if (!qf) did.push(`No questionnaire was sent to ${tp}.`);
  else {
    did.push(`We sent ${tp} a questionnaire of ${plural(qf.questions, 'question')}${qf.sentAt ? ` on ${dayOf(qf.sentAt)}` : ''}.`);
    if (qf.notReturned) did.push(`${tp} did not return it.`);
    else if (qf.submittedAt) did.push(`${qf.answeredBy ? `${qf.answeredBy} answered it for ${tp}` : `${tp} returned it`} on ${dayOf(qf.submittedAt)}.`);
    else did.push('It had not been returned when this recommendation was issued.');
    if (qf.clarificationsAsked) {
      const a = qf.clarificationsAnswered;
      const answered = a === qf.clarificationsAsked ? (a === 1 ? 'it was answered' : 'all were answered') : `${a} ${a === 1 ? 'was' : 'were'} answered`;
      did.push(`We asked ${plural(qf.clarificationsAsked, 'follow-up question')}; ${answered}.`);
    }
  }
  const ct = data.contract;
  if (ct && ct.not_reviewed < ct.clauses) {
    const parts = [[ct.satisfactory, 'satisfactory'], [ct.gaps, 'with gaps'], [ct.missing, 'missing'], [ct.not_required, 'not required']]
      .filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
    const reviewed = ct.clauses - ct.not_reviewed;
    did.push(`${reviewed === ct.clauses ? `We reviewed the contract against ${plural(ct.clauses, 'clause')}` : `We reviewed ${reviewed} of the ${ct.clauses} contract clauses on our checklist`}: ${listWords(parts)}.`);
  }
  if (data.rulebooks && data.rulebooks.length) did.push(`The questionnaire included the requirements of ${data.rulebooks.length === 1 ? 'this regulatory rulebook' : 'these regulatory rulebooks'}: ${data.rulebooks.join('; ')}.`);

  const docs = data.documents || [];
  const fromWord = d => (d.from === 'third_party' ? tp : lh.displayName);
  const usedFor = d => {
    const bits = [];
    if (d.areas && d.areas.length) bits.push(d.areas.join(', '));
    if (d.findings && d.findings.length) bits.push(`${d.findings.length === 1 ? 'finding' : 'findings'} ${listWords(d.findings.map(String))}`);
    return bits.length ? bits.join('; ') : 'General review';
  };
  const documentsHtml = docs.length
    ? table(['Document', 'From', 'Received', 'Used for', 'Shared with the client'],
      docs.map(d => [d.name, fromWord(d), dayOf(d.date), usedFor(d), d.released ? dayOf(d.releasedOn) || 'Yes' : 'No']), 'list', [1, 2, 4],
      i => `data-report-document="${attr(docs[i].name)}" data-report-released="${attr(docs[i].released ? dayOf(docs[i].releasedOn) : '')}"`,
      (i, j) => `data-report-doc="${['name', 'from', 'received', 'used-for', 'shared'][j]}"`)
    : '<p class="muted">No documents were provided.</p>';

  const basis = [qf && qf.submittedAt && !qf.notReturned ? `${tp}'s answers to the questionnaire` : null, docs.length ? 'the documents listed above' : null].filter(Boolean);
  const limits = `${basis.length ? `This assessment is based on ${listWords(basis)}.` : 'This assessment is based on the information recorded above.'} We did not test ${tp}'s controls on site. This report is our recommendation; the decision is ${client}'s own.`;

  const results = data.results || [];
  const showUnreviewed = results.some(x => x.notReviewed);
  const resultsHtml = results.length
    ? numberTable(['Area', 'Questions', 'Satisfactory', 'Gaps', 'Not applicable', ...(showUnreviewed ? ['Not reviewed'] : [])],
      results.map(x => [x.area, x.questions, x.satisfactory, x.gaps, x.notApplicable, ...(showUnreviewed ? [x.notReviewed] : [])]), [1, 2, 3, 4, 5],
      i => `data-report-area="${attr(results[i].area)}" data-report-gaps="${results[i].gaps}"`,
      ['area', 'questions', 'satisfactory', 'gaps', 'not-applicable', 'not-reviewed'])
    : '';

  const fd = data.findingDetails || [];
  const findingsHtml = fd.length
    ? fd.map(f => `<div class="finding" data-report-finding="${f.n}" data-report-severity="${attr(f.severity)}" data-report-control="${attr(f.control)}" data-report-finding-status="${attr(f.status)}">
  <p class="finding-title" data-report-finding-title>${f.n}. ${esc(f.title)}</p>
  <p class="finding-meta" data-report-finding-meta>${esc(f.severity)} severity${f.control ? `. Control ${esc(f.control)}` : ''}. ${esc(f.status)} when this recommendation was issued.</p>
  ${f.description ? `<div data-report-finding-description>${para(f.description)}</div>` : ''}
  ${f.impact ? `<p class="label">Why it matters to ${esc(client)}</p><div data-report-finding-impact>${para(f.impact)}</div>` : ''}
  <p class="finding-link" data-report-finding-conditions="${f.conditions.join(',')}">${f.conditions.length ? `Addressed by ${f.conditions.length === 1 ? 'condition' : 'conditions'} ${listWords(f.conditions.map(String))}.` : 'No condition addresses this finding.'}</p>
</div>`).join('\n')
    : '<p class="muted">No findings were recorded.</p>';

  const cd = data.conditionDetails || [];
  const conditionsHtml = data.conditions.length
    ? table(['#', 'Condition', 'Owner', 'Due', 'Finding'], data.conditions.map((c, i) => {
      const d = cd[i] || {};
      return [c.n, c.automatic ? `${c.description} (automatic: ${client}'s rulebooks require an exit plan)` : c.description, c.owner, dayOf(d.due), d.finding ? `Finding ${d.finding}` : '-'];
    }), 'list', [0, 2, 3, 4],
    i => { const c = data.conditions[i]; const d = cd[i] || {}; return `data-report-condition="${c.n}" data-report-owner="${attr(c.owner)}" data-report-due="${attr(dayOf(d.due))}" data-report-condition-status="${attr(c.status)}" data-report-condition-finding="${d.finding || ''}"`; },
    (i, j) => (j === 1 ? 'data-report-condition-text' : j === 4 ? 'data-report-condition-finding-cell' : ''))
    : '<p class="muted">No conditions.</p>';

  const person = (key, label, name, role, at) => `<div data-report-signoff="${key}"><dt>${esc(label)}</dt><dd><div class="who" data-report-signoff-name>${esc(name || '-')}</div>${role ? `<div class="role" data-report-signoff-role>${esc(role)}</div>` : ''}${at ? `<div class="role" data-report-signoff-date>${esc(dayOf(at))}</div>` : ''}</dd></div>`;
  const st = data.status;
  return `${pageHead(`Recommendation report: ${tp}, version ${r.version}`, LAYOUT2_STYLES)}${coverHtml(data, lh, logo, facts, dayOf(data.validUntilYmd), scopeHtml)}
<div class="rest">
<h2 data-report-what-we-did>What we did</h2>
<p>${esc(did.join(' '))}</p>
${documentsHtml}
<p class="limits" data-report-limits>${esc(limits)}</p>
${resultsHtml ? `
<h2 data-report-results>Results by area</h2>
${resultsHtml}` : ''}

<h2 data-report-findings>Findings</h2>
${findingsHtml}

<h2 data-report-conditions>Conditions</h2>
${conditionsHtml}
${exitPlansHtml(data)}

<h2 data-report-signoffs>Sign-off</h2>
<dl class="signoff">${person('prepared', 'Prepared by', so.preparedBy, so.preparedRole, so.preparedAt)}${person('issued', 'Reviewed and issued by', so.issuedBy, so.issuedRole, so.issuedAt)}</dl>
${data.snapshot && data.snapshot.takenAfterIssue ? `<p class="note" data-report-after-issue>This report was compiled on ${esc(data.snapshot.takenAt ? dayOf(data.snapshot.takenAt) : shortDay(data.snapshot.takenOn))} from the records as they stood then, after version ${esc(r.version)} was issued.</p>` : ''}

${statusHtml(st, `Appendix: status on ${F.day(st.asOfYmd)}`, F)}
</div>
</body></html>`;
}

const slug = s => String(s || 'third-party').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'third-party';

async function generate(db, { ws, recommendationId, actorId, audience, expect = null }) {
  if (!AUDIENCES.includes(audience)) throw new TypeError('audience must be firm or client');
  const data = await reportData(db, ws, recommendationId, { actorId });
  if (!data) throw notFound();
  if (expect && (Number(expect.thirdPartyId) !== data.thirdPartyId || Number(expect.assessmentId) !== data.assessmentId)) throw notFound();
  const lh = await letterhead.getLetterhead(db, ws.firm_id);
  const html = renderHtml(data, lh, await letterhead.logoDataUri(db, ws.firm_id));
  let pdf;
  try {
    pdf = Buffer.from(await renderPdf(html, {
      headerLeft: `${data.clientName} · ${data.thirdPartyName}`,
      headerRight: `Recommendation · version ${data.recommendation.version}`,
      footerLeft: data.layoutVersion >= 2
        ? `${lh.footerText || lh.displayName} · Document reference ${data.snapshot.sha256.slice(0, 8)}`
        : lh.footerText || lh.displayName,
    }));
  } catch (err) {
    console.error('[tprm report] rendering failed:', err && err.message);
    throw new TprmError(503, 'The report could not be generated just now. Try again in a minute.');
  }
  const digest = sha256(pdf);
  await events.appendEvent(db, {
    workspaceId: ws.id, thirdPartyId: data.thirdPartyId, assessmentId: data.assessmentId, actorId, action: EVENT,
    after: {
      recommendation_id: data.recommendation.id, version: data.recommendation.version, audience,
      sha256: digest, html_sha256: sha256(html), size_bytes: pdf.length, letterhead_version: lh.rowVersion,
      snapshot_id: data.snapshot.id, snapshot_sha256: data.snapshot.sha256, snapshot_taken_after_issue: data.snapshot.takenAfterIssue,
      status_as_of: data.status.asOfYmd,
    },
  });
  return { pdf, filename: `recommendation-${slug(data.thirdPartyName)}-v${data.recommendation.version}.pdf`, sha256: digest };
}

function firmLink(tpClientId, thirdPartyId, assessmentId, rec) {
  return `/tprm/clients/${Number(tpClientId)}/third-parties/${Number(thirdPartyId)}/assessments/${Number(assessmentId)}/recommendations/${Number(rec.id)}/report.pdf`;
}

module.exports = { EVENT, EVENT_LABELS, AUDIENCES, configure, reportData, takeSnapshot, getSnapshot, renderHtml, generate, firmLink, day };
