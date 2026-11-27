'use strict';

const access = require('./access');
const { todayFor } = require('../dates');

const DAY = 24 * 3600 * 1000;
const STAGE_KEYS = Object.freeze(['scope', 'third_party', 'consultant', 'reviewer', 'client']);
const STAGE_LABELS = Object.freeze({
  scope: 'Scoping', third_party: 'With the supplier', consultant: 'With your team', reviewer: 'Second person', client: 'Client decision',
});

const ymd = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
const avg = list => (list.length ? Math.round(list.reduce((s, n) => s + n, 0) / list.length) : null);

function stageOf(r) {
  if (r.stepKey === 'scope' && r.waiting === 'consultant') return 'scope';
  return STAGE_KEYS.includes(r.waiting) ? r.waiting : 'consultant';
}

async function build(deps, user, pipelineView, clients) {
  const { db } = deps;
  const reachable = [];
  for (const c of clients) if (await access.loadFirmWorkspace(deps, user, c.id)) reachable.push({ id: Number(c.id), name: c.name, sector: c.sector || null });
  const ids = reachable.map(c => c.id);
  const visible = await require('./scope').visibleIds(db, user, ids);
  const vis = col => (!visible ? ['', []] : visible.size ? [` AND ${col} IN (${[...visible].map(() => '?').join(',')})`, [...visible]] : [' AND false', []]);
  const today = ymd(new Date());
  const in7 = ymd(new Date(Date.now() + 7 * DAY));
  const rows = (pipelineView && pipelineView.allRows) || (pipelineView && pipelineView.rows) || [];
  const stages = STAGE_KEYS.map(k => ({ key: k, label: STAGE_LABELS[k], count: rows.filter(r => stageOf(r) === k).length }));
  const supplierDays = avg(rows.filter(r => r.waiting === 'third_party').map(r => r.days));
  const teamDays = avg(rows.filter(r => ['consultant', 'reviewer'].includes(r.waiting)).map(r => r.days));

  const canManage = access.firmCan(user, 'tp.manage');
  const proofs = canManage ? await require('./conditions').proofQueue(deps, user) : [];
  const requests = canManage && ids.length ? await require('./client-requests').visibleTo(db, user, await db.prepare(`SELECT r.id, r.workspace_id, r.kind, r.third_party_id, r.name, r.service_description, r.requested_at, u.name AS requested_by_name
    FROM tp_client_requests r LEFT JOIN users u ON u.id = r.requested_by
    WHERE r.status = 'submitted' AND r.workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.requested_at`).all(...ids)) : [];
  const names = new Map(reachable.map(c => [c.id, c.name]));
  const work = [];
  for (const r of rows.filter(x => x.forMe)) {
    work.push({ kind: 'assessment', what: r.step, detail: r.waitingName ? `Waiting on you since ${r.days} day${r.days === 1 ? '' : 's'}` : '',
      thirdParty: r.thirdPartyName, sub: r.typeLabel || (r.type === 'reassessment' ? 'Reassessment' : 'Onboarding'), client: r.clientName, tier: r.tier, since: r.days,
      due: r.due, late: r.late, href: `/tprm/clients/${r.workspaceId}/third-parties/${r.thirdPartyId}/assessments/${r.id}` });
  }
  for (const p of proofs) {
    const days = p.pending_since ? Math.max(0, Math.floor((Date.now() - new Date(p.pending_since).getTime()) / DAY)) : 0;
    work.push({ kind: 'proof', what: `Check proof for condition ${p.position}`, detail: p.pending_by_name ? `Sent by ${p.pending_by_name}` : 'Proof sent',
      thirdParty: p.third_party_name, sub: 'Condition', client: p.client_name, tier: null, since: days, due: p.due_date || null,
      late: !!p.due_date && ymd(p.due_date) < today, href: `/tprm/clients/${p.workspace_id}/third-parties/${p.third_party_id}/assessments/${p.assessment_id}?step=decision#conditions` });
  }
  for (const q of requests) {
    const days = Math.max(0, Math.floor((Date.now() - new Date(q.requested_at).getTime()) / DAY));
    const reassess = q.kind === 'reassessment';
    work.push({ kind: 'request', requestKind: reassess ? 'reassessment' : 'new_supplier', what: reassess ? 'Reassess at the client\'s request' : 'Add the client\'s request', detail: q.requested_by_name ? `Requested by ${q.requested_by_name}` : 'Requested by the client',
      thirdParty: q.name, sub: reassess ? 'Reassessment' : 'New supplier', client: names.get(Number(q.workspace_id)) || '', tier: null, since: days, due: null, late: false,
      href: `/tprm/clients/${q.workspace_id}/requests/${q.id}` });
  }
  work.sort((a, b) => Number(b.late) - Number(a.late) || String(a.due || '9999').localeCompare(String(b.due || '9999')) || b.since - a.since);

  const conditionsDue = await require('./conditions').conditionsDue(deps, user);
  const [aSql, aArgs] = vis('a.third_party_id');
  const expiring = ids.length ? (await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_vendor_requests v JOIN tp_assessments a ON a.workspace_id = v.workspace_id AND a.id = v.assessment_id
    WHERE v.status = 'active' AND v.expires_at > now() AND v.expires_at <= ?::date + 1 AND v.workspace_id IN (${ids.map(() => '?').join(',')})${aSql}`).get(in7, ...ids, ...aArgs)).n : 0;

  const quarterStart = `${today.slice(0, 5)}${String(Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  const decided = ids.length ? await db.prepare(`SELECT d.outcome, COUNT(*)::int AS n FROM tp_client_decisions d JOIN tp_assessments a ON a.workspace_id = d.workspace_id AND a.id = d.assessment_id
    WHERE d.decided_at >= ?::date AND d.outcome <> 'request_more_information' AND d.workspace_id IN (${ids.map(() => '?').join(',')})${aSql} GROUP BY d.outcome`).all(quarterStart, ...ids, ...aArgs) : [];
  const dec = Object.fromEntries(decided.map(d => [d.outcome, d.n]));

  const [tSql, tArgs] = vis('t.id');
  const counts = ids.length ? await db.prepare(`SELECT t.workspace_id, COUNT(*) FILTER (WHERE t.status <> 'exited')::int AS parties
    FROM tp_third_parties t WHERE t.workspace_id IN (${ids.map(() => '?').join(',')})${tSql} GROUP BY t.workspace_id`).all(...ids, ...tArgs) : [];
  const partiesBy = new Map(counts.map(c => [Number(c.workspace_id), c.parties]));
  const reqBy = new Map();
  const reassessBy = new Map();
  for (const q of requests) {
    const by = q.kind === 'reassessment' ? reassessBy : reqBy;
    by.set(Number(q.workspace_id), (by.get(Number(q.workspace_id)) || 0) + 1);
  }
  const cards = reachable.map(c => {
    const mine = rows.filter(r => Number(r.workspaceId) === c.id);
    return { ...c, parties: partiesBy.get(c.id) || 0, open: mine.length, late: mine.filter(r => r.late).length,
      waitingClient: mine.filter(r => r.waiting === 'client').length, requests: reqBy.get(c.id) || 0, reassessRequests: reassessBy.get(c.id) || 0 };
  });

  return {
    work,
    stages, total: rows.length, supplierDays, teamDays,
    waitingOnYou: work.length,
    waitingBreakdown: [
      ['Assessment steps', work.filter(w => w.kind === 'assessment').length],
      ['Condition proofs to check', work.filter(w => w.kind === 'proof').length],
      ['Client requests to add', work.filter(w => w.kind === 'request' && w.requestKind !== 'reassessment').length],
      ['Client requests to reassess', work.filter(w => w.requestKind === 'reassessment').length],
    ],
    late: rows.filter(r => r.late).length, dueSoon: rows.filter(r => r.dueSoon).length,
    conditionsOverdue: conditionsDue.overdue.length, linksExpiring: expiring,
    byClient: cards.filter(c => c.open).sort((a, b) => b.open - a.open).slice(0, 5), maxOpen: Math.max(1, ...cards.map(c => c.open)),
    decisions: { approved: dec.approve || 0, conditions: dec.approve_with_conditions || 0, rejected: dec.reject || 0 },
    clients: cards, partiesTotal: cards.reduce((s, c) => s + c.parties, 0),
  };
}

module.exports = { STAGE_KEYS, STAGE_LABELS, build };
