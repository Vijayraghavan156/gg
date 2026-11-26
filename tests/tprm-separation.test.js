'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

let env;
let client;
let db;
let firmId;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
});

test.after(async () => { if (client) await client.close(); });

function createdId(location, pattern = /(?:workspaces|tprm\/clients)\/(\d+)/) {
  const match = String(location || '').match(pattern);
  assert.ok(match, `expected a client redirect, got ${location}`);
  return Number(match[1]);
}

async function tpEnabled(id) {
  const row = await db.prepare('SELECT enabled FROM tp_client_settings WHERE workspace_id=?').get(id);
  return !!(row && row.enabled);
}

async function insertWorkspace(name, { firm = firmId, frameworks = [], tprm = false } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,?,'certification_support')`).run(firm, name, JSON.stringify(frameworks))).lastInsertRowid);
  if (tprm) await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  return id;
}

async function signIn(email, password) {
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${email} signs in`);
  await session.get('/dashboard');
  return session;
}

async function firmUser(email, role, firm = firmId) {
  const password = `${role}-password-for-tests-1234`;
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,?,1)`).run(email, bcrypt.hashSync(password, 4), email, firm, role)).lastInsertRowid);
  return { id, email, password };
}

async function clientUser(email, workspaceId, role = 'client_owner') {
  const password = 'client-password-for-tests-1234';
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active)
    VALUES (?,?,?,'client',1)`).run(email, bcrypt.hashSync(password, 4), email)).lastInsertRowid);
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, role);
  return { id, email, password };
}

function section(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return '';
  const next = marker === 'data-tprm-client-list' ? html.indexOf('data-tprm-available', start) : -1;
  return html.slice(start, next === -1 ? undefined : next);
}

test('the create forms offer Third-party risk alongside the ISO programmes', async () => {
  const page = await client.get('/workspaces/new');
  assert.equal(page.status, 200);
  assert.match(page.text, /name="frameworks" value="iso27001"/);
  assert.match(page.text, /name="tp_enabled" value="1"/);
  assert.match(page.text, /Third-party risk/);
  const dashboard = await client.get('/dashboard');
  assert.match(dashboard.text, /id="dashboard-tp-service" type="checkbox" name="tp_enabled" value="1"/);
});

test('a TPRM-only client is created and opens cleanly', async () => {
  const res = await client.post('/workspaces', { client_name: 'TPRM Only Client', industry: 'Banking', tp_enabled: '1' });
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/tprm\/clients\/\d+\?/, 'a TPRM-only client opens on its TPRM home');
  const id = createdId(res.location);
  const ws = await db.prepare('SELECT frameworks, firm_id FROM workspaces WHERE id=?').get(id);
  assert.deepEqual(JSON.parse(ws.frameworks), [], 'no ISO programme is assigned');
  assert.equal(await tpEnabled(id), true);
  const audit = await db.prepare(`SELECT details FROM audit_log WHERE action='create_workspace' AND entity_id=?`).get(String(id));
  assert.equal(JSON.parse(audit.details).third_party_risk, true);

  const home = await client.get(res.location);
  assert.equal(home.status, 200);
  assert.match(home.text, new RegExp(`data-tprm-client-home="${id}"`));
  assert.match(home.text, /data-tprm-register-empty/, 'the TPRM home is the client\'s (empty) third-party register');
  assert.match(home.text, /TPRM Only Client/);
  assert.doesNotMatch(home.text, new RegExp(`href="/workspaces/${id}/(controls|soa|readiness|risks)"`),
    'the TPRM home does not render the ISO workspace sidebar');

  const overview = await client.get(`/workspaces/${id}`);
  assert.equal(overview.status, 200, 'the client opens without an ISO programme');
  assert.doesNotMatch(overview.text, /data-tp-service-on|name="tp_enabled"|name="tp_present"/,
    'the ISO overview neither reads nor offers the TPRM switch');

  const dashboard = await client.get('/dashboard');
  assert.match(dashboard.text, new RegExp(`data-client-home="/tprm/clients/${id}"`), 'the Clients dashboard opens a TPRM-only client on its TPRM home');
});

test('a client with both services goes to its ISO scoping and has TPRM switched on', async () => {
  const res = await client.post('/workspaces', {
    client_name: 'Both Services Client', frameworks: ['iso27001'], engagement_outcome: 'certification_support', tp_enabled: '1',
  });
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/workspaces\/\d+\/intake(?:\?|$)/);
  assert.equal(await tpEnabled(createdId(res.location)), true);
});

test('at least one service is required on create; ISO settings never switch TPRM', async () => {
  const before = (await db.prepare('SELECT COUNT(*) c FROM workspaces').get()).c;
  const none = await client.post('/workspaces', { client_name: 'No Service Client' });
  assert.equal(none.status, 400);
  assert.match(none.text, /Choose at least one service/);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM workspaces').get()).c, before);

  const created = await client.post('/workspaces', { client_name: 'TPRM Only Edit Client', tp_enabled: '1' });
  const id = createdId(created.location);
  const empty = await client.post(`/workspaces/${id}/frameworks`, { tp_present: '1' });
  assert.equal(empty.status, 400, 'saving no ISO programme on the programme form is refused');
  assert.match(empty.text, /Choose an ISO programme to enable/);
  assert.equal(await tpEnabled(id), true, 'and TPRM is untouched');

  const addIso = await client.post(`/workspaces/${id}/frameworks`, {
    frameworks: 'iso27001', engagement_outcome: 'gap_assessment_only', tp_present: '1',
  });
  assert.equal(addIso.status, 302);
  assert.deepEqual(JSON.parse((await db.prepare('SELECT frameworks FROM workspaces WHERE id=?').get(id)).frameworks), ['iso27001']);
  assert.equal(await tpEnabled(id), true, 'an unticked TPRM field on the programme form no longer switches it off');

  const settings = await client.get(`/workspaces/${id}?skipSetupRedirect=1`);
  assert.equal(settings.status, 200);
  assert.doesNotMatch(settings.text, /workspace-tp-service|name="tp_enabled"|name="tp_present"/,
    'the ISO workspace settings form has no TPRM switch');
  const update = await client.post(`/workspaces/${id}/update`, {
    client_name: 'TPRM Only Edit Client', engagement_outcome: 'gap_assessment_only',
    frameworks_present: '1', frameworks: 'iso27001', tp_present: '1',
  });
  assert.equal(update.status, 302);
  assert.equal(await tpEnabled(id), true, 'a forged tp_present on the ISO settings form is ignored');

  const isoOnly = await insertWorkspace('ISO Settings Never Enable Client', { frameworks: ['iso27001'] });
  const forged = await client.post(`/workspaces/${isoOnly}/update`, {
    client_name: 'ISO Settings Never Enable Client', engagement_outcome: 'certification_support',
    frameworks_present: '1', frameworks: 'iso27001', tp_present: '1', tp_enabled: '1',
  });
  assert.equal(forged.status, 302);
  assert.equal(await tpEnabled(isoOnly), false, 'nor can the ISO settings form switch TPRM on');
});

test('/tprm lists only the firm\'s TPRM clients and switches TPRM on for an existing client', async () => {
  const isoOnly = await insertWorkspace('Listed ISO Only Client', { frameworks: ['iso27001'] });
  const tprm = await insertWorkspace('Listed TPRM Client', { tprm: true });
  const otherFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Other TPRM Firm')").run()).lastInsertRowid);
  const foreign = await insertWorkspace('Foreign TPRM Client', { firm: otherFirm, tprm: true });

  const page = await client.get('/tprm');
  assert.equal(page.status, 200);
  const listed = section(page.text, 'data-tprm-client-list');
  assert.match(listed, new RegExp(`href="/tprm/clients/${tprm}"`));
  assert.doesNotMatch(listed, new RegExp(`href="/tprm/clients/${isoOnly}"`), 'an ISO-only client is not a TPRM client');
  assert.doesNotMatch(page.text, /Foreign TPRM Client/, 'another firm\'s client is never listed');
  assert.match(section(page.text, 'data-tprm-available'), new RegExp(`action="/tprm/clients/${isoOnly}/enable"`));

  assert.equal((await client.get(`/tprm/clients/${foreign}`)).status, 404, 'another firm\'s TPRM client is a 404');
  assert.equal((await client.post(`/tprm/clients/${foreign}/enable`, {})).status, 404);
  assert.equal((await client.get(`/tprm/clients/${isoOnly}`)).status, 404, 'a client without TPRM has no TPRM home');
  assert.equal((await client.get('/tprm/clients/not-a-number')).status, 404);
  assert.equal((await client.get('/tprm/clients/999999999')).status, 404);

  const enable = await client.post(`/tprm/clients/${isoOnly}/enable`, {});
  assert.equal(enable.status, 302);
  assert.match(enable.location, new RegExp(`^/tprm/clients/${isoOnly}\\?`));
  assert.equal(await tpEnabled(isoOnly), true);
  assert.ok(await db.prepare(`SELECT 1 FROM audit_log WHERE action='tprm_service_enabled' AND workspace_id=?`).get(isoOnly));
  assert.equal((await client.get(`/tprm/clients/${isoOnly}`)).status, 200);
});

test('a consultant sees only the TPRM clients they are a member of; other workspaces are a 404', async () => {
  const mine = await insertWorkspace('Consultant Member TPRM Client', { tprm: true });
  const notMine = await insertWorkspace('Consultant Non-member TPRM Client', { tprm: true });
  const consultant = await firmUser('tprm-consultant@test.local', 'consultant');
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(mine, consultant.id, 'consultant');

  const session = await signIn(consultant.email, consultant.password);
  try {
    const page = await session.get('/tprm');
    assert.equal(page.status, 200, 'tp.view is held by every firm role');
    assert.match(page.text, /Consultant Member TPRM Client/);
    assert.doesNotMatch(page.text, /Consultant Non-member TPRM Client/);
    assert.equal((await session.get(`/tprm/clients/${mine}`)).status, 200);
    assert.equal((await session.get(`/tprm/clients/${notMine}`)).status, 404);
    assert.equal((await session.post(`/tprm/clients/${notMine}/enable`, {})).status, 404);
  } finally {
    await session.close();
  }
});

test('the client portal shows a TPRM entry only for clients with TPRM switched on', async () => {
  const tprmClient = await insertWorkspace('Portal TPRM Client', { frameworks: ['iso27001'], tprm: true });
  const isoClient = await insertWorkspace('Portal ISO Client', { frameworks: ['iso27001'] });
  const tprmOnly = await insertWorkspace('Portal TPRM Only Client', { tprm: true });
  const owner = await clientUser('tprm-portal-owner@test.local', tprmClient);
  const isoOwner = await clientUser('iso-portal-owner@test.local', isoClient);
  const contributor = await clientUser('tprm-only-contributor@test.local', tprmOnly, 'contributor');

  const entry = id => new RegExp(`href="/workspaces/${id}/client-portal/third-party-risk"`);

  const withTprm = await signIn(owner.email, owner.password);
  try {
    const portal = await withTprm.get(`/workspaces/${tprmClient}/client-portal`);
    assert.equal(portal.status, 200);
    assert.match(portal.text, entry(tprmClient));
    const page = await withTprm.get(`/workspaces/${tprmClient}/client-portal/third-party-risk`);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-tprm-portal-home/);
    assert.match(page.text, entry(tprmClient), 'the entry stays in the portal navigation');
    assert.equal((await withTprm.get(`/workspaces/${isoClient}/client-portal/third-party-risk`)).status, 403,
      'another client workspace is outside this user\'s portal');
    assert.equal((await withTprm.get('/tprm')).status, 403, 'the firm TPRM area is not for client users');
    assert.equal((await withTprm.get(`/tprm/clients/${tprmClient}`)).status, 404);
  } finally {
    await withTprm.close();
  }

  const withoutTprm = await signIn(isoOwner.email, isoOwner.password);
  try {
    const portal = await withoutTprm.get(`/workspaces/${isoClient}/client-portal`);
    assert.equal(portal.status, 200);
    assert.doesNotMatch(portal.text, /client-portal\/third-party-risk/, 'no TPRM entry without TPRM');
    assert.equal((await withoutTprm.get(`/workspaces/${isoClient}/client-portal/third-party-risk`)).status, 404);
  } finally {
    await withoutTprm.close();
  }

  const onlyTprm = await signIn(contributor.email, contributor.password);
  try {
    const portal = await onlyTprm.get(`/workspaces/${tprmOnly}/client-portal`);
    assert.equal(portal.status, 302, 'a TPRM-only client\'s portal opens on Third-party risk');
    assert.equal(portal.location, `/workspaces/${tprmOnly}/client-portal/third-party-risk`);
    assert.equal((await onlyTprm.get(`/workspaces/${tprmOnly}/client-portal/third-party-risk`)).status, 200);
  } finally {
    await onlyTprm.close();
  }

  const firmView = await client.get(`/workspaces/${tprmClient}/client-portal/third-party-risk`);
  assert.equal(firmView.status, 404, 'the portal TPRM page is for client users');
});

test('the new TPRM forms are CSRF-protected', async () => {
  const target = await insertWorkspace('CSRF ISO Client', { frameworks: ['iso27001'] });
  const enable = await client.post(`/tprm/clients/${target}/enable`, {}, { csrf: false });
  assert.equal(enable.status, 403);
  assert.match(enable.text, /CSRF token missing or invalid/);
  assert.equal(await tpEnabled(target), false);

  const forged = await client.post(`/tprm/clients/${target}/enable`, { _csrf: 'f'.repeat(64) }, { csrf: false });
  assert.equal(forged.status, 403);
  assert.equal(await tpEnabled(target), false);

  const before = (await db.prepare('SELECT COUNT(*) c FROM workspaces').get()).c;
  const create = await client.post('/workspaces', { client_name: 'CSRF TPRM Client', tp_enabled: '1' }, { csrf: false });
  assert.equal(create.status, 403);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM workspaces').get()).c, before);

  const page = await client.get('/tprm');
  assert.match(section(page.text, 'data-tprm-available'), /name="_csrf" value="[a-f0-9]+"/, 'the switch-on form carries the token');
});

test('only a manager switches TPRM on or off; senior consultants and consultants cannot', async () => {
  const target = await insertWorkspace('Switch Permission ISO Client', { frameworks: ['iso27001'] });
  const tprm = await insertWorkspace('Switch Permission TPRM Client', { tprm: true });
  const senior = await firmUser('tprm-switch-senior@test.local', 'senior_consultant');
  const consultant = await firmUser('tprm-switch-consultant@test.local', 'consultant');
  for (const id of [target, tprm]) {
    await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, consultant.id, 'consultant');
  }
  for (const user of [senior, consultant]) {
    const session = await signIn(user.email, user.password);
    try {
      const page = await session.get('/tprm');
      assert.equal(page.status, 200);
      assert.equal(section(page.text, 'data-tprm-available'), '', `${user.email} is not offered the switch-on list`);
      const on = await session.post(`/tprm/clients/${target}/enable`, {});
      assert.equal(on.status, 403, `${user.email} cannot switch TPRM on`);
      assert.match(on.text, /Only a manager can switch third-party risk on or off/);
      const off = await session.post(`/tprm/clients/${tprm}/disable`, {});
      assert.equal(off.status, 403, `${user.email} cannot switch TPRM off`);
    } finally {
      await session.close();
    }
  }
  assert.equal(await tpEnabled(target), false);
  assert.equal(await tpEnabled(tprm), true);

  const enable = await client.post(`/tprm/clients/${target}/enable`, {});
  assert.equal(enable.status, 302, 'a manager switches it on');
  assert.equal(await tpEnabled(target), true);
});

test('switching TPRM off is refused while the client has any third party, exited ones included', async () => {
  const ws = await insertWorkspace('Switch Off TPRM Client', { frameworks: ['iso27001'], tprm: true });
  const settings = await client.get(`/tprm/clients/${ws}/settings`);
  assert.equal(settings.status, 200);
  assert.match(settings.text, new RegExp(`action="/tprm/clients/${ws}/disable"`), 'the switch-off lives on the client TPRM settings page');

  await db.prepare(`INSERT INTO tp_third_parties (workspace_id, name, status) VALUES (?, 'Exited Supplier', 'exited')`).run(ws);
  const blockedPage = await client.get(`/tprm/clients/${ws}/settings`);
  assert.match(blockedPage.text, /data-tprm-switch-off-blocked/);
  assert.doesNotMatch(blockedPage.text, new RegExp(`action="/tprm/clients/${ws}/disable"`));
  const refused = await client.post(`/tprm/clients/${ws}/disable`, {});
  assert.equal(refused.status, 302);
  assert.match(decodeURIComponent(refused.location), /cannot be switched off for this client: it has 1 third party recorded \(exited ones included\)/);
  assert.equal(await tpEnabled(ws), true, 'nothing changed');
  assert.equal(await db.prepare(`SELECT 1 FROM audit_log WHERE action='tprm_service_disabled' AND workspace_id=?`).get(ws), undefined);

  const empty = await insertWorkspace('Switch Off Empty TPRM Client', { frameworks: ['iso27001'], tprm: true });
  const off = await client.post(`/tprm/clients/${empty}/disable`, {});
  assert.equal(off.status, 302);
  assert.match(off.location, /^\/tprm\?/);
  assert.equal(await tpEnabled(empty), false);
  assert.ok(await db.prepare(`SELECT 1 FROM audit_log WHERE action='tprm_service_disabled' AND workspace_id=?`).get(empty));
  assert.equal((await client.get(`/tprm/clients/${empty}`)).status, 404, 'the client leaves the TPRM area');

  const csrf = await client.post(`/tprm/clients/${ws}/disable`, {}, { csrf: false });
  assert.equal(csrf.status, 403, 'the switch-off form is CSRF-protected');
});

test('consultants see the firm Third-party risk menu only when assigned to a TPRM client', async () => {
  const isoClient = await insertWorkspace('Menu ISO Client', { frameworks: ['iso27001'] });
  const tprmClient = await insertWorkspace('Menu TPRM Client', { frameworks: ['iso27001'], tprm: true });
  const consultant = await firmUser('tprm-menu-consultant@test.local', 'consultant');
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(isoClient, consultant.id, 'consultant');
  const menu = /<a href="\/tprm" class="nav-item/;

  let session = await signIn(consultant.email, consultant.password);
  try {
    assert.doesNotMatch((await session.get('/dashboard')).text, menu, 'no TPRM client assigned: no menu entry');
  } finally {
    await session.close();
  }
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(tprmClient, consultant.id, 'consultant');
  session = await signIn(consultant.email, consultant.password);
  try {
    assert.match((await session.get('/dashboard')).text, menu, 'assigned to a TPRM client: the menu entry appears');
  } finally {
    await session.close();
  }

  const senior = await firmUser('tprm-menu-senior@test.local', 'senior_consultant');
  session = await signIn(senior.email, senior.password);
  try {
    assert.match((await session.get('/dashboard')).text, menu, 'senior consultants keep the entry');
  } finally {
    await session.close();
  }
  assert.match((await client.get('/dashboard')).text, menu, 'managers keep the entry');
});

test('the Clients dashboard opens a client with an ISO programme on its workspace, TPRM or not', async () => {
  const both = await insertWorkspace('Dashboard Both Services Client', { frameworks: ['iso27001'], tprm: true });
  const unassigned = await insertWorkspace('Dashboard Unassigned Client');
  const page = await client.get('/dashboard');
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-client-home="/workspaces/${both}"`));
  assert.match(page.text, new RegExp(`data-client-home="/workspaces/${unassigned}"`), 'a client with no service at all keeps its workspace link');
});

test('the client decision is for the client owner or ISMS manager, never a contributor', () => {
  const rbac = require('../lib/rbac');
  assert.ok(rbac.rolePermissions('client_owner').includes('tp.client_decide'));
  assert.ok(rbac.rolePermissions('isms_manager').includes('tp.client_decide'));
  assert.ok(!rbac.rolePermissions('contributor').includes('tp.client_decide'), 'contributors cannot record the decision');
  assert.ok(rbac.rolePermissions('contributor').includes('tp.client_view'), 'they can still view the portal pages');
  for (const firmRole of ['manager', 'senior_consultant', 'consultant']) {
    const access = require('../lib/tprm/access');
    assert.equal(access.can({ user_type: 'firm', firm_role: firmRole }, new Set(rbac.rolePermissions(firmRole)), 'tp.client_decide'), false,
      `${firmRole} never holds the client decision`);
  }
});
