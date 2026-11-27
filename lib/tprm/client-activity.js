'use strict';

const LIMIT = 12;

async function recent(db, ws, user) {
  const base = `/workspaces/${Number(ws.id)}/client-portal/third-party-risk`;
  const home = await require('./client-view').home(db, ws, {}, user);
  const items = [];
  for (const r of home.decisionsNeeded) {
    items.push({
      kind: 'decision', at: r.recommendation.issued_at, title: `Decision needed on ${r.name}`,
      text: `${home.firmName} issued recommendation version ${r.recommendation.version}.`,
      href: `${base}/recommendations/${Number(r.recommendation.recommendation_id)}`,
    });
  }
  for (const q of home.requests) {
    if (!['accepted', 'declined'].includes(q.status) || !q.decided_at) continue;
    items.push({
      kind: 'request', at: q.decided_at,
      title: q.kind === 'reassessment'
        ? (q.status === 'accepted' ? `Reassessment of ${q.name} started` : `Your reassessment request for ${q.name} was declined`)
        : (q.status === 'accepted' ? `Your request for ${q.name} was accepted` : `Your request for ${q.name} was declined`),
      text: q.decided_by_name ? `Answered by ${q.decided_by_name}.` : '',
      href: `${base}/requests/${Number(q.id)}`,
    });
  }
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  return items.slice(0, LIMIT);
}

module.exports = { recent };
