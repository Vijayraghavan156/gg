'use strict';

for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'client-team-tests-password-1234';
const LINK = /\/invite\/[0-9a-f]{64}/;
const realFetch = globalThis.fetch;

let env;
let client;
let db;
let firmId;
let otherFirmId;
let consultant;
let A;
let B;
let iso;
const sessions = [];

async function withProvider(status, sent, fn) {
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sent.push(JSON.parse(opts.body));
      const body = status === 200 ? { id: 'sent-1' } : { message: 'provider unavailable' };
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  try { return await fn(); } finally {
    process.env.RESEND_API_KEY = '';
    globalThis.fetch = realFetch;
  }
}

async function makeUser(email, { type = 'client', role = 'consultant', firm = firmId, workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), `Name ${email.split('@')[0]}`, type,
    type === 'firm' ? firm : null, type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email };
}

async function signIn(user) {
  if (user.session) return user.session;
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email: user.email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${user.email} signs in`);
  await session.get('/dashboard');
  sessions.push(session);
  user.session = session;
  return session;
}

async function clientWs(name, { tprm = true, firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome,lead_consultant_id)
    VALUES (?,?,'["iso27001"]','certification_support',?)`).run(firm, name, firm === firmId ? consultant.id : null)).lastInsertRowid);
  if (tprm) await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (firm === firmId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, consultant.id, 'consultant');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`team-owner-${slug}@test.local`, { workspaceId: id, memberRole: 'client_owner' });
  const coord = await makeUser(`team-coord-${slug}@test.local`, { workspaceId: id, memberRole: 'isms_manager' });
  const contributor = await makeUser(`team-contrib-${slug}@test.local`, { workspaceId: id, memberRole: 'contributor' });
  return { id, owner, coord, contributor };
}

const tpAccount = ws => `/workspaces/${ws}/client-portal/third-party-risk/account`;
const isoAccount = ws => `/workspaces/${ws}/client-portal/account`;
const inviteRow = async email => db.prepare(`SELECT * FROM user_invitations WHERE email=? ORDER BY id DESC LIMIT 1`).get(email);
const memberRole = async (ws, userId) => ((await db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(ws, userId)) || {}).role || null;
const said = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  otherFirmId = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Other Team Firm')").run()).lastInsertRowid);
  consultant = await makeUser('team-consultant@test.local', { type: 'firm', role: 'consultant' });
  A = await clientWs('Team Client A');
  B = await clientWs('Team Client B');
  iso = await clientWs('Team ISO Only', { tprm: false });
});

test.after(async () => {
  globalThis.fetch = realFetch;
  for (const s of sessions) await s.close();
  if (client) await client.close();
});

test('the owner sees their team and the assigned consultants from the avatar in both rails', async () => {
  const s = await signIn(A.owner);
  const home = await s.get(`/workspaces/${A.id}/client-portal/third-party-risk`);
  assert.equal(home.status, 200);
  assert.match(home.text, new RegExp(`data-tprm-cv-account-link[^>]*>|href="${tpAccount(A.id)}"[^>]*data-tprm-cv-account-link`));
  const page = await s.get(tpAccount(A.id));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-cv-account-me/);
  assert.match(page.text, new RegExp(A.owner.email.replace(/\./g, '\\.')));
  assert.match(page.text, /data-tprm-cv-team-owner="1"/);
  for (const u of [A.owner, A.coord, A.contributor]) assert.match(page.text, new RegExp(`data-tprm-cv-team-person="${u.id}"`));
  assert.match(page.text, new RegExp(`data-tprm-cv-team-consultant="${consultant.id}"`));
  assert.match(page.text, /Engagement lead/);
  assert.match(page.text, /data-tprm-cv-team-invite-form/);
  assert.doesNotMatch(page.text, new RegExp(`data-tprm-cv-team-remove="${A.owner.id}"`), 'no remove button on yourself');
  assert.match(page.text, new RegExp(`data-tprm-cv-team-remove="${A.contributor.id}"`));
  assert.doesNotMatch(page.text, new RegExp(`data-tprm-cv-team-remove="${consultant.id}"`));
  assert.match(page.text, /data-tprm-cv-activity/);
  assert.match(page.text, /does not keep a personal notification list/);
  assert.doesNotMatch(page.text, /B Team Client|Team Client B/);

  const portal = await s.get(`/workspaces/${A.id}/client-portal`);
  assert.equal(portal.status, 200);
  assert.match(portal.text, new RegExp(`href="${isoAccount(A.id)}"[^>]*data-client-account-link`));
  const isoPage = await s.get(isoAccount(A.id));
  assert.equal(isoPage.status, 200);
  assert.match(isoPage.text, /data-client-team-owner="1"/);
  assert.match(isoPage.text, /data-client-account-updates/);
});

test('a contributor and a coordinator see a read-only team list and cannot change the team', async () => {
  const pending = await withProvider(200, [], async () => (await signIn(A.owner)).post(`${tpAccount(A.id)}/team/invite`, { email: 'ro-pending@test.local', role: 'contributor' }));
  assert.equal(pending.status, 302);
  const inv = await inviteRow('ro-pending@test.local');
  for (const who of [A.contributor, A.coord]) {
    const s = await signIn(who);
    const page = await s.get(tpAccount(A.id));
    assert.equal(page.status, 200);
    assert.match(page.text, /data-tprm-cv-team-owner="0"/);
    assert.match(page.text, /data-tprm-cv-team-readonly/);
    assert.match(page.text, new RegExp(`data-tprm-cv-team-person="${A.owner.id}"`));
    assert.doesNotMatch(page.text, /data-tprm-cv-team-invite-form|data-tprm-cv-team-remove=|data-tprm-cv-team-resend=/);
    const isoPage = await s.get(isoAccount(A.id));
    assert.match(isoPage.text, /data-client-team-readonly/);
    assert.doesNotMatch(isoPage.text, /data-client-team-invite-form/);
    for (const base of [tpAccount(A.id), isoAccount(A.id)]) {
      assert.equal((await s.post(`${base}/team/invite`, { email: 'nope@test.local', role: 'contributor' })).status, 403);
      assert.equal((await s.post(`${base}/team/invites/${inv.id}/revoke`, { _tp_confirmed: '1' })).status, 403);
      assert.equal((await s.post(`${base}/team/invites/${inv.id}/resend`, {})).status, 403);
      assert.equal((await s.post(`${base}/team/members/${A.owner.id}/remove`, { _tp_confirmed: '1' })).status, 403);
    }
  }
  assert.equal(await inviteRow('nope@test.local'), undefined);
  assert.equal((await inviteRow('ro-pending@test.local')).revoked_at, null);
  assert.equal(await memberRole(A.id, A.owner.id), 'client_owner');
});

test('an invitation is emailed, never shown, and accepting it joins the client with the chosen role', async () => {
  const s = await signIn(A.owner);
  const sent = [];
  const res = await withProvider(200, sent, () => s.post(`${isoAccount(A.id)}/team/invite`, { email: 'New.Colleague@test.local', name: 'New Colleague', role: 'isms_manager' }));
  assert.equal(res.status, 302);
  assert.doesNotMatch(said(res), LINK);
  assert.match(said(res), /Invitation sent to new\.colleague@test\.local/);
  const row = await inviteRow('new.colleague@test.local');
  assert.equal(Number(row.workspace_id), A.id);
  assert.equal(Number(row.firm_id), firmId);
  assert.equal(row.workspace_role, 'isms_manager');
  assert.equal(row.user_type, 'client');
  assert.equal(Number(row.invited_by), A.owner.id);
  assert.equal(sent.length, 1);
  const token = (sent[0].html.match(/\/invite\/([0-9a-f]{64})/) || [])[1];
  assert.ok(token);
  const page = await s.get(res.location);
  assert.doesNotMatch(page.text, LINK);

  const guest = makeClient(env.app);
  sessions.push(guest);
  const form = await guest.get(`/invite/${token}`);
  assert.equal(form.status, 200);
  const csrf = (form.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const accepted = await guest.post(`/invite/${token}`, { name: 'New Colleague', password: PASSWORD, password2: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(accepted.status, 302);
  const user = await db.prepare('SELECT id, user_type FROM users WHERE email=?').get('new.colleague@test.local');
  assert.equal(user.user_type, 'client');
  assert.equal(await memberRole(A.id, user.id), 'isms_manager');
});

test('the owner cannot invite another sponsor, a bad address, or someone already on the team', async () => {
  const s = await signIn(A.owner);
  await withProvider(200, [], async () => {
    const owner = await s.post(`${tpAccount(A.id)}/team/invite`, { email: 'would-be-owner@test.local', role: 'client_owner' });
    assert.equal(owner.status, 302);
    assert.match(said(owner), /Choose Contributor or Client coordinator/);
    const bad = await s.post(`${tpAccount(A.id)}/team/invite`, { email: 'not-an-email', role: 'contributor' });
    assert.match(said(bad), /valid email/);
    const dup = await s.post(`${tpAccount(A.id)}/team/invite`, { email: A.contributor.email, role: 'contributor' });
    assert.match(said(dup), /already on your team/);
    const elsewhere = await s.post(`${tpAccount(A.id)}/team/invite`, { email: B.contributor.email, role: 'contributor' });
    assert.match(said(elsewhere), /already has an account/);
    assert.doesNotMatch(said(elsewhere), /Team Client B/);
  });
  assert.equal(await inviteRow('would-be-owner@test.local'), undefined);
  assert.equal(await inviteRow(A.contributor.email), undefined);
});

test('a failed invitation email says it did not send, shows no link, and Resend issues a new link that replaces the old one', async () => {
  const s = await signIn(A.owner);
  const failed = [];
  const res = await withProvider(500, failed, () => s.post(`${tpAccount(A.id)}/team/invite`, { email: 'bounce@test.local', role: 'contributor' }));
  assert.equal(res.status, 302);
  assert.doesNotMatch(said(res), LINK);
  assert.match(said(res), /did not send\. Try again/);
  const page = await s.get(res.location);
  assert.match(page.text, /did not send/);
  assert.doesNotMatch(page.text, LINK);
  assert.doesNotMatch(page.text, /Single-use link to share/);
  const first = await inviteRow('bounce@test.local');
  const oldToken = (failed[0].html.match(/\/invite\/([0-9a-f]{64})/) || [])[1];
  assert.ok(oldToken);
  assert.match((await s.get(tpAccount(A.id))).text, new RegExp(`data-tprm-cv-team-invite="${first.id}"`));

  const sent = [];
  const again = await withProvider(200, sent, () => s.post(`${tpAccount(A.id)}/team/invites/${first.id}/resend`, {}));
  assert.equal(again.status, 302);
  assert.match(said(again), /sent again/);
  assert.doesNotMatch(said(again), LINK);
  const newToken = (sent[0].html.match(/\/invite\/([0-9a-f]{64})/) || [])[1];
  assert.notEqual(newToken, oldToken);
  const guest = makeClient(env.app);
  sessions.push(guest);
  assert.equal((await guest.get(`/invite/${oldToken}`)).status, 400, 'the old link stops working');
  assert.equal((await guest.get(`/invite/${newToken}`)).status, 200);
  assert.ok((await db.prepare('SELECT revoked_at FROM user_invitations WHERE id=?').get(first.id)).revoked_at);

  const current = await inviteRow('bounce@test.local');
  const revoke = await s.post(`${tpAccount(A.id)}/team/invites/${current.id}/revoke`, { _tp_confirmed: '1' });
  assert.equal(revoke.status, 302);
  assert.match(said(revoke), /withdrawn/);
  assert.equal((await guest.get(`/invite/${newToken}`)).status, 400, 'a withdrawn link stops working');
});

test('the owner removes a colleague but never a consultant, themselves, or the last sponsor', async () => {
  const s = await signIn(A.owner);
  const extra = await makeUser('team-extra-a@test.local', { workspaceId: A.id, memberRole: 'contributor' });
  const removeAt = (base, id) => s.post(`${base}/team/members/${id}/remove`, { _tp_confirmed: '1' });
  const ok = await removeAt(tpAccount(A.id), extra.id);
  assert.equal(ok.status, 302);
  assert.match(said(ok), /no longer has access/);
  assert.equal(await memberRole(A.id, extra.id), null);
  assert.equal((await removeAt(isoAccount(A.id), consultant.id)).status, 404);
  assert.equal(await memberRole(A.id, consultant.id), 'consultant');
  const self = await removeAt(isoAccount(A.id), A.owner.id);
  assert.match(said(self), /cannot remove yourself/);
  assert.equal(await memberRole(A.id, A.owner.id), 'client_owner');

  const team = require('../lib/client-team');
  const second = await makeUser('team-second-owner-a@test.local', { workspaceId: A.id, memberRole: 'client_admin' });
  const ws = { id: A.id, firm_id: firmId, role: 'client_owner' };
  const removed = await team.remove(db, ws, { id: second.id, user_type: 'client' }, A.owner.id).then(() => true, err => err);
  assert.equal(removed, true, 'a second sponsor can remove the first while two remain');
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(A.id, A.owner.id, 'client_owner');
  await db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(A.id, second.id);
  const lone = await makeUser('team-lone-owner@test.local', { workspaceId: B.id, memberRole: 'contributor' });
  await db.prepare("UPDATE workspace_members SET role='client_owner' WHERE workspace_id=? AND user_id=?").run(B.id, lone.id);
  await db.prepare("UPDATE workspace_members SET role='contributor' WHERE workspace_id=? AND user_id=?").run(B.id, B.owner.id);
  const blocked = await team.remove(db, { id: B.id, firm_id: firmId, role: 'client_owner' }, { id: B.owner.id, user_type: 'client' }, lone.id).catch(err => err);
  assert.ok(blocked instanceof team.TeamError);
  assert.equal(blocked.status, 409);
  assert.match(blocked.message, /at least one client sponsor/);
  assert.equal(await memberRole(B.id, lone.id), 'client_owner');
  await db.prepare("UPDATE workspace_members SET role='client_owner' WHERE workspace_id=? AND user_id=?").run(B.id, B.owner.id);
  await db.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(B.id, lone.id);
});

test('a sponsor invitation sent by the consultants cannot be resent, withdrawn or replaced from the client side', async () => {
  const theirs = async (email, role) => Number((await db.prepare(`INSERT INTO user_invitations
      (email, name, firm_id, user_type, workspace_id, workspace_role, token_hash, expires_at, invited_by)
      VALUES (?, 'New CISO', ?, 'client', ?, ?, ?, ?, ?) RETURNING id`)
    .get(email, firmId, A.id, role, require('node:crypto').randomBytes(32).toString('hex'), new Date(Date.now() + 86400000).toISOString(), consultant.id)).id);
  const sponsor = await theirs('ciso@test.local', 'client_owner');
  const alias = await theirs('alias-admin@test.local', 'client_admin');
  const s = await signIn(A.owner);
  const tpPage = await s.get(tpAccount(A.id));
  const isoPage = await s.get(isoAccount(A.id));
  for (const id of [sponsor, alias]) {
    assert.match(tpPage.text, new RegExp(`data-tprm-cv-team-invite="${id}"`));
    assert.doesNotMatch(tpPage.text, new RegExp(`data-tprm-cv-team-(resend|revoke)="${id}"`));
    assert.match(tpPage.text, new RegExp(`data-tprm-cv-team-invite-theirs="${id}"`));
    assert.match(isoPage.text, new RegExp(`data-client-team-invite="${id}"`));
    assert.doesNotMatch(isoPage.text, new RegExp(`data-client-team-(resend|revoke)="${id}"`));
    assert.match(isoPage.text, new RegExp(`data-client-team-invite-theirs="${id}"`));
  }
  const sent = [];
  await withProvider(200, sent, async () => {
    for (const base of [tpAccount(A.id), isoAccount(A.id)]) {
      assert.match(said(await s.post(`${base}/team/invites/${sponsor}/resend`, {})), /Your consultants sent this invitation/);
      assert.match(said(await s.post(`${base}/team/invites/${alias}/revoke`, { _tp_confirmed: '1' })), /Your consultants sent this invitation/);
      const replaced = await s.post(`${base}/team/invite`, { email: 'CISO@test.local', role: 'contributor' });
      assert.match(said(replaced), /Your consultants have already invited ciso@test\.local as Client sponsor/);
    }
  });
  assert.equal(sent.length, 0, 'no email goes out');
  const lib = require('../lib/client-team');
  const ws = { id: A.id, firm_id: firmId, role: 'client_owner' };
  const actor = { id: A.owner.id, user_type: 'client', name: 'Owner' };
  for (const run of [() => lib.resend(db, ws, actor, sponsor, { sendInviteEmail: async () => ({ ok: true }) }), () => lib.revoke(db, ws, actor, alias),
    () => lib.invite(db, ws, actor, { email: 'ciso@test.local', role: 'isms_manager' }, { sendInviteEmail: async () => ({ ok: true }) })]) {
    const err = await run().then(() => null, e => e);
    assert.ok(err instanceof lib.TeamError);
    assert.equal(err.status, 409);
  }
  for (const [id, role] of [[sponsor, 'client_owner'], [alias, 'client_admin']]) {
    const row = await db.prepare('SELECT revoked_at, workspace_role FROM user_invitations WHERE id=?').get(id);
    assert.equal(row.revoked_at, null);
    assert.equal(row.workspace_role, role);
  }
  assert.equal(Number((await db.prepare("SELECT COUNT(*) AS n FROM user_invitations WHERE lower(email) IN ('ciso@test.local','alias-admin@test.local')").get()).n), 2);
  await db.prepare('UPDATE user_invitations SET revoked_at = utc_now_text() WHERE id IN (?, ?)').run(sponsor, alias);
});

test('a sponsor can send a limited number of invitations a day, and the limit lifts after 24 hours', async () => {
  const C = await clientWs('Team Client Capped');
  const lib = require('../lib/client-team');
  const insert = (i, at) => db.prepare(`INSERT INTO user_invitations
      (email, firm_id, user_type, workspace_id, workspace_role, token_hash, expires_at, invited_by, created_at)
      VALUES (?, ?, 'client', ?, 'contributor', ?, ?, ?, ${at})`)
    .run(`capped-${i}@test.local`, firmId, C.id, require('node:crypto').randomBytes(32).toString('hex'), new Date(Date.now() + 86400000).toISOString(), C.owner.id);
  for (let i = 1; i < lib.INVITES_PER_DAY; i += 1) await insert(i, 'utc_now_text()');
  const s = await signIn(C.owner);
  assert.equal((await s.get(tpAccount(C.id))).status, 200);
  const sent = [];
  await withProvider(200, sent, async () => {
    const last = await s.post(`${tpAccount(C.id)}/team/invite`, { email: 'capped-last@test.local', role: 'contributor' });
    assert.match(said(last), /Invitation sent to capped-last@test\.local/);
    const over = await s.post(`${isoAccount(C.id)}/team/invite`, { email: 'capped-over@test.local', role: 'contributor' });
    assert.match(said(over), new RegExp(`You have sent ${lib.INVITES_PER_DAY} invitations in the last 24 hours`));
    const pending = await inviteRow('capped-last@test.local');
    const again = await s.post(`${tpAccount(C.id)}/team/invites/${pending.id}/resend`, {});
    assert.match(said(again), /in the last 24 hours/);
    assert.equal((await db.prepare('SELECT revoked_at FROM user_invitations WHERE id=?').get(pending.id)).revoked_at, null);
  });
  assert.equal(sent.length, 1, 'only the invitation under the limit is emailed');
  assert.equal(await inviteRow('capped-over@test.local'), undefined);
  const err = await lib.invite(db, { id: C.id, firm_id: firmId, role: 'client_owner' }, { id: C.owner.id, user_type: 'client' },
    { email: 'capped-lib@test.local', role: 'contributor' }, { sendInviteEmail: async () => ({ ok: true }) }).then(() => null, e => e);
  assert.ok(err instanceof lib.TeamError);
  assert.equal(err.status, 429);

  await db.prepare(`UPDATE user_invitations SET created_at = to_char((statement_timestamp() AT TIME ZONE 'UTC') - interval '25 hours', 'YYYY-MM-DD HH24:MI:SS')
    WHERE invited_by = ?`).run(C.owner.id);
  const later = await withProvider(200, [], () => s.post(`${tpAccount(C.id)}/team/invite`, { email: 'capped-later@test.local', role: 'contributor' }));
  assert.match(said(later), /Invitation sent to capped-later@test\.local/);
});

test('another client, another firm and the firm itself are refused', async () => {
  await withProvider(200, [], async () => (await signIn(A.owner)).post(`${tpAccount(A.id)}/team/invite`, { email: 'cross-a@test.local', role: 'contributor' }));
  const inv = await inviteRow('cross-a@test.local');
  const sB = await signIn(B.owner);
  assert.equal((await sB.get(tpAccount(A.id))).status, 403);
  assert.equal((await sB.get(isoAccount(A.id))).status, 403);
  assert.equal((await sB.post(`${tpAccount(A.id)}/team/invite`, { email: 'cross-b@test.local', role: 'contributor' })).status, 403);
  assert.equal((await sB.post(`${tpAccount(B.id)}/team/invites/${inv.id}/revoke`, { _tp_confirmed: '1' })).status, 404);
  assert.equal((await sB.post(`${isoAccount(B.id)}/team/invites/${inv.id}/resend`, {})).status, 404);
  assert.equal((await sB.post(`${isoAccount(B.id)}/team/members/${A.contributor.id}/remove`, {})).status, 404);
  assert.equal((await inviteRow('cross-a@test.local')).revoked_at, null);
  assert.equal(await memberRole(A.id, A.contributor.id), 'contributor');
  assert.equal(await inviteRow('cross-b@test.local'), undefined);

  for (const route of [tpAccount(A.id), isoAccount(A.id)]) assert.equal((await client.get(route)).status, 404, `a firm manager gets 404 on ${route}`);
  assert.equal((await client.post(`${isoAccount(A.id)}/team/invites/${inv.id}/revoke`, {})).status, 404);
  assert.equal((await client.post(`${isoAccount(A.id)}/team/members/${A.contributor.id}/remove`, {})).status, 404);
  const outsider = await makeUser('team-outsider@test.local', { type: 'firm', role: 'manager', firm: otherFirmId });
  const so = await signIn(outsider);
  assert.equal((await so.get(isoAccount(A.id))).status, 403);
  assert.equal((await so.post(`${isoAccount(A.id)}/team/members/${A.contributor.id}/remove`, {})).status, 403);
  assert.equal(await memberRole(A.id, A.contributor.id), 'contributor');
});

test('a client without third-party risk gets the portal account page and not the third-party one', async () => {
  const s = await signIn(iso.owner);
  const page = await s.get(isoAccount(iso.id));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-client-team-owner="1"/);
  assert.match(page.text, /Your notifications/);
  assert.doesNotMatch(page.text, /client-portal\/third-party-risk/);
  assert.equal((await s.get(tpAccount(iso.id))).status, 404);
  assert.equal((await s.post(`${tpAccount(iso.id)}/team/invite`, { email: 'iso-tp@test.local', role: 'contributor' })).status, 404);
});

test('the team routes and library stay outside the third-party risk code', () => {
  for (const file of ['routes/client-team.js', 'lib/client-team.js', 'views/client_account.ejs', 'views/client_account_confirm.ejs']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(text, /lib\/tprm\/|\btp_[a-z_]+\b/, `${file} uses no TPRM code or tables`);
  }
});

test('the third-party account page lists answered requests and asks before removing someone', async () => {
  await db.prepare(`INSERT INTO tp_client_requests (workspace_id, name, service_description, requested_by, status, decided_by, decided_at, decline_reason)
    VALUES (?, 'Answered Supplier', 'Payroll', ?, 'declined', ?, now(), 'Already covered')`).run(A.id, A.owner.id, consultant.id);
  const s = await signIn(A.owner);
  const page = await s.get(tpAccount(A.id));
  assert.match(page.text, /data-tprm-cv-activity-item="request"/);
  assert.match(page.text, /Your request for Answered Supplier was declined/);
  const other = await s.get(tpAccount(B.id));
  assert.equal(other.status, 403);
  const ask = await s.post(`${tpAccount(A.id)}/team/members/${A.coord.id}/remove`, { _tp_confirm_title: 'Remove?', _tp_confirm_action: 'Remove' });
  assert.equal(ask.status, 200);
  assert.match(ask.text, /Remove\?/);
  assert.equal(await memberRole(A.id, A.coord.id), 'isms_manager');
});

test('the portal account page asks before removing someone, and the question works without JavaScript', async () => {
  const s = await signIn(A.owner);
  const extra = await makeUser('team-iso-confirm@test.local', { workspaceId: A.id, memberRole: 'contributor' });
  const page = await s.get(isoAccount(A.id));
  assert.match(page.text, new RegExp(`data-client-team-remove="${extra.id}"`));
  const ask = await s.post(`${isoAccount(A.id)}/team/members/${extra.id}/remove`, {});
  assert.equal(ask.status, 200);
  assert.match(ask.text, new RegExp(`data-client-team-confirm-remove="${extra.id}"`));
  assert.match(ask.text, /Remove Name team-iso-confirm from your team\?/);
  assert.match(ask.text, new RegExp(`action="${isoAccount(A.id)}/team/members/${extra.id}/remove"`));
  assert.match(ask.text, /name="confirmed" value="1"/);
  assert.match(ask.text, new RegExp(`href="${isoAccount(A.id)}"`));
  assert.equal(await memberRole(A.id, extra.id), 'contributor', 'nothing changes until they confirm');
  const self = await s.post(`${isoAccount(A.id)}/team/members/${A.owner.id}/remove`, {});
  assert.equal(self.status, 302);
  assert.match(said(self), /cannot remove yourself/);
  assert.equal((await s.post(`${isoAccount(A.id)}/team/members/${consultant.id}/remove`, {})).status, 404);
  const done = await s.post(`${isoAccount(A.id)}/team/members/${extra.id}/remove`, { confirmed: '1' });
  assert.equal(done.status, 302);
  assert.match(said(done), /no longer has access/);
  assert.equal(await memberRole(A.id, extra.id), null);
});

test('an invitation email names the client, words the role plainly and dates the expiry in the app style, in both parts', async () => {
  await db.prepare("UPDATE workspaces SET timezone = 'Asia/Kolkata' WHERE id = ?").run(A.id);
  const check = (mail, role) => {
    for (const part of [mail.text, mail.html]) {
      assert.match(part, /Team Client A/, 'the client is named');
      assert.match(part, new RegExp(`as a (<strong>)?${role}`));
      assert.doesNotMatch(part, /Client-side/);
      assert.doesNotMatch(part, /(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/);
      assert.match(part, /expires on (<strong>)?\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/);
    }
    assert.match(mail.text, /You're invited/);
    assert.doesNotMatch(mail.text, /&#39;|&quot;|&amp;|&#\d+;/);
    assert.doesNotMatch(mail.text, /\n[ \t]+\S/, 'no layout indentation in the text part');
    assert.match(mail.subject, /You're invited to join Team Client A/);
  };
  const sent = [];
  await withProvider(200, sent, () => signIn(A.owner).then(s => s.post(`${tpAccount(A.id)}/team/invite`, { email: 'plain-invite@test.local', role: 'isms_manager' })));
  assert.equal(sent.length, 1);
  check(sent[0], 'Client coordinator');

  const firmSent = [];
  await withProvider(200, firmSent, () => client.post(`/workspaces/${A.id}/team/invite-client`, { email: 'plain-sponsor@test.local', name: 'Plain Sponsor', workspace_role: 'client_owner' }));
  assert.equal(firmSent.length, 1);
  check(firmSent[0], 'Client sponsor');
  await db.prepare('UPDATE workspaces SET timezone = NULL WHERE id = ?').run(A.id);
});

test('the plain-text part of any email decodes entities', () => {
  const email = require('../lib/email');
  assert.equal(email.stripHtml('<p>You&#39;re &quot;in&quot; &amp; set &#8217;now&#x2019;</p>\n      <p>  Next  </p>'), 'You\'re "in" & set ’now’\n\nNext');
});

test('third-party risk emails offer a notification switch only where it exists, and the client Account page has it', async () => {
  const email = require('../lib/email');
  for (const kind of Object.keys(email.TPRM_TEMPLATES)) {
    const m = email.renderTprmEmail(kind, { toName: 'Ana', clientName: 'Acme', firmName: 'Firm', thirdPartyName: 'Varma', url: 'https://app.example/x', position: 1, dueDay: '1 Dec 2026', until: '1 Dec 2026', sentDay: '1 Nov 2026', sections: [] });
    assert.doesNotMatch(m.text, /in your profile/, kind);
    if (kind.startsWith('client_')) assert.match(m.text, /turn them off on your Account page in Third-party risk/, kind);
    if (kind.startsWith('consultant_')) assert.match(m.text, /ask your firm administrator/, kind);
  }
  const s = await signIn(A.contributor);
  const page = await s.get(tpAccount(A.id));
  assert.match(page.text, /data-tprm-cv-notify-pref="on"/);
  assert.match(page.text, new RegExp(`action="${tpAccount(A.id)}/email"`));
  assert.match(page.text, /This setting changes only these emails/);
  const before = (await db.prepare('SELECT email_notify FROM users WHERE id = ?').get(A.contributor.id)).email_notify;
  const off = await s.post(`${tpAccount(A.id)}/email`, { value: 'off' });
  assert.equal(off.status, 302);
  assert.ok(off.location.startsWith(tpAccount(A.id)));
  const row = await db.prepare('SELECT email_notify, tprm_email_notify FROM users WHERE id = ?').get(A.contributor.id);
  assert.deepEqual([row.email_notify, row.tprm_email_notify], [before, 'off'], 'only third-party risk emails stop; other emails are untouched');
  assert.match((await s.get(tpAccount(A.id))).text, /data-tprm-cv-notify-pref="off"[\s\S]*?Turn third-party risk emails on/);
  await s.post(`${tpAccount(A.id)}/email`, { value: 'on' });
  assert.equal((await db.prepare('SELECT tprm_email_notify FROM users WHERE id = ?').get(A.contributor.id)).tprm_email_notify, 'on');
});

test('an invitation sent early in the UTC day shows that day as Sent, even on a server east of UTC', async () => {
  const ejs = require('ejs');
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  try {
    const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'tprm_portal_account.ejs'), {
      ws: { id: 1, client_name: 'Sent Day Client' }, user: { id: 9, name: 'Owner', email: 'o@test.local', user_type: 'client' },
      team: { clientPeople: [], consultants: [], invites: [{ id: 4, email: 'rohan@test.local', name: 'Rohan', roleLabel: 'Client coordinator',
        created_at: '2026-11-27 02:37:07', expires_at: '2026-12-04T02:37:07.143Z', expired: false, manageable: true }] },
      isOwner: true, myRole: 'Client sponsor', inviteRoles: [], activity: [], csrfToken: 'x',
      tpf: require('../lib/tprm/format').forZone('UTC'),
    }, { async: true });
    const row = html.slice(html.indexOf('data-tprm-cv-team-invite="4"'));
    assert.match(row, /<td>27 Nov 2026<\/td>/);
    assert.match(row, /Expires 4 Dec 2026/);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('inviting an address with a pending invitation says it replaces it and names the old and new role', async () => {
  const s = await signIn(A.owner);
  await withProvider(200, [], async () => {
    const first = await s.post(`${tpAccount(A.id)}/team/invite`, { email: 'twice@test.local', role: 'isms_manager' });
    assert.doesNotMatch(said(first), /replaces/);
    const again = await s.post(`${tpAccount(A.id)}/team/invite`, { email: 'twice@test.local', role: 'contributor' });
    assert.match(said(again), /It replaces the earlier invitation as Client coordinator, whose link no longer works: they now join as Contributor\./);
    const same = await s.post(`${tpAccount(A.id)}/team/invite`, { email: 'twice@test.local', role: 'contributor' });
    assert.match(said(same), /It replaces the earlier invitation as Contributor, whose link no longer works\./);
  });
});
