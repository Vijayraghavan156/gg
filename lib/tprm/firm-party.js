'use strict';

const { todayFor } = require('../dates');

const DAY = 24 * 3600 * 1000;
const plusDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const ymdOf = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

async function build(db, ws, thirdPartyId) {
  const id = Number(thirdPartyId);
  const today = todayFor(ws);
  const yearOn = plusDays(today, 365);
  const assessments = await db.prepare(`SELECT a.id, a.type, a.status, a.final_tier, a.created_at, a.lead_consultant_id, a.reviewer_id,
      lu.name AS lead_name, ru.name AS reviewer_name, du.name AS owner_name
    FROM tp_assessments a LEFT JOIN users lu ON lu.id = a.lead_consultant_id LEFT JOIN users ru ON ru.id = a.reviewer_id
    LEFT JOIN users du ON du.id = a.client_decision_owner_id
    WHERE a.workspace_id = ? AND a.third_party_id = ? AND a.status <> 'cancelled' ORDER BY a.created_at DESC, a.id DESC`).all(ws.id, id);
  const aIds = assessments.map(a => Number(a.id));
  const inList = n => n.map(() => '?').join(',');
  const latestRec = aIds.length ? await db.prepare(`SELECT r.id, r.assessment_id, r.version, r.outcome, r.residual_rating, r.issued_at, r.valid_until::text AS valid_until,
      au.name AS author_name, iu.name AS reviewer_name
    FROM tp_recommendations r LEFT JOIN users au ON au.id = r.author_id LEFT JOIN users iu ON iu.id = r.reviewer_id
    WHERE r.workspace_id = ? AND r.assessment_id IN (${inList(aIds)}) AND r.status = 'issued' ORDER BY r.issued_at DESC, r.id DESC LIMIT 1`).get(ws.id, ...aIds) : null;
  const findings = aIds.length ? await db.prepare(`SELECT f.id, f.assessment_id, f.control_ref, f.severity, f.title, f.status, f.description,
      i.id AS issue_id, i.status AS issue_status
    FROM tp_findings f LEFT JOIN tp_issues i ON i.workspace_id = f.workspace_id AND i.finding_id = f.id AND i.status <> 'withdrawn'
    WHERE f.workspace_id = ? AND f.assessment_id IN (${inList(aIds)})
    ORDER BY CASE f.status WHEN 'open' THEN 0 ELSE 1 END, CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, f.id`).all(ws.id, ...aIds) : [];
  const conditions = aIds.length ? await db.prepare(`SELECT c.id, c.position, c.description, c.owner, c.due_date::text AS due_date, c.status,
      r.assessment_id, r.version
    FROM tp_conditions c JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id
    WHERE c.workspace_id = ? AND r.assessment_id IN (${inList(aIds)}) AND r.status = 'issued' ORDER BY r.issued_at DESC, c.position, c.id`).all(ws.id, ...aIds) : [];
  const documents = aIds.length ? await db.prepare(`SELECT e.id, e.assessment_id, e.original_name, e.size_bytes, e.description, e.released_to_client,
      e.created_at, (e.vendor_request_id IS NOT NULL) AS from_supplier
    FROM tp_evidence e WHERE e.workspace_id = ? AND e.assessment_id IN (${inList(aIds)}) ORDER BY e.created_at DESC, e.id DESC`).all(ws.id, ...aIds)
    : [];
  const reports = aIds.length ? await db.prepare(`SELECT DISTINCT ON (r.kind) r.kind, COALESCE(r.confirmed_expires_on, r.certificate_expires_on)::text AS expires_on, COALESCE(r.confirmed_period_end, r.period_end)::text AS period_end,
      r.check_status FROM tp_assurance_reports r WHERE r.workspace_id = ? AND r.assessment_id IN (${inList(aIds)}) AND r.check_status <> 'rejected'
    ORDER BY r.kind, r.uploaded_at DESC, r.id DESC`).all(ws.id, ...aIds) : [];
  const insurance = aIds.length ? await db.prepare(`SELECT x.response, x.fields FROM tp_answers x WHERE x.workspace_id = ? AND x.question_id = 'GOV-07'
    AND x.submitted_at IS NOT NULL AND x.assessment_id IN (${inList(aIds)}) ORDER BY x.submitted_at DESC, x.id DESC LIMIT 1`).get(ws.id, ...aIds) : null;
  const proofs = aIds.length ? await db.prepare(`SELECT c.id, c.position, r.assessment_id, p.submitted_at FROM tp_conditions c
    JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id
    JOIN tp_condition_proofs p ON p.workspace_id = c.workspace_id AND p.condition_id = c.id AND p.review_status = 'pending'
    WHERE c.workspace_id = ? AND r.assessment_id IN (${inList(aIds)}) AND c.status = 'proof_submitted'`).all(ws.id, ...aIds) : [];
  const latestWithTier = assessments.find(a => a.final_tier) || null;
  const scoping = latestWithTier ? await require('./client-view').scopingFor(db, ws, latestWithTier.id) : null;
  const liveConds = latestRec ? conditions.filter(c => Number(c.assessment_id) === Number(latestRec.assessment_id)) : [];
  const done = liveConds.filter(c => ['verified', 'waived'].includes(c.status)).length;
  const expiring = [];
  for (const r of reports) {
    if (r.expires_on && r.expires_on >= today && r.expires_on <= yearOn) expiring.push({ label: r.kind === 'iso27001' ? 'ISO 27001 certificate' : 'SOC 2 report', date: r.expires_on });
  }
  const next = [];
  const open = assessments.find(a => !['completed', 'cancelled'].includes(a.status));
  for (const p of proofs) next.push({ text: `Check proof for condition ${p.position}`, sub: `Sent ${ymdOf(p.submitted_at)}`, href: `assessments/${p.assessment_id}?step=decision#conditions`, primary: true });
  for (const c of liveConds.filter(x => ['open', 'changes_requested'].includes(x.status))) {
    next.push({ text: `${c.owner === 'client' ? 'Client' : 'Supplier'} condition ${c.position}`, sub: c.due_date ? `Due ${c.due_date}${c.due_date < today ? ', overdue' : ''}` : 'No due date',
      late: !!c.due_date && c.due_date < today, href: `assessments/${c.assessment_id}?step=decision#conditions` });
  }
  for (const e of expiring) next.push({ text: `${e.label} expires`, sub: e.date, href: null });
  return {
    today, assessments, open, latestRec, latestWithTier, scoping,
    lead: (open || assessments[0] || {}).lead_name || null, reviewer: (open || assessments[0] || {}).reviewer_name || null,
    decisionOwner: (open || assessments[0] || {}).owner_name || null,
    findings, openFindings: findings.filter(f => f.status === 'open').length,
    conditions, liveConditions: liveConds, conditionsDone: done,
    documents, released: documents.filter(d => d.released_to_client).length,
    reports, insurance, expiring, next,
  };
}

module.exports = { build };
