'use strict';

const placement = require('./placement');
const decisions = require('./decisions');
const { todayFor } = require('../dates');

const TABS = Object.freeze(['all', 'waiting', 'renewals', 'ended']);
const TAB_LABELS = Object.freeze({ all: 'All third parties', waiting: 'Waiting on you', renewals: 'Renewals and expiries', ended: 'Ended' });
const STAGES = Object.freeze(['in_use', 'review', 'decision', 'proposed', 'exited']);
const PAGE_SIZE = 25;
const HORIZON_DAYS = 90;
const RANK = { critical: 1, high: 2, medium: 3, low: 4 };

const ymdPlus = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const str = (v, max = 100) => String(v == null ? '' : v).trim().slice(0, max);

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
  return { tab, tier, stage, service: str(q.service), q: str(q.q), page };
}

async function firmNameFor(db, ws) {
  const row = ws && ws.firm_id ? await db.prepare('SELECT name FROM firms WHERE id = ?').get(ws.firm_id) : null;
  return (row && row.name) || 'Your consultants';
}

async function baseRows(db, ws, today, firmName) {
  const rows = await db.prepare(`SELECT t.id, t.name, t.legal_name, t.category, t.status, t.current_tier, t.tier_source,
      t.next_due_date::text AS next_due_date, t.last_assessment_date::text AS last_assessment_date, t.created_at
    FROM tp_third_parties t WHERE t.workspace_id = ? ORDER BY lower(t.name), t.id`).all(ws.id);
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

async function dueSoon(db, ws, rows, today) {
  const end = ymdPlus(today, HORIZON_DAYS);
  const items = [];
  for (const r of rows) {
    if (r.status === 'in_use' && r.next_due_date && r.next_due_date >= today && r.next_due_date <= end) {
      items.push({ kind: 'review', label: 'Review due', name: r.name, thirdPartyId: r.id, date: r.next_due_date });
    }
    const until = r.approval && r.approval.until;
    if (until && until >= today && until <= end) items.push({ kind: 'approval', label: 'Approval ends', name: r.name, thirdPartyId: r.id, date: until });
  }
  const conds = await db.prepare(`SELECT c.position, c.due_date::text AS due_date, c.owner, t.id AS third_party_id, t.name
    FROM tp_conditions c
    JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id
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
  return { items, months, overdue: items.filter(x => x.overdue).length };
}

function matches(r, f) {
  if (f.tab === 'ended' ? r.status !== 'exited' : r.status === 'exited') return false;
  if (f.tab === 'waiting' && !r.waitingOnClient) return false;
  if (f.tab === 'renewals' && !r.renewalSoon) return false;
  if (f.tier && r.current_tier !== f.tier) return false;
  if (f.stage && r.stage.key !== f.stage) return false;
  if (f.service && (r.category || '') !== f.service) return false;
  if (f.q) {
    const hay = [r.name, r.legal_name, r.category].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

async function home(db, ws, query = {}) {
  const today = todayFor(ws);
  const firmName = await firmNameFor(db, ws);
  const f = parseQuery(query);
  const rows = await baseRows(db, ws, today, firmName);
  const ownConditions = await require('./conditions').clientOwnedOpen(db, ws);
  const ownBy = countBy(ownConditions, c => c.third_party_name);
  const due = await dueSoon(db, ws, rows, today);
  const renewalIds = new Set(due.items.filter(x => x.kind !== 'condition').map(x => x.thirdPartyId));
  for (const r of rows) {
    r.ownConditions = ownBy.get(r.name) || 0;
    r.waitingOnClient = r.approval.pending === 'decision_needed' || r.ownConditions > 0;
    r.renewalSoon = renewalIds.has(r.id) || r.approval.state === 'expired';
  }
  const current = rows.filter(r => r.status !== 'exited');
  const quarterStart = `${today.slice(0, 5)}${String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  const added = current.filter(r => r.created_at && new Date(r.created_at).toISOString().slice(0, 10) >= quarterStart)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const stageCounts = countBy(current, r => r.stage.key);
  const residual = countBy(current.filter(r => r.recommendation && r.recommendation.residual_rating), r => r.recommendation.residual_rating);
  const services = [...countBy(current, r => r.category || null)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const filtered = rows.filter(r => matches(r, f))
    .sort((a, b) => Number(b.waitingOnClient) - Number(a.waitingOnClient) || a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  return {
    today, firmName, filters: { ...f, page }, rows: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: filtered.length, page, pages, pageSize: PAGE_SIZE,
    tabCounts: {
      all: current.length,
      waiting: rows.filter(r => r.status !== 'exited' && r.waitingOnClient).length,
      renewals: rows.filter(r => r.status !== 'exited' && r.renewalSoon).length,
      ended: rows.length - current.length,
    },
    decisionsNeeded: rows.filter(r => r.approval.pending === 'decision_needed' && r.recommendation),
    ownConditions,
    tiles: {
      total: current.length,
      stages: STAGES.filter(k => k !== 'exited').map(k => ({ key: k, count: stageCounts.get(k) || 0 })),
      residual: ['critical', 'high', 'medium', 'low'].map(k => ({ key: k, count: residual.get(k) || 0 })),
      decided: [...residual.values()].reduce((s, n) => s + n, 0),
      inherentHigh: current.filter(r => ['critical', 'high'].includes(r.current_tier)).length,
      added, services: services.slice(0, 5), serviceMax: services.length ? services[0][1] : 0,
      due,
    },
    serviceOptions: services.map(s => s[0]),
  };
}

async function thirdParty(db, ws, thirdPartyId) {
  const id = Number(thirdPartyId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const today = todayFor(ws);
  const t = await db.prepare(`SELECT t.id, t.name, t.legal_name, t.registration_number, t.website, t.category, t.country,
      t.primary_contact_name, t.primary_contact_email, t.status, t.current_tier, t.tier_source,
      t.next_due_date::text AS next_due_date, t.last_assessment_date::text AS last_assessment_date, t.created_at
    FROM tp_third_parties t WHERE t.workspace_id = ? AND t.id = ?`).get(ws.id, id);
  if (!t) return null;
  const firmName = await firmNameFor(db, ws);
  const approval = await decisions.currentApproval(db, ws, id, { today });
  const reviews = await db.prepare(`SELECT a.id AS assessment_id, a.type, a.status AS assessment_status, a.final_tier,
      r.id AS recommendation_id, r.version, r.outcome, r.residual_rating, r.rationale, r.valid_until::text AS valid_until, r.issued_at,
      d.outcome AS decision_outcome, d.decided_at, du.name AS decided_by_name, au.name AS author_name
    FROM tp_recommendations r
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    LEFT JOIN LATERAL (SELECT dd.outcome, dd.decided_at, dd.decided_by FROM tp_client_decisions dd
      WHERE dd.workspace_id = r.workspace_id AND dd.recommendation_id = r.id ORDER BY dd.decided_at DESC, dd.id DESC LIMIT 1) d ON true
    LEFT JOIN users du ON du.id = d.decided_by
    LEFT JOIN users au ON au.id = r.author_id
    WHERE r.workspace_id = ? AND a.third_party_id = ? AND r.status = 'issued' AND a.status <> 'cancelled'
    ORDER BY r.issued_at DESC, r.id DESC`).all(ws.id, id);
  const recIds = reviews.map(r => Number(r.recommendation_id));
  const assessIds = [...new Set(reviews.map(r => Number(r.assessment_id)))];
  const inList = n => n.map(() => '?').join(',');
  const issues = assessIds.length ? await db.prepare(`SELECT f.id, f.assessment_id, f.control_ref, f.severity, f.title, f.status,
      f.description, f.impact FROM tp_findings f WHERE f.workspace_id = ? AND f.assessment_id IN (${inList(assessIds)})
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
  const recFor = new Map();
  for (const r of reviews) if (!recFor.has(Number(r.assessment_id))) recFor.set(Number(r.assessment_id), Number(r.recommendation_id));
  for (const e of evidence) e.recommendation_id = recFor.get(Number(e.assessment_id));
  for (const i of issues) i.recommendation_id = recFor.get(Number(i.assessment_id));
  const threads = await require('./issues').clientThreads(db, ws, issues.map(i => i.id));
  for (const i of issues) i.thread = threads.get(Number(i.id)) || null;
  const latest = reviews[0] || null;
  const live = latest ? conditions.filter(c => Number(c.recommendation_id) === Number(latest.recommendation_id)) : [];
  const activity = [];
  for (const r of reviews) {
    activity.push({ at: r.issued_at, text: `Recommendation version ${r.version} issued`, who: r.author_name || firmName });
    if (r.decided_at) activity.push({ at: r.decided_at, text: 'Decision recorded', who: r.decided_by_name || '' });
  }
  activity.sort((a, b) => new Date(b.at) - new Date(a.at));
  return {
    today, firmName, thirdParty: t, approval, reviews, latest, issues, conditions, liveConditions: live, evidence,
    openIssues: issues.filter(i => i.status === 'open').length,
    conditionsDone: live.filter(c => ['verified', 'waived'].includes(c.status)).length,
    activity: activity.slice(0, 6),
    tierLabel: t.current_tier ? placement.TIER_LABELS[t.current_tier] : null,
  };
}

module.exports = { TABS, TAB_LABELS, STAGES, PAGE_SIZE, HORIZON_DAYS, parseQuery, stageFor, home, thirdParty };
