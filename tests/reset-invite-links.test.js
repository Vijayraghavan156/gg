'use strict';

for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient, openTestDb } = require('./helpers');

let env;
let client;
let db;
let firmId;
let wsId;
const realFetch = globalThis.fetch;

const LINK = /\/(reset|invite)\/[0-9a-f]{64}/;

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
  try { return await fn(); }
  finally {
    process.env.RESEND_API_KEY = '';
    globalThis.fetch = realFetch;
  }
}

const withFailingEmail = (fn) => withProvider(500, [], fn);

async function addUser(email, name, type) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,'x',?,?,?,?,1)`).run(email, name, type, type === 'firm' ? firmId : null, type === 'firm' ? 'consultant' : null)).lastInsertRowid);
  if (type === 'client') await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(wsId, id, 'contributor');
  return id;
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = await openTestDb(env.dbUrl);
  firmId = (await db.prepare("SELECT firm_id FROM users WHERE email='sec-test@example.com'").get()).firm_id;
  wsId = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,'Link Client','["iso27001"]','certification_support')`).run(firmId)).lastInsertRowid);
});

test.after(async () => {
  globalThis.fetch = realFetch;
  if (db) await db.close();
  if (client) await client.close();
});

test('the saved copy of a reset or invite email keeps no working link, while the email itself was sent with one', async () => {
  await addUser('saved-copy-staff@test.local', 'Saved Copy Staff', 'firm');
  const sent = [];
  await withProvider(200, sent, async () => {
    assert.equal((await client.post('/admin/users/send-reset', { email: 'saved-copy-staff@test.local' })).status, 302);
    assert.equal((await client.post('/admin/users/invite', { email: 'saved-copy-new@test.local', name: 'New Person', user_type: 'firm' })).status, 302);
  });
  assert.equal(sent.length, 2);
  assert.match(sent[0].html, /\/reset\/[0-9a-f]{64}/);
  assert.match(sent[1].html, /\/invite\/[0-9a-f]{64}/);
  const rows = await db.prepare(`SELECT related_type, body_html, body_text FROM email_outbox
    WHERE to_email IN ('saved-copy-staff@test.local','saved-copy-new@test.local') ORDER BY id`).all();
  assert.deepEqual(rows.map(r => r.related_type), ['password_reset', 'user_invite']);
  for (const row of rows) {
    assert.doesNotMatch(row.body_html, LINK);
    assert.doesNotMatch(row.body_text, LINK);
    assert.match(row.body_html, /\[link removed\]/);
  }
});

test('when a reset email fails, the owner gets a link to share for their own staff but not for a client account', async () => {
  await addUser('failed-staff@test.local', 'Failed Staff', 'firm');
  await addUser('failed-client@test.local', 'Failed Client', 'client');
  await withFailingEmail(async () => {
    const staff = await client.post('/admin/users/send-reset', { email: 'failed-staff@test.local' });
    assert.equal(staff.status, 302);
    assert.doesNotMatch(staff.location, LINK);
    const staffPage = await client.get(staff.location);
    assert.match(staffPage.text, /aria-label="Single-use link to share"/);
    assert.match(staffPage.text, /\/reset\/[0-9a-f]{64}/);

    const res = await client.post('/admin/users/send-reset', { email: 'failed-client@test.local' });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.location, LINK);
    const clientPage = await client.get(res.location);
    assert.match(clientPage.text, /The reset email did not send/);
    assert.doesNotMatch(clientPage.text, LINK);
    assert.doesNotMatch(clientPage.text, /Single-use link to share/);
  });
});

test('when an invitation email fails, only a new staff member\'s link is offered, and a client invite never puts the link in the address', async () => {
  await withFailingEmail(async () => {
    const staff = await client.post('/admin/users/invite', { email: 'invite-staff@test.local', name: 'Invite Staff', user_type: 'firm' });
    assert.equal(staff.status, 302);
    assert.match((await client.get(staff.location)).text, /\/invite\/[0-9a-f]{64}/);

    const admin = await client.post('/admin/users/invite', { email: 'invite-client@test.local', name: 'Invite Client', user_type: 'client', workspace_id: String(wsId), workspace_role: 'contributor' });
    assert.equal(admin.status, 302);
    assert.doesNotMatch(admin.location, LINK);
    const adminPage = await client.get(admin.location);
    assert.match(adminPage.text, /The invitation email did not send/);
    assert.doesNotMatch(adminPage.text, LINK);

    const team = await client.post(`/workspaces/${wsId}/team/invite-client`, { email: 'team-client@test.local', name: 'Team Client' });
    assert.equal(team.status, 302);
    assert.doesNotMatch(decodeURIComponent(team.location), LINK);
    assert.match(decodeURIComponent(team.location), /The invitation email did not send/);
  });
  assert.equal(Number((await db.prepare(`SELECT COUNT(*) c FROM user_invitations WHERE email IN ('invite-client@test.local','team-client@test.local')`).get()).c), 2);
});
