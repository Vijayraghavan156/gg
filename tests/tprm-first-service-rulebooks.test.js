'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'first-service-tests-password-1234';
const LOW = {
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no', supplies_software: 'no',
};

let env;
let client;
let db;
let firmId;
let events;
let register;
let RB;
let consultant;
let senior;

async function makeUser(email, role) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, firmId, role)).lastInsertRowid);
  return { id, email, role };
}

async function signIn(email) {
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${email} signs in`);
  await session.get('/dashboard');
  return session;
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  events = require('../lib/tprm/events');
  register = require('../lib/tprm/register');
  RB = require('../lib/tprm/rulebooks');
  firmId = Number((await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id);
  consultant = await makeUser('first-service-consultant@test.local', 'consultant');
  senior = await makeUser('first-service-senior@test.local', 'senior_consultant');
  for (const u of [consultant, senior]) u.session = await signIn(u.email);
});

test.after(async () => {
  for (const u of [consultant, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

async function tprmClient(name, { enabled = true } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  if (enabled) await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.role);
  return id;
}

const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const tpId = location => Number((String(location).match(/third-parties\/(\d+)/) || [])[1]);
const count = async (sql, ...args) => (await db.prepare(sql).get(...args)).c;
const chain = async (ws, id) => db.prepare(`SELECT action, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='third_party' AND chain_id=? ORDER BY chain_seq`).all(ws, id);
const servicesOf = async (ws, id) => db.prepare(`SELECT *, contract_start::text AS cs, contract_end::text AS ce FROM tp_services
  WHERE workspace_id=? AND third_party_id=? ORDER BY id`).all(ws, id);
const nothingSaved = async ws => {
  assert.equal(await count('SELECT COUNT(*)::integer c FROM tp_third_parties WHERE workspace_id=?', ws), 0, 'no third party');
  assert.equal(await count('SELECT COUNT(*)::integer c FROM tp_services WHERE workspace_id=?', ws), 0, 'no service');
  assert.equal(await count('SELECT COUNT(*)::integer c FROM tp_events WHERE workspace_id=?', ws), 0, 'no event');
};

const FIRST = {
  first_service: '1', description: 'Core banking platform, hosted', data_access: 'Customer account data',
  hosting_countries: 'India', contract_start: '2025-04-01', contract_end: '2028-03-31', notice_period_days: '180',
  annual_spend: '2,50,000', sole_source: '1',
};

test('the Add form asks what they provide; the Edit form does not', async () => {
  const ws = await tprmClient('First Service Form Client');
  const form = await client.get(`/tprm/clients/${ws}/third-parties/new`);
  assert.equal(form.status, 200);
  assert.match(form.text, /data-tprm-third-party-form/);
  assert.match(form.text, /data-tprm-first-service/);
  assert.match(form.text, /What do they provide for this client\?/);
  assert.match(form.text, /name="first_service" value="1"/);
  assert.match(form.text, /<textarea[^>]*id="svc-desc" name="description"[^>]*required/, 'the description is required');
  for (const field of ['data_access', 'hosting_countries', 'annual_spend', 'contract_start', 'contract_end', 'notice_period_days', 'sole_source']) {
    assert.match(form.text, new RegExp(`name="${field}"`), field);
  }
  const created = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'Edit Form Co', status: 'proposed' });
  const edit = await client.get(`/tprm/clients/${ws}/third-parties/${tpId(created.location)}/edit`);
  assert.equal(edit.status, 200);
  assert.doesNotMatch(edit.text, /data-tprm-first-service|name="first_service"|What do they provide/);
});

test('one step: the third party and its first service are created together, each with its event', async () => {
  const ws = await tprmClient('First Service Create Client');
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'Core Bank Tech', status: 'proposed', category: 'Core banking', ...FIRST });
  assert.equal(res.status, 302);
  assert.match(toast(res), /Third party and its first service added/);
  const id = tpId(res.location);
  const services = await servicesOf(ws, id);
  assert.equal(services.length, 1);
  const s = services[0];
  assert.equal(s.description, 'Core banking platform, hosted');
  assert.equal(s.data_access, 'Customer account data');
  assert.equal(s.hosting_countries, 'India');
  assert.equal(s.cs, '2025-04-01');
  assert.equal(s.ce, '2028-03-31');
  assert.equal(s.notice_period_days, 180);
  assert.equal(s.annual_spend, 250000);
  assert.equal(s.sole_source, true);
  assert.equal(Number(s.created_by), Number((await db.prepare('SELECT created_by FROM tp_third_parties WHERE id=?').get(id)).created_by));

  const history = await chain(ws, id);
  assert.deepEqual(history.map(e => e.action), ['third_party.created', 'service.added']);
  assert.equal(history[0].after_state.name, 'Core Bank Tech');
  assert.equal(Number(history[1].after_state.service_id), Number(s.id));
  assert.equal(history[1].after_state.description, 'Core banking platform, hosted');
  assert.deepEqual(await events.verifyChains(db, ws), []);

  const page = await client.get(`/tprm/clients/${ws}/third-parties/${id}`);
  assert.match(page.text, new RegExp(`data-tprm-service="${s.id}"`));
  assert.match(page.text, /Add another service/);
  assert.doesNotMatch(page.text, /data-tprm-services-empty/);

  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${id}/assessments`, {});
  assert.equal(started.status, 302, toast(started));
  const aid = Number((started.location.match(/assessments\/(\d+)/) || [])[1]);
  const scope = await consultant.session.get(`/tprm/clients/${ws}/third-parties/${id}/assessments/${aid}`);
  assert.match(scope.text, /Core banking platform, hosted/);
});

test('one step: validation errors re-show the form with both parts filled in, and nothing is saved', async () => {
  const ws = await tprmClient('First Service Validation Client');
  const noService = await client.post(`/tprm/clients/${ws}/third-parties`, {
    name: 'Half Filled Ltd', status: 'in_use', category: 'Payroll', ...FIRST, description: '  ',
  });
  assert.equal(noService.status, 400);
  assert.match(noService.text, /data-tprm-form-errors/);
  assert.match(noService.text, /Service description is required/);
  assert.match(noService.text, /name="name" required maxlength="200" value="Half Filled Ltd"/, 'the third party part is kept');
  assert.match(noService.text, /value="Payroll"/);
  assert.match(noService.text, /name="data_access"[^>]*value="Customer account data"/, 'the service part is kept');
  assert.match(noService.text, /name="hosting_countries"[^>]*value="India"/);
  assert.match(noService.text, /name="contract_end"[^>]*value="2028-03-31"/);
  assert.match(noService.text, /name="sole_source" value="1"\s+checked/);
  assert.match(noService.text, /name="first_service" value="1"/, 'the re-shown form is still the one-step form');

  const both = await client.post(`/tprm/clients/${ws}/third-parties`, {
    name: '', status: 'in_use', ...FIRST, description: 'Payroll run', contract_start: '2026-05-01', contract_end: '2026-01-01', notice_period_days: 'soon',
  });
  assert.equal(both.status, 400);
  assert.match(both.text, /Name is required/);
  assert.match(both.text, /Contract end cannot be before contract start/);
  assert.match(both.text, /Notice period must be a whole number of days/);
  assert.match(both.text, />Payroll run<\/textarea>/, 'the description is kept');
  await nothingSaved(ws);
});

test('one step: a duplicate name keeps the service part; "Save anyway" creates both', async () => {
  const ws = await tprmClient('First Service Duplicate Client');
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'Twin Ltd', status: 'proposed' })).status, 302);
  const body = { name: 'twin ltd', status: 'proposed', ...FIRST, description: 'Second twin service' };
  const warn = await client.post(`/tprm/clients/${ws}/third-parties`, body);
  assert.equal(warn.status, 200);
  assert.match(warn.text, /data-tprm-duplicate-warning/);
  assert.match(warn.text, />Second twin service<\/textarea>/);
  assert.match(warn.text, /name="first_service" value="1"/);
  assert.equal(await count('SELECT COUNT(*)::integer c FROM tp_services WHERE workspace_id=?', ws), 0);
  const saved = await client.post(`/tprm/clients/${ws}/third-parties`, { ...body, confirm_duplicate: '1' });
  assert.equal(saved.status, 302);
  assert.match(toast(saved), /Third party and its first service added\. Another third party has the same name/);
  assert.deepEqual((await servicesOf(ws, tpId(saved.location))).map(s => s.description), ['Second twin service']);
});

async function managerActor(ws, permissions = require('../lib/rbac').rolePermissions('manager')) {
  return {
    user: await db.prepare('SELECT * FROM users WHERE email=?').get(env.login.email),
    perms: new Set(permissions),
    ws: await db.prepare('SELECT * FROM workspaces WHERE id=?').get(ws),
  };
}

test('one step: a failure while writing the service creates neither the third party nor the service', async () => {
  const ws = await tprmClient('First Service Atomic Client');
  const original = events.appendEvent;
  events.appendEvent = async (dbx, ev) => {
    if (ev.action === 'service.added') throw new Error('simulated failure after the third party was written');
    return original(dbx, ev);
  };
  try {
    const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'Never Half Made', status: 'proposed', ...FIRST });
    assert.equal(res.status, 500);
    await assert.rejects(register.createThirdParty(db, await managerActor(ws),
      { name: 'Never Half Made Either', status: 'proposed' }, { firstService: { description: 'Hosted' } }), /simulated failure/);
  } finally {
    events.appendEvent = original;
  }
  await nothingSaved(ws);
  const ok = await register.createThirdParty(db, await managerActor(ws), { name: 'Made Whole', status: 'proposed' }, { firstService: { description: 'Hosted' } });
  assert.equal(ok.service.description, 'Hosted');
  assert.equal(Number(ok.service.third_party_id), Number(ok.thirdParty.id));
});

test('the one-step create keeps the permission checks', async () => {
  const ws = await tprmClient('First Service Permission Client');
  const viewOnly = await managerActor(ws, ['tp.view']);
  await assert.rejects(register.createThirdParty(db, viewOnly, { name: 'No Rights Co', status: 'proposed' }, { firstService: { description: 'Hosted' } }),
    err => err.status === 403);
  const clientUser = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,active)
    VALUES ('first-service-client@test.local',?,'Client','client',1)`).run(bcrypt.hashSync(PASSWORD, 4))).lastInsertRowid);
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(ws, clientUser, 'client_owner');
  const session = await signIn('first-service-client@test.local');
  try {
    for (const res of [await session.get(`/tprm/clients/${ws}/third-parties/new`),
      await session.post(`/tprm/clients/${ws}/third-parties`, { name: 'Client Made', status: 'proposed', ...FIRST })]) {
      assert.ok([302, 403, 404].includes(res.status), `a client user is refused (${res.status})`);
    }
  } finally { await session.close(); }
  await nothingSaved(ws);
});

test('two steps still work: a third party without a service, then services on the Services tab', async () => {
  const ws = await tprmClient('Two Step Client');
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'Later Service Co', status: 'in_use' });
  assert.equal(res.status, 302, 'a post without the first-service part creates the third party only');
  assert.match(toast(res), /Third party added$/);
  const id = tpId(res.location);
  assert.equal((await servicesOf(ws, id)).length, 0);
  let page = await client.get(`/tprm/clients/${ws}/third-parties/${id}`);
  assert.match(page.text, /data-tprm-services-empty/);
  assert.match(page.text, /data-tprm-add-service/);
  assert.match(page.text, /<summary class="tprm-summary">Add a service<\/summary>/);

  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${id}/services`, { description: 'Desk support' })).status, 302);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${id}/services`, { description: 'Laptop leasing' })).status, 302);
  page = await client.get(`/tprm/clients/${ws}/third-parties/${id}`);
  assert.match(page.text, /<summary class="tprm-summary">Add another service<\/summary>/);
  assert.deepEqual((await servicesOf(ws, id)).map(s => s.description), ['Desk support', 'Laptop leasing']);

  const edited = await client.post(`/tprm/clients/${ws}/third-parties/${id}`, {
    name: 'Later Service Co', status: 'in_use', category: 'IT', row_version: '1', first_service: '1', description: 'Ignored',
  });
  assert.equal(edited.status, 302);
  assert.match(toast(edited), /Third party updated/);
  assert.deepEqual((await servicesOf(ws, id)).map(s => s.description), ['Desk support', 'Laptop leasing']);
  assert.deepEqual((await chain(ws, id)).map(e => e.action), ['third_party.created', 'service.added', 'service.added', 'third_party.updated']);

  const one = tpId((await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'One Step Co', status: 'proposed', ...FIRST })).location);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${one}/services`, { description: 'Second service' })).status, 302);
  assert.deepEqual((await servicesOf(ws, one)).map(s => s.description), ['Core banking platform, hosted', 'Second service']);
});

function multipart(token, filename, content) {
  const boundary = '----tprmfs' + crypto.randomBytes(8).toString('hex');
  const parts = [`--${boundary}`, 'Content-Disposition: form-data; name="_csrf"', '', token,
    `--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${filename}"`, 'Content-Type: text/csv', '', content,
    `--${boundary}--`, ''];
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function previewCsv(ws, content) {
  await client.get(`/tprm/clients/${ws}/import`);
  const form = multipart(client.getCsrfToken(), 'with-services.csv', content);
  return await client.post(`/tprm/clients/${ws}/import/preview`, form.body, { headers: form.headers, csrf: false });
}

const unescape = s => s.replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('CSV import: an optional service_description column creates each row\'s first service in the same commit', async () => {
  const ws = await tprmClient('Import Services Client');
  const upload = await client.get(`/tprm/clients/${ws}/import`);
  assert.match(upload.text, />service_description</);
  assert.match(upload.text, /data-tprm-import-service-hint/);
  const template = await client.get(`/tprm/clients/${ws}/import/template`);
  assert.match(template.text, /^name,status,last_assessment_date,client_label,.*,service_description\r\n$/);

  const tooLong = await previewCsv(ws, `name,status,service_description\r\nLong Co,in_use,${'x'.repeat(2001)}\r\n`);
  assert.equal(tooLong.status, 422);
  assert.match(tooLong.text, /Service description must be 2000 characters or fewer/);

  const csv = 'Name,Status,Service\r\nPayroll House,in_use,Monthly payroll processing\r\nNo Service Yet,proposed,\r\n';
  const preview = await previewCsv(ws, csv);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /data-tprm-import-ok="1"/);
  assert.match(preview.text, /<th>First service<\/th>/);
  assert.match(preview.text, /data-tprm-import-service>Monthly payroll processing</);
  assert.match(preview.text, /1 get a first service/);
  assert.equal(await count('SELECT COUNT(*)::integer c FROM tp_services WHERE workspace_id=?', ws), 0, 'nothing saved at preview');

  const batch = (preview.text.match(/name="batch_id" value="(\d+)"/) || [])[1];
  const text = unescape((preview.text.match(/<textarea name="csv"[^>]*>\n([\s\S]*?)<\/textarea>/) || [])[1]);
  const commit = await client.post(`/tprm/clients/${ws}/import/commit`, { batch_id: batch, csv: text });
  assert.equal(commit.status, 302);
  assert.match(toast(commit), /Imported 2 third parties, 1 with a first service/);
  const rows = await db.prepare('SELECT id, name FROM tp_third_parties WHERE workspace_id=? ORDER BY id').all(ws);
  const payroll = rows.find(r => r.name === 'Payroll House');
  const none = rows.find(r => r.name === 'No Service Yet');
  assert.deepEqual((await servicesOf(ws, payroll.id)).map(s => s.description), ['Monthly payroll processing']);
  assert.equal((await servicesOf(ws, none.id)).length, 0);
  const history = await chain(ws, payroll.id);
  assert.deepEqual(history.map(e => e.action), ['third_party.imported', 'service.added']);
  assert.equal(Number(history[1].after_state.import_batch_id), Number(batch));
  assert.equal(history[1].after_state.file_line, 2);
  assert.deepEqual((await chain(ws, none.id)).map(e => e.action), ['third_party.imported']);
  assert.deepEqual(await events.verifyChains(db, ws), []);
});

async function fingerprintOf(ws) {
  return RB.fingerprint((await db.prepare('SELECT rulebook_id FROM tp_client_rulebooks WHERE workspace_id=?').all(ws)).map(r => Number(r.rulebook_id)));
}

async function tick(ws, keys) {
  const ids = [];
  for (const k of keys) ids.push(String((await db.prepare('SELECT id FROM tp_rulebooks WHERE firm_id=? AND key=?').get(firmId, k)).id));
  const res = await client.post(`/tprm/clients/${ws}/rulebooks`, { rulebook: ids, fingerprint: await fingerprintOf(ws) });
  assert.equal(res.status, 302, toast(res));
}

const line = html => (html.match(/<div class="tprm-chips tprm-rulebooks-line"[\s\S]*?<\/div>/) || [''])[0];

test('the client head shows the ticked rulebooks; managers get a Change link to the settings panel, others read only', async () => {
  const ws = await tprmClient('Rulebooks Head Client');
  const settingsHref = new RegExp(`href="/tprm/clients/${ws}/settings#rulebooks" data-tprm-rulebooks-change`);

  let manager = line((await client.get(`/tprm/clients/${ws}`)).text);
  assert.match(manager, /data-tprm-rulebooks-count="0"/);
  assert.match(manager, /data-tprm-rulebooks-none>No rulebooks ticked</);
  assert.match(manager, settingsHref);
  assert.match(manager, />Tick rulebooks<\/a>/);
  let other = line((await consultant.session.get(`/tprm/clients/${ws}`)).text);
  assert.match(other, /No rulebooks ticked/);
  assert.doesNotMatch(other, /data-tprm-rulebooks-change/, 'a consultant cannot change them');

  await tick(ws, ['rbi_commercial_banks', 'india_baseline']);
  manager = line((await client.get(`/tprm/clients/${ws}`)).text);
  assert.match(manager, /data-tprm-rulebooks-count="2"/);
  assert.match(manager, /data-tprm-rulebook-chip="india_baseline">India baseline \(CERT-In \+ DPDP\)</);
  assert.match(manager, /data-tprm-rulebook-chip="rbi_commercial_banks">RBI - Commercial Banks</);
  assert.ok(manager.indexOf('india_baseline') < manager.indexOf('rbi_commercial_banks'), 'in the firm\'s order');
  assert.match(manager, settingsHref);
  assert.match(manager, />Change<\/a>/);
  assert.doesNotMatch(manager, /No rulebooks ticked/);
  for (const page of [`/tprm/clients/${ws}`, `/tprm/clients/${ws}?view=due`]) {
    other = line((await senior.session.get(page)).text);
    assert.match(other, /RBI - Commercial Banks/, page);
    assert.doesNotMatch(other, /data-tprm-rulebooks-change/, page);
  }

  const settings = await client.get(`/tprm/clients/${ws}/settings`);
  assert.equal(settings.status, 200);
  assert.match(settings.text, /id="rulebooks"[^>]*data-tprm-client-rulebooks/);
  assert.match(settings.text, /data-tprm-client-rulebooks-form/);
  assert.equal((await consultant.session.get(`/tprm/clients/${ws}/settings`)).status, 403);

  const rbRow = async () => db.prepare('SELECT * FROM tp_rulebooks WHERE firm_id=? AND key=?').get(firmId, 'rbi_commercial_banks');
  const save = async (enabled) => {
    const rb = await rbRow();
    const res = await client.post(`/tprm/settings/rulebooks/${rb.id}`, { ...(enabled ? { enabled: '1' } : {}),
      exit_plan_required: rb.exit_plan_required ? '1' : '', data_country: rb.data_country || '',
      question_ids: rb.question_ids.join(', '), reference_text: rb.reference_text, row_version: String(rb.row_version) });
    assert.equal(res.status, 302, toast(res));
  };
  await save(false);
  try {
    manager = line((await client.get(`/tprm/clients/${ws}`)).text);
    assert.match(manager, /data-tprm-rulebooks-count="1"/);
    assert.doesNotMatch(manager, /RBI - Commercial Banks/);
  } finally {
    await save(true);
  }
  assert.equal((await rbRow()).enabled, true);
});

test('the questionnaire step: rulebooks before preparing, with a Change link for managers only', async () => {
  const ws = await tprmClient('Rulebooks Questionnaire Client');
  await tick(ws, ['eu_gdpr']);
  const made = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'Prep Ltd', status: 'proposed', first_service: '1', description: 'Hosted CRM' });
  const tp = tpId(made.location);
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302, toast(started));
  const aid = Number((started.location.match(/assessments\/(\d+)/) || [])[1]);
  const aBase = `/tprm/clients/${ws}/third-parties/${tp}/assessments/${aid}`;
  const rowVersion = async () => String((await db.prepare('SELECT row_version FROM tp_assessments WHERE id=?').get(aid)).row_version);
  const svc = (await servicesOf(ws, tp)).map(s => String(s.id));
  const body = { services: svc, intent: 'propose', row_version: await rowVersion() };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase}/confirm`, { row_version: await rowVersion() })).status, 302);

  const prep = html => (html.match(/<form[^>]*data-tprm-prepare-form[\s\S]*?<\/form>/) || [''])[0];
  const manager = prep((await client.get(aBase)).text);
  assert.match(manager, /data-tprm-rulebooks-to-pin>EU - GDPR/);
  assert.match(manager, new RegExp(`href="/tprm/clients/${ws}/settings#rulebooks" data-tprm-rulebooks-change>Change</a>`));
  const other = prep((await consultant.session.get(aBase)).text);
  assert.match(other, /data-tprm-rulebooks-to-pin>EU - GDPR/);
  assert.doesNotMatch(other, /data-tprm-rulebooks-change/);

  await tick(ws, []);
  const none = prep((await client.get(aBase)).text);
  assert.match(none, /None ticked for the client\./);
  assert.match(none, /data-tprm-rulebooks-change>Change</);
});

test('switching TPRM on points the manager to the rulebooks', async () => {
  const ws = await tprmClient('Rulebooks Switch On Client', { enabled: false });
  const home = await client.get('/tprm');
  assert.match(home.text, /data-tprm-switch-on-hint/);
  assert.match(home.text, new RegExp(`action="/tprm/clients/${ws}/enable"`));
  const on = await client.post(`/tprm/clients/${ws}/enable`, {});
  assert.equal(on.status, 302);
  assert.match(toast(on), /switched on for this client\. Next, tick the rulebooks it is regulated under/);
  const head = line((await client.get(`/tprm/clients/${ws}`)).text);
  assert.match(head, /No rulebooks ticked/);
  assert.match(head, />Tick rulebooks<\/a>/);
});
