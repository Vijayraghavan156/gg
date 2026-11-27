'use strict';

const access = require('./access');
const linkAccess = require('./link-access');

const WAITING_LABELS = Object.freeze({ third_party: 'Third party', consultant: 'Consultant', reviewer: 'Second person', client: 'Client' });
const WAITING = Object.keys(WAITING_LABELS);
const SORTS = Object.freeze(['due', 'days', 'client', 'third_party', 'step', 'waiting']);
const DAY = 24 * 3600 * 1000;

const ymd = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

function supplierWaiting(r) {
  if (!r.recipient_name) return null;
  if (r.third_party_exited) return 'no one, as the third party has exited';
  if (!r.recipient_left) return r.recipient_name;
  return r.main_name ? `${r.main_name} (main contact, by sign-in)` : `no one, as the link to ${r.recipient_name} no longer opens and there is no main contact`;
}

function stageOf(r) {
  const consultantName = r.author_name || r.lead_name || null;
  const st = (step, stepKey, waiting, waitingName = null) => ({ step, stepKey, waiting, waitingName });
  switch (r.status) {
    case 'scoping': return st('Scope and tier', 'scope', 'consultant', r.lead_name);
    case 'tier_proposed': return st('Tier to confirm', 'scope', 'reviewer', namedReviewer(r) ? r.reviewer_name : null);
    case 'tier_confirmed':
      if (!r.q_status || r.q_status === 'draft') return st('Questionnaire to send', 'questionnaire', 'consultant', r.lead_name);
      if (['sent', 'in_progress'].includes(r.q_status)) return st('Questionnaire with the third party', 'questionnaire', 'third_party', supplierWaiting(r));
      if (['submitted', 'under_review'].includes(r.q_status)) {
        if (Number(r.unreviewed) > 0) return st('Review of answers', 'review', 'consultant', r.lead_name);
        if (Number(r.open_clarifications) > 0) return st('Clarifications with the third party', 'review', 'third_party', supplierWaiting(r));
        return st('Review to close', 'review', 'consultant', r.lead_name);
      }
      return st('Recommendation to draft', 'recommendation', 'consultant', consultantName);
    case 'recommendation_draft':
      return st(r.rec_status === 'changes_requested' ? 'Recommendation: changes requested' : 'Recommendation being drafted', 'recommendation', 'consultant', consultantName);
    case 'recommendation_in_review': return st('Recommendation to review', 'recommendation', 'reviewer', namedReviewer(r) ? r.reviewer_name : null);
    case 'recommendation_issued': return st('Client decision', 'decision', 'client', r.owner_name);
    case 'information_requested': return st('Client asked for more information', 'decision', 'consultant', consultantName);
    default: return st(r.status, null, 'consultant');
  }
}

function namedReviewer(r) {
  if (!r.reviewer_id || Number(r.reviewer_active) !== 1) return false;
  if (!access.firmCan({ user_type: r.reviewer_type, firm_role: r.reviewer_role }, 'tp.review')) return false;
  return ![r.proposed_by, r.author_id].some(x => x && Number(x) === Number(r.reviewer_id));
}

function parseFilters(q = {}) {
  const who = ['mine', 'me'].includes(String(q.who)) ? String(q.who) : 'all';
  const waiting = WAITING.includes(String(q.waiting)) ? String(q.waiting) : '';
  const sort = SORTS.includes(String(q.sort)) ? String(q.sort) : 'due';
  const dir = String(q.dir) === 'desc' ? 'desc' : 'asc';
  return { who, waiting, late: String(q.late) === '1', due30: String(q.due) === '30', sort, dir, q: String(q.q || '').trim().slice(0, 100) };
}

async function openRows(db, ids) {
  if (!ids.length) return [];
  return await db.prepare(`SELECT a.id, a.workspace_id, a.third_party_id, a.type, a.status, a.final_tier, a.due_date::text AS due_date,
      a.lead_consultant_id, a.reviewer_id, a.proposed_by, a.created_at, t.name AS third_party_name, lu.name AS lead_name, ou.name AS owner_name, vu.name AS reviewer_name, vu.active AS reviewer_active, vu.firm_role AS reviewer_role, vu.user_type AS reviewer_type,
      q.status AS q_status, q.closed_reason AS q_closed_reason,
      (SELECT COUNT(*)::int FROM tp_answers x WHERE x.workspace_id = a.workspace_id AND x.questionnaire_id = q.id AND x.review_conclusion = 'not_reviewed' AND x.response IS NOT NULL) AS unreviewed,
      (SELECT COUNT(*)::int FROM tp_clarifications c WHERE c.workspace_id = a.workspace_id AND c.questionnaire_id = q.id AND c.status = 'open') AS open_clarifications,
      vl.recipient_name, vl.recipient_left, (t.status = 'exited') AS third_party_exited,
      ${linkAccess.mainContactSql('a.workspace_id', 'a.third_party_id', 'name')} AS main_name,
      r.status AS rec_status, r.author_id, au.name AS author_name,
      (SELECT MAX(e.created_at) FROM tp_events e WHERE e.workspace_id = a.workspace_id AND e.chain_type = 'assessment' AND e.chain_id = a.id
         AND e.action NOT LIKE 'message.%') AS last_event_at
    FROM tp_assessments a
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    LEFT JOIN users lu ON lu.id = a.lead_consultant_id
    LEFT JOIN users ou ON ou.id = a.client_decision_owner_id
    LEFT JOIN users vu ON vu.id = a.reviewer_id
    LEFT JOIN tp_questionnaires q ON q.workspace_id = a.workspace_id AND q.assessment_id = a.id
    LEFT JOIN LATERAL (SELECT status, author_id FROM tp_recommendations rr WHERE rr.workspace_id = a.workspace_id AND rr.assessment_id = a.id
       AND rr.status IN ('draft', 'changes_requested', 'in_review') ORDER BY rr.version DESC LIMIT 1) r ON true
    LEFT JOIN users au ON au.id = r.author_id
    LEFT JOIN LATERAL (SELECT v.recipient_name, ${linkAccess.recipientLeft('v', 'a.third_party_id')} AS recipient_left FROM tp_vendor_requests v
       WHERE v.workspace_id = a.workspace_id AND v.questionnaire_id = q.id AND v.status = 'active' AND v.expires_at > now()
       ORDER BY v.created_at DESC LIMIT 1) vl ON true
    WHERE a.workspace_id IN (${ids.map(() => '?').join(',')}) AND a.status NOT IN ('completed', 'cancelled')`).all(...ids);
}

async function stagesForClient(db, workspaceId) {
  const map = new Map();
  for (const r of await openRows(db, [Number(workspaceId)])) {
    const stage = stageOf(r);
    map.set(Number(r.third_party_id), { assessmentId: Number(r.id), ...stage, waitingLabel: WAITING_LABELS[stage.waiting] });
  }
  return map;
}

async function pipeline(deps, user, { query = {}, today = null } = {}) {
  const filters = parseFilters(query);
  const empty = { rows: [], all: 0, clientCount: 0, counts: { mine: 0, waitingForMe: 0, late: 0, dueSoon: 0, total: 0 }, filters };
  if (!access.isFirmUser(user) || !access.firmCan(user, 'tp.view')) return empty;
  const { enabled } = await access.listFirmClients(deps, user);
  const reachable = [];
  for (const c of enabled) if (await access.loadFirmWorkspace(deps, user, c.id)) reachable.push({ id: Number(c.id), name: c.name });
  if (!reachable.length) return empty;
  const names = new Map(reachable.map(c => [c.id, c.name]));
  const ids = reachable.map(c => c.id);
  const rows = await require('./scope').keep(deps.db, user, await openRows(deps.db, ids));

  const now = today ? new Date(`${ymd(today)}T12:00:00Z`) : new Date();
  const todayYmd = ymd(now);
  const in30 = ymd(new Date(now.getTime() + 30 * DAY));
  const canReview = access.firmCan(user, 'tp.review');
  const me = Number(user.id);
  const typeLabels = await require('./assessments').typeLabelsFor(deps.db, rows.map(r => ({ id: r.id, type: r.type })));
  const list = rows.map(r => {
    const stage = stageOf(r);
    const mine = [r.lead_consultant_id, r.author_id, r.proposed_by, r.reviewer_id].some(x => Number(x) === me);
    const forMe = (stage.waiting === 'consultant' && [r.lead_consultant_id, r.author_id].some(x => Number(x) === me))
      || (stage.waiting === 'reviewer' && canReview && Number(r.proposed_by) !== me && Number(r.author_id) !== me
        && (!namedReviewer(r) || Number(r.reviewer_id) === me));
    const since = r.last_event_at ? new Date(r.last_event_at) : new Date(r.created_at);
    const days = Math.max(0, Math.floor((now - since) / DAY));
    const due = r.due_date ? ymd(r.due_date) : null;
    return {
      id: Number(r.id), workspaceId: Number(r.workspace_id), thirdPartyId: Number(r.third_party_id), clientName: names.get(Number(r.workspace_id)),
      thirdPartyName: r.third_party_name, type: r.type, typeLabel: typeLabels.get(Number(r.id)), status: r.status, tier: r.final_tier, ...stage,
      waitingLabel: WAITING_LABELS[stage.waiting], mine, forMe, days, due,
      late: !!due && due < todayYmd, dueSoon: !!due && due >= todayYmd && due <= in30,
    };
  });
  const counts = { mine: list.filter(x => x.mine).length, waitingForMe: list.filter(x => x.forMe).length,
    late: list.filter(x => x.late).length, dueSoon: list.filter(x => x.dueSoon).length, total: list.length };
  const { fold } = require('./text-fold');
  const words = fold(filters.q).split(/\s+/).filter(Boolean);
  let shown = list.filter(x => (filters.who === 'all' || (filters.who === 'mine' ? x.mine : x.forMe))
    && (!filters.waiting || x.waiting === filters.waiting) && (!filters.late || x.late) && (!filters.due30 || x.dueSoon)
    && words.every(w => fold(`${x.clientName} ${x.thirdPartyName} ${x.step} ${x.waitingLabel} ${x.waitingName || ''}`).includes(w)));
  const key = { due: x => x.due || '9999', days: x => String(100000 - x.days).padStart(6, '0'), client: x => `${x.clientName} ${x.thirdPartyName}`.toLowerCase(),
    third_party: x => x.thirdPartyName.toLowerCase(), step: x => x.step.toLowerCase(), waiting: x => x.waitingLabel }[filters.sort];
  shown = shown.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id - b.id) * (filters.dir === 'desc' ? -1 : 1));
  return { rows: shown, allRows: list, all: list.length, clientCount: new Set(list.map(x => x.workspaceId)).size, counts, filters };
}

module.exports = { WAITING_LABELS, WAITING, SORTS, stageOf, parseFilters, pipeline, stagesForClient };
