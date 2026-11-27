'use strict';

const { todayFor } = require('../dates');

const DAY = 24 * 3600 * 1000;
const plusDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const ymdOf = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

const EVIDENCE_KIND = Object.freeze({ iso27001_certificate: 'iso27001', soc2_report: 'soc2_type2' });

async function evidenceCertificates(db, workspaceId, assessmentIds, { releasedOnly = false } = {}) {
  const ids = (assessmentIds || []).map(Number).filter(Boolean);
  if (!ids.length) return [];
  const rows = await db.prepare(`SELECT DISTINCT ON (e.document_kind) e.id, e.document_kind, e.expires_on::text AS expires_on, e.original_name
    FROM tp_evidence e WHERE e.workspace_id = ? AND e.document_kind IS NOT NULL${releasedOnly ? ' AND e.released_to_client' : ''} AND e.assessment_id IN (${ids.map(() => '?').join(',')})
    ORDER BY e.document_kind, e.expires_on DESC NULLS LAST, e.uploaded_at DESC, e.id DESC`).all(Number(workspaceId), ...ids);
  return rows.map(r => ({ kind: EVIDENCE_KIND[r.document_kind], expires_on: r.expires_on || null, evidence_id: Number(r.id), name: r.original_name }));
}

const runsTo = r => (r.kind === 'soc2_type2' ? r.period_end : r.expires_on) || null;
const runsLonger = (a, b) => Number(!!runsTo(b)) - Number(!!runsTo(a)) || String(runsTo(b) || '').localeCompare(String(runsTo(a) || ''))
  || Number(b.source === 'report') - Number(a.source === 'report') || Number(b.check_status === 'accepted') - Number(a.check_status === 'accepted');

function mergeAssurance(reports, certificates) {
  const all = [
    ...(reports || []).map(r => ({ ...r, source: 'report' })),
    ...(certificates || []).map(c => ({ kind: c.kind, expires_on: c.kind === 'iso27001' ? c.expires_on : null, period_end: c.kind === 'soc2_type2' ? c.expires_on : null,
      check_status: 'uploaded', source: c.source || 'evidence', name: c.name })),
  ];
  const out = [];
  for (const r of all.sort(runsLonger)) if (!out.some(x => x.kind === r.kind)) out.push(r);
  return out;
}

async function insuranceStateFor(db, workspaceId, assessmentIds, questionId = 'GOV-07') {
  const ids = (assessmentIds || []).map(Number).filter(Boolean);
  if (!ids.length) return 'not_answered';
  const q = await db.prepare(`SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(q.sections) s WHERE COALESCE(s->'ids', '[]'::jsonb) @> jsonb_build_array(?::text)) AS asked
    FROM tp_questionnaires q WHERE q.workspace_id = ? AND q.assessment_id IN (${ids.map(() => '?').join(',')})
    ORDER BY q.created_at DESC, q.id DESC LIMIT 1`).get(questionId, Number(workspaceId), ...ids);
  if (q && !q.asked) return 'not_asked';
  return 'not_answered';
}

async function build(db, ws, thirdPartyId) {
  const id = Number(thirdPartyId);
  const today = todayFor(ws);
  const yearOn = plusDays(today, 365);
  const assessments = await db.prepare(`SELECT a.id, a.type, a.status, a.final_tier, a.created_at, a.lead_consultant_id, a.reviewer_id,
      lu.name AS lead_name, ru.name AS reviewer_name, du.name AS owner_name
    FROM tp_assessments a LEFT JOIN users lu ON lu.id = a.lead_consultant_id LEFT JOIN users ru ON ru.id = a.reviewer_id
    LEFT JOIN users du ON du.id = a.client_decision_owner_id
    WHERE a.workspace_id = ? AND a.third_party_id = ? AND a.status <> 'cancelled' ORDER BY a.created_at DESC, a.id DESC`).all(ws.id, id);
  const typeLabels = await require('./assessments').typeLabelsFor(db, assessments);
  for (const a of assessments) a.type_label = typeLabels.get(Number(a.id));
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
    ORDER BY r.kind, CASE WHEN r.kind = 'soc2_type2' THEN COALESCE(r.confirmed_period_end, r.period_end) ELSE COALESCE(r.confirmed_expires_on, r.certificate_expires_on) END DESC NULLS LAST,
      (r.check_status = 'accepted') DESC, r.uploaded_at DESC, r.id DESC`).all(ws.id, ...aIds) : [];
  const certificates = await evidenceCertificates(db, ws.id, aIds);
  const insuranceState = await insuranceStateFor(db, ws.id, aIds);
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
  const library = await require('./party-documents').forFirm(db, ws, id, today);
  const assurance = mergeAssurance(reports, [...require('./party-documents').certificates(library.documents), ...certificates]);
  const assuranceLabel = r => (r.kind === 'iso27001' ? 'ISO 27001 certificate' : 'SOC 2 report');
  const assuranceExpiring = assurance.filter(r => r.expires_on && r.expires_on >= today && r.expires_on <= yearOn).map(r => ({ label: assuranceLabel(r), date: r.expires_on }));
  const expiring = [
    ...assurance.filter(r => r.source !== 'document' && r.expires_on && r.expires_on >= today && r.expires_on <= yearOn).map(r => ({ label: assuranceLabel(r), date: r.expires_on })),
    ...library.documents.filter(d => d.expires_on && d.expires_on >= today && d.expires_on <= yearOn).map(d => ({ label: d.title, date: d.expires_on, documentId: d.id })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const expired = assurance.filter(r => r.source !== 'document' && r.expires_on && r.expires_on < today).length + library.expired.length;
  const next = [];
  const open = assessments.find(a => !['completed', 'cancelled'].includes(a.status));
  for (const p of proofs) next.push({ text: `Check proof for condition ${p.position}`, sub: `Sent ${ymdOf(p.submitted_at)}`, href: `assessments/${p.assessment_id}?step=decision#conditions`, primary: true });
  for (const c of liveConds.filter(x => ['open', 'changes_requested'].includes(x.status))) {
    next.push({ text: `${c.owner === 'client' ? 'Client' : 'Supplier'} condition ${c.position}`, sub: c.due_date ? `Due ${c.due_date}${c.due_date < today ? ', overdue' : ''}` : 'No due date',
      late: !!c.due_date && c.due_date < today, href: `assessments/${c.assessment_id}?step=decision#conditions` });
  }
  for (const e of assuranceExpiring) next.push({ text: `${e.label} expires`, sub: e.date, href: null });
  const party = await db.prepare(`SELECT status, current_tier, next_due_date::text AS next_due_date, last_assessment_date::text AS last_assessment_date
    FROM tp_third_parties WHERE workspace_id = ? AND id = ?`).get(ws.id, id);
  if (party && party.status === 'in_use' && !open) {
    if (!party.last_assessment_date && !party.next_due_date) next.unshift({ text: 'Assess this third party', sub: 'Not assessed yet', href: null, primary: true });
    else if (!party.next_due_date) next.unshift({ text: 'Set a tier to date the next review', sub: `Last assessed ${party.last_assessment_date}`, href: null });
    else if (party.next_due_date <= plusDays(today, 30)) {
      next.unshift({ text: 'Reassessment due', sub: `Due ${party.next_due_date}${party.next_due_date < today ? ', overdue' : ''}`, late: party.next_due_date < today, href: null, primary: true });
    }
  }
  return {
    today, assessments, open, latestRec, latestWithTier, scoping,
    lead: (open || assessments[0] || {}).lead_name || null, reviewer: (open || assessments[0] || {}).reviewer_name || null,
    decisionOwner: (open || assessments[0] || {}).owner_name || null,
    findings, openFindings: findings.filter(f => f.status === 'open').length,
    conditions, liveConditions: liveConds, conditionsDone: done,
    documents, released: documents.filter(d => d.released_to_client).length,
    library, held: documents.length + library.documents.length,
    shared: documents.filter(d => d.released_to_client).length + library.documents.filter(d => d.shared_with_client).length,
    reports, assurance, insurance, insuranceState: insurance ? 'answered' : insuranceState, expiring, expired, next,
  };
}

module.exports = { build, evidenceCertificates, mergeAssurance, insuranceStateFor };
