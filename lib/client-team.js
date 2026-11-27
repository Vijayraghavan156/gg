'use strict';

const crypto = require('node:crypto');
const rbac = require('./rbac');

const INVITE_ROLES = Object.freeze(['contributor', 'isms_manager']);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITES_PER_DAY = 20;
const hashToken = raw => crypto.createHash('sha256').update(raw).digest('hex');

class TeamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const roleOf = ws => rbac.normalizeRole(ws && ws.role);
const isClient = user => !!user && user.user_type === 'client';
const isOwner = (user, ws) => isClient(user) && roleOf(ws) === 'client_owner';
const roleLabel = role => rbac.ROLE_LABELS[rbac.normalizeRole(role)] || role;
const invitable = role => INVITE_ROLES.includes(rbac.normalizeRole(role));

async function team(db, ws) {
  const people = await db.prepare(`SELECT wm.role, u.id, u.name, u.email, u.active, u.last_active_at
    FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND u.user_type = 'client'
    ORDER BY lower(u.name), u.id`).all(ws.id);
  const rank = { client_owner: 1, isms_manager: 2 };
  const clientPeople = people.map(p => ({ ...p, id: Number(p.id), role: rbac.normalizeRole(p.role), roleLabel: roleLabel(p.role) }))
    .sort((a, b) => (rank[a.role] || 3) - (rank[b.role] || 3));
  const consultants = await db.prepare(`SELECT u.id, u.name, u.email,
      (u.id = w.lead_consultant_id) AS is_lead
    FROM users u JOIN workspaces w ON w.id = ?
    WHERE u.user_type = 'firm' AND u.active = 1 AND u.firm_id = w.firm_id
      AND (u.id = w.lead_consultant_id OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id = u.id))
    ORDER BY (u.id = w.lead_consultant_id) DESC, lower(u.name), u.id`).all(ws.id);
  const invites = await db.prepare(`SELECT i.id, i.email, i.name, i.workspace_role, i.expires_at, i.created_at, u.name AS invited_by_name
    FROM user_invitations i LEFT JOIN users u ON u.id = i.invited_by
    WHERE i.workspace_id = ? AND i.user_type = 'client' AND i.accepted_at IS NULL AND i.revoked_at IS NULL
    ORDER BY i.created_at DESC, i.id DESC`).all(ws.id);
  const now = Date.now();
  return {
    clientPeople,
    consultants: consultants.map(c => ({ ...c, id: Number(c.id), is_lead: !!c.is_lead })),
    invites: invites.map(i => ({ ...i, id: Number(i.id), roleLabel: roleLabel(i.workspace_role), expired: new Date(i.expires_at).getTime() < now,
      manageable: invitable(i.workspace_role) })),
  };
}

function requireOwner(user, ws) {
  if (!isOwner(user, ws)) throw new TeamError(403, 'Only a client sponsor can change who is on your team.');
}

async function withinDailyLimit(db, actor) {
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`client_invites_by:${Number(actor.id)}`);
  const row = await db.prepare(`SELECT COUNT(*)::int AS n FROM user_invitations WHERE invited_by = ?
    AND created_at >= to_char((statement_timestamp() AT TIME ZONE 'UTC') - interval '24 hours', 'YYYY-MM-DD HH24:MI:SS')`).get(actor.id);
  if (Number(row.n) >= INVITES_PER_DAY) {
    throw new TeamError(429, `You have sent ${INVITES_PER_DAY} invitations in the last 24 hours, which is the most allowed. Try again tomorrow, or ask your consultants.`);
  }
}

async function issue(db, ws, actor, { email, name, role }) {
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const row = await db.prepare(`INSERT INTO user_invitations
      (email, name, firm_id, user_type, workspace_id, workspace_role, token_hash, expires_at, invited_by)
      VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?) RETURNING id`)
    .get(email, name, ws.firm_id, ws.id, role, hashToken(raw), expiresAt, actor.id);
  return { id: Number(row.id), raw, expiresAt };
}

async function send(db, ws, actor, { email, name, role, raw, expiresAt }, emailLib) {
  try {
    const firm = await db.prepare('SELECT name FROM firms WHERE id = ?').get(ws.firm_id);
    const r = await emailLib.sendInviteEmail({
      toEmail: email, toName: name, inviterName: actor.name,
      firmName: (firm && firm.name) || null,
      role: roleLabel(role),
      token: raw, expiresAt, firmId: ws.firm_id,
    });
    return !!(r && r.ok);
  } catch (_) {
    return false;
  }
}

async function invite(db, ws, actor, input = {}, emailLib = require('./email')) {
  requireOwner(actor, ws);
  const email = String(input.email || '').trim().toLowerCase();
  const name = String(input.name || '').trim().slice(0, 200) || null;
  const role = String(input.role || '');
  if (!email || email.length > 254 || !EMAIL.test(email)) throw new TeamError(400, 'Enter a valid email address.');
  if (!INVITE_ROLES.includes(role)) throw new TeamError(400, 'Choose Contributor or Client coordinator.');
  const issued = await db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`client_team:${Number(ws.id)}`);
    const existing = await db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
    if (existing) {
      const member = await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(ws.id, existing.id);
      throw new TeamError(409, member
        ? `${email} is already on your team.`
        : `${email} already has an account. Ask your consultants to add them to your team.`);
    }
    const pending = await db.prepare(`SELECT workspace_role FROM user_invitations
      WHERE workspace_id = ? AND user_type = 'client' AND lower(email) = ? AND accepted_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC, id DESC`).all(ws.id, email);
    const theirs = pending.find(p => !invitable(p.workspace_role));
    if (theirs) {
      throw new TeamError(409, `Your consultants have already invited ${email} as ${roleLabel(theirs.workspace_role)}. Ask them if that should change.`);
    }
    await withinDailyLimit(db, actor);
    await db.prepare(`UPDATE user_invitations SET revoked_at = utc_now_text()
      WHERE workspace_id = ? AND lower(email) = ? AND accepted_at IS NULL AND revoked_at IS NULL`).run(ws.id, email);
    const replaced = pending.length ? { role: rbac.normalizeRole(pending[0].workspace_role), roleLabel: roleLabel(pending[0].workspace_role) } : null;
    return { ...(await issue(db, ws, actor, { email, name, role })), replaced };
  })();
  const sent = await send(db, ws, actor, { email, name, role, ...issued }, emailLib);
  return { id: issued.id, email, sent, role, roleLabel: roleLabel(role), replaced: issued.replaced };
}

async function pendingInvite(db, ws, invId) {
  const id = Number(invId);
  if (!Number.isSafeInteger(id) || id < 1) throw new TeamError(404, 'This invitation does not exist.');
  const row = await db.prepare(`SELECT id, email, name, workspace_role FROM user_invitations
    WHERE id = ? AND workspace_id = ? AND user_type = 'client' AND accepted_at IS NULL AND revoked_at IS NULL`).get(id, ws.id);
  if (!row) throw new TeamError(404, 'This invitation does not exist, or it was already used or withdrawn.');
  return row;
}

async function resend(db, ws, actor, invId, emailLib = require('./email')) {
  requireOwner(actor, ws);
  const { issued, row } = await db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`client_team:${Number(ws.id)}`);
    const row = await pendingInvite(db, ws, invId);
    if (!invitable(row.workspace_role)) throw new TeamError(409, 'Your consultants sent this invitation. Ask them to resend it.');
    const role = rbac.normalizeRole(row.workspace_role);
    if (await db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?)').get(row.email)) {
      throw new TeamError(409, `${row.email} already has an account. Ask your consultants to add them to your team.`);
    }
    await withinDailyLimit(db, actor);
    await db.prepare('UPDATE user_invitations SET revoked_at = utc_now_text() WHERE id = ?').run(row.id);
    return { row: { ...row, workspace_role: role }, issued: await issue(db, ws, actor, { email: row.email, name: row.name, role }) };
  })();
  const sent = await send(db, ws, actor, { email: row.email, name: row.name, role: row.workspace_role, ...issued }, emailLib);
  return { id: issued.id, email: row.email, sent };
}

async function revoke(db, ws, actor, invId) {
  requireOwner(actor, ws);
  const row = await pendingInvite(db, ws, invId);
  if (!invitable(row.workspace_role)) throw new TeamError(409, 'Your consultants sent this invitation. Ask them to withdraw it.');
  await db.prepare('UPDATE user_invitations SET revoked_at = utc_now_text() WHERE id = ? AND revoked_at IS NULL').run(row.id);
  return { id: Number(row.id), email: row.email };
}

async function removable(db, ws, actor, userId) {
  requireOwner(actor, ws);
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id < 1) throw new TeamError(404, 'This person is not on your team.');
  if (id === Number(actor.id)) throw new TeamError(409, 'You cannot remove yourself. Ask another client sponsor or your consultants.');
  const target = await db.prepare(`SELECT wm.role, u.id, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND wm.user_id = ? AND u.user_type = 'client'`).get(ws.id, id);
  if (!target) throw new TeamError(404, 'This person is not on your team.');
  if (rbac.normalizeRole(target.role) === 'client_owner') {
    const owners = await db.prepare(`SELECT wm.role FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? AND u.user_type = 'client' AND u.active = 1`).all(ws.id);
    if (owners.filter(o => rbac.normalizeRole(o.role) === 'client_owner').length <= 1) {
      throw new TeamError(409, 'Your team needs at least one client sponsor. Ask your consultants to name another sponsor first.');
    }
  }
  return { id, name: target.name, email: target.email, role: rbac.normalizeRole(target.role) };
}

async function remove(db, ws, actor, userId) {
  requireOwner(actor, ws);
  return await db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`client_team:${Number(ws.id)}`);
    const target = await removable(db, ws, actor, userId);
    await db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(ws.id, target.id);
    return target;
  })();
}

async function setThirdPartyEmail(db, userId, on) {
  await db.prepare('UPDATE users SET tprm_email_notify = ? WHERE id = ?').run(on ? 'on' : 'off', userId);
}

module.exports = { INVITE_ROLES, INVITES_PER_DAY, TeamError, isOwner, roleLabel, team, invite, resend, revoke, removable, remove, setThirdPartyEmail };
