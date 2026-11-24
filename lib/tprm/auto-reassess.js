'use strict';

const { todayFor } = require('../dates');

const DAY = 24 * 3600 * 1000;

async function run(db, { permissionsFor, now = new Date() } = {}) {
  const assessments = require('./assessments');
  const clients = await db.prepare(`SELECT w.*, cs.auto_reassess_days FROM tp_client_settings cs JOIN workspaces w ON w.id = cs.workspace_id
    WHERE cs.enabled AND cs.auto_reassess_days IS NOT NULL ORDER BY w.id`).all();
  let started = 0;
  for (const ws of clients) {
    const today = todayFor(ws, null, now);
    const until = new Date(Date.parse(`${today}T00:00:00Z`) + Number(ws.auto_reassess_days) * DAY).toISOString().slice(0, 10);
    const due = await db.prepare(`SELECT t.id,
        (SELECT a.lead_consultant_id FROM tp_assessments a WHERE a.workspace_id = t.workspace_id AND a.third_party_id = t.id AND a.status = 'completed'
          ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS last_lead
      FROM tp_third_parties t
      WHERE t.workspace_id = ? AND t.status = 'in_use' AND t.next_due_date IS NOT NULL AND t.next_due_date <= ?::date
        AND NOT EXISTS (SELECT 1 FROM tp_assessments a WHERE a.workspace_id = t.workspace_id AND a.third_party_id = t.id AND a.status NOT IN ('completed', 'cancelled'))
      ORDER BY t.next_due_date, t.id`).all(ws.id, until);
    if (!due.length) continue;
    const leads = await assessments.leadCandidates(db, ws);
    const leadIds = new Set(leads.map(l => Number(l.id)));
    for (const row of due) {
      const leadId = [row.last_lead, ws.lead_consultant_id].map(Number).find(id => id && leadIds.has(id));
      if (!leadId) continue;
      const user = await db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(leadId);
      if (!user) continue;
      const perms = permissionsFor ? await permissionsFor(user, ws) : null;
      if (!perms) continue;
      try {
        await assessments.start(db, { user, perms, ws }, row.id, { automatic: true });
        started += 1;
      } catch (err) {
        if (!err || !err.status) throw err;
      }
    }
  }
  return started;
}

module.exports = { run };
