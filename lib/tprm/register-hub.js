'use strict';

const { todayFor } = require('../dates');

const DAY = 24 * 3600 * 1000;
const plusDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

async function extras(db, workspaceId) {
  const rows = await db.prepare(`SELECT t.id, ou.name AS owner_name,
      (SELECT r.residual_rating FROM tp_recommendations r JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
        WHERE r.workspace_id = t.workspace_id AND a.third_party_id = t.id AND r.status = 'issued' AND a.status <> 'cancelled'
        ORDER BY r.issued_at DESC, r.id DESC LIMIT 1) AS residual,
      (SELECT COUNT(*)::int FROM tp_findings f JOIN tp_assessments a ON a.workspace_id = f.workspace_id AND a.id = f.assessment_id
        WHERE f.workspace_id = t.workspace_id AND a.third_party_id = t.id AND a.status <> 'cancelled' AND f.status = 'open') AS open_findings,
      (SELECT lu.name FROM tp_assessments a JOIN users lu ON lu.id = a.lead_consultant_id
        WHERE a.workspace_id = t.workspace_id AND a.third_party_id = t.id AND a.status <> 'cancelled'
        ORDER BY CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END, a.created_at DESC LIMIT 1) AS lead_name
    FROM tp_third_parties t LEFT JOIN users ou ON ou.id = t.client_owner_user_id WHERE t.workspace_id = ?`).all(workspaceId);
  return new Map(rows.map(r => [Number(r.id), r]));
}

async function tiles(db, ws, { approvals, stages }) {
  const today = todayFor(ws);
  const end = plusDays(today, 90);
  const parties = await db.prepare(`SELECT id, status, current_tier, tier_source, next_due_date::text AS next_due_date
    FROM tp_third_parties WHERE workspace_id = ? AND status <> 'exited'`).all(ws.id);
  const tierCount = k => parties.filter(p => (k === 'none' ? !p.current_tier : ['critical', 'high'].includes(k) ? ['critical', 'high'].includes(p.current_tier) && k === 'high' : p.current_tier === k)).length;
  const states = parties.map(p => approvals.get(Number(p.id))).filter(Boolean);
  const findings = await db.prepare(`SELECT f.severity, COUNT(*)::int AS n FROM tp_findings f
    JOIN tp_assessments a ON a.workspace_id = f.workspace_id AND a.id = f.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    WHERE f.workspace_id = ? AND f.status = 'open' AND a.status <> 'cancelled' AND t.status <> 'exited' GROUP BY f.severity`).all(ws.id);
  const fBy = Object.fromEntries(findings.map(f => [f.severity, f.n]));
  const condDue = (await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_conditions c
    JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id AND r.status = 'issued'
    WHERE c.workspace_id = ? AND c.status IN ('open', 'changes_requested', 'proof_submitted') AND c.due_date IS NOT NULL AND c.due_date <= ?::date`).get(ws.id, end)).n;
  const certs = (await db.prepare(`SELECT COUNT(DISTINCT a.third_party_id)::int AS n FROM tp_assurance_reports r
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    WHERE r.workspace_id = ? AND r.check_status <> 'rejected' AND r.certificate_expires_on BETWEEN ?::date AND ?::date`).get(ws.id, today, end)).n;
  const clarifications = (await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_clarifications c
    JOIN tp_assessments a ON a.workspace_id = c.workspace_id AND a.id = c.assessment_id
    WHERE c.workspace_id = ? AND c.status = 'open' AND a.status NOT IN ('completed', 'cancelled')`).get(ws.id)).n;
  const links = (await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_vendor_requests v WHERE v.workspace_id = ? AND v.status = 'active'
    AND v.expires_at > now() AND v.expires_at <= ?::date + 1`).get(ws.id, plusDays(today, 7))).n;
  const open = [...stages.values()];
  return {
    total: parties.length,
    tiers: [
      { key: 'high', label: 'High or critical', cls: 'red', count: tierCount('high') },
      { key: 'medium', label: 'Medium', cls: 'amber', count: tierCount('medium') },
      { key: 'low', label: 'Low', cls: 'green', count: tierCount('low') },
      { key: 'none', label: 'Tier needed', cls: 'grey', count: tierCount('none') },
    ],
    provisional: parties.filter(p => p.tier_source === 'provisional_from_client_label').length,
    decisions: [
      { label: 'Approved', cls: 'green', count: states.filter(s => s.state === 'approved').length },
      { label: 'Waiting for decision', cls: 'amber', count: states.filter(s => s.pending === 'decision_needed').length },
      { label: 'Approval ended', cls: 'red', count: states.filter(s => s.state === 'expired').length },
      { label: 'Not assessed yet', cls: 'grey', count: states.filter(s => ['not_yet_assessed', 'awaiting_approval'].includes(s.state) && s.pending !== 'decision_needed').length },
    ],
    approvalsEnding: states.filter(s => s.until && s.until >= today && s.until <= end).length,
    open: {
      total: open.length,
      supplier: open.filter(s => s.waiting === 'third_party').length,
      team: open.filter(s => ['consultant', 'reviewer'].includes(s.waiting)).length,
      client: open.filter(s => s.waiting === 'client').length,
      late: parties.filter(p => p.status === 'in_use' && p.next_due_date && p.next_due_date < today).length,
      clarifications, links,
    },
    findings: ['critical', 'high', 'medium', 'low'].map(k => ({ key: k, count: fBy[k] || 0 })).filter(f => f.key !== 'critical' || f.count),
    findingsMax: Math.max(1, ...Object.values(fBy)),
    due: {
      reassessments: parties.filter(p => p.status === 'in_use' && p.next_due_date && p.next_due_date >= today && p.next_due_date <= end).length,
      conditions: condDue, certificates: certs,
    },
  };
}

module.exports = { extras, tiles };
