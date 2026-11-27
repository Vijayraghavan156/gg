'use strict';

const placement = require('./placement');
const decisions = require('./decisions');
const labels = require('./labels');
const { todayFor } = require('../dates');

const TABS = Object.freeze(['all', 'waiting', 'requests', 'renewals', 'ended']);
const TAB_LABELS = Object.freeze({ all: 'All third parties', waiting: 'Waiting on you', requests: 'Requests', renewals: 'Renewals and expiries', ended: 'Ended' });
const STAGES = Object.freeze(['in_use', 'review', 'decision', 'proposed', 'exited']);
const PAGE_SIZE = 25;
const HORIZON_DAYS = 90;
const RANK = { critical: 1, high: 2, medium: 3, low: 4 };

const ymdPlus = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const str = (v, max = 100) => String(v == null ? '' : v).trim().slice(0, max);
const { fold } = require('./text-fold');

function stageFor(row, firmName) {
  const ap = row.approval;
  if (row.status === 'exited') return { key: 'exited', label: 'Ended' };
  if (ap.pending === 'decision_needed') return { key: 'decision', label: 'Waiting for your decision' };
  if (ap.pending === 'information_requested') return { key: 'review', label: `${firmName} answering your question` };
  if (ap.pending === 'in_progress') {
    const s = row.assessmentStatus;
    if (['scoping', 'tier_proposed'].includes(s)) return { key: 'review', label: 'Being scoped' };
    if (s === 'tier_confirmed' && ['sent', 'in_progress'].includes(row.questionnaireStatus)) return { key: 'review', label: 'Supplier answering' };
    return { key: 'review', label: `${firmName} reviewing` };
  }
  if (row.status === 'proposed') return { key: 'proposed', label: 'Not started' };
  return { key: 'in_use', label: 'In use' };
}

function parseQuery(q = {}) {
  const tab = TABS.includes(String(q.tab)) ? String(q.tab) : 'all';
  const tier = Object.keys(RANK).includes(String(q.tier)) ? String(q.tier) : '';
  const stage = STAGES.includes(String(q.stage)) ? String(q.stage) : '';
  const page = Math.max(1, Math.min(1000, Number.parseInt(q.page, 10) || 1));
  const owner = String(q.owner) === 'me' ? 'me' : '';
  return { tab, tier, stage, owner, service: str(q.service), q: str(q.q), page };
}

async function firmNameFor(db, ws) {
  const row = ws && ws.firm_id ? await db.prepare('SELECT name FROM firms WHERE id = ?').get(ws.firm_id) : null;
  return (row && row.name) || 'Your consultants';
}

async function baseRows(db, ws, today, firmName) {
  const rows = await db.prepare(`SELECT t.id, t.name, t.legal_name, t.category, t.status, t.current_tier, t.tier_source,
      t.next_due_date::text AS next_due_date, t.last_assessment_date::text AS last_assessment_date, t.created_at,
      t.client_owner_user_id, ou.name AS owner_name, t.business_unit
    FROM tp_third_parties t LEFT JOIN users ou ON ou.id = t.client_owner_user_id
    WHERE t.workspace_id = ? ORDER BY lower(t.name), t.id`).all(ws.id);
  const states = await decisions.approvals(db, ws, null, { today });
  const open = await db.prepare(`SELECT a.third_party_id, a.status, q.status AS q_status FROM tp_assessments a
    LEFT JOIN tp_questionnaires q ON q.workspace_id = a.workspace_id AND q.assessment_id = a.id
    WHERE a.workspace_id = ? AND a.status NOT IN ('completed', 'cancelled')`).all(ws.id);
  const openBy = new Map(open.map(o => [Number(o.third_party_id), o]));
  const live = await db.prepare(`SELECT DISTINCT ON (a.third_party_id) a.third_party_id, r.id AS recommendation_id, r.version,
      r.residual_rating, r.valid_until::text AS valid_until, r.issued_at,
      (SELECT COUNT(*)::int FROM tp_findings f WHERE f.workspace_id = r.workspace_id AND f.assessment_id = a.id AND f.status = 'open') AS open_findings,
      (SELECT COUNT(*)::int FROM tp_conditions c WHERE c.workspace_id = r.workspace_id AND c.recommendation_id = r.id) AS conditions,
      (SELECT COUNT(*)::int FROM tp_conditions c WHERE c.workspace_id = r.workspace_id AND c.recommendation_id = r.id
         AND c.status IN ('verified', 'waived')) AS conditions_done
    FROM tp_recommendations r JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    WHERE r.workspace_id = ? AND r.status = 'issued' AND a.status <> 'cancelled'
    ORDER BY a.third_party_id, r.issued_at DESC, r.id DESC`).all(ws.id);
  const liveBy = new Map(live.map(r => [Number(r.third_party_id), r]));
  return rows.map(r => {
    const id = Number(r.id);
    const o = openBy.get(id);
    const row = {
      ...r, id, approval: states.get(id), recommendation: liveBy.get(id) || null,
      assessmentStatus: o ? o.status : null, questionnaireStatus: o ? o.q_status : null,
    };
    row.stage = stageFor(row, firmName);
    return row;
  });
}

function countBy(list, fn) {
  const m = new Map();
  for (const x of list) { const k = fn(x); if (k != null) m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

const REVIEW_DUE_KEYS = Object.freeze(['overdue', 'due_today', 'due']);

function reviewDue(r, today) {
  if (r.status !== 'in_use') return null;
  return labels.due({ nextDueDate: r.next_due_date, lastAssessmentDate: r.last_assessment_date,
    inProgress: !!(r.approval && r.approval.openAssessment), today });
}

async function dueSoon(db, ws, rows, today) {
  const end = ymdPlus(today, HORIZON_DAYS);
  const items = [];
  for (const r of rows) {
    const due = reviewDue(r, today);
    if (due && REVIEW_DUE_KEYS.includes(due.key) && r.next_due_date <= end) {
      items.push({ kind: 'review', label: 'Review due', name: r.name, thirdPartyId: r.id, date: r.next_due_date, overdue: due.key === 'overdue' });
    }
    const until = r.approval && r.approval.until;
    if (until && until >= today && until <= end) items.push({ kind: 'approval', label: 'Approval ends', name: r.name, thirdPartyId: r.id, date: until });
  }
  const conds = await db.prepare(`SELECT c.position, c.due_date::text AS due_date, c.owner, t.id AS third_party_id, t.name
    FROM tp_conditions c
    JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id
    JOIN tp_client_decisions d ON d.workspace_id = r.workspace_id AND d.recommendation_id = r.id AND d.outcome = 'approve_with_conditions'
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    WHERE c.workspace_id = ? AND r.status = 'issued' AND a.status = 'completed'
      AND c.status IN ('open', 'changes_requested', 'proof_submitted') AND c.due_date IS NOT NULL AND c.due_date <= ?`).all(ws.id, end);
  for (const c of conds) {
    items.push({ kind: 'condition', label: c.owner === 'client' ? 'Your condition due' : 'Supplier condition due',
      name: c.name, thirdPartyId: Number(c.third_party_id), date: c.due_date, overdue: c.due_date < today });
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const months = [];
  for (let i = 0; i < 3; i += 1) {
    const d = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`));
    d.setUTCMonth(d.getUTCMonth() + i);
    const key = d.toISOString().slice(0, 7);
    const inMonth = items.filter(x => x.date.slice(0, 7) === key && !x.overdue);
    months.push({ key, label: d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }), total: inMonth.length,
      reviews: inMonth.filter(x => x.kind === 'review').length,
      conditions: inMonth.filter(x => x.kind === 'condition').length,
      approvals: inMonth.filter(x => x.kind === 'approval').length });
  }
  return { items, months, overdue: items.filter(x => x.overdue).length,
    overdueReviews: items.filter(x => x.overdue && x.kind === 'review').length,
    overdueConditions: items.filter(x => x.overdue && x.kind === 'condition').length };
}

function matches(r, f) {
  if (f.tab === 'ended' ? r.status !== 'exited' : r.status === 'exited') return false;
  if (f.tab === 'waiting' && !r.waitingOnClient) return false;
  if (f.tab === 'renewals' && !r.renewalSoon) return false;
  if (f.tier && r.current_tier !== f.tier) return false;
  if (f.stage && r.stage.key !== f.stage) return false;
  if (f.service && (r.category || '') !== f.service) return false;
  if (f.owner === 'me' && Number(r.client_owner_user_id) !== Number(f.userId)) return false;
  if (f.q) {
    const hay = fold([r.name, r.legal_name, r.category, r.owner_name, r.business_unit].filter(Boolean).join(' '));
    if (!hay.includes(fold(f.q))) return false;
  }
  return true;
}

async function home(db, ws, query = {}, user = null, { questionnaires: withProgress = false } = {}) {
  const today = todayFor(ws);
  const firmName = await firmNameFor(db, ws);
  const f = { ...parseQuery(query), userId: user ? Number(user.id) : 0 };
  const rows = await baseRows(db, ws, today, firmName);
  const conditionsLib = require('./conditions');
  const owned = await conditionsLib.clientOwnedOpen(db, ws);
  const ownConditions = owned.filter(conditionsLib.needsClient);
  const proofPending = owned.filter(c => !conditionsLib.needsClient(c));
  const ownBy = countBy(ownConditions, c => Number(c.third_party_id));
  const due = await dueSoon(db, ws, rows, today);
  const renewalIds = new Set(due.items.filter(x => x.kind !== 'condition').map(x => x.thirdPartyId));
  for (const r of rows) {
    r.ownConditions = ownBy.get(r.id) || 0;
    r.waitingOnClient = r.approval.pending === 'decision_needed' || r.ownConditions > 0;
    r.renewalSoon = renewalIds.has(r.id) || r.approval.state === 'expired';
  }
  const current = rows.filter(r => r.status !== 'exited');
  const quarterStart = `${today.slice(0, 5)}${String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  const added = current.filter(r => r.created_at && new Date(r.created_at).toISOString().slice(0, 10) >= quarterStart)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const stageCounts = countBy(current, r => r.stage.key);
  const rated = r => !!(r.recommendation && r.recommendation.residual_rating);
  const residual = countBy(current.filter(rated), r => r.recommendation.residual_rating);
  const services = [...countBy(current, r => r.category || null)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const requests = await require('./client-requests').list(db, ws.id);
  const filtered = f.tab === 'requests' ? [] : rows.filter(r => matches(r, f))
    .sort((a, b) => Number(b.waitingOnClient) - Number(a.waitingOnClient) || a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const questionnaires = withProgress
    ? await require('./questionnaire-progress').forThirdParties(db, ws, pageRows.filter(r => r.approval && r.approval.openAssessment).map(r => r.id))
    : new Map();
  return {
    today, firmName, filters: { ...f, page }, rows: pageRows, questionnaires,
    allRows: filtered,
    total: filtered.length, page, pages, pageSize: PAGE_SIZE,
    requests,
    tabCounts: {
      all: current.length,
      requests: requests.filter(r => r.status === 'submitted').length,
      waiting: rows.filter(r => r.status !== 'exited' && r.waitingOnClient).length,
      renewals: rows.filter(r => r.status !== 'exited' && r.renewalSoon).length,
      ended: rows.length - current.length,
    },
    decisionsNeeded: rows.filter(r => r.approval.pending === 'decision_needed' && r.recommendation),
    ownConditions, proofPending,
    tiles: {
      total: current.length,
      stages: STAGES.filter(k => k !== 'exited').map(k => ({ key: k, count: stageCounts.get(k) || 0 })),
      residual: ['critical', 'high', 'medium', 'low'].map(k => ({ key: k, count: residual.get(k) || 0 })),
      decided: [...residual.values()].reduce((s, n) => s + n, 0),
      underReview: current.filter(r => !rated(r) && r.approval.openAssessment).length,
      notAssessed: current.filter(r => !rated(r) && !r.approval.openAssessment && !r.last_assessment_date).length,
      assessedNoDecision: current.filter(r => !rated(r) && !r.approval.openAssessment && !!r.last_assessment_date).length,
      inUse: current.filter(r => r.status === 'in_use').length,
      inherentHigh: current.filter(r => ['critical', 'high'].includes(r.current_tier)).length,
      added, services: services.slice(0, 5), serviceMax: services.length ? services[0][1] : 0,
      due,
    },
    serviceOptions: services.map(s => s[0]),
  };
}

async function thirdPartyRef(db, ws, thirdPartyId) {
  const id = Number(thirdPartyId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = await db.prepare('SELECT t.id, t.name FROM tp_third_parties t WHERE t.workspace_id = ? AND t.id = ?').get(ws.id, id);
  return row ? { id: Number(row.id), name: row.name } : null;
}

async function thirdParty(db, ws, thirdPartyId) {
  const id = Number(thirdPartyId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const today = todayFor(ws);
  const t = await db.prepare(`SELECT t.id, t.name, t.legal_name, t.registration_number, t.website, t.category, t.country,
      t.primary_contact_name, t.primary_contact_email, t.status, t.current_tier, t.tier_source,
      t.next_due_date::text AS next_due_date, t.last_assessment_date::text AS last_assessment_date, t.created_at,
      t.business_unit, t.service_volume, t.client_owner_user_id, t.row_version, ou.name AS owner_name, ou.email AS owner_email
    FROM tp_third_parties t LEFT JOIN users ou ON ou.id = t.client_owner_user_id
    WHERE t.workspace_id = ? AND t.id = ?`).get(ws.id, id);
  if (!t) return null;
  const firmName = await firmNameFor(db, ws);
  const approval = await decisions.currentApproval(db, ws, id, { today });
  const reviews = await db.prepare(`SELECT a.id AS assessment_id, a.type, a.status AS assessment_status, a.final_tier, a.created_at AS assessment_created_at,
      r.id AS recommendation_id, r.version, r.outcome, r.residual_rating, r.rationale, r.valid_until::text AS valid_until, r.issued_at,
      d.outcome AS decision_outcome, d.decided_at, du.name AS decided_by_name, au.name AS author_name, iu.name AS issuer_name
    FROM tp_recommendations r
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    LEFT JOIN LATERAL (SELECT dd.outcome, dd.decided_at, dd.decided_by FROM tp_client_decisions dd
      WHERE dd.workspace_id = r.workspace_id AND dd.recommendation_id = r.id ORDER BY dd.decided_at DESC, dd.id DESC LIMIT 1) d ON true
    LEFT JOIN users du ON du.id = d.decided_by
    LEFT JOIN users au ON au.id = r.author_id
    LEFT JOIN users iu ON iu.id = r.reviewer_id
    WHERE r.workspace_id = ? AND a.third_party_id = ? AND r.status = 'issued' AND a.status <> 'cancelled'
    ORDER BY r.issued_at DESC, r.id DESC`).all(ws.id, id);
  const typeLabels = new Map();
  for (const r of reviews) {
    const aid = Number(r.assessment_id);
    if (!typeLabels.has(aid)) {
      typeLabels.set(aid, await require('./assessments').typeLabelFor(db, ws.id, t,
        { id: aid, type: r.type, third_party_id: id, created_at: r.assessment_created_at }));
    }
    r.type_label = typeLabels.get(aid);
    r.outcome_label = decisions.outcomeLabel(r.type, r.outcome);
    r.decision_label = r.decision_outcome ? decisions.outcomeLabel(r.type, r.decision_outcome) : null;
  }
  const recIds = reviews.map(r => Number(r.recommendation_id));
  const assessIds = [...new Set(reviews.map(r => Number(r.assessment_id)))];
  const inList = n => n.map(() => '?').join(',');
  const issues = assessIds.length ? await db.prepare(`SELECT f.id, f.assessment_id, f.control_ref, f.severity, f.title, f.status,
      f.description, f.impact, f.closed_at FROM tp_findings f WHERE f.workspace_id = ? AND f.assessment_id IN (${inList(assessIds)})
    ORDER BY CASE f.status WHEN 'open' THEN 0 ELSE 1 END,
      CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, f.id`).all(ws.id, ...assessIds) : [];
  const conditions = recIds.length ? await db.prepare(`SELECT c.id, c.recommendation_id, c.position, c.description, c.owner,
      c.due_date::text AS due_date, c.status FROM tp_conditions c
    WHERE c.workspace_id = ? AND c.recommendation_id IN (${inList(recIds)}) ORDER BY c.recommendation_id DESC, c.position, c.id`)
    .all(ws.id, ...recIds) : [];
  const evidence = assessIds.length ? await db.prepare(`SELECT e.id, e.assessment_id, e.original_name, e.size_bytes, e.mime_type,
      e.description, e.released_at FROM tp_evidence e
    WHERE e.workspace_id = ? AND e.assessment_id IN (${inList(assessIds)}) AND e.released_to_client
    ORDER BY e.released_at DESC, e.id DESC`).all(ws.id, ...assessIds) : [];
  const decidedBy = new Map(reviews.map(r => [Number(r.recommendation_id), r.decision_outcome || null]));
  for (const c of conditions) {
    c.decided = !!decidedBy.get(Number(c.recommendation_id));
    c.tracked = decidedBy.get(Number(c.recommendation_id)) === 'approve_with_conditions';
  }
  const recFor = new Map();
  for (const r of reviews) if (!recFor.has(Number(r.assessment_id))) recFor.set(Number(r.assessment_id), Number(r.recommendation_id));
  for (const e of evidence) e.recommendation_id = recFor.get(Number(e.assessment_id));
  for (const i of issues) i.recommendation_id = recFor.get(Number(i.assessment_id));
  const threads = await require('./issues').clientThreads(db, ws, issues.map(i => i.id));
  const notes = await require('./finding-comments').forFindings(db, ws.id, issues.map(i => i.id));
  const statusBy = new Map(reviews.map(r => [Number(r.assessment_id), r.assessment_status]));
  const closedReason = require('./finding-comments').closedReason;
  for (const i of issues) {
    i.thread = threads.get(Number(i.id)) || null;
    i.notes = notes.get(Number(i.id)) || [];
    i.notesClosedReason = closedReason(i.status, statusBy.get(Number(i.assessment_id)));
    i.notesOpen = !i.notesClosedReason;
  }
  const latest = reviews[0] || null;
  const services = await db.prepare(`SELECT s.id, s.description, s.data_access, s.hosting_countries, s.sole_source, s.material
    FROM tp_services s WHERE s.workspace_id = ? AND s.third_party_id = ? ORDER BY s.id`).all(ws.id, id);
  const contacts = await db.prepare(`SELECT p.id, p.name, p.job_title, p.email, p.phone, p.role FROM tp_vendor_people p
    WHERE p.workspace_id = ? AND p.third_party_id = ? AND p.status = 'active' ORDER BY CASE p.role WHEN 'main' THEN 0 ELSE 1 END, lower(p.name), p.id`).all(ws.id, id);
  const insurance = assessIds.length ? await db.prepare(`SELECT x.response, x.fields, x.submitted_at FROM tp_answers x
    WHERE x.workspace_id = ? AND x.question_id = 'GOV-07' AND x.submitted_at IS NOT NULL AND x.assessment_id IN (${inList(assessIds)})
    ORDER BY x.submitted_at DESC, x.id DESC LIMIT 1`).get(ws.id, ...assessIds) : null;
  const sharedDocuments = await require('./party-documents').forClient(db, ws, id, today);
  const shownCertificates = [...require('./party-documents').certificates(sharedDocuments),
    ...await require('./firm-party').evidenceCertificates(db, ws.id, assessIds, { releasedOnly: true })];
  const assurance = require('./firm-party').mergeAssurance(assessIds.length ? await db.prepare(`SELECT r.kind, COALESCE(r.confirmed_expires_on, r.certificate_expires_on)::text AS expires_on,
      COALESCE(r.confirmed_period_end, r.period_end)::text AS period_end, r.check_status FROM tp_assurance_reports r
    WHERE r.workspace_id = ? AND r.assessment_id IN (${inList(assessIds)}) AND r.check_status <> 'rejected'
    ORDER BY r.kind, r.uploaded_at DESC, r.id DESC`).all(ws.id, ...assessIds) : [], shownCertificates);
  const confirmed = await db.prepare(`SELECT a.id FROM tp_assessments a WHERE a.workspace_id = ? AND a.third_party_id = ?
      AND a.status <> 'cancelled' AND a.confirmed_at IS NOT NULL ORDER BY a.confirmed_at DESC, a.id DESC LIMIT 1`).get(ws.id, id);
  const scopingId = confirmed ? confirmed.id : (latest ? latest.assessment_id : null);
  const live = latest ? conditions.filter(c => Number(c.recommendation_id) === Number(latest.recommendation_id)) : [];
  const activity = [];
  for (const r of reviews) {
    activity.push({ at: r.issued_at, text: `Recommendation version ${r.version} issued`, who: r.issuer_name || r.author_name || firmName });
    if (r.decided_at) activity.push({ at: r.decided_at, text: 'Decision recorded', who: r.decided_by_name || '' });
  }
  activity.sort((a, b) => new Date(b.at) - new Date(a.at));
  return {
    today, firmName, thirdParty: t, approval, reviews, latest, issues, conditions, liveConditions: live, evidence,
    services, contacts, insurance, assurance,
    documents: sharedDocuments,
    questionnaire: (await require('./questionnaire-progress').forThirdParties(db, ws, [id])).get(id) || null,
    insuranceState: insurance ? 'answered' : await require('./firm-party').insuranceStateFor(db, ws.id, assessIds),
    scoping: scopingId ? clientScoping(await scoping(db, ws, scopingId), await scopingTypeLabel(db, ws, t, scopingId)) : null,
    contract: latest ? await require('./contract-review').clientRows(db, ws, latest.assessment_id) : null,
    openIssues: issues.filter(i => i.status === 'open').length,
    conditionsDone: live.filter(c => ['verified', 'waived'].includes(c.status)).length,
    activity: activity.slice(0, 6),
    tierLabel: t.current_tier ? placement.TIER_LABELS[t.current_tier] : null,
  };
}

async function scopingTypeLabel(db, ws, t, assessmentId) {
  const a = await db.prepare('SELECT id, type, third_party_id, created_at FROM tp_assessments WHERE workspace_id = ? AND id = ?').get(ws.id, Number(assessmentId) || 0);
  return a ? await require('./assessments').typeLabelFor(db, ws.id, t, a) : null;
}

function clientScoping(sc, typeLabel) {
  if (!sc) return sc;
  const wording = require('./client-wording');
  const word = r => ({ ...r, text: wording.forClient(r.text), answer: wording.forClient(r.answer) });
  const pack = m => ({ ...m, because: wording.forClient(m.because), reason: wording.forClient(m.reason), when: wording.forClient(m.when) });
  return { ...sc, typeLabel, criticality: sc.criticality.map(word), context: sc.context.map(word),
    explanation: wording.forClient(sc.explanation), included: sc.included.map(pack), excluded: sc.excluded.map(pack),
    whenAnswered: sc.whenAnswered.map(pack) };
}

async function scoping(db, ws, assessmentId) {
  const a = await db.prepare(`SELECT a.id, a.type, a.answers, a.criticality_model_id, a.scored_tier, a.final_tier, a.tier_explanation,
      a.override_direction, a.deciding_question_id, a.deciding_answer_id, a.services_in_scope, a.proposed_at, a.confirmed_at,
      pu.name AS proposed_by_name, cu.name AS confirmed_by_name
    FROM tp_assessments a LEFT JOIN users pu ON pu.id = a.proposed_by LEFT JOIN users cu ON cu.id = a.confirmed_by
    WHERE a.workspace_id = ? AND a.id = ?`).get(ws.id, Number(assessmentId) || 0);
  if (!a || !a.final_tier) return null;
  const model = a.criticality_model_id ? await require('./criticality').getVersion(db, ws.firm_id, a.criticality_model_id) : null;
  const answers = a.answers && typeof a.answers === 'object' ? a.answers : {};
  const rows = ((model && model.questions) || []).filter(q => q && answers[q.id] !== undefined).map(q => {
    const ans = (q.answers || []).find(x => x && x.id === answers[q.id]) || null;
    return { id: q.id, text: q.text, kind: q.kind, answer: ans ? ans.label : String(answers[q.id]),
      tier: q.kind === 'criticality' && ans && ans.tier ? placement.TIER_LABELS[String(ans.tier).toLowerCase()] || ans.tier : null,
      deciding: q.id === a.deciding_question_id };
  });
  const q = await db.prepare(`SELECT modules, dynamic_modules, sections, sent_at FROM tp_questionnaires WHERE workspace_id = ? AND assessment_id = ?
    ORDER BY id DESC LIMIT 1`).get(ws.id, a.id);
  const modules = q && Array.isArray(q.modules) ? q.modules : [];
  const sections = q && Array.isArray(q.sections) ? q.sections.map(x => ({ title: x.title, count: Array.isArray(x.ids) ? x.ids.length : 0 })) : [];
  return {
    assessmentId: Number(a.id), type: a.type,
    tier: placement.TIER_LABELS[a.final_tier], scoredTier: a.scored_tier ? placement.TIER_LABELS[a.scored_tier] : null,
    explanation: a.tier_explanation, adjusted: a.override_direction && a.override_direction !== 'none' ? a.override_direction : null,
    proposedBy: a.proposed_by_name, proposedAt: a.proposed_at, confirmedBy: a.confirmed_by_name, confirmedAt: a.confirmed_at,
    criticality: rows.filter(r => r.kind === 'criticality'), context: rows.filter(r => r.kind !== 'criticality'),
    services: Array.isArray(a.services_in_scope) ? a.services_in_scope.map(x => x && x.description).filter(Boolean) : [],
    included: modules.filter(m => m && m.included !== false), excluded: modules.filter(m => m && m.included === false),
    whenAnswered: q && Array.isArray(q.dynamic_modules) ? q.dynamic_modules : [],
    sections, questionCount: sections.reduce((n, x) => n + x.count, 0), questionsSent: !!(q && q.sent_at),
  };
}

async function canEditDetails(db, ws, user) {
  if (!user) return false;
  const member = await db.prepare(`SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND m.user_id = ? AND u.user_type = 'client'`).get(ws.id, user.id);
  if (!member) return false;
  const roles = require('./conditions').CLIENT_SUBMITTER_ROLES;
  return roles.includes(member.role) || roles.includes(require('../rbac').normalizeRole(member.role));
}

module.exports = { TABS, TAB_LABELS, STAGES, PAGE_SIZE, HORIZON_DAYS, parseQuery, stageFor, home, thirdParty, thirdPartyRef, canEditDetails, scopingFor: scoping };
