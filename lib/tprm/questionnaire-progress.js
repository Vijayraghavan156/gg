'use strict';

const STATUS_LABELS = Object.freeze({
  not_sent: 'Not sent yet', sent: 'Sent, not started', in_progress: 'Being answered', submitted: 'Submitted', closed: 'Closed without answers',
});

function statusOf(q) {
  if (!q || !q.questionnaire_id || q.q_status === 'draft') return 'not_sent';
  if (q.submitted_at || ['submitted', 'under_review'].includes(q.q_status)) return 'submitted';
  if (q.q_status === 'closed') return 'closed';
  if (q.q_status === 'in_progress') return 'in_progress';
  return q.sent_at ? 'sent' : 'not_sent';
}

async function counts(db, ws, q, clientName) {
  try {
    const page = await require('./vendor-answers').progressCounts(db, {
      workspaceId: Number(ws.id), questionnaireId: Number(q.questionnaire_id), assessmentId: Number(q.assessment_id),
      firmId: Number(ws.firm_id), clientName, mode: 'clarifying',
    });
    return { answered: Number(page.answered) || 0, total: Number(page.total) || 0, responded: Number(page.responded) || 0 };
  } catch (_) {
    return null;
  }
}

async function forThirdParties(db, ws, thirdPartyIds) {
  const ids = [...new Set((thirdPartyIds || []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await db.prepare(`SELECT DISTINCT ON (a.third_party_id) a.id AS assessment_id, a.third_party_id,
      q.id AS questionnaire_id, q.status AS q_status, q.submitted_at,
      (SELECT MIN(r.created_at) FROM tp_vendor_requests r WHERE r.workspace_id = q.workspace_id AND r.questionnaire_id = q.id) AS sent_at,
      (SELECT r.expires_at FROM tp_vendor_requests r WHERE r.workspace_id = q.workspace_id AND r.questionnaire_id = q.id
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS expires_at
    FROM tp_assessments a
    LEFT JOIN tp_questionnaires q ON q.workspace_id = a.workspace_id AND q.assessment_id = a.id
    WHERE a.workspace_id = ? AND a.third_party_id IN (${ids.map(() => '?').join(',')}) AND a.status NOT IN ('completed', 'cancelled')
    ORDER BY a.third_party_id, a.created_at DESC, a.id DESC, q.id DESC`).all(Number(ws.id), ...ids);
  const clientName = ws.brand_display_name || ws.client_name;
  for (const q of rows) {
    const first = statusOf(q);
    const c = first === 'not_sent' ? null : await counts(db, ws, q, clientName);
    const status = first === 'sent' && c && c.responded > 0 ? 'in_progress' : first;
    out.set(Number(q.third_party_id), {
      assessmentId: Number(q.assessment_id), status, statusLabel: STATUS_LABELS[status],
      sentAt: status === 'not_sent' ? null : q.sent_at || null, dueAt: status === 'not_sent' ? null : q.expires_at || null,
      answered: c ? c.answered : null, total: c ? c.total : null,
      percent: c && c.total ? Math.round((c.answered / c.total) * 100) : c ? 0 : null,
    });
  }
  return out;
}

module.exports = { STATUS_LABELS, statusOf, forThirdParties };
