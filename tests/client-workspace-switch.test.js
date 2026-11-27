'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

let env;
let client;
let db;
let firmId;
const sessions = [];
const PASSWORD = 'client-switch-password-1234';

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
});

test.after(async () => {
  for (const s of sessions) await s.close();
  if (client) await client.close();
});

async function workspace(name, { iso = false, tprm = false } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome,scope)
    VALUES (?,?,?,'certification_support','Scope text')`).run(firmId, name, JSON.stringify(iso ? ['iso27001'] : []))).lastInsertRowid);
  if (tprm) await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  return id;
}

async function clientUser(email, workspaceIds) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active) VALUES (?,?,?,'client',1)`)
    .run(email, bcrypt.hashSync(PASSWORD, 4), email)).lastInsertRowid);
  for (const ws of workspaceIds) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(ws, id, 'client_owner');
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302);
  sessions.push(session);
  return session;
}

test('a client user in two workspaces can switch between them from both client shells', async () => {
  const tpOnly = await workspace('Switch Harbour TPRM', { tprm: true });
  const iso = await workspace('Switch Atlas ISO', { iso: true });
  const other = await workspace('Switch Hidden Neighbour', { iso: true, tprm: true });
  const session = await clientUser('switch-two@test.local', [tpOnly, iso]);

  const tprmPage = await session.get(`/workspaces/${tpOnly}/client-portal/third-party-risk`);
  assert.equal(tprmPage.status, 200);
  assert.match(tprmPage.text, new RegExp(`href="/workspaces/${iso}/client-portal"[^>]*data-tprm-cv-workspace="${iso}"`));
  assert.doesNotMatch(tprmPage.text, /Switch Hidden Neighbour/);
  assert.doesNotMatch(tprmPage.text, new RegExp(`data-tprm-cv-workspace="${other}"`));

  const portal = await session.get(`/workspaces/${iso}/client-portal`);
  assert.equal(portal.status, 200);
  const list = portal.text.slice(portal.text.indexOf('data-client-workspace-switch'));
  assert.match(list, new RegExp(`href="/workspaces/${tpOnly}/client-portal"`));
  assert.match(list, new RegExp(`data-client-workspace="${iso}"`));
  assert.doesNotMatch(portal.text, /Switch Hidden Neighbour/);

  const followed = await session.get(`/workspaces/${tpOnly}/client-portal`);
  assert.equal(followed.status, 302);
  assert.equal(followed.location, `/workspaces/${tpOnly}/client-portal/third-party-risk`, 'the switch link opens third-party risk for that client');
});

test('a client user in one workspace sees no switcher, and firm staff never do', async () => {
  const only = await workspace('Switch Single Client', { iso: true, tprm: true });
  const session = await clientUser('switch-one@test.local', [only]);
  const portal = await session.get(`/workspaces/${only}/client-portal`);
  assert.equal(portal.status, 200);
  assert.doesNotMatch(portal.text, /data-client-workspace-switch/);
  const tprmPage = await session.get(`/workspaces/${only}/client-portal/third-party-risk`);
  assert.doesNotMatch(tprmPage.text, /data-tprm-cv-workspace=/);

  const preview = await client.get(`/workspaces/${only}/client-portal?preview=client`);
  assert.doesNotMatch(preview.text, /data-client-workspace-switch/);
});
