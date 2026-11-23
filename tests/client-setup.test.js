'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient } = require('./helpers');

let env;
let client;
let db;
let setupLib;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  setupLib = require('../lib/client-setup');
});

test.after(async () => { if (client) await client.close(); });

function created(location) {
  const match = String(location || '').match(/workspaces\/(\d+)/);
  assert.ok(match, `expected a workspace redirect, got ${location}`);
  return Number(match[1]);
}

async function workspace(id) {
  const row = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  row.frameworks = require('../lib/frameworks').parseWorkspaceFrameworks(row.frameworks);
  return row;
}

test('legacy third-party risk fields on the create form are ignored: the client is ISO 27001 only', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Multi Service Client',
    frameworks: ['iso27001'],
    engagement_outcome: 'certification_support',
    tprm_enabled: '1',
    tprm_service_model: 'managed_lifecycle',
  });
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/workspaces\/\d+\/intake(?:\?|$)/,
    'with ISO 27001 as the only service the client goes straight to its intake');

  const id = created(res.location);
  const setup = await setupLib.clientSetup(db, await workspace(id));
  assert.equal(setup.total, 1, 'the removed third-party risk module adds no setup step');
  assert.deepEqual(setup.steps.map(s => s.key), ['iso27001']);
  assert.equal(setup.steps[0].status, 'not_started');
  assert.equal(setup.nextStep.key, 'iso27001');
});

test('a client with no service is rejected; the retired tprm_enabled field does not count as third-party risk', async () => {
  const before = (await db.prepare('SELECT COUNT(*) c FROM workspaces').get()).c;
  const res = await client.post('/workspaces', {
    client_name: 'Third-party Risk Only', tprm_enabled: '1', tprm_service_model: 'assessment_only',
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /Choose at least one service for this client: an ISO programme or third-party risk/);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM workspaces').get()).c, before, 'no workspace is created');
});

test('a single-service client goes straight to its own surface', async () => {
  for (const [name, body, pattern] of [
    ['iso27001', { frameworks: ['iso27001'], engagement_outcome: 'certification_support' }, /\/intake(?:\?|$)/],
  ]) {
    const res = await client.post('/workspaces', { client_name: `Single ${name} Client`, ...body });
    assert.match(res.location, pattern,
      `a ${name}-only client should open its own scoping surface, not a checklist of one`);
  }
});

test('the seeded cert-deadline answer never counts as setup progress', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Seeded Deadline Client',
    frameworks: ['iso27001'],
    engagement_outcome: 'certification_support',
    target_cert_date: '2027-06-30',
  });
  const id = created(res.location);

  const seeded = (await db.prepare(`SELECT COUNT(*) c FROM engagement_intake
    WHERE workspace_id=? AND answer IS NOT NULL AND length(trim(answer))>0`).get(id)).c;
  assert.ok(seeded >= 1, 'this test is meaningless unless the seed still happens');

  const setup = await setupLib.clientSetup(db, await workspace(id));
  assert.equal(setup.steps[0].status, 'not_started',
    'an untouched client must read as not started despite the seeded answer');
  assert.equal(await setupLib.needsSetup(db, await workspace(id)), true);
});

test('a real scope statement is required, not placeholder prose', async () => {
  const res = await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES ((SELECT id FROM firms LIMIT 1),'Placeholder Scope Client',?, 'certification_support')`)
    .run(JSON.stringify(['iso27001']));
  const id = Number(res.lastInsertRowid);

  await db.prepare(`UPDATE workspaces SET scope=?, scope_confirmed_at=utc_now_text() WHERE id=?`)
    .run('The information security management system covers the operations of [org-name - not answered].', id);

  const setup = await setupLib.clientSetup(db, await workspace(id));
  assert.notEqual(setup.steps[0].status, 'complete',
    'placeholder scope prose must never count as a signed-off scope');
});

test('a new ISO client with legacy module fields still needs its programme setup', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Programme Plus TPRM',
    frameworks: ['iso27001'],
    engagement_outcome: 'certification_support',
    tprm_enabled: '1',
    tprm_service_model: 'assessment_only',
  });
  const id = created(res.location);
  const ws = await workspace(id);
  const setup = await setupLib.clientSetup(db, ws);

  assert.equal(setup.steps.find(s => s.key === 'tprm'), undefined, 'no third-party risk module step exists any more');
  assert.equal(await setupLib.needsSetup(db, ws), true);
  assert.equal(setup.nextStep.kind, 'programme');
});

test('the setup hub no longer offers the removed third-party risk module', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'TPRM Added Later', frameworks: ['iso27001'], engagement_outcome: 'certification_support',
  });
  const id = created(res.location);
  const hub = await client.get(`/workspaces/${id}/setup`);
  assert.equal(hub.status, 200);
  assert.doesNotMatch(hub.text, new RegExp(`action="/workspaces/${id}/modules/tprm"`),
    'the setup hub must not host the retired TPRM service-model form');
  assert.equal((await client.post(`/workspaces/${id}/modules/tprm`, { service_model: 'assessment_only' })).status, 404);
});

test('a legacy TPRM-only workspace (no frameworks) still opens as a client with no programme', async () => {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome,lead_consultant_id)
    VALUES ((SELECT id FROM firms ORDER BY id LIMIT 1),'Legacy TPRM Only','[]','certification_support',
      (SELECT id FROM users WHERE email=?))`).run(env.login.email)).lastInsertRowid);

  const open = await client.get(`/workspaces/${id}`);
  assert.equal(open.status, 200, `expected the workspace to render, got ${open.status} ${open.location || ''}`);
  assert.match(open.text, /No programme|programme/i, 'the no-programme page renders');
  assert.doesNotMatch(open.text, new RegExp(`href="/workspaces/${id}/tprm`), 'no link to the removed workspace TPRM module');

  const setup = await client.get(`/workspaces/${id}/setup`);
  assert.equal(setup.status, 200, `expected the setup page to render, got ${setup.status} ${setup.location || ''}`);
});

test('the third-party risk menu entry opens the firm-level TPRM area for firm users only', async () => {
  const firm = await client.get('/tprm');
  assert.equal(firm.status, 200);
  assert.match(firm.text, /data-tprm-area/);
  assert.doesNotMatch(firm.text, /coming soon/i, 'the Phase 1 coming-soon page is gone');

  const bcrypt = require('bcrypt');
  const { makeClient } = require('./helpers');
  const password = 'Coming-soon-client-password-1234';
  const wsId = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES ((SELECT id FROM firms ORDER BY id LIMIT 1),'Coming Soon Portal Client',?,'certification_support')`)
    .run(JSON.stringify(['iso27001']))).lastInsertRowid);
  const userId = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active)
    VALUES ('coming-soon-client@test.local',?,'Portal Client','client',1)`).run(bcrypt.hashSync(password, 4))).lastInsertRowid);
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(wsId, userId, 'client_owner');

  const portal = makeClient(env.app);
  const page = await portal.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const signedIn = await portal.post('/login', { email: 'coming-soon-client@test.local', password, _csrf: csrf }, { csrf: false });
  assert.equal(signedIn.status, 302);
  const denied = await portal.get('/tprm');
  assert.equal(denied.status, 403);
  await portal.close();
});
