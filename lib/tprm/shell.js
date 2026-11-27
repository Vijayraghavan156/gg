'use strict';

const access = require('./access');
const scope = require('./scope');
const { workspaceTimeZone, todayFor } = require('../dates');

async function reachableClients(deps, user, permission = 'tp.view') {
  if (!access.isFirmUser(user) || !access.firmCan(user, permission)) return [];
  const { enabled } = await access.listFirmClients(deps, user);
  const out = [];
  for (const c of enabled) {
    const loaded = await access.loadFirmWorkspace(deps, user, c.id, { permission });
    if (loaded) out.push({ id: Number(c.id), name: c.name, ws: loaded.ws, perms: loaded.perms });
  }
  return out;
}

async function searchThirdParties(deps, user, q, { limit = 8 } = {}) {
  const words = String(q || '').trim().slice(0, 100);
  if (!words) return [];
  const clients = await reachableClients(deps, user);
  if (!clients.length) return [];
  const names = new Map(clients.map(c => [c.id, c.name]));
  const ids = clients.map(c => c.id);
  const own = await scope.filterFor(deps.db, user, 't');
  const { foldSql, likeFolded } = require('./text-fold');
  const like = likeFolded(words);
  const rows = await deps.db.prepare(`SELECT t.id, t.workspace_id, t.name, t.category, t.status FROM tp_third_parties t
    WHERE t.workspace_id IN (${ids.map(() => '?').join(',')})
      AND (${foldSql('t.name')} LIKE ? OR ${foldSql('t.legal_name')} LIKE ?)${own.sql}
    ORDER BY (t.status = 'exited'), lower(t.name), t.id LIMIT ?`).all(...ids, like, like, ...own.params, Number(limit));
  return rows.map(r => ({
    type: 'Third party',
    label: r.name,
    sublabel: [names.get(Number(r.workspace_id)), r.category, r.status === 'exited' ? 'Exited' : null].filter(Boolean).join(' · '),
    href: `/tprm/clients/${r.workspace_id}/third-parties/${r.id}`,
  }));
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

async function workspaceActivity(deps, user, workspaceId, filters = {}, { limit = 100 } = {}) {
  const empty = { available: false, list: [], total: 0 };
  const loaded = await access.loadFirmWorkspace(deps, user, workspaceId);
  if (!loaded) return empty;
  const where = ['e.workspace_id = ?'];
  const args = [loaded.ws.id];
  const actorId = Number(filters.user_id);
  if (filters.user_id && Number.isSafeInteger(actorId)) { where.push('e.actor_user_id = ?'); args.push(actorId); }
  const tz = workspaceTimeZone(loaded.ws);
  if (YMD.test(String(filters.from || ''))) { where.push('(e.created_at AT TIME ZONE ?)::date >= ?::date'); args.push(tz, filters.from); }
  if (YMD.test(String(filters.to || ''))) { where.push('(e.created_at AT TIME ZONE ?)::date <= ?::date'); args.push(tz, filters.to); }
  const rows = await deps.db.prepare(`SELECT e.id, e.action, e.before_state, e.after_state, e.created_at, e.workspace_id,
      e.actor_user_id, u.name AS actor_name, COALESCE(e.third_party_id, a.third_party_id) AS third_party_id, t.name AS third_party_name
    FROM tp_events e
    LEFT JOIN users u ON u.id = e.actor_user_id
    LEFT JOIN tp_assessments a ON e.chain_type = 'assessment' AND a.workspace_id = e.workspace_id AND a.id = e.chain_id
    LEFT JOIN tp_third_parties t ON t.workspace_id = e.workspace_id AND t.id = COALESCE(e.third_party_id, a.third_party_id)
    WHERE ${where.join(' AND ')}
    ORDER BY e.created_at DESC, e.id DESC LIMIT 2000`).all(...args);
  let shown = rows;
  if (await scope.restricted(deps.db, user)) {
    const keepIds = new Set((await scope.keep(deps.db, user, rows.filter(r => r.third_party_id != null))).map(r => Number(r.id)));
    shown = rows.filter(r => keepIds.has(Number(r.id)));
  }
  const placement = require('./placement');
  const history = require('./history');
  const fmt = require('./format');
  const o = {
    tier: k => (k ? placement.TIER_LABELS[k] || k : ''),
    conclusion: c => require('./questionnaire-review').CONCLUSION_LABELS[c] || String(c || '').replace(/_/g, ' '),
  };
  const words = String(filters.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
  const list = [];
  for (const e of shown) {
    const { text } = history.sentenceOf(e, o);
    const entry = {
      id: Number(e.id),
      at: e.created_at,
      when: fmt.dayTime(e.created_at, tz, { zone: true }),
      who: e.actor_name || '',
      actorId: e.actor_user_id != null ? Number(e.actor_user_id) : null,
      thirdParty: e.third_party_name || '',
      thirdPartyId: e.third_party_id != null ? Number(e.third_party_id) : null,
      text,
    };
    const hay = `${entry.text} ${entry.thirdParty} ${e.action}`.toLowerCase();
    if (words.length && !words.every(w => hay.includes(w))) continue;
    list.push(entry);
  }
  return { available: true, list: list.slice(0, limit), total: list.length };
}

const DAY = 24 * 3600 * 1000;
const SOON_DAYS = 30;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const tpHref = (ws, tp) => `/tprm/clients/${ws}/third-parties/${tp}`;
const inList = list => list.map(() => '?').join(',');

async function visibleRows(db, user, rows) {
  return await scope.restricted(db, user) ? await scope.keep(db, user, rows) : rows;
}

async function workRows(deps, user, clients) {
  const ids = clients.map(c => c.id);
  if (!ids.length) return { parties: [], assessments: [], questionnaires: [], conditions: [], proofs: [], requests: [] };
  const db = deps.db;
  const parties = await visibleRows(db, user, (await db.prepare(`SELECT t.id AS third_party_id, t.workspace_id, t.name, t.status,
      t.next_due_date::text AS next_due_date, t.team_owner_id,
      EXISTS (SELECT 1 FROM tp_assessments x WHERE x.workspace_id = t.workspace_id AND x.third_party_id = t.id
        AND x.status NOT IN ('completed', 'cancelled')) AS assessing
    FROM tp_third_parties t WHERE t.workspace_id IN (${inList(ids)}) AND t.status <> 'exited'`).all(...ids)));
  const assessments = await visibleRows(db, user, await db.prepare(`SELECT a.id, a.workspace_id, a.third_party_id, a.status, a.type,
      a.due_date::text AS due_date, a.lead_consultant_id, t.name AS third_party_name
    FROM tp_assessments a JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    WHERE a.workspace_id IN (${inList(ids)}) AND a.status NOT IN ('completed', 'cancelled')`).all(...ids));
  const questionnaires = await visibleRows(db, user, await db.prepare(`SELECT q.id, q.workspace_id, q.assessment_id, a.third_party_id,
      a.lead_consultant_id, t.name AS third_party_name, v.expires_at, v.status AS link_status
    FROM tp_questionnaires q
    JOIN tp_assessments a ON a.workspace_id = q.workspace_id AND a.id = q.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    LEFT JOIN LATERAL (SELECT r.status, r.expires_at FROM tp_vendor_requests r
      WHERE r.workspace_id = q.workspace_id AND r.questionnaire_id = q.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) v ON true
    WHERE q.workspace_id IN (${inList(ids)}) AND q.status IN ('sent', 'in_progress')
      AND a.status NOT IN ('completed', 'cancelled')`).all(...ids));
  const conditions = await visibleRows(db, user, await db.prepare(`SELECT c.id, c.workspace_id, c.position, c.status,
      c.due_date::text AS due_date, c.waive_until::text AS waive_until, r.assessment_id, a.third_party_id, a.lead_consultant_id,
      t.name AS third_party_name
    FROM tp_conditions c
    JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id AND r.status = 'issued'
    JOIN tp_client_decisions d ON d.workspace_id = r.workspace_id AND d.recommendation_id = r.id AND d.outcome = 'approve_with_conditions'
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    WHERE c.workspace_id IN (${inList(ids)}) AND c.status <> 'verified'`).all(...ids));
  const requests = access.firmCan(user, 'tp.manage') ? await require('./client-requests').visibleTo(db, user, await db.prepare(`SELECT r.id, r.workspace_id, r.kind,
      r.third_party_id, r.name, r.requested_at
    FROM tp_client_requests r WHERE r.status = 'submitted' AND r.workspace_id IN (${inList(ids)})`).all(...ids)) : [];
  return { parties, assessments, questionnaires, conditions, requests };
}

async function calendarItems(deps, user) {
  const clients = await reachableClients(deps, user);
  if (!clients.length) return [];
  return calendarFromRows(await workRows(deps, user, clients), clients);
}

function calendarFromRows(rows, clients) {
  const byId = new Map(clients.map(c => [Number(c.id), c]));
  const fmt = require('./format');
  const conditionsLib = require('./conditions');
  const items = [];
  const base = (wsId, link) => ({ wsId: Number(wsId), wsName: byId.get(Number(wsId)).name, link, ownerLabel: null });
  for (const a of rows.assessments) {
    items.push({ ...base(a.workspace_id, `${tpHref(a.workspace_id, a.third_party_id)}/assessments/${a.id}`),
      kind: 'tp-assessment', title: `Assessment: ${a.third_party_name}`,
      date: a.due_date || null, status: a.status, open: true, countsWorkload: true, ownerId: a.lead_consultant_id || null });
  }
  for (const q of rows.questionnaires) {
    const ws = byId.get(Number(q.workspace_id)).ws;
    const date = q.expires_at ? fmt.ymd(q.expires_at, workspaceTimeZone(ws)) : null;
    if (!date) continue;
    items.push({ ...base(q.workspace_id, `${tpHref(q.workspace_id, q.third_party_id)}/assessments/${q.assessment_id}?step=questionnaire`),
      kind: 'tp-questionnaire', title: `Questionnaire due: ${q.third_party_name}`, date, status: q.link_status || 'sent',
      open: true, countsWorkload: false, ownerId: q.lead_consultant_id || null });
  }
  for (const c of rows.conditions) {
    const today = todayFor(byId.get(Number(c.workspace_id)).ws);
    if (!c.due_date || conditionsLib.stateOf(c, today).met) continue;
    items.push({ ...base(c.workspace_id, `${tpHref(c.workspace_id, c.third_party_id)}/assessments/${c.assessment_id}?step=decision#conditions`),
      kind: 'tp-condition', title: `Condition ${c.position} due: ${c.third_party_name}`, date: c.due_date, status: c.status,
      open: true, countsWorkload: false, ownerId: c.lead_consultant_id || null });
  }
  for (const p of rows.parties) {
    if (p.status !== 'in_use' || !p.next_due_date || p.assessing) continue;
    const today = todayFor(byId.get(Number(p.workspace_id)).ws);
    items.push({ ...base(p.workspace_id, tpHref(p.workspace_id, p.third_party_id)),
      kind: 'tp-review', title: `Review due: ${p.name}`, date: p.next_due_date, status: 'due', open: true,
      countsWorkload: p.next_due_date <= addDays(today, SOON_DAYS), ownerId: p.team_owner_id || null });
  }
  return items;
}

function statusOf(rows, wsId, today) {
  const conditionsLib = require('./conditions');
  const mine = list => list.filter(r => Number(r.workspace_id) === wsId);
  const parties = mine(rows.parties);
  const due = parties.filter(p => p.status === 'in_use' && p.next_due_date && !p.assessing);
  const overdue = due.filter(p => p.next_due_date < today);
  const dueSoon = due.filter(p => p.next_due_date >= today && p.next_due_date <= addDays(today, SOON_DAYS));
  const conditions = mine(rows.conditions).map(c => ({ ...c, state: conditionsLib.stateOf(c, today) })).filter(c => !c.state.met);
  const condOverdue = conditions.filter(c => c.state.overdue);
  const proofs = conditions.filter(c => c.state.awaitingVerification);
  const questionnairesOverdue = mine(rows.questionnaires).filter(q => !q.expires_at || q.link_status !== 'active' || new Date(q.expires_at) <= new Date());
  const requests = mine(rows.requests);
  const open = mine(rows.assessments);
  const reasons = [];
  if (overdue.length) reasons.push(`${plural(overdue.length, 'review')} overdue`);
  if (condOverdue.length) reasons.push(`${plural(condOverdue.length, 'condition')} overdue`);
  if (questionnairesOverdue.length) reasons.push(`${plural(questionnairesOverdue.length, 'questionnaire')} past the link date`);
  if (proofs.length) reasons.push(`${plural(proofs.length, 'condition proof')} to check`);
  const reassessments = requests.filter(r => r.kind === 'reassessment').length;
  if (requests.length > reassessments) reasons.push(`${plural(requests.length - reassessments, 'client request')} to add`);
  if (reassessments) reasons.push(`${plural(reassessments, 'reassessment')} asked for by the client`);
  if (dueSoon.length) reasons.push(`${plural(dueSoon.length, 'review')} due within ${SOON_DAYS} days`);
  const severity = overdue.length || condOverdue.length || questionnairesOverdue.length ? 'high' : reasons.length ? 'medium' : 'ok';
  const nextDue = due.map(p => p.next_due_date).filter(d => d >= today).sort()[0] || null;
  return {
    parties: parties.length, openAssessments: open.length, reassessmentsOverdue: overdue.length, reassessmentsDueSoon: dueSoon.length,
    conditionsOverdue: condOverdue.length, proofsToCheck: proofs.length, requestsToAdd: requests.length - reassessments, requestsToReassess: reassessments,
    questionnairesOverdue: questionnairesOverdue.length, nextDue, reasons, severity,
    detail: { overdue, dueSoon, condOverdue, conditions, proofs, requests, questionnairesOverdue },
  };
}

async function clientStatuses(deps, user, workspaceIds) {
  const wanted = new Set((workspaceIds || []).map(Number));
  const clients = (await reachableClients(deps, user)).filter(c => wanted.has(c.id));
  const out = new Map();
  if (!clients.length) return out;
  const rows = await workRows(deps, user, clients);
  for (const c of clients) {
    const { detail, ...status } = statusOf(rows, c.id, todayFor(c.ws));
    out.set(c.id, status);
  }
  return out;
}

async function attention(deps, user, workspaceId) {
  const clients = (await reachableClients(deps, user)).filter(c => c.id === Number(workspaceId));
  if (!clients.length) return [];
  const c = clients[0];
  const today = todayFor(c.ws);
  const rows = await workRows(deps, user, clients);
  const s = statusOf(rows, c.id, today).detail;
  const items = [];
  const push = (severity, title, link, detail) => items.push({ severity, category: 'third-party risk', title, link, detail });
  for (const p of s.overdue) push('high', `Review overdue: ${p.name}`, tpHref(c.id, p.third_party_id), `Was due ${p.next_due_date}`);
  for (const k of s.condOverdue) push('high', `Condition ${k.position} overdue: ${k.third_party_name}`, `${tpHref(c.id, k.third_party_id)}/assessments/${k.assessment_id}?step=decision#conditions`, `Due ${k.due_date}`);
  for (const q of s.questionnairesOverdue) push('high', `Questionnaire past its link date: ${q.third_party_name}`, `${tpHref(c.id, q.third_party_id)}/assessments/${q.assessment_id}?step=questionnaire`, 'Reopen the link or close the questionnaire');
  for (const k of s.proofs) push('medium', `Check the proof for condition ${k.position}: ${k.third_party_name}`, `${tpHref(c.id, k.third_party_id)}/assessments/${k.assessment_id}?step=decision#conditions`, k.due_date ? `Due ${k.due_date}` : '');
  for (const r of s.requests) push('medium', `${r.kind === 'reassessment' ? 'Reassess at the client\'s request' : 'Add the client\'s request'}: ${r.name}`, `/tprm/clients/${c.id}/requests/${r.id}`, '');
  for (const k of s.conditions.filter(x => x.state.dueSoon && !x.state.awaitingVerification)) push('medium', `Condition ${k.position} due soon: ${k.third_party_name}`, `${tpHref(c.id, k.third_party_id)}/assessments/${k.assessment_id}?step=decision#conditions`, `Due ${k.due_date}`);
  for (const p of s.dueSoon) push('medium', `Review due: ${p.name}`, tpHref(c.id, p.third_party_id), `Due ${p.next_due_date}`);
  return items;
}

function bind(deps) {
  return {
    searchThirdParties: (user, q, options) => searchThirdParties(deps, user, q, options),
    workspaceActivity: (user, workspaceId, filters, options) => workspaceActivity(deps, user, workspaceId, filters, options),
    calendarItems: user => calendarItems(deps, user),
    clientStatuses: (user, workspaceIds) => clientStatuses(deps, user, workspaceIds),
    attention: (user, workspaceId) => attention(deps, user, workspaceId),
  };
}

module.exports = { reachableClients, searchThirdParties, workspaceActivity, calendarItems, calendarFromRows, statusOf, clientStatuses, attention, bind };
