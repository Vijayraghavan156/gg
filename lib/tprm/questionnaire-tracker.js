'use strict';

const access = require('./access');
const { TprmError } = require('./errors');

const DAY = 24 * 3600 * 1000;
const SOON_DAYS = 7;
const REOPEN_DAYS = require('./questionnaires').DEFAULT_EXPIRY_DAYS;
const STATES = Object.freeze(['overdue', 'due_soon', 'not_opened', 'in_progress']);
const STATE_LABELS = Object.freeze({
  overdue: 'Overdue: the link stopped working', due_soon: 'Due soon', not_opened: 'Not opened yet', in_progress: 'Being answered',
});
const STATE_TONES = Object.freeze({ overdue: 'problem', due_soon: 'attention', not_opened: 'attention', in_progress: 'quiet' });
const FILTERS = Object.freeze(['all', 'overdue', 'due_soon', 'not_opened', 'mine']);

const ymd = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

function stateOf(r, now) {
  const expires = r.expires_at ? new Date(r.expires_at) : null;
  if (!expires || r.link_status !== 'active' || expires <= now) return 'overdue';
  if (expires - now <= SOON_DAYS * DAY) return 'due_soon';
  if (!r.last_opened_at) return 'not_opened';
  return 'in_progress';
}

async function rowsFor(db, workspaceIds) {
  if (!workspaceIds.length) return [];
  return await db.prepare(`SELECT q.id AS questionnaire_id, q.workspace_id, q.assessment_id, q.status AS q_status, q.vendor_question_count, q.row_version AS q_row_version,
      a.third_party_id, a.type, a.final_tier, a.due_date::text AS review_due, a.lead_consultant_id, a.reviewer_id, t.name AS third_party_name, lu.name AS lead_name,
      v.id AS link_id, v.status AS link_status, v.recipient_name, v.recipient_email, v.created_at AS sent_at, v.expires_at, v.last_opened_at,
      (SELECT COUNT(*)::int FROM tp_answers x WHERE x.workspace_id = q.workspace_id AND x.questionnaire_id = q.id AND x.response IS NOT NULL) AS answered
    FROM tp_questionnaires q
    JOIN tp_assessments a ON a.workspace_id = q.workspace_id AND a.id = q.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    LEFT JOIN users lu ON lu.id = a.lead_consultant_id
    LEFT JOIN LATERAL (SELECT r.id, r.status, r.recipient_name, r.recipient_email, r.created_at, r.expires_at, r.last_opened_at FROM tp_vendor_requests r
      WHERE r.workspace_id = q.workspace_id AND r.questionnaire_id = q.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) v ON true
    WHERE q.workspace_id IN (${workspaceIds.map(() => '?').join(',')}) AND q.status IN ('sent', 'in_progress')
      AND a.status NOT IN ('completed', 'cancelled')`).all(...workspaceIds);
}

async function list(deps, user, { query = {}, now = new Date() } = {}) {
  const filter = FILTERS.includes(String(query.show)) ? String(query.show) : 'all';
  const words = String(query.q || '').trim().slice(0, 100).toLowerCase().split(/\s+/).filter(Boolean);
  const empty = { rows: [], all: 0, counts: Object.fromEntries(FILTERS.map(f => [f, 0])), filter, q: String(query.q || '').trim().slice(0, 100) };
  if (!access.isFirmUser(user) || !access.firmCan(user, 'tp.view')) return empty;
  const { enabled } = await access.listFirmClients(deps, user);
  const reachable = [];
  for (const c of enabled) {
    const loaded = await access.loadFirmWorkspace(deps, user, c.id);
    if (loaded) reachable.push({ id: Number(c.id), name: c.name, canManage: access.can(user, loaded.perms, 'tp.manage') });
  }
  const byId = new Map(reachable.map(c => [c.id, c]));
  const today = ymd(now);
  const me = Number(user.id);
  const rows = (await require('./scope').keep(deps.db, user, await rowsFor(deps.db, reachable.map(c => c.id)))).map(r => {
    const state = stateOf(r, now);
    const client = byId.get(Number(r.workspace_id));
    const expires = r.expires_at ? new Date(r.expires_at) : null;
    return {
      questionnaireId: Number(r.questionnaire_id), assessmentId: Number(r.assessment_id), workspaceId: Number(r.workspace_id), thirdPartyId: Number(r.third_party_id),
      clientName: client.name, canManage: client.canManage, thirdPartyName: r.third_party_name, type: r.type, tier: r.final_tier, leadName: r.lead_name,
      recipientName: r.recipient_name, recipientEmail: r.recipient_email, sentAt: r.sent_at, expiresAt: r.expires_at, lastOpenedAt: r.last_opened_at,
      daysLeft: expires ? Math.ceil((expires - now) / DAY) : null, answered: Number(r.answered) || 0, total: Number(r.vendor_question_count) || 0,
      rowVersion: Number(r.q_row_version), state, stateLabel: STATE_LABELS[state], stateTone: STATE_TONES[state],
      reviewDue: r.review_due || null, reviewLate: !!r.review_due && r.review_due < today,
      mine: [r.lead_consultant_id, r.reviewer_id].some(x => Number(x) === me),
      canRemind: state !== 'overdue', canReopen: state === 'overdue' && !!r.recipient_email,
    };
  });
  const counts = { all: rows.length, overdue: 0, due_soon: 0, not_opened: 0, mine: rows.filter(r => r.mine).length };
  for (const r of rows) if (counts[r.state] != null) counts[r.state] += 1;
  const order = s => STATES.indexOf(s);
  const shown = rows.filter(r => (filter === 'all' || (filter === 'mine' ? r.mine : r.state === filter))
    && words.every(w => `${r.clientName} ${r.thirdPartyName} ${r.recipientName || ''} ${r.leadName || ''}`.toLowerCase().includes(w)))
    .sort((a, b) => order(a.state) - order(b.state) || String(a.expiresAt || '').localeCompare(String(b.expiresAt || '')) || a.questionnaireId - b.questionnaireId);
  return { rows: shown, all: rows.length, counts, filter, q: String(query.q || '').trim().slice(0, 100) };
}

async function latestLink(db, workspaceId, assessmentId) {
  return await db.prepare(`SELECT r.recipient_name, r.recipient_email, q.row_version, q.status AS q_status, a.third_party_id
    FROM tp_questionnaires q JOIN tp_assessments a ON a.workspace_id = q.workspace_id AND a.id = q.assessment_id
    LEFT JOIN LATERAL (SELECT recipient_name, recipient_email FROM tp_vendor_requests v WHERE v.workspace_id = q.workspace_id AND v.questionnaire_id = q.id
      ORDER BY v.created_at DESC, v.id DESC LIMIT 1) r ON true
    WHERE q.workspace_id = ? AND q.assessment_id = ?`).get(workspaceId, assessmentId);
}

async function reopen(db, actor, assessmentId) {
  const questionnaires = require('./questionnaires');
  const last = await latestLink(db, actor.ws.id, Number(assessmentId) || 0);
  if (!last) throw new TprmError(404, 'This questionnaire does not exist, or it is not available to your account.');
  if (!last.recipient_email) throw new TprmError(409, 'No one was sent this questionnaire yet. Send it from the assessment.');
  const created = await questionnaires.createLink(db, actor, last.third_party_id, assessmentId, {
    recipient_name: last.recipient_name, recipient_email: last.recipient_email, row_version: String(last.row_version),
  });
  const emailed = await questionnaires.emailLink(db, actor, created.assessment, created.request, created.url);
  return { recipient: last.recipient_name, expiresAt: created.request.expires_at, emailed };
}

async function cancel(db, actor, assessmentId, input = {}) {
  const questionnaires = require('./questionnaires');
  const last = await latestLink(db, actor.ws.id, Number(assessmentId) || 0);
  if (!last) throw new TprmError(404, 'This questionnaire does not exist, or it is not available to your account.');
  return await questionnaires.closeNotReturned(db, actor, last.third_party_id, assessmentId, { reason: input.reason, row_version: String(last.row_version) });
}

module.exports = { STATES, STATE_LABELS, STATE_TONES, FILTERS, SOON_DAYS, REOPEN_DAYS, stateOf, list, reopen, cancel };
