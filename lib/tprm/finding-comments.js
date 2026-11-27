'use strict';

const access = require('./access');
const { TprmError } = require('./errors');

const LIMIT = 4000;
function closedReason(findingStatus, assessmentStatus) {
  if (assessmentStatus === 'cancelled') return 'This review was cancelled, so comments can no longer be added.';
  if (findingStatus !== 'open') return 'This finding is closed, so comments can no longer be added.';
  return null;
}
const notFound = () => new TprmError(404, 'This finding does not exist, or it is not available to your account.');

function bodyOf(input) {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new TprmError(400, 'Write your comment.', { errors: ['Write your comment.'] });
  if (body.length > LIMIT) throw new TprmError(400, `The comment must be ${LIMIT} characters or fewer.`, { errors: [`The comment must be ${LIMIT} characters or fewer.`] });
  return body;
}

async function forFindings(db, workspaceId, findingIds) {
  const ids = [...new Set((findingIds || []).map(Number))].filter(n => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const rows = await db.prepare(`SELECT id, finding_id, author_kind, author_name, body, created_at FROM tp_finding_comments
    WHERE workspace_id = ? AND finding_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(workspaceId, ...ids);
  const map = new Map();
  for (const r of rows) {
    const k = Number(r.finding_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

async function findingFor(db, workspaceId, findingId) {
  return await db.prepare(`SELECT f.id, f.assessment_id, f.title, f.status, a.status AS assessment_status, a.third_party_id,
      EXISTS (SELECT 1 FROM tp_recommendations r WHERE r.workspace_id = f.workspace_id AND r.assessment_id = f.assessment_id AND r.status = 'issued') AS issued,
      EXISTS (SELECT 1 FROM tp_issues i WHERE i.workspace_id = f.workspace_id AND i.finding_id = f.id AND i.status <> 'withdrawn') AS shared
    FROM tp_findings f JOIN tp_assessments a ON a.workspace_id = f.workspace_id AND a.id = f.assessment_id
    WHERE f.workspace_id = ? AND f.id = ?`).get(workspaceId, Number(findingId) || 0);
}

async function insert(db, ws, f, user, kind, body) {
  const row = await db.prepare(`INSERT INTO tp_finding_comments (workspace_id, assessment_id, finding_id, author_kind, author_user_id, author_name, body)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(ws.id, f.assessment_id, f.id, kind, user.id, String(user.name || '').slice(0, 200) || null, body);
  return { id: Number(row.id), findingId: Number(f.id), assessmentId: Number(f.assessment_id), thirdPartyId: Number(f.third_party_id), title: f.title };
}

async function clientAdd(db, ws, user, findingId, input = {}) {
  if (!user || !access.isClientUser(user)) throw notFound();
  const body = bodyOf(input);
  const f = await findingFor(db, ws.id, findingId);
  if (!f || !f.issued) throw notFound();
  if (f.shared) throw new TprmError(409, 'This finding is shared with the third party: comment on its conversation instead.');
  const shut = closedReason(f.status, f.assessment_status);
  if (shut) throw new TprmError(409, shut);
  return await insert(db, ws, f, user, 'client', body);
}

async function firmAdd(db, actor, assessmentId, findingId, input = {}) {
  if (!actor || !access.can(actor.user, actor.perms, 'tp.manage')) throw new TprmError(403, 'Your role does not allow replying to the client.');
  const body = bodyOf(input);
  const f = await findingFor(db, actor.ws.id, findingId);
  if (!f || Number(f.assessment_id) !== Number(assessmentId)) throw notFound();
  const shut = closedReason(f.status, f.assessment_status);
  if (shut) throw new TprmError(409, shut);
  return await insert(db, actor.ws, f, actor.user, 'firm', body);
}

module.exports = { LIMIT, closedReason, forFindings, clientAdd, firmAdd };
