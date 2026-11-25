'use strict';

const access = require('./access');
const events = require('./events');
const tpSettings = require('./settings');
const placement = require('./placement');
const { TprmError } = require('./errors');
const { todayFor } = require('../dates');
const { sha256File } = require('./evidence');

const STATUSES = Object.freeze(['open', 'proof_submitted', 'verified', 'changes_requested', 'waived']);
const STATUS_LABELS = Object.freeze({
  open: 'Open', proof_submitted: 'Proof submitted', verified: 'Verified', changes_requested: 'Changes requested',
  waived: 'Waived', waiver_expired: 'Waiver expired',
});
const KIND_LABELS = Object.freeze({
  client: 'The client', consultant: 'Uploaded by the firm (from the third party)', vendor: 'The third party, through its conditions link',
});
const OWNER_LABELS = Object.freeze({ vendor: 'Third party', client: 'Client' });
const SUMMARY_LABELS = Object.freeze({ met: 'Conditions met', overdue: 'Conditions overdue', open: 'Conditions open' });
const LIMITS = Object.freeze({ note: 4000, comment: 2000, reason: 1000, filesPerProof: 10 });
const DUE_SOON_DAYS = 30;
const WITH_CONDITIONS = 'approve_with_conditions';
const CLIENT_SUBMITTER_ROLES = Object.freeze(['client_owner', 'client_admin', 'isms_manager']);

const EVENT_LABELS = Object.freeze({
  'condition.proof_submitted': 'Proof submitted for a condition',
  'condition.verified': 'Condition verified',
  'condition.changes_requested': 'Changes requested on a condition\'s proof',
  'condition.waived': 'Condition waived',
  'third_party.conditions_met': 'All conditions met',
  'condition_link.created': 'Conditions link created for the third party',
  'condition_link.revoked': 'Conditions link revoked',
});

const notFound = () => new TprmError(404, 'This condition does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed this condition after you opened the page. Nothing was saved: reload the page and try again.');
const notTracked = () => new TprmError(409,
  'This condition is followed up only once the client has decided on the recommendation with conditions.');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();

function addDays(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(days))).toISOString().slice(0, 10);
}

function stateOf(c, today) {
  const waiverExpired = c.status === 'waived' && !!c.waive_until && c.waive_until < today;
  const met = c.status === 'verified' || (c.status === 'waived' && !waiverExpired);
  const overdue = !met && !!c.due_date && c.due_date < today;
  const dueSoon = !met && !overdue && !!c.due_date && c.due_date <= addDays(today, DUE_SOON_DAYS);
  const open = ['open', 'changes_requested'].includes(c.status) || waiverExpired;
  return {
    met, overdue, dueSoon, waiverExpired,
    awaitingVerification: c.status === 'proof_submitted',
    canSubmit: open,
    canWaive: open,
    status: waiverExpired ? 'waiver_expired' : c.status,
    label: waiverExpired ? STATUS_LABELS.waiver_expired : STATUS_LABELS[c.status] || c.status,
  };
}

function summarize(conditions, today) {
  const list = conditions || [];
  if (!list.length) return null;
  const states = list.map(c => stateOf(c, today));
  const met = states.filter(s => s.met).length;
  const overdue = states.filter(s => s.overdue).length;
  const state = overdue ? 'overdue' : met === list.length ? 'met' : 'open';
  const label = state === 'open' ? `${SUMMARY_LABELS.open}: ${met} of ${list.length} met` : SUMMARY_LABELS[state];
  return { state, label, total: list.length, met, overdue };
}

const COND_COLUMNS = `c.id, c.workspace_id, c.recommendation_id, c.position, c.description, c.owner,
  c.due_date::text AS due_date, c.status, c.verified_by, c.verified_at, c.waived_by, c.waived_at, c.waive_reason,
  c.waive_until::text AS waive_until, c.row_version`;

const trackable = row => !!row && row.recommendation_status === 'issued' && row.decision_outcome === WITH_CONDITIONS;

async function loadCondition(db, workspaceId, conditionId, { scope = null, forUpdate = false } = {}) {
  const id = Number(conditionId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const args = [workspaceId, id];
  let where = '';
  if (scope) {
    const tpId = Number(scope.thirdPartyId);
    const aid = Number(scope.assessmentId);
    if (![tpId, aid].every(n => Number.isSafeInteger(n) && n > 0)) return null;
    where = ' AND a.id = ? AND a.third_party_id = ?';
    args.push(aid, tpId);
  }
  return await db.prepare(`SELECT ${COND_COLUMNS}, r.assessment_id, r.status AS recommendation_status, r.version,
      a.third_party_id, a.type, d.id AS decision_id, d.outcome AS decision_outcome
    FROM tp_conditions c
    JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    LEFT JOIN tp_client_decisions d ON d.workspace_id = r.workspace_id AND d.recommendation_id = r.id
    WHERE c.workspace_id = ? AND c.id = ?${where}${forUpdate ? ' FOR UPDATE OF c' : ''}`).get(...args) || null;
}

async function conditionsOfRecommendations(db, workspaceId, recommendationIds) {
  const ids = [...new Set((recommendationIds || []).map(Number))].filter(Number.isSafeInteger);
  if (!ids.length) return [];
  return await db.prepare(`SELECT ${COND_COLUMNS}, vu.name AS verified_by_name, wu.name AS waived_by_name
    FROM tp_conditions c
    LEFT JOIN users vu ON vu.id = c.verified_by
    LEFT JOIN users wu ON wu.id = c.waived_by
    WHERE c.workspace_id = ? AND c.recommendation_id IN (${ids.map(() => '?').join(',')})
    ORDER BY c.recommendation_id, c.position, c.id`).all(workspaceId, ...ids);
}

async function proofsOf(db, workspaceId, conditionIds, { kinds = null } = {}) {
  const ids = [...new Set((conditionIds || []).map(Number))].filter(Number.isSafeInteger);
  const out = new Map(ids.map(id => [id, []]));
  if (!ids.length) return out;
  const kindFilter = kinds ? ` AND p.submitted_by_kind IN (${kinds.map(() => '?').join(',')})` : '';
  const proofs = await db.prepare(`SELECT p.id, p.condition_id, p.submitted_by_kind, p.submitted_by, p.note, p.submitted_at,
      p.review_status, p.reviewed_by, p.reviewed_at, p.review_comment, su.name AS submitted_by_name, ru.name AS reviewed_by_name
    FROM tp_condition_proofs p
    LEFT JOIN users su ON su.id = p.submitted_by
    LEFT JOIN users ru ON ru.id = p.reviewed_by
    WHERE p.workspace_id = ? AND p.condition_id IN (${ids.map(() => '?').join(',')})${kindFilter}
    ORDER BY p.id DESC`).all(workspaceId, ...ids, ...(kinds || []));
  const proofIds = proofs.map(p => Number(p.id));
  const files = proofIds.length ? await db.prepare(`SELECT f.id, f.proof_id, f.condition_id, f.original_name, f.size_bytes,
      f.mime_type, f.sha256, f.created_at
    FROM tp_condition_proof_files f WHERE f.workspace_id = ? AND f.proof_id IN (${proofIds.map(() => '?').join(',')})
    ORDER BY f.id`).all(workspaceId, ...proofIds) : [];
  const filesBy = new Map(proofIds.map(id => [id, []]));
  for (const f of files) filesBy.get(Number(f.proof_id)).push(f);
  for (const p of proofs) {
    p.files = filesBy.get(Number(p.id)) || [];
    out.get(Number(p.condition_id)).push(p);
  }
  return out;
}

function requirePermission(actor, permission, message) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, permission)) {
    throw new TprmError(403, message || 'Your role does not allow this change.');
  }
}

function checkVersion(row, input) {
  const rowVersion = Number(input && input.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion !== Number(row.row_version)) throw conflict();
}

const wrongStatus = (c, today) => new TprmError(409,
  `This condition is "${stateOf(c, today).label}", so that step is not available. Reload the page to see where it is.`);

async function append(db, actor, row, action, before, after) {
  await events.appendEvent(db, {
    workspaceId: actor.ws.id, thirdPartyId: row.third_party_id, assessmentId: row.assessment_id,
    actorId: actor.user.id, action, before, after,
  });
}

async function recordAllMet(db, actor, row, today) {
  const all = await conditionsOfRecommendations(db, actor.ws.id, [row.recommendation_id]);
  const summary = summarize(all, today);
  if (!summary || summary.state !== 'met') return;
  await events.appendEvent(db, {
    workspaceId: actor.ws.id, thirdPartyId: row.third_party_id, actorId: actor.user.id, action: 'third_party.conditions_met',
    before: null,
    after: { assessment_id: Number(row.assessment_id), recommendation_id: Number(row.recommendation_id),
      decision_id: Number(row.decision_id), conditions: summary.total,
      verified: all.filter(c => c.status === 'verified').length, waived: all.filter(c => c.status === 'waived').length },
  });
}

async function submissionTarget(db, actor, target, { forUpdate = false } = {}) {
  if (!actor || !actor.ws || !actor.user) throw notFound();
  let row;
  if (target.via === 'portal') {
    if (!access.isClientUser(actor.user)) throw notFound();
    if (!(await tpSettings.isEnabled(db, actor.ws.id))) throw notFound();
    if (!access.can(actor.user, actor.perms, 'tp.client_decide')) {
      throw new TprmError(403, 'Only your organisation\'s client sponsor or coordinator can submit proof for a condition.');
    }
    row = await loadCondition(db, actor.ws.id, target.conditionId, { forUpdate });
    if (!row) throw notFound();
    if (!trackable(row)) throw notTracked();
    if (row.owner !== 'client') {
      throw new TprmError(403, 'The third party owns this condition: your consultants collect its proof from the third party.');
    }
  } else {
    if (!access.isFirmUser(actor.user)) throw notFound();
    requirePermission(actor, 'tp.manage', 'Your role does not allow uploading proof for a condition.');
    row = await loadCondition(db, actor.ws.id, target.conditionId,
      { scope: { thirdPartyId: target.thirdPartyId, assessmentId: target.assessmentId }, forUpdate });
    if (!row) throw notFound();
    if (!trackable(row)) throw notTracked();
    if (row.owner !== 'vendor') {
      throw new TprmError(409, 'The client owns this condition: the client submits its proof in the client portal.');
    }
  }
  const today = todayFor(actor.ws);
  if (!stateOf(row, today).canSubmit) throw wrongStatus(row, today);
  return row;
}

async function assertCanSubmit(db, actor, target) {
  return await submissionTarget(db, actor, target);
}

async function submitProof(db, actor, target, files, input = {}) {
  const list = (files || []).filter(Boolean);
  const note = str(input.note) || null;
  const errors = [];
  if (!list.length && !note) errors.push('Attach at least one file or write a note.');
  if (list.length > LIMITS.filesPerProof) errors.push(`Attach at most ${LIMITS.filesPerProof} files at a time.`);
  if (note && note.length > LIMITS.note) errors.push(`The note must be ${LIMITS.note} characters or fewer.`);
  await submissionTarget(db, actor, target);
  if (errors.length) throw invalid(errors);
  const hashed = [];
  for (const file of list) hashed.push({ file, sha256: await sha256File(file.path) });
  const kind = target.via === 'portal' ? 'client' : 'consultant';

  return await db.transaction(async () => {
    const row = await submissionTarget(db, actor, target, { forUpdate: true });
    checkVersion(row, input);
    const proof = await db.prepare(`INSERT INTO tp_condition_proofs
      (workspace_id, recommendation_id, condition_id, submitted_by_kind, submitted_by, note)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id, submitted_at`)
      .get(actor.ws.id, row.recommendation_id, row.id, kind, actor.user.id, note);
    const stored = [];
    for (const { file, sha256 } of hashed) {
      const name = String(file.originalname || '').trim().slice(0, 255) || 'file';
      const f = await db.prepare(`INSERT INTO tp_condition_proof_files
        (workspace_id, condition_id, proof_id, original_name, stored_path, size_bytes, mime_type, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(actor.ws.id, row.id, proof.id, name, file.filename, Number(file.size) || 0,
          file.mimetype ? String(file.mimetype).slice(0, 200) : null, sha256);
      stored.push({ file_id: Number(f.id), name, size_bytes: Number(file.size) || 0, sha256 });
    }
    const res = await db.prepare(`UPDATE tp_conditions SET status = 'proof_submitted', waived_by = NULL, waived_at = NULL,
        waive_reason = NULL, waive_until = NULL, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.ws.id, row.id, row.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, row, 'condition.proof_submitted',
      { condition_id: Number(row.id), status: row.status },
      { condition_id: Number(row.id), position: row.position, owner: row.owner, status: 'proof_submitted',
        proof_id: Number(proof.id), submitted_by_kind: kind, note, files: stored });
    return { proof: { id: Number(proof.id), submitted_at: proof.submitted_at, files: stored }, condition: row };
  })();
}

async function forFirmAction(db, actor, thirdPartyId, assessmentId, conditionId) {
  if (!access.isFirmUser(actor && actor.user)) throw notFound();
  const row = await loadCondition(db, actor.ws.id, conditionId, { scope: { thirdPartyId, assessmentId }, forUpdate: true });
  if (!row) throw notFound();
  if (!trackable(row)) throw notTracked();
  return row;
}

async function pendingProof(db, workspaceId, conditionId) {
  return await db.prepare(`SELECT id, submitted_by, submitted_by_kind, row_version FROM tp_condition_proofs
    WHERE workspace_id = ? AND condition_id = ? AND review_status = 'pending' FOR UPDATE`).get(workspaceId, conditionId);
}

async function review(db, actor, thirdPartyId, assessmentId, conditionId, input, decision) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow reviewing proof for a condition.');
  const comment = str(input && input.comment) || null;
  const errors = [];
  if (decision === 'changes_requested' && !comment) errors.push('Say what needs to change.');
  if (comment && comment.length > LIMITS.comment) errors.push(`The comment must be ${LIMITS.comment} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  const today = todayFor(actor.ws);
  return await db.transaction(async () => {
    const row = await forFirmAction(db, actor, thirdPartyId, assessmentId, conditionId);
    if (row.status !== 'proof_submitted') throw wrongStatus(row, today);
    const proof = await pendingProof(db, actor.ws.id, row.id);
    if (!proof) throw wrongStatus(row, today);
    if (proof.submitted_by != null && Number(proof.submitted_by) === Number(actor.user.id)) {
      throw new TprmError(403, 'You submitted this proof, so someone else verifies it or asks for changes.');
    }
    checkVersion(row, input);
    await db.prepare(`UPDATE tp_condition_proofs SET review_status = ?, reviewed_by = ?, reviewed_at = now(), review_comment = ?,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
      .run(decision, actor.user.id, comment, actor.ws.id, proof.id);
    const res = decision === 'verified'
      ? await db.prepare(`UPDATE tp_conditions SET status = 'verified', verified_by = ?, verified_at = now(), updated_at = now(),
          row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
        .run(actor.user.id, actor.ws.id, row.id, row.row_version)
      : await db.prepare(`UPDATE tp_conditions SET status = 'changes_requested', updated_at = now(), row_version = row_version + 1
          WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.ws.id, row.id, row.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, row, decision === 'verified' ? 'condition.verified' : 'condition.changes_requested',
      { condition_id: Number(row.id), status: row.status },
      { condition_id: Number(row.id), position: row.position, status: decision, proof_id: Number(proof.id),
        submitted_by_kind: proof.submitted_by_kind, comment });
    if (decision === 'verified') {
      await recordAllMet(db, actor, row, today);
      await require('./condition-links').revokeIfDone(db, actor, row, today);
    }
    return { condition: row, proofId: Number(proof.id), status: decision };
  })();
}

const verify = (db, actor, tpId, aid, cid, input) => review(db, actor, tpId, aid, cid, input, 'verified');
const requestChanges = (db, actor, tpId, aid, cid, input) => review(db, actor, tpId, aid, cid, input, 'changes_requested');

async function waive(db, actor, thirdPartyId, assessmentId, conditionId, input = {}) {
  requirePermission(actor, 'tp.manage', 'Only a manager can waive a condition.');
  if (!access.isManager(actor.user)) throw new TprmError(403, 'Only a manager can waive a condition.');
  const reason = str(input.reason) || null;
  const until = str(input.waive_until) || null;
  const today = todayFor(actor.ws);
  const errors = [];
  if (!reason) errors.push('Give the reason for waiving this condition.');
  else if (reason.length > LIMITS.reason) errors.push(`The reason must be ${LIMITS.reason} characters or fewer.`);
  if (until && !placement.isYmd(until)) errors.push('The waiver expiry must be a date written YYYY-MM-DD.');
  else if (until && until <= today) errors.push('The waiver expiry must be a date after today.');
  if (errors.length) throw invalid(errors);
  return await db.transaction(async () => {
    const row = await forFirmAction(db, actor, thirdPartyId, assessmentId, conditionId);
    if (!stateOf(row, today).canWaive) throw wrongStatus(row, today);
    checkVersion(row, input);
    const res = await db.prepare(`UPDATE tp_conditions SET status = 'waived', waived_by = ?, waived_at = now(), waive_reason = ?,
        waive_until = ?::date, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.user.id, reason, until, actor.ws.id, row.id, row.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, row, 'condition.waived',
      { condition_id: Number(row.id), status: row.status, ...(row.status === 'waived' ? { waive_until: row.waive_until } : {}) },
      { condition_id: Number(row.id), position: row.position, status: 'waived', reason, waive_until: until });
    await recordAllMet(db, actor, row, today);
    await require('./condition-links').revokeIfDone(db, actor, row, today);
    return { condition: row };
  })();
}

async function firmProofFile(db, actor, thirdPartyId, assessmentId, conditionId, fileId) {
  if (!actor || !access.isFirmUser(actor.user) || !access.can(actor.user, actor.perms, 'tp.view')) throw notFound();
  const row = await loadCondition(db, actor.ws.id, conditionId, { scope: { thirdPartyId, assessmentId } });
  const id = Number(fileId);
  if (!row || !Number.isSafeInteger(id) || id < 1) throw notFound();
  const file = await db.prepare(`SELECT f.id, f.original_name, f.stored_path, f.mime_type FROM tp_condition_proof_files f
    WHERE f.workspace_id = ? AND f.condition_id = ? AND f.id = ?`).get(actor.ws.id, row.id, id);
  if (!file) throw notFound();
  return file;
}

async function portalProofFile(db, ws, fileId) {
  const workspaceId = Number(ws && typeof ws === 'object' ? ws.id : ws);
  const id = Number(fileId);
  if (![workspaceId, id].every(n => Number.isSafeInteger(n) && n > 0)) return null;
  return await db.prepare(`SELECT f.id, f.original_name, f.stored_path, f.mime_type, c.recommendation_id
    FROM tp_condition_proof_files f
    JOIN tp_condition_proofs p ON p.workspace_id = f.workspace_id AND p.id = f.proof_id
    JOIN tp_conditions c ON c.workspace_id = f.workspace_id AND c.id = f.condition_id
    WHERE f.workspace_id = ? AND f.id = ? AND p.submitted_by_kind = 'client' AND c.owner = 'client'
      AND tp_condition_trackable(c.workspace_id, c.recommendation_id)`).get(workspaceId, id) || null;
}

async function assessmentContext(db, workspaceId, assessmentId) {
  const decision = await db.prepare(`SELECT d.id, d.recommendation_id, d.outcome, r.version
    FROM tp_client_decisions d JOIN tp_recommendations r ON r.workspace_id = d.workspace_id AND r.id = d.recommendation_id
    WHERE d.workspace_id = ? AND d.assessment_id = ? AND d.outcome <> 'request_more_information'
    ORDER BY d.decided_at DESC, d.id DESC LIMIT 1`).get(workspaceId, assessmentId);
  const issued = await db.prepare(`SELECT r.id, r.version FROM tp_recommendations r
    WHERE r.workspace_id = ? AND r.assessment_id = ? AND r.status = 'issued'
      AND EXISTS (SELECT 1 FROM tp_conditions c WHERE c.workspace_id = r.workspace_id AND c.recommendation_id = r.id)
    ORDER BY r.version DESC LIMIT 1`).get(workspaceId, assessmentId);
  return { decision: decision || null, issued: issued || null };
}

async function firmPanel(db, actor, assessment) {
  if (!actor || !access.isFirmUser(actor.user) || !access.can(actor.user, actor.perms, 'tp.view')) return null;
  const { decision, issued } = await assessmentContext(db, actor.ws.id, assessment.id);
  const tracked = !!decision && decision.outcome === WITH_CONDITIONS;
  const recId = tracked ? decision.recommendation_id : issued && issued.id;
  if (!recId) return null;
  const conditions = await conditionsOfRecommendations(db, actor.ws.id, [recId]);
  if (!conditions.length) return null;
  const today = todayFor(actor.ws);
  const user = actor.user;
  const canManage = access.can(user, actor.perms, 'tp.manage');
  const manager = canManage && access.isManager(user);
  const proofs = tracked ? await proofsOf(db, actor.ws.id, conditions.map(c => c.id)) : new Map();
  const rows = conditions.map(c => {
    const state = stateOf(c, today);
    const history = proofs.get(Number(c.id)) || [];
    const pending = history.find(p => p.review_status === 'pending') || null;
    const own = !!pending && pending.submitted_by != null && Number(pending.submitted_by) === Number(user.id);
    return {
      ...c, state, proofs: history, pending, ownPending: own,
      canUpload: tracked && canManage && c.owner === 'vendor' && state.canSubmit,
      canReview: tracked && canManage && !!pending && c.status === 'proof_submitted' && !own,
      canWaive: tracked && manager && state.canWaive,
      changesVisibleToThirdParty: !!pending && pending.submitted_by_kind === 'vendor',
    };
  });
  return {
    link: await require('./condition-links').panel(db, actor, assessment, rows, { tracked }),
    tracked,
    decision,
    version: tracked ? decision.version : issued.version,
    waiting: !decision,
    conditions: rows,
    summary: tracked ? summarize(conditions, today) : null,
    today,
    canManage,
    isManager: manager,
    statusLabels: STATUS_LABELS, kindLabels: KIND_LABELS, ownerLabels: OWNER_LABELS,
    eventLabels: EVENT_LABELS,
    limits: LIMITS,
  };
}

async function portalTracking(db, ws, recommendationId, user = null) {
  const rid = Number(recommendationId);
  if (!Number.isSafeInteger(rid) || rid < 1) return null;
  const head = await db.prepare(`SELECT r.id FROM tp_recommendations r
    JOIN tp_client_decisions d ON d.workspace_id = r.workspace_id AND d.recommendation_id = r.id
    WHERE r.workspace_id = ? AND r.id = ? AND r.status = 'issued' AND d.outcome = ?`).get(ws.id, rid, WITH_CONDITIONS);
  if (!head) return null;
  const conditions = await db.prepare(`SELECT c.id, c.position, c.description, c.owner, c.due_date::text AS due_date, c.status,
      c.verified_at, c.waive_until::text AS waive_until, c.row_version
    FROM tp_conditions c WHERE c.workspace_id = ? AND c.recommendation_id = ? ORDER BY c.position, c.id`).all(ws.id, rid);
  if (!conditions.length) return null;
  const today = todayFor(ws);
  let eligible = false;
  if (user && access.isClientUser(user)) {
    const rbac = require('../rbac');
    const member = await db.prepare(`SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.user_id = ? AND u.active = 1`).get(ws.id, user.id);
    eligible = !!member && (CLIENT_SUBMITTER_ROLES.includes(member.role)
      || CLIENT_SUBMITTER_ROLES.includes(rbac.normalizeRole(member.role)));
  }
  const clientIds = conditions.filter(c => c.owner === 'client').map(c => c.id);
  const proofRows = clientIds.length ? await db.prepare(`SELECT p.id, p.condition_id, p.note, p.submitted_at, p.review_status,
      p.reviewed_at, CASE WHEN p.review_status = 'changes_requested' THEN p.review_comment END AS changes_comment,
      su.name AS submitted_by_name
    FROM tp_condition_proofs p LEFT JOIN users su ON su.id = p.submitted_by
    WHERE p.workspace_id = ? AND p.submitted_by_kind = 'client' AND p.condition_id IN (${clientIds.map(() => '?').join(',')})
    ORDER BY p.id DESC`).all(ws.id, ...clientIds) : [];
  const proofIds = proofRows.map(p => Number(p.id));
  const files = proofIds.length ? await db.prepare(`SELECT f.id, f.proof_id, f.original_name, f.size_bytes FROM tp_condition_proof_files f
    WHERE f.workspace_id = ? AND f.proof_id IN (${proofIds.map(() => '?').join(',')}) ORDER BY f.id`).all(ws.id, ...proofIds) : [];
  for (const p of proofRows) p.files = files.filter(f => Number(f.proof_id) === Number(p.id));
  const rows = conditions.map(c => {
    const state = stateOf(c, today);
    return {
      ...c, state,
      proofs: c.owner === 'client' ? proofRows.filter(p => Number(p.condition_id) === Number(c.id)) : [],
      canSubmit: eligible && c.owner === 'client' && state.canSubmit,
    };
  });
  return { conditions: rows, summary: summarize(conditions, today), eligible, today, limits: LIMITS,
    statusLabels: STATUS_LABELS, ownerLabels: OWNER_LABELS };
}

async function reachable(deps, user, permission) {
  if (!access.isFirmUser(user) || !access.firmCan(user, permission)) return [];
  const { enabled } = await access.listFirmClients(deps, user);
  const out = [];
  for (const c of enabled) {
    const loaded = await access.loadFirmWorkspace(deps, user, c.id, { permission });
    if (loaded) out.push({ id: Number(c.id), name: c.name, ws: loaded.ws });
  }
  return out;
}

const TRACKED_JOINS = `JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id AND r.status = 'issued'
    JOIN tp_client_decisions d ON d.workspace_id = r.workspace_id AND d.recommendation_id = r.id AND d.outcome = 'approve_with_conditions'
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    LEFT JOIN tp_condition_proofs p ON p.workspace_id = c.workspace_id AND p.condition_id = c.id AND p.review_status = 'pending'
    LEFT JOIN users pu ON pu.id = p.submitted_by`;
const TRACKED_COLUMNS = `${COND_COLUMNS}, r.assessment_id, r.version, a.third_party_id, a.type, t.name AS third_party_name,
    p.id AS pending_proof_id, p.submitted_at AS pending_since, p.submitted_by AS pending_by, p.submitted_by_kind AS pending_kind,
    pu.name AS pending_by_name`;

async function conditionsDue(deps, user, { today = null } = {}) {
  const clients = await reachable(deps, user, 'tp.view');
  const result = { overdue: [], dueSoon: [], awaiting: [], dueSoonDays: DUE_SOON_DAYS };
  if (!clients.length) return result;
  const byId = new Map(clients.map(c => [c.id, c]));
  const rows = await deps.db.prepare(`SELECT ${TRACKED_COLUMNS} FROM tp_conditions c ${TRACKED_JOINS}
    WHERE c.status <> 'verified' AND c.workspace_id IN (${clients.map(() => '?').join(',')})`).all(...clients.map(c => c.id));
  for (const r of await require('./scope').keep(deps.db, user, rows)) {
    const client = byId.get(Number(r.workspace_id));
    const day = today || todayFor(client.ws);
    const state = stateOf(r, day);
    if (state.met) continue;
    const item = { ...r, state, client_name: client.name };
    if (state.overdue) result.overdue.push(item);
    else if (state.dueSoon) result.dueSoon.push(item);
    else if (state.awaitingVerification) result.awaiting.push(item);
  }
  const byDue = (x, y) => String(x.due_date).localeCompare(String(y.due_date)) || Number(x.id) - Number(y.id);
  result.overdue.sort(byDue);
  result.dueSoon.sort(byDue);
  result.awaiting.sort((x, y) => new Date(x.pending_since) - new Date(y.pending_since) || Number(x.id) - Number(y.id));
  return result;
}

async function proofQueue(deps, user, { today = null } = {}) {
  const clients = await reachable(deps, user, 'tp.manage');
  if (!clients.length) return [];
  const byId = new Map(clients.map(c => [c.id, c]));
  const rows = await deps.db.prepare(`SELECT ${TRACKED_COLUMNS} FROM tp_conditions c ${TRACKED_JOINS}
    WHERE c.status = 'proof_submitted' AND p.id IS NOT NULL AND p.submitted_by IS DISTINCT FROM ?::bigint
      AND c.workspace_id IN (${clients.map(() => '?').join(',')})
    ORDER BY p.submitted_at, c.id`).all(user.id, ...clients.map(c => c.id));
  return (await require('./scope').keep(deps.db, user, rows)).map(r => {
    const client = byId.get(Number(r.workspace_id));
    return { ...r, state: stateOf(r, today || todayFor(client.ws)), client_name: client.name };
  });
}

async function attachStates(db, workspaceId, approvalMap, today) {
  const recIds = [];
  for (const entry of approvalMap.values()) {
    entry.conditions = null;
    if (entry.decision && entry.decision.outcome === WITH_CONDITIONS) recIds.push(Number(entry.decision.recommendation_id));
  }
  if (!recIds.length) return approvalMap;
  const rows = await conditionsOfRecommendations(db, workspaceId, recIds);
  for (const entry of approvalMap.values()) {
    if (!entry.decision || entry.decision.outcome !== WITH_CONDITIONS) continue;
    const mine = rows.filter(c => Number(c.recommendation_id) === Number(entry.decision.recommendation_id));
    entry.conditions = summarize(mine, today);
  }
  return approvalMap;
}

async function clientOwnedOpen(db, ws) {
  return await db.prepare(`SELECT c.id, c.position, c.description, c.due_date::text AS due_date, c.status, c.recommendation_id,
      t.name AS third_party_name
    FROM tp_conditions c
    JOIN tp_recommendations r ON r.workspace_id = c.workspace_id AND r.id = c.recommendation_id
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    WHERE c.workspace_id = ? AND c.owner = 'client' AND c.status IN ('open', 'changes_requested', 'proof_submitted')
      AND r.status = 'issued' AND a.status = 'completed'
    ORDER BY c.due_date NULLS LAST, c.id`).all(ws.id);
}

module.exports = {
  STATUSES, STATUS_LABELS, KIND_LABELS, OWNER_LABELS, SUMMARY_LABELS, LIMITS, DUE_SOON_DAYS, EVENT_LABELS,
  CLIENT_SUBMITTER_ROLES,
  stateOf, summarize, assertCanSubmit, submitProof, verify, requestChanges, waive,
  firmProofFile, portalProofFile, firmPanel, portalTracking, clientOwnedOpen, conditionsDue, proofQueue, attachStates,
};
