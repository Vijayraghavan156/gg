'use strict';

const crypto = require('crypto');
const access = require('./access');
const events = require('./events');
const questionnaires = require('./questionnaires');
const { TprmError } = require('./errors');
const { todayFor } = require('../dates');
const { sha256File } = require('./evidence');

const LINK_PATH = '/vendor/c/';
const TOKEN_BYTES = 32;
const DEFAULT_EXPIRY_DAYS = 30;
const WITH_CONDITIONS = 'approve_with_conditions';
const LIMITS = Object.freeze({
  name: 200, email: 320, reason: 500, note: 4000, expiryDaysMin: 1, expiryDaysMax: 90,
  filesPerRequest: 5, fileBytes: 20 * 1024 * 1024,
});
const REVOKE_REASONS = Object.freeze({
  replaced: 'Replaced by a new link',
  manual: 'Revoked by the firm',
  met: 'Every condition the third party owns is verified or waived',
});
const LINK_STATUS_LABELS = Object.freeze({ active: 'Active', expired: 'Expired', revoked: 'Revoked' });
const VENDOR_STATUS_LABELS = Object.freeze({
  open: 'Waiting for your proof',
  changes_requested: 'Changes requested',
  waiver_expired: 'Waiting for your proof',
  proof_submitted: 'Proof sent: waiting for verification',
});
const EVENT_LABELS = Object.freeze({
  'condition_link.created': 'Conditions link created for the third party',
  'condition_link.revoked': 'Conditions link revoked',
});

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const invalid = errors => new TprmError(400, errors.join(' '), { errors });
const notFound = () => new TprmError(404, 'This assessment does not exist, or it is not available to your account.');
const notTracked = () => new TprmError(409,
  'A conditions link is available once the client has decided on the recommendation with conditions.');
const foreign = () => new TprmError(400, 'This form does not belong to this link. Reload the page and try again.', { foreign: true });
const conditionsLib = () => require('./conditions');

function linkUrl(token) {
  return `${require('../email').appBaseUrl()}${LINK_PATH}${token}`;
}

function requireManage(actor) {
  if (!actor || !actor.ws || !access.isFirmUser(actor.user) || !access.can(actor.user, actor.perms, 'tp.manage')) {
    throw new TprmError(403, 'Your role does not allow managing the conditions link.');
  }
}

function parseRecipient(input = {}) {
  const errors = [];
  const name = str(input.recipient_name);
  const email = str(input.recipient_email).toLowerCase();
  if (!name) errors.push('Give the name of the person at the third party who sends the proof.');
  else if (name.length > LIMITS.name) errors.push(`The name must be ${LIMITS.name} characters or fewer.`);
  if (!email) errors.push('Give their email address.');
  else if (email.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Give a valid email address.');
  const daysRaw = str(input.expires_in_days);
  const days = daysRaw === '' ? DEFAULT_EXPIRY_DAYS : Number(daysRaw);
  if (!Number.isInteger(days) || days < LIMITS.expiryDaysMin || days > LIMITS.expiryDaysMax) {
    errors.push(`The link lasts from ${LIMITS.expiryDaysMin} to ${LIMITS.expiryDaysMax} days.`);
  }
  if (errors.length) throw invalid(errors);
  return { name, email, days };
}

function inScope(conditions, today) {
  const { stateOf } = conditionsLib();
  return (conditions || []).filter(c => c.owner === 'vendor' && !stateOf(c, today).met);
}

const COND_COLUMNS = `c.id, c.recommendation_id, c.position, c.description, c.owner, c.due_date::text AS due_date, c.status,
  c.waive_until::text AS waive_until, c.row_version`;

async function conditionsOf(db, workspaceId, recommendationId) {
  return await db.prepare(`SELECT ${COND_COLUMNS} FROM tp_conditions c
    WHERE c.workspace_id = ? AND c.recommendation_id = ? ORDER BY c.position, c.id`).all(workspaceId, recommendationId);
}

async function trackedHead(db, workspaceId, thirdPartyId, assessmentId) {
  const tpId = Number(thirdPartyId);
  const aid = Number(assessmentId);
  if (![tpId, aid].every(n => Number.isSafeInteger(n) && n > 0)) return null;
  return await db.prepare(`SELECT a.id AS assessment_id, a.third_party_id, a.status AS assessment_status, r.id AS recommendation_id,
      r.version, d.id AS decision_id
    FROM tp_assessments a
    JOIN tp_recommendations r ON r.workspace_id = a.workspace_id AND r.assessment_id = a.id AND r.status = 'issued'
    JOIN tp_client_decisions d ON d.workspace_id = r.workspace_id AND d.recommendation_id = r.id AND d.outcome = ?
    WHERE a.workspace_id = ? AND a.id = ? AND a.third_party_id = ?`).get(WITH_CONDITIONS, workspaceId, aid, tpId) || null;
}

async function append(db, workspaceId, head, actorId, action, before, after) {
  await events.appendEvent(db, {
    workspaceId, thirdPartyId: head.third_party_id, assessmentId: head.assessment_id, actorId, action, before, after,
  });
}

async function revokeActive(db, workspaceId, head, actorId, reason) {
  const active = await db.prepare(`SELECT id, (expires_at <= now()) AS expired FROM tp_condition_links
    WHERE workspace_id = ? AND assessment_id = ? AND status = 'active' FOR UPDATE`).all(workspaceId, head.assessment_id);
  for (const l of active) {
    await db.prepare(`UPDATE tp_condition_links SET status = 'revoked', revoked_by = ?, revoked_at = now(), revoke_reason = ?,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
      .run(actorId, reason, workspaceId, l.id);
    await append(db, workspaceId, head, actorId, 'condition_link.revoked',
      { condition_link_id: Number(l.id), status: l.expired ? 'expired' : 'active' },
      { condition_link_id: Number(l.id), status: 'revoked', reason });
  }
  return active.map(l => Number(l.id));
}

async function create(db, actor, thirdPartyId, assessmentId, input = {}) {
  requireManage(actor);
  const recipient = parseRecipient(input);
  const today = todayFor(actor.ws);
  return await db.transaction(async () => {
    const head = await trackedHead(db, actor.ws.id, thirdPartyId, assessmentId);
    if (!head) {
      const exists = await db.prepare('SELECT 1 FROM tp_assessments WHERE workspace_id = ? AND id = ? AND third_party_id = ?')
        .get(actor.ws.id, Number(assessmentId) || 0, Number(thirdPartyId) || 0);
      throw exists ? notTracked() : notFound();
    }
    const scope = inScope(await conditionsOf(db, actor.ws.id, head.recommendation_id), today);
    if (!scope.length) {
      throw new TprmError(409, 'No condition owned by the third party is waiting for proof, so no link is needed.');
    }
    const replaced = await revokeActive(db, actor.ws.id, head, actor.user.id, REVOKE_REASONS.replaced);
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const row = await db.prepare(`INSERT INTO tp_condition_links
      (workspace_id, assessment_id, recommendation_id, token_hash, recipient_name, recipient_email, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, now() + (?::integer * interval '1 day'), ?)
      RETURNING id, recipient_name, recipient_email, expires_at, status, created_at, row_version`)
      .get(actor.ws.id, head.assessment_id, head.recommendation_id, questionnaires.hashToken(token), recipient.name,
        recipient.email, recipient.days, actor.user.id);
    const conditionIds = scope.map(c => Number(c.id));
    await append(db, actor.ws.id, head, actor.user.id, 'condition_link.created', null, {
      condition_link_id: Number(row.id), recommendation_id: Number(head.recommendation_id), version: head.version,
      recipient_name: recipient.name, recipient_email: recipient.email, expires_at: new Date(row.expires_at).toISOString(),
      expires_in_days: recipient.days, condition_ids: conditionIds,
      ...(replaced.length ? { replaced_link_ids: replaced } : {}),
    });
    return { link: row, token, url: linkUrl(token), replaced, conditionIds, head };
  })();
}

async function revoke(db, actor, thirdPartyId, assessmentId, linkId, input = {}) {
  requireManage(actor);
  const reason = str(input.reason) || REVOKE_REASONS.manual;
  if (reason.length > LIMITS.reason) throw invalid([`The reason must be ${LIMITS.reason} characters or fewer.`]);
  const id = Number(linkId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  return await db.transaction(async () => {
    const head = await trackedHead(db, actor.ws.id, thirdPartyId, assessmentId);
    if (!head) throw notFound();
    const link = await db.prepare(`SELECT id, status, row_version, (expires_at <= now()) AS expired FROM tp_condition_links
      WHERE workspace_id = ? AND assessment_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, head.assessment_id, id);
    if (!link) throw notFound();
    if (Number(input.row_version) !== Number(link.row_version)) {
      throw new TprmError(409, 'Someone else changed this link after you opened the page. Nothing was saved: reload the page and try again.');
    }
    if (link.status !== 'active') throw new TprmError(409, 'This link is no longer active.');
    await db.prepare(`UPDATE tp_condition_links SET status = 'revoked', revoked_by = ?, revoked_at = now(), revoke_reason = ?,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(actor.user.id, reason, actor.ws.id, id);
    await append(db, actor.ws.id, head, actor.user.id, 'condition_link.revoked',
      { condition_link_id: id, status: link.expired ? 'expired' : 'active' }, { condition_link_id: id, status: 'revoked', reason });
    return { head };
  })();
}

async function revokeIfDone(db, actor, row, today) {
  const scope = inScope(await conditionsOf(db, actor.ws.id, row.recommendation_id), today);
  if (scope.length) return [];
  return await revokeActive(db, actor.ws.id,
    { assessment_id: Number(row.assessment_id), third_party_id: Number(row.third_party_id) }, actor.user.id, REVOKE_REASONS.met);
}

async function panel(db, actor, assessment, conditions, { tracked }) {
  if (!tracked) return null;
  const links = await db.prepare(`SELECT l.id, l.recipient_name, l.recipient_email, l.expires_at, l.status, l.created_at,
      l.revoked_at, l.revoke_reason, l.row_version, (l.expires_at <= now()) AS expired, cu.name AS created_by_name
    FROM tp_condition_links l LEFT JOIN users cu ON cu.id = l.created_by
    WHERE l.workspace_id = ? AND l.assessment_id = ? ORDER BY l.id DESC`).all(actor.ws.id, assessment.id);
  for (const l of links) l.display_status = l.status === 'active' && l.expired ? 'expired' : l.status;
  const canManage = access.isFirmUser(actor.user) && access.can(actor.user, actor.perms, 'tp.manage');
  const scope = (conditions || []).filter(c => c.owner === 'vendor' && !c.state.met);
  return {
    links,
    active: links.find(l => l.display_status === 'active') || null,
    scopeCount: scope.length,
    hasVendorConditions: (conditions || []).some(c => c.owner === 'vendor'),
    canCreate: canManage && scope.length > 0,
    canRevoke: canManage,
    limits: LIMITS,
    defaultDays: DEFAULT_EXPIRY_DAYS,
    statusLabels: LINK_STATUS_LABELS,
  };
}

async function linkContext(db, token) {
  const raw = String(token || '');
  if (!questionnaires.TOKEN_PATTERN.test(raw)) return null;
  const tokenHash = questionnaires.hashToken(raw);
  const row = await db.prepare(`SELECT l.id, l.workspace_id, l.assessment_id, l.recommendation_id, l.expires_at, a.third_party_id
    FROM tp_condition_links l
    JOIN tp_assessments a ON a.workspace_id = l.workspace_id AND a.id = l.assessment_id
    JOIN tp_client_settings s ON s.workspace_id = l.workspace_id
    WHERE l.token_hash = ? AND l.status = 'active' AND l.expires_at > now() AND s.enabled AND a.status <> 'cancelled'
      AND tp_condition_trackable(l.workspace_id, l.recommendation_id)`).get(tokenHash);
  if (!row) return null;
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id = ?').get(row.workspace_id);
  if (!ws) return null;
  const today = todayFor(ws);
  const conditions = inScope(await conditionsOf(db, ws.id, row.recommendation_id), today);
  if (!conditions.length) return null;
  return {
    tokenHash,
    linkId: Number(row.id),
    workspaceId: Number(row.workspace_id),
    assessmentId: Number(row.assessment_id),
    recommendationId: Number(row.recommendation_id),
    thirdPartyId: Number(row.third_party_id),
    firmId: Number(ws.firm_id),
    clientName: ws.brand_display_name || ws.client_name,
    expiresAt: row.expires_at,
    ws,
    today,
    conditions,
  };
}

async function pageData(db, ctx) {
  const { stateOf } = conditionsLib();
  const ids = ctx.conditions.map(c => Number(c.id));
  const latest = ids.length ? await db.prepare(`SELECT DISTINCT ON (p.condition_id) p.condition_id, p.submitted_by_kind,
      p.review_status, p.review_comment
    FROM tp_condition_proofs p WHERE p.workspace_id = ? AND p.condition_id IN (${ids.map(() => '?').join(',')})
    ORDER BY p.condition_id, p.id DESC`).all(ctx.workspaceId, ...ids) : [];
  const latestBy = new Map(latest.map(p => [Number(p.condition_id), p]));
  const letterhead = require('./letterhead');
  const lh = await letterhead.getLetterhead(db, ctx.firmId).catch(() => null);
  return {
    clientName: ctx.clientName,
    expiresAt: ctx.expiresAt,
    firm: {
      name: lh ? lh.displayName : '',
      logo: lh && lh.logo ? await letterhead.logoDataUri(db, ctx.firmId).catch(() => null) : null,
    },
    limits: LIMITS,
    conditions: ctx.conditions.map(c => {
      const state = stateOf(c, ctx.today);
      const p = latestBy.get(Number(c.id));
      return {
        id: Number(c.id),
        position: c.position,
        description: c.description,
        due_date: c.due_date,
        status: state.status,
        label: VENDOR_STATUS_LABELS[state.status] || state.label,
        overdue: state.overdue,
        canSubmit: state.canSubmit,
        changesComment: c.status === 'changes_requested' && p && p.submitted_by_kind === 'vendor'
          && p.review_status === 'changes_requested' ? p.review_comment : null,
      };
    }),
  };
}

async function submitProof(db, token, conditionId, files, input = {}) {
  const list = (files || []).filter(Boolean);
  const note = str(input.note) || null;
  const cid = Number(conditionId);
  const ctx = await linkContext(db, token);
  if (!ctx) return null;
  if (!Number.isSafeInteger(cid) || cid < 1) throw foreign();
  const inScopeRow = ctx.conditions.find(c => Number(c.id) === cid);
  if (!inScopeRow) throw foreign();
  const errors = [];
  if (!list.length && !note) errors.push('Attach at least one file or write a note.');
  if (list.length > LIMITS.filesPerRequest) errors.push(`Attach at most ${LIMITS.filesPerRequest} files at a time.`);
  if (note && note.length > LIMITS.note) errors.push(`The note must be ${LIMITS.note} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  const hashed = [];
  for (const file of list) hashed.push({ file, sha256: await sha256File(file.path) });
  const { stateOf } = conditionsLib();

  return await db.transaction(async () => {
    const cond = await db.prepare(`SELECT ${COND_COLUMNS} FROM tp_conditions c
      WHERE c.workspace_id = ? AND c.recommendation_id = ? AND c.id = ? AND c.owner = 'vendor' FOR UPDATE OF c`)
      .get(ctx.workspaceId, ctx.recommendationId, cid);
    if (!cond) throw foreign();
    const link = await db.prepare(`SELECT id FROM tp_condition_links
      WHERE workspace_id = ? AND id = ? AND status = 'active' AND expires_at > now() FOR UPDATE`).get(ctx.workspaceId, ctx.linkId);
    if (!link) return null;
    const state = stateOf(cond, ctx.today);
    if (!state.canSubmit) {
      throw new TprmError(409, 'Proof for this condition has already been sent and is waiting for verification.');
    }
    const proof = await db.prepare(`INSERT INTO tp_condition_proofs
      (workspace_id, recommendation_id, condition_id, submitted_by_kind, submitted_by, note, condition_link_id)
      VALUES (?, ?, ?, 'vendor', NULL, ?, ?) RETURNING id, submitted_at`)
      .get(ctx.workspaceId, cond.recommendation_id, cond.id, note, ctx.linkId);
    const stored = [];
    for (const { file, sha256 } of hashed) {
      const name = String(file.originalname || '').trim().slice(0, 255) || 'file';
      const f = await db.prepare(`INSERT INTO tp_condition_proof_files
        (workspace_id, condition_id, proof_id, original_name, stored_path, size_bytes, mime_type, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .get(ctx.workspaceId, cond.id, proof.id, name, file.filename, Number(file.size) || 0,
          file.mimetype ? String(file.mimetype).slice(0, 200) : null, sha256);
      stored.push({ file_id: Number(f.id), name, size_bytes: Number(file.size) || 0, sha256 });
    }
    const res = await db.prepare(`UPDATE tp_conditions SET status = 'proof_submitted', waived_by = NULL, waived_at = NULL,
        waive_reason = NULL, waive_until = NULL, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(ctx.workspaceId, cond.id, cond.row_version);
    if (res.changes !== 1) throw new TprmError(409, 'This condition changed while you were sending. Reload the page and try again.');
    await events.appendEvent(db, {
      workspaceId: ctx.workspaceId, thirdPartyId: ctx.thirdPartyId, assessmentId: ctx.assessmentId, actorId: null,
      action: 'condition.proof_submitted',
      before: { condition_id: Number(cond.id), status: cond.status },
      after: { condition_id: Number(cond.id), position: cond.position, owner: cond.owner, status: 'proof_submitted',
        proof_id: Number(proof.id), submitted_by_kind: 'vendor', by: 'third_party', condition_link_id: ctx.linkId,
        note, files: stored },
    });
    return { proof: { id: Number(proof.id), submitted_at: proof.submitted_at, files: stored }, condition: cond, ctx };
  })();
}

module.exports = {
  LINK_PATH, LIMITS, REVOKE_REASONS, LINK_STATUS_LABELS, VENDOR_STATUS_LABELS, EVENT_LABELS, DEFAULT_EXPIRY_DAYS,
  inScope, linkUrl, create, revoke, revokeIfDone, panel, linkContext, pageData, submitProof,
};
