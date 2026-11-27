'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

let env;
let client;
let db;
let firmId;
let managerId;
let placement;
let events;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  placement = require('../lib/tprm/placement');
  events = require('../lib/tprm/events');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
});

test.after(async () => { if (client) await client.close(); });

async function tprmClient(name, { firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'[]','certification_support')`).run(firm, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
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

async function makeUser(email, { type = 'firm', role = 'consultant', workspaceId = null, memberRole = null } = {}) {
  const password = 'register-tests-password-1234';
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(password, 4), email, type, type === 'firm' ? firmId : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email, password };
}

const tpId = location => Number((String(location).match(/third-parties\/(\d+)/) || [])[1]);
const row = async id => db.prepare(`SELECT *, last_assessment_date::text AS last_assessment_date, next_due_date::text AS next_due_date
  FROM tp_third_parties WHERE id=?`).get(id);
const chain = async (ws, id) => db.prepare(`SELECT action, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='third_party' AND chain_id=? ORDER BY chain_seq`).all(ws, id);
const count = async (sql, ...args) => (await db.prepare(sql).get(...args)).c;

async function today(ws) {
  const { todayFor } = require('../lib/dates');
  const wsRow = await env.db.prepare('SELECT * FROM workspaces WHERE id=?').get(ws);
  return todayFor(wsRow);
}

async function addThirdParty(ws, body, session = client) {
  const res = await session.post(`/tprm/clients/${ws}/third-parties`, { status: 'in_use', ...body });
  assert.equal(res.status, 302, `create redirects (got ${res.status})`);
  return tpId(res.location);
}

function multipart(token, filename, content) {
  const boundary = '----tprm' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (token) parts.push(`--${boundary}`, 'Content-Disposition: form-data; name="_csrf"', '', token);
  parts.push(`--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${filename}"`, 'Content-Type: text/csv', '', content,
    `--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function previewCsv(ws, content, { session = client, filename = 'third-parties.csv', token } = {}) {
  await session.get(`/tprm/clients/${ws}/import`);
  const form = multipart(token === undefined ? session.getCsrfToken() : token, filename, content);
  return await session.post(`/tprm/clients/${ws}/import/preview`, form.body, { headers: form.headers, csrf: false });
}


const encoded = text => Buffer.from(text, 'utf8').toString('base64url');
const decoded = value => Buffer.from(value, 'base64url').toString('utf8');

function commitFields(html) {
  const batch = (html.match(/name="batch_id" value="(\d+)"/) || [])[1];
  const csv = (html.match(/name="csv_b64" value="([A-Za-z0-9_-]*)"/) || [])[1];
  assert.ok(batch && csv != null, 'the preview offers the commit form');
  return { batch_id: batch, csv_b64: csv };
}

test('add, view and edit a third party; every change writes an event in its chain', async () => {
  const ws = await tprmClient('Register CRUD Client');
  const form = await client.get(`/tprm/clients/${ws}/third-parties/new`);
  assert.equal(form.status, 200);
  assert.match(form.text, /data-tprm-third-party-form/);

  const id = await addThirdParty(ws, { name: '  Acme Cloud  ', category: 'Hosting', country: 'India', client_label: 'Tier 1' });
  let stored = await row(id);
  assert.equal(stored.name, 'Acme Cloud', 'the name is trimmed');
  assert.equal(stored.status, 'in_use');
  assert.equal(stored.current_tier, null, 'an unmapped label leaves the tier to be set');
  assert.equal(stored.next_due_date, null, 'in use and never assessed: no due date is invented, it is not assessed yet');
  assert.equal(stored.row_version, 1);

  const detail = await client.get(`/tprm/clients/${ws}/third-parties/${id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Acme Cloud/);
  assert.match(detail.text, /Tier needed/);
  assert.match(detail.text, /data-tprm-services-empty/);

  const edit = await client.get(`/tprm/clients/${ws}/third-parties/${id}/edit`);
  assert.match(edit.text, /name="row_version" value="1"/);
  const saved = await client.post(`/tprm/clients/${ws}/third-parties/${id}`, {
    name: 'Acme Cloud Pvt Ltd', status: 'in_use', category: 'Hosting', country: 'India', client_label: 'Tier 1',
    last_assessment_date: '2026-01-15', row_version: '1',
  });
  assert.equal(saved.status, 302);
  stored = await row(id);
  assert.equal(stored.name, 'Acme Cloud Pvt Ltd');
  assert.equal(stored.last_assessment_date, '2026-01-15');
  assert.equal(stored.row_version, 2);

  const history = await chain(ws, id);
  assert.deepEqual(history.map(e => e.action), ['third_party.created', 'third_party.updated']);
  assert.equal(history[0].after_state.name, 'Acme Cloud');
  assert.deepEqual(history[1].before_state, { name: 'Acme Cloud', last_assessment_date: null });
  assert.deepEqual(history[1].after_state, { name: 'Acme Cloud Pvt Ltd', last_assessment_date: '2026-01-15' });
  assert.deepEqual(await events.verifyChains(db, ws), []);

  const list = await client.get(`/tprm/clients/${ws}`);
  assert.equal(list.status, 200);
  assert.match(list.text, new RegExp(`data-tprm-row="${id}"`));
  assert.match(list.text, /Acme Cloud Pvt Ltd/);
});

test('invalid input is refused with the reasons and nothing is saved', async () => {
  const ws = await tprmClient('Register Validation Client');
  const bad = await client.post(`/tprm/clients/${ws}/third-parties`, {
    name: '   ', status: 'maybe', last_assessment_date: '2026-02-30', primary_contact_email: 'not-an-email',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /data-tprm-form-errors/);
  assert.match(bad.text, /Name is required/);
  assert.match(bad.text, /Status must be Proposed, In use or Exited/);
  assert.match(bad.text, /Last assessment date must be a date written YYYY-MM-DD/);
  assert.match(bad.text, /Contact email is not a valid email address/);
  const future = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'Future Co', status: 'in_use', last_assessment_date: '2999-01-01' });
  assert.equal(future.status, 400);
  assert.match(future.text, /cannot be in the future/);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 0);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_events WHERE workspace_id=?', ws), 0);
});

test('the name is not an identity key: a duplicate is warned about, then allowed', async () => {
  const ws = await tprmClient('Register Duplicate Client');
  const first = await addThirdParty(ws, { name: 'Same Name Ltd' });
  const warn = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'same name ltd ', status: 'proposed' });
  assert.equal(warn.status, 200, 'the form is shown again with a warning');
  assert.match(warn.text, /data-tprm-duplicate-warning/);
  assert.match(warn.text, new RegExp(`third-parties/${first}`));
  assert.match(warn.text, /name="confirm_duplicate" value="1"/);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 1, 'nothing saved before confirmation');

  const second = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'same name ltd ', status: 'proposed', confirm_duplicate: '1' });
  assert.equal(second.status, 302);
  assert.match(decodeURIComponent(second.location), /same name/);
  const secondId = tpId(second.location);
  assert.notEqual(secondId, first);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 2);
  const detail = await client.get(`/tprm/clients/${ws}/third-parties/${secondId}`);
  assert.match(detail.text, /data-tprm-duplicate-note/);
});

test('a stale row_version is refused with 409 and changes nothing', async () => {
  const ws = await tprmClient('Register Conflict Client');
  const id = await addThirdParty(ws, { name: 'Versioned Co' });
  const body = { name: 'Versioned Co', status: 'exited', row_version: '1', exit_date: '2026-01-31', exit_reason: 'Contract ended' };
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${id}`, body)).status, 302);
  const stale = await client.post(`/tprm/clients/${ws}/third-parties/${id}`, { ...body, name: 'Overwritten Co' });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /Someone else changed this third party after you opened it/);
  assert.match(stale.text, /reload the page/);
  const missing = await client.post(`/tprm/clients/${ws}/third-parties/${id}`, { name: 'No Version Co', status: 'exited' });
  assert.equal(missing.status, 409, 'a missing row_version is stale too');
  const stored = await row(id);
  assert.equal(stored.name, 'Versioned Co');
  assert.equal(stored.row_version, 2);
  assert.equal(stored.next_due_date, null, 'an exited third party has no due date');
  assert.deepEqual((await chain(ws, id)).map(e => e.action), ['third_party.created', 'third_party.updated']);
});

test('saving an already-due third party on a later day keeps the date it became due', async () => {
  const ws = await tprmClient('Register Due Stability Client');
  const id = await addThirdParty(ws, { name: 'Long Overdue Co', client_label: 'Unmapped' });
  await db.prepare("UPDATE tp_third_parties SET next_due_date='2026-01-05' WHERE id=?").run(id);
  const unchanged = await client.post(`/tprm/clients/${ws}/third-parties/${id}`, { name: 'Long Overdue Co', status: 'in_use', client_label: 'Unmapped', row_version: '1' });
  assert.equal(unchanged.status, 302);
  assert.match(decodeURIComponent(unchanged.location), /No changes to save/);
  let stored = await row(id);
  assert.equal(stored.next_due_date, '2026-01-05');
  assert.equal(stored.row_version, 1, 'an unchanged save is not a change');
  assert.deepEqual((await chain(ws, id)).map(e => e.action), ['third_party.created']);
  await client.post(`/tprm/clients/${ws}/third-parties/${id}`, { name: 'Long Overdue Co', category: 'IT', status: 'in_use', client_label: 'Unmapped', row_version: '1' });
  stored = await row(id);
  assert.equal(stored.next_due_date, '2026-01-05', 'an unrelated edit keeps the original due date');
  assert.deepEqual((await chain(ws, id))[1].after_state, { category: 'IT' });
});

test('services: add, edit and remove, each recorded in the third party\'s chain; stale versions refused', async () => {
  const ws = await tprmClient('Register Services Client');
  const id = await addThirdParty(ws, { name: 'Payroll Partner' });
  const add = await client.post(`/tprm/clients/${ws}/third-parties/${id}/services`, {
    description: 'Monthly payroll processing', data_access: 'Employee personal and bank data', hosting_countries: 'India',
    contract_start: '2025-04-01', contract_end: '2027-03-31', notice_period_days: '90', annual_spend: '1,20,000.50', sole_source: '1',
  });
  assert.equal(add.status, 302);
  const service = await db.prepare(`SELECT *, contract_start::text cs FROM tp_services WHERE workspace_id=? AND third_party_id=?`).get(ws, id);
  assert.equal(service.description, 'Monthly payroll processing');
  assert.equal(service.annual_spend, 120000.5);
  assert.equal(service.spend_currency, 'INR', 'no currency chosen and none used before: INR');
  assert.equal(service.sole_source, true);
  assert.equal(service.cs, '2025-04-01');

  const badDates = await client.post(`/tprm/clients/${ws}/third-parties/${id}/services`, {
    description: 'Backwards contract', contract_start: '2026-05-01', contract_end: '2026-01-01',
  });
  assert.equal(badDates.status, 400);
  assert.match(badDates.text, /Contract end cannot be before contract start/);

  const editPage = await client.get(`/tprm/clients/${ws}/third-parties/${id}/services/${service.id}/edit`);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, /Monthly payroll processing/);
  const edited = await client.post(`/tprm/clients/${ws}/third-parties/${id}/services/${service.id}`, {
    description: 'Monthly payroll and reimbursements', notice_period_days: '60', row_version: '1',
  });
  assert.equal(edited.status, 302);
  const stale = await client.post(`/tprm/clients/${ws}/third-parties/${id}/services/${service.id}`, { description: 'Stale', row_version: '1' });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /Someone else changed this service/);
  const staleRemove = await client.post(`/tprm/clients/${ws}/third-parties/${id}/services/${service.id}/remove`, { row_version: '1' });
  assert.equal(staleRemove.status, 409);

  const detail = await client.get(`/tprm/clients/${ws}/third-parties/${id}`);
  assert.match(detail.text, new RegExp(`data-tprm-service="${service.id}"`));
  assert.match(detail.text, /Monthly payroll and reimbursements/);

  const removed = await client.post(`/tprm/clients/${ws}/third-parties/${id}/services/${service.id}/remove`, { row_version: '2' });
  assert.equal(removed.status, 302);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_services WHERE workspace_id=?', ws), 0);

  const history = await chain(ws, id);
  assert.deepEqual(history.map(e => e.action), ['third_party.created', 'service.added', 'service.updated', 'service.removed']);
  assert.equal(history[1].after_state.service_id, service.id);
  assert.deepEqual(history[2].after_state, { service_id: service.id, description: 'Monthly payroll and reimbursements', data_access: null,
    hosting_countries: null, contract_start: null, contract_end: null, notice_period_days: 60, annual_spend: null, spend_currency: null, sole_source: false });
  assert.equal(history[3].before_state.description, 'Monthly payroll and reimbursements');
  assert.deepEqual(await events.verifyChains(db, ws), []);
});

test('isolation: another client\'s or firm\'s records are a 404; composite keys block cross-client links', async () => {
  const mine = await tprmClient('Isolation Mine Client');
  const sibling = await tprmClient('Isolation Sibling Client');
  const otherFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Register Other Firm')").run()).lastInsertRowid);
  const foreign = await tprmClient('Isolation Foreign Client', { firm: otherFirm });
  const mineTp = await addThirdParty(mine, { name: 'Mine Co' });
  const siblingTp = await addThirdParty(sibling, { name: 'Sibling Co' });
  const foreignTp = Number((await db.prepare('INSERT INTO tp_third_parties (workspace_id, name) VALUES (?, ?)').run(foreign, 'Foreign Co')).lastInsertRowid);
  const siblingService = Number((await db.prepare('INSERT INTO tp_services (workspace_id, third_party_id, description) VALUES (?, ?, ?)')
    .run(sibling, siblingTp, 'Sibling service')).lastInsertRowid);

  for (const path of [`/tprm/clients/${mine}/third-parties/${siblingTp}`, `/tprm/clients/${mine}/third-parties/${siblingTp}/edit`,
    `/tprm/clients/${mine}/third-parties/${foreignTp}`, `/tprm/clients/${foreign}`, `/tprm/clients/${foreign}/third-parties/${foreignTp}`,
    `/tprm/clients/${foreign}/import`, `/tprm/clients/${foreign}/settings`, `/tprm/clients/${foreign}/third-parties/new`,
    `/tprm/clients/${mine}/third-parties/${mineTp}/services/${siblingService}/edit`,
    `/tprm/clients/${sibling}/third-parties/${mineTp}`]) {
    assert.equal((await client.get(path)).status, 404, `${path} is a 404`);
  }
  assert.equal((await client.post(`/tprm/clients/${mine}/third-parties/${siblingTp}`, { name: 'Hijack', status: 'exited', row_version: '1' })).status, 404);
  assert.equal((await client.post(`/tprm/clients/${mine}/third-parties/${siblingTp}/services`, { description: 'Hijack' })).status, 404);
  assert.equal((await client.post(`/tprm/clients/${mine}/third-parties/${mineTp}/services/${siblingService}/remove`, { row_version: '1' })).status, 404);
  assert.equal((await client.post(`/tprm/clients/${foreign}/third-parties`, { name: 'Foreign add', status: 'in_use' })).status, 404);
  assert.equal((await row(siblingTp)).name, 'Sibling Co');
  assert.equal(await count('SELECT COUNT(*) c FROM tp_services WHERE id=?', siblingService), 1);

  await assert.rejects(db.prepare('INSERT INTO tp_services (workspace_id, third_party_id, description) VALUES (?, ?, ?)').run(mine, siblingTp, 'Cross link'),
    /foreign key/, 'a service cannot link to another client\'s third party');
  await assert.rejects(db.prepare('UPDATE tp_services SET workspace_id=? WHERE id=?').run(mine, siblingService), /foreign key/);
  await assert.rejects(events.appendEvent(db, { workspaceId: mine, thirdPartyId: siblingTp, actorId: managerId, action: 'third_party.updated' }),
    /foreign key/, 'an event cannot sit in another client\'s third-party chain');

  const list = await client.get(`/tprm/clients/${mine}`);
  assert.doesNotMatch(list.text, /Sibling Co|Foreign Co/);
});

test('client users never reach the register, import or settings', async () => {
  const ws = await tprmClient('Register Client User Client');
  const id = await addThirdParty(ws, { name: 'Hidden From Client Co' });
  const clientUser = await makeUser('register-client-owner@test.local', { type: 'client', workspaceId: ws, memberRole: 'client_owner' });
  const session = await signIn(clientUser.email, clientUser.password);
  try {
    for (const path of [`/tprm/clients/${ws}`, `/tprm/clients/${ws}?view=due`, `/tprm/clients/${ws}/third-parties/${id}`,
      `/tprm/clients/${ws}/third-parties/new`, `/tprm/clients/${ws}/import`, `/tprm/clients/${ws}/import/template`, `/tprm/clients/${ws}/settings`]) {
      const res = await session.get(path);
      assert.equal(res.status, 404, `${path} is a 404 for a client user`);
      assert.doesNotMatch(res.text, /Hidden From Client Co/);
    }
    const post = await session.post(`/tprm/clients/${ws}/third-parties`, { name: 'Client added', status: 'in_use' });
    assert.equal(post.status, 404);
    const preview = await previewCsv(ws, 'name,status\nClient Import,in_use\n', { session });
    assert.equal(preview.status, 404);
  } finally {
    await session.close();
  }
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 1);
});

test('CSRF is required on every register, settings and import form', async () => {
  const ws = await tprmClient('Register CSRF Client');
  const id = await addThirdParty(ws, { name: 'CSRF Co' });
  const forged = { _csrf: 'f'.repeat(64) };
  for (const [path, body] of [
    [`/tprm/clients/${ws}/third-parties`, { name: 'Forged', status: 'in_use' }],
    [`/tprm/clients/${ws}/third-parties/${id}`, { name: 'Forged', status: 'in_use', row_version: '1' }],
    [`/tprm/clients/${ws}/third-parties/${id}/services`, { description: 'Forged' }],
    [`/tprm/clients/${ws}/settings`, { label: 'Tier 1', tier: 'critical', row_version: '1' }],
    [`/tprm/clients/${ws}/import/commit`, { batch_id: '1', csv: 'name,status\nX,in_use' }],
  ]) {
    assert.equal((await client.post(path, body, { csrf: false })).status, 403, `${path} without a token`);
    assert.equal((await client.post(path, { ...body, ...forged }, { csrf: false })).status, 403, `${path} with a forged token`);
  }
  const preview = await previewCsv(ws, 'name,status\nNo Token Co,in_use\n', { token: null });
  assert.equal(preview.status, 403, 'the multipart preview checks the token too');
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 1);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_import_batches WHERE workspace_id=?', ws), 0);
  const page = await client.get(`/tprm/clients/${ws}/third-parties/${id}`);
  assert.match(page.text, /name="_csrf" value="[a-f0-9]{64}"/);
});

test('placement: label mapping, interval overrides and due-date rules', () => {
  const map = { 'Tier 1': 'critical', 'Important': 'high', 'Tier 3': 'low' };
  const firm = { critical: 12, high: 12, medium: 24, low: 36 };
  const intervals = placement.intervalsFor({ interval_months_high: 6 }, firm);
  assert.deepEqual(intervals, { critical: 12, high: 6, medium: 24, low: 36 }, 'an override replaces the firm interval for its tier only');
  assert.equal(placement.FIRM_DEFAULT_INTERVAL_MONTHS, undefined, 'no firm default constant: the criticality model owns the intervals');
  assert.throws(() => placement.intervalsFor({}, null), /No firm interval/, 'the firm intervals are required');
  assert.equal(placement.tierForLabel(map, '  tier   1 '), 'critical', 'case and spaces are ignored');
  assert.equal(placement.tierForLabel(map, 'Tier 2'), null);
  assert.equal(placement.addMonths('2026-01-31', 1), '2026-02-28', 'month ends are clamped');
  assert.equal(placement.addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(placement.addMonths('2025-11-21', 12), '2026-11-21');

  const today = '2026-11-21';
  const place = (o) => placement.provisionalPlacement({ status: 'in_use', labelMap: map, intervals, today, ...o });
  assert.deepEqual(place({ clientLabel: 'Tier 3', lastAssessmentDate: '2025-01-10' }),
    { tier: 'low', tierSource: 'provisional_from_client_label', nextDueDate: '2028-01-10', tierNeeded: false, labelUnmapped: false });
  assert.equal(place({ clientLabel: 'Important', lastAssessmentDate: '2026-08-01' }).nextDueDate, '2027-02-01', 'the client override (6 months) applies');
  assert.equal(place({ clientLabel: 'Tier 1', lastAssessmentDate: '2025-06-30' }).nextDueDate, '2026-06-30', 'a lapsed review keeps its real due date');
  assert.equal(place({ clientLabel: 'Tier 1', lastAssessmentDate: '2025-11-21' }).nextDueDate, today, 'due exactly today');
  assert.equal(place({ clientLabel: 'Tier 1' }).nextDueDate, null, 'never assessed -> no date, not assessed yet');
  const unmapped = place({ clientLabel: 'Gold', lastAssessmentDate: '2026-10-01' });
  assert.deepEqual([unmapped.tier, unmapped.tierNeeded, unmapped.labelUnmapped, unmapped.nextDueDate], [null, true, true, null],
    'an unmapped label -> tier needed and no date until the tier is set');
  assert.equal(place({ clientLabel: 'Tier 3', designatedCritical: true, lastAssessmentDate: '2026-10-01' }).tier, 'critical',
    'the client designation raises the provisional tier to Critical');
  assert.equal(place({ status: 'proposed', clientLabel: 'Tier 1' }).nextDueDate, null, 'a proposed third party has no reassessment due date');
  assert.equal(place({ status: 'exited', clientLabel: 'Tier 1' }).nextDueDate, null);
});

test('client settings: label mapping and intervals drive the provisional tier and due date; manager only; stale version refused', async () => {
  const ws = await tprmClient('Register Settings Client');
  const page = await client.get(`/tprm/clients/${ws}/settings`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-label-map/);
  assert.match(page.text, /Firm default 36 months/);

  const invalid = await client.post(`/tprm/clients/${ws}/settings`, {
    label: ['Tier 1', 'tier 1', 'Orphan'], tier: ['critical', 'high', ''], interval_months_low: '0', row_version: '1',
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.text, /listed twice/);
  assert.match(invalid.text, /Choose a tier for the label &#34;Orphan&#34;|Choose a tier for the label "Orphan"/);
  assert.match(invalid.text, /Low interval must be a whole number of months from 1 to 120/);

  const saved = await client.post(`/tprm/clients/${ws}/settings`, {
    label: ['Tier 1', 'Tier 2', '', ''], tier: ['critical', 'medium', '', ''], interval_months_medium: '6', row_version: '1',
  });
  assert.equal(saved.status, 302);
  const settings = await db.prepare('SELECT label_tier_map, interval_months_medium, row_version FROM tp_client_settings WHERE workspace_id=?').get(ws);
  assert.deepEqual(settings.label_tier_map, { 'Tier 1': 'critical', 'Tier 2': 'medium' });
  assert.equal(settings.interval_months_medium, 6);
  assert.equal(settings.row_version, 2);
  assert.ok(await db.prepare(`SELECT 1 FROM audit_log WHERE action='tprm_client_settings_updated' AND workspace_id=?`).get(ws));

  const stale = await client.post(`/tprm/clients/${ws}/settings`, { label: 'Tier 1', tier: 'low', row_version: '1' });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /Someone else changed these settings/);

  const lastDate = '2026-10-15';
  const id = await addThirdParty(ws, { name: 'Mapped Co', client_label: 'tier 2', last_assessment_date: lastDate });
  let stored = await row(id);
  assert.equal(stored.current_tier, 'medium');
  assert.equal(stored.tier_source, 'provisional_from_client_label');
  const expected = placement.addMonths(lastDate, 6);
  const now = await today(ws);
  assert.equal(stored.next_due_date, expected > now ? expected : now, 'last assessment + the client\'s Medium interval');
  const designated = await addThirdParty(ws, { name: 'Designated Co', client_label: 'Tier 2', client_designated_critical: '1' });
  stored = await row(designated);
  assert.equal(stored.current_tier, 'critical');
  assert.equal(stored.client_designated_critical, true);

  const consultant = await makeUser('register-consultant@test.local', { role: 'consultant', workspaceId: ws });
  const session = await signIn(consultant.email, consultant.password);
  try {
    assert.equal((await session.get(`/tprm/clients/${ws}`)).status, 200, 'a consultant works on the register');
    assert.doesNotMatch((await session.get(`/tprm/clients/${ws}`)).text, new RegExp(`href="/tprm/clients/${ws}/settings"`));
    assert.equal((await session.get(`/tprm/clients/${ws}/settings`)).status, 403);
    assert.equal((await session.post(`/tprm/clients/${ws}/settings`, { label: 'Tier 1', tier: 'low', row_version: '2' })).status, 403);
    assert.equal(await addThirdParty(ws, { name: 'Consultant Co' }, session) > 0, true, 'tp.manage lets a consultant add third parties');
  } finally {
    await session.close();
  }
  assert.equal((await db.prepare('SELECT row_version FROM tp_client_settings WHERE workspace_id=?').get(ws)).row_version, 2);
});

test('register filters and the "Due for reassessment" view', async () => {
  const ws = await tprmClient('Register Filter Client');
  await client.post(`/tprm/clients/${ws}/settings`, { label: ['Gold', 'Bronze'], tier: ['high', 'low'], row_version: '1' });
  const now = await today(ws);
  const recent = placement.addMonths(now, -1);
  const dueNoDate = await addThirdParty(ws, { name: 'Due No Date', client_label: 'Gold' });
  const overdue = await addThirdParty(ws, { name: 'Overdue Co', client_label: 'Gold', last_assessment_date: placement.addMonths(now, -13) });
  const notDue = await addThirdParty(ws, { name: 'Recent Co', client_label: 'Bronze', last_assessment_date: recent });
  const proposed = await addThirdParty(ws, { name: 'Proposed Co', status: 'proposed', client_label: 'Gold' });
  const exited = await addThirdParty(ws, { name: 'Exited Co', status: 'exited' });
  const ids = html => [...html.matchAll(/data-tprm-row="(\d+)"/g)].map(m => Number(m[1]));

  const due = await client.get(`/tprm/clients/${ws}?view=due`);
  assert.equal(due.status, 200);
  assert.match(due.text, /data-tprm-view="due"/);
  assert.deepEqual(ids(due.text).sort(), [dueNoDate, overdue].sort(), 'in use, due today or earlier, or no date');
  assert.match(due.text, /Due for reassessment \(2\)/);

  const register = await client.get(`/tprm/clients/${ws}`);
  assert.deepEqual(ids(register.text).sort(), [dueNoDate, overdue, notDue, proposed].sort(), 'exited third parties are hidden by default');
  assert.match(register.text, /data-tprm-exited-hidden/);
  assert.match(register.text, /1 exited third party is hidden/);
  assert.match(register.text, /<option value="">Current \(not exited\)<\/option>/);
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?status=all`)).text).sort(),
    [dueNoDate, overdue, notDue, proposed, exited].sort(), '"All" shows them');
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?status=proposed`)).text), [proposed]);
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?status=exited`)).text), [exited]);
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?tier=low`)).text), [notDue]);
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?tier=none`)).text), [], 'the exited one is hidden by default');
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?tier=none&status=all`)).text), [exited]);
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?due=due`)).text).sort(), [dueNoDate, overdue].sort());
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?due=not_due`)).text).sort(), [notDue, proposed].sort());
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?due=not_due&status=all`)).text).sort(), [notDue, proposed, exited].sort());
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?status=in_use&tier=high`)).text).sort(), [dueNoDate, overdue].sort());
  assert.equal(ids((await client.get(`/tprm/clients/${ws}?status=bogus'--`)).text).length, 4, 'an unknown filter value is ignored (default view)');

  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?q=overdue`)).text), [overdue], 'search matches the name, case-insensitive');
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?q=Bronze`)).text), [notDue], 'search matches the client label');
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?q=${encodeURIComponent('100%_')}`)).text), [], 'LIKE wildcards in the search are literal');
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?sort=name&dir=desc`)).text), [notDue, proposed, overdue, dueNoDate], 'sorted by name, descending');
  assert.deepEqual(ids((await client.get(`/tprm/clients/${ws}?sort=last_assessed&dir=asc`)).text).slice(-2), [overdue, notDue], 'never assessed first, then oldest');
  assert.equal(ids((await client.get(`/tprm/clients/${ws}?sort=bogus;drop`)).text).length, 4, 'an unknown sort column is ignored');
  const sorted = (await client.get(`/tprm/clients/${ws}?sort=name&dir=asc&q=co`)).text;
  assert.match(sorted, /data-tp-sort="name" aria-sort="ascending"/);
  assert.match(sorted, /name="q" value="co"/);
  assert.match(sorted, /data-tp-list-count data-tp-total="5">Showing 3 of 5</);
});

test('changing the label mapping or intervals recalculates third parties not yet assessed, never assessed ones', async () => {
  const ws = await tprmClient('Register Recalculation Client');
  let res = await client.post(`/tprm/clients/${ws}/settings`, { label: ['Gold'], tier: ['high'], row_version: '1' });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.location), /Settings saved · 0 third parties not yet assessed have a new tier or due date/);
  const now = await today(ws);
  const last = placement.addMonths(now, -1);
  const gold = await addThirdParty(ws, { name: 'Gold Co', client_label: 'Gold', last_assessment_date: last });
  const silver = await addThirdParty(ws, { name: 'Silver Co', client_label: 'Silver', last_assessment_date: last });
  const assessed = await addThirdParty(ws, { name: 'Assessed Co', client_label: 'Gold', last_assessment_date: last });
  const proposed = await addThirdParty(ws, { name: 'Proposed Gold Co', status: 'proposed', client_label: 'Gold' });
  await db.prepare(`UPDATE tp_third_parties SET tier_source='assessed', current_tier='critical', next_due_date='2030-01-01' WHERE id=?`).run(assessed);
  assert.deepEqual([(await row(gold)).current_tier, (await row(silver)).current_tier], ['high', null]);
  const assessedBefore = await row(assessed);
  const eventsBefore = (await chain(ws, assessed)).length;

  res = await client.post(`/tprm/clients/${ws}/settings`, {
    label: ['Gold', 'Silver'], tier: ['low', 'medium'], interval_months_low: '2', row_version: '2',
  });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.location), /Settings saved · 3 third parties not yet assessed have a new tier or due date/,
    'the count updated is shown after saving');

  const g = await row(gold);
  assert.deepEqual([g.current_tier, g.tier_source, g.next_due_date], ['low', 'provisional_from_client_label', placement.addMonths(last, 2)],
    'the new mapping and the new Low override');
  const sv = await row(silver);
  assert.deepEqual([sv.current_tier, sv.tier_source], ['medium', 'provisional_from_client_label'], 'a newly mapped label gets its tier');
  const p = await row(proposed);
  assert.deepEqual([p.current_tier, p.next_due_date], ['low', null], 'a proposed third party gets the tier but still no due date');
  const a = await row(assessed);
  assert.deepEqual([a.current_tier, a.tier_source, a.next_due_date, a.row_version],
    [assessedBefore.current_tier, 'assessed', assessedBefore.next_due_date, assessedBefore.row_version], 'an assessed third party is untouched');
  assert.equal((await chain(ws, assessed)).length, eventsBefore, 'and gets no event');

  const goldChain = await chain(ws, gold);
  const event = goldChain[goldChain.length - 1];
  assert.equal(event.action, 'third_party.placement_recalculated');
  assert.equal(event.before_state.reason, 'client_settings_changed');
  assert.equal(event.before_state.current_tier, 'high');
  assert.equal(event.after_state.current_tier, 'low');
  assert.equal(event.after_state.next_due_date, placement.addMonths(last, 2));
  assert.equal((await chain(ws, silver)).slice(-1)[0].action, 'third_party.placement_recalculated');
  const page = await client.get(`/tprm/clients/${ws}/third-parties/${gold}`);
  assert.match(page.text, /Tier or due date recalculated after a client settings change<\/strong>\s*<span class="meta"> · current tier, next due date<\/span>/,
    'the history names the recalculation and the fields it changed');
  assert.deepEqual(await events.verifyChains(db, ws), [], 'the event chains still verify');

  res = await client.post(`/tprm/clients/${ws}/settings`, {
    label: ['Gold', 'Silver', 'Unused'], tier: ['low', 'medium', 'high'], interval_months_low: '2', row_version: '3',
  });
  assert.match(decodeURIComponent(res.location), /Settings saved · 0 third parties/, 'a change that moves nobody updates nobody');
});

test('CSV import: template, preview with mapped tiers and due dates, one commit, idempotent', async () => {
  const ws = await tprmClient('Import Happy Client');
  await client.post(`/tprm/clients/${ws}/settings`, { label: ['Tier 1', 'Tier 3'], tier: ['critical', 'low'], row_version: '1' });
  const existing = await addThirdParty(ws, { name: 'Already Here Ltd' });
  const now = await today(ws);

  const template = await client.get(`/tprm/clients/${ws}/import/template`);
  assert.equal(template.status, 200);
  assert.match(template.headers['content-type'], /text\/csv/);
  assert.match(template.headers['content-disposition'], /third_parties_template\.csv/);
  assert.match(template.text, /^name,status,last_assessment_date,client_label,/);

  const recent = placement.addMonths(now, -2);
  const csv = '﻿Name,Status,Last Assessment Date,Client Label,Category,Notes\r\n'
    + 'Core Banking Co,in use,2024-03-01,Tier 1,Core banking,legacy\r\n'
    + `Office Snacks,In_Use,${recent},tier 3,Facilities,\r\n`
    + 'New Analytics,proposed,,Tier 1,,\r\n'
    + '"Comma, Quote ""Ltd""",in_use,,Gold,,\r\n'
    + 'Already Here Ltd,exited,,,,\r\n';
  const preview = await previewCsv(ws, csv);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /data-tprm-import-ok="1"/);
  assert.match(preview.text, /Ignored columns: Notes/);
  assert.match(preview.text, /Tier needed: the label &#34;Gold&#34; is not mapped|Tier needed: the label "Gold" is not mapped/);
  assert.match(preview.text, /A third party with this name is already in the register/);
  assert.match(preview.text, /data-tprm-import-row="2"(?:(?!<\/tr>)[^])*data-tprm-import-due="overdue">Due 1 Mar 2025, \d+ days overdue</, 'a lapsed review (Core Banking Co) shows its real due date as overdue');
  assert.match(preview.text, /data-tprm-import-row="5"(?:(?!<\/tr>)[^])*data-tprm-import-due="not_assessed">Not assessed yet</, 'in use, never assessed');
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 1, 'the preview saves no third party');
  const fields = commitFields(preview.text);

  const commit = await client.post(`/tprm/clients/${ws}/import/commit`, fields);
  assert.equal(commit.status, 302);
  assert.match(decodeURIComponent(commit.location), /Imported 5 third parties/);
  const rows = await db.prepare(`SELECT name, status, client_label, current_tier, tier_source, client_designated_critical,
      last_assessment_date::text AS last, next_due_date::text AS due, import_batch_id FROM tp_third_parties
    WHERE workspace_id=? AND import_batch_id IS NOT NULL ORDER BY id`).all(ws);
  assert.deepEqual(rows.map(r => [r.name, r.status, r.current_tier, r.due]), [
    ['Core Banking Co', 'in_use', 'critical', '2025-03-01'],
    ['Office Snacks', 'in_use', 'low', placement.addMonths(recent, 36)],
    ['New Analytics', 'proposed', 'critical', null],
    ['Comma, Quote "Ltd"', 'in_use', null, null],
    ['Already Here Ltd', 'exited', null, null],
  ]);
  assert.equal(rows[0].tier_source, 'provisional_from_client_label');
  assert.equal(rows[0].client_designated_critical, true, 'a label mapped to Critical records the client designation');
  assert.equal(rows[1].client_designated_critical, false);
  assert.equal(rows[0].last, '2024-03-01');
  const batch = await db.prepare('SELECT * FROM tp_import_batches WHERE id=?').get(Number(fields.batch_id));
  assert.equal(batch.status, 'committed');
  assert.equal(batch.imported_count, 5);
  assert.ok(rows.every(r => r.import_batch_id === batch.id));
  const imported = await db.prepare(`SELECT action, after_state FROM tp_events WHERE workspace_id=? AND action='third_party.imported' ORDER BY id`).all(ws);
  assert.equal(imported.length, 5, 'one event per imported third party');
  assert.equal(imported[0].after_state.import_batch_id, batch.id);
  assert.equal(imported[0].after_state.file_line, 2);
  assert.deepEqual(await events.verifyChains(db, ws), []);
  assert.ok(await db.prepare(`SELECT 1 FROM audit_log WHERE action='tprm_third_parties_imported' AND workspace_id=?`).get(ws));
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 6, 'duplicates are imported, not merged');

  const again = await client.post(`/tprm/clients/${ws}/import/commit`, fields);
  assert.equal(again.status, 302);
  assert.match(decodeURIComponent(again.location), /already imported/);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 6, 're-committing the same preview adds nothing');
  assert.equal(await count("SELECT COUNT(*) c FROM tp_events WHERE workspace_id=? AND action='third_party.imported'", ws), 5);

  const lfVersion = csv.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const repeat = await previewCsv(ws, lfVersion, { filename: 'same-file-again.csv' });
  assert.equal(repeat.status, 200);
  assert.match(repeat.text, /data-tprm-import-already/, 'the same content (any line endings) is recognised as already imported');
  assert.doesNotMatch(repeat.text, /data-tprm-import-commit/);

  const register = await client.get(`/tprm/clients/${ws}`);
  assert.match(register.text, /Core Banking Co/);
  assert.match(register.text, /Comma, Quote &#34;Ltd&#34;|Comma, Quote "Ltd"/);
});

test('CSV import: a second preview of the same file cannot import it twice', async () => {
  const ws = await tprmClient('Import Double Preview Client');
  const csv = 'name,status\nTwin Preview Co,in_use\n';
  const first = commitFields((await previewCsv(ws, csv)).text);
  const second = commitFields((await previewCsv(ws, csv)).text);
  assert.notEqual(first.batch_id, second.batch_id);
  assert.equal((await client.post(`/tprm/clients/${ws}/import/commit`, first)).status, 302);
  const late = await client.post(`/tprm/clients/${ws}/import/commit`, second);
  assert.equal(late.status, 302);
  assert.match(decodeURIComponent(late.location), /already imported/);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 1);
});

test('CSV import: text the pages display differently, such as an em dash, is imported exactly as in the file', async () => {
  const ws = await tprmClient('Import Em Dash Client');
  const csv = '\ufeff\ufeffname,status,category\r\nDash \u2014 Co,in_use,Cloud \u2014 hosting\r\nCaf\u00e9 \u201cQuotes\u201d \u2026,proposed,\r\n';
  const preview = await previewCsv(ws, csv);
  assert.equal(preview.status, 200);
  assert.doesNotMatch(preview.text, /<textarea name="csv"/);
  const commit = await client.post(`/tprm/clients/${ws}/import/commit`, commitFields(preview.text));
  assert.equal(commit.status, 302);
  assert.match(decodeURIComponent(commit.location), /Imported 2 third parties/);
  const rows = await db.prepare('SELECT name, category FROM tp_third_parties WHERE workspace_id=? ORDER BY id').all(ws);
  assert.deepEqual(rows.map(r => [r.name, r.category]), [['Dash \u2014 Co', 'Cloud \u2014 hosting'], ['Caf\u00e9 \u201cQuotes\u201d \u2026', null]]);
});

test('CSV import: a file changed after preview is rejected and nothing is imported', async () => {
  const ws = await tprmClient('Import Changed File Client');
  const preview = await previewCsv(ws, 'name,status\nOriginal Co,in_use\nSecond Co,proposed\n');
  const fields = commitFields(preview.text);
  const text = decoded(fields.csv_b64);
  const changed = await client.post(`/tprm/clients/${ws}/import/commit`, { ...fields, csv_b64: encoded(text.replace('Original Co', 'Swapped Co')) });
  assert.equal(changed.status, 409);
  assert.match(changed.text, /The file changed after it was previewed, so nothing was imported/);
  const appended = await client.post(`/tprm/clients/${ws}/import/commit`, { ...fields, csv_b64: encoded(text + '\nExtra Co,in_use') });
  assert.equal(appended.status, 409);
  const garbled = await client.post(`/tprm/clients/${ws}/import/commit`, { ...fields, csv_b64: '%%not-the-file%%' });
  assert.equal(garbled.status, 409);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 0);
  assert.equal((await db.prepare('SELECT status FROM tp_import_batches WHERE id=?').get(Number(fields.batch_id))).status, 'previewed');
  const crlf = await client.post(`/tprm/clients/${ws}/import/commit`, { batch_id: fields.batch_id, csv: text.replace(/\n/g, '\r\n') });
  assert.equal(crlf.status, 302, 'a preview page opened before the encoded field still imports, and line endings rewritten by a browser are not a change');
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 2);

  const other = await tprmClient('Import Other Batch Client');
  const foreignBatch = await client.post(`/tprm/clients/${other}/import/commit`, fields);
  assert.equal(foreignBatch.status, 404, 'a batch of another client is a 404');
});

test('CSV import: one bad row blocks the whole file; missing columns and empty files are refused', async () => {
  const ws = await tprmClient('Import Bad Row Client');
  const bad = await previewCsv(ws, 'name,status,last_assessment_date,client_label\n'
    + 'Good One,in_use,2025-01-01,\n'
    + ',in_use,,\n'
    + 'Bad Status Co,active,,\n'
    + 'Bad Date Co,in_use,01/02/2025,\n'
    + 'Good Two,proposed,,\n');
  assert.equal(bad.status, 422);
  assert.match(bad.text, /data-tprm-import-blocked/);
  assert.match(bad.text, /3 rows have errors/);
  assert.match(bad.text, /data-tprm-import-row="3" data-tprm-row-state="error"/);
  assert.match(bad.text, /Name is required/);
  assert.match(bad.text, /Status must be Proposed, In use or Exited/);
  assert.match(bad.text, /Last assessment date must be a date written YYYY-MM-DD/);
  assert.match(bad.text, /data-tprm-import-row="2" data-tprm-row-state="warning"/, "a valid row with no label is only flagged: tier needed");
  assert.doesNotMatch(bad.text, /data-tprm-import-commit/, 'no commit is offered');

  const noStatus = await previewCsv(ws, 'name,category\nNo Status Column Co,IT\n');
  assert.equal(noStatus.status, 422);
  assert.match(noStatus.text, /The file has no &#34;status&#34; column|The file has no "status" column/);
  const empty = await previewCsv(ws, 'name,status\n');
  assert.equal(empty.status, 422);
  assert.match(empty.text, /header row but no third parties/);
  const notCsv = await previewCsv(ws, 'name,status\nX,in_use\n', { filename: 'list.xlsx' });
  assert.equal(notCsv.status, 400, 'the upload validation refuses a non-CSV file');
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 0);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_import_batches WHERE workspace_id=?', ws), 0, 'a file that cannot be imported records no preview');

  const forged = await client.post(`/tprm/clients/${ws}/import/commit`, { batch_id: '999999999', csv: 'name,status\nX,in_use' });
  assert.equal(forged.status, 404);
});

test('CSV import commit is atomic: a failure on any row leaves nothing behind', async () => {
  const ws = await tprmClient('Import Atomic Client');
  const preview = await previewCsv(ws, 'name,status\nFirst Fine Co,in_use\nExplode Ltd,in_use\nThird Fine Co,proposed\n');
  const fields = commitFields(preview.text);
  await db.exec(`CREATE OR REPLACE FUNCTION tp_test_explode_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF NEW.name = 'Explode Ltd' THEN RAISE EXCEPTION 'simulated failure on one row'; END IF; RETURN NEW; END; $fn$`);
  await db.exec('CREATE TRIGGER tp_test_explode BEFORE INSERT ON tp_third_parties FOR EACH ROW EXECUTE FUNCTION tp_test_explode_fn()');
  try {
    const failed = await client.post(`/tprm/clients/${ws}/import/commit`, fields);
    assert.equal(failed.status, 500);
  } finally {
    await db.exec('DROP TRIGGER tp_test_explode ON tp_third_parties');
    await db.exec('DROP FUNCTION tp_test_explode_fn()');
  }
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 0);
  assert.equal(await count('SELECT COUNT(*) c FROM tp_events WHERE workspace_id=?', ws), 0);
  assert.equal((await db.prepare('SELECT status FROM tp_import_batches WHERE id=?').get(Number(fields.batch_id))).status, 'previewed');

  const retry = await client.post(`/tprm/clients/${ws}/import/commit`, fields);
  assert.equal(retry.status, 302, 'the same preview commits once the fault is gone');
  assert.equal(await count('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?', ws), 3);
});

test('a client with third-party risk and no ISO programme: the client menus open its third-party risk page, with Client setup one tab away', async () => {
  const ws = await tprmClient('Only Third Party Risk Client');
  const iso = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, 'ISO And Third Party Risk Client')).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(iso);

  const page = (await client.get('/tprm')).text;
  assert.match(page, new RegExp(`href="/tprm/clients/${ws}"[^>]*>\\s*<span[^>]*></span>\\s*<span[^>]*>Only Third Party Risk Client`), 'Jump to a client opens the third-party risk page');
  assert.doesNotMatch(page, new RegExp(`href="/workspaces/${ws}"`));
  assert.match(page, new RegExp(`href="/workspaces/${iso}"`), 'a client with ISO still opens on its client overview');

  const register = await client.get(`/tprm/clients/${ws}`);
  assert.equal(register.status, 200);
  assert.match(register.text, new RegExp(`href="/workspaces/${ws}"[^>]*data-tprm-client-setup`));
  assert.equal((await client.get(`/workspaces/${ws}`)).status, 200, 'Client setup opens the services page, where ISO can be switched on');
  assert.doesNotMatch((await client.get(`/tprm/clients/${iso}`)).text, /data-tprm-client-setup/);
});

test('a lapsed supplier keeps its real due date and counts as overdue; a never-assessed one has no invented date', async () => {
  const ws = await tprmClient('Register True Due Client');
  await client.post(`/tprm/clients/${ws}/settings`, { label: ['Tier 1'], tier: ['critical'], row_version: '1' });
  const now = await today(ws);
  const lastAssessed = placement.addMonths(now, -22);
  const lapsed = await addThirdParty(ws, { name: 'Lapsed Payments', client_label: 'Tier 1', last_assessment_date: lastAssessed });
  const fresh = await addThirdParty(ws, { name: 'Never Assessed Co', client_label: 'Tier 1' });
  assert.equal((await row(lapsed)).next_due_date, placement.addMonths(lastAssessed, 12), 'last assessed plus the Critical interval, in the past');
  assert.equal((await row(fresh)).next_due_date, null);

  const register = await client.get(`/tprm/clients/${ws}`);
  assert.match(register.text, /Reassessments overdue<b class="fx-bad">1</, 'the lapsed supplier is counted overdue; the never-assessed one is not');
  const party = await client.get(`/tprm/clients/${ws}/third-parties/${lapsed}`);
  assert.match(party.text, /data-tprm-due-state="overdue">Due [^<]*, \d+ days overdue</);
  assert.doesNotMatch(party.text, /Due today/);
  assert.match(party.text, /data-tprm-party-next[\s\S]*?Reassessment due/, 'next steps prompt the reassessment');
  const never = await client.get(`/tprm/clients/${ws}/third-parties/${fresh}`);
  assert.match(never.text, /data-tprm-due-state="not_assessed">Not assessed yet</);
  assert.match(never.text, /data-tprm-party-next[\s\S]*?Assess this third party/);

  const due = await client.get(`/tprm/due?client=${ws}`);
  assert.match(due.text, new RegExp(`data-tprm-due-bucket="overdue"(?:(?!data-tprm-due-bucket=)[^])*data-tprm-due-row="${lapsed}"`));
  assert.match(due.text, new RegExp(`data-tprm-due-bucket="no_date"(?:(?!data-tprm-due-bucket=)[^])*data-tprm-due-row="${fresh}"(?:(?!</tr>)[^])*Not assessed yet(?:(?!</tr>)[^])*Start assessment<`));
});

test('the data fix gives rows stamped "due today" on entry their real due date, and records why', async () => {
  const ws = await tprmClient('Register Stamped Due Client');
  await client.post(`/tprm/clients/${ws}/settings`, { label: ['Tier 1'], tier: ['critical'], row_version: '1' });
  const lapsed = await addThirdParty(ws, { name: 'Stamped Lapsed', client_label: 'Tier 1', last_assessment_date: '2024-01-15' });
  const never = await addThirdParty(ws, { name: 'Stamped Never', client_label: 'Tier 1' });
  const triggered = await addThirdParty(ws, { name: 'Stamped Triggered', client_label: 'Tier 1' });
  for (const id of [lapsed, never, triggered]) await db.prepare("UPDATE tp_third_parties SET next_due_date = '2026-11-26' WHERE id = ?").run(id);
  await db.prepare(`INSERT INTO tp_trigger_events (workspace_id, third_party_id, reason, previous_due_date, new_due_date, recorded_by)
    VALUES (?, ?, 'breach', NULL, '2026-11-26', ?)`).run(ws, triggered, managerId);
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'migrations', '159_tprm_true_due_dates.sql'), 'utf8');
  await db.exec(sql);
  assert.equal((await row(lapsed)).next_due_date, '2025-01-15');
  assert.equal((await row(never)).next_due_date, null);
  assert.equal((await row(triggered)).next_due_date, '2026-11-26', 'a date set by an early reassessment trigger is kept');
  const last = (await chain(ws, lapsed)).pop();
  assert.equal(last.action, 'third_party.due_date_corrected');
  assert.deepEqual(last.before_state, { next_due_date: '2026-11-26' });
  assert.deepEqual(await require('../lib/tprm/events').verifyChains(db, ws), []);
  const page = await client.get(`/tprm/clients/${ws}/third-parties/${lapsed}?tab=history`);
  assert.match(page.text, /Next review date corrected to the last assessment date plus the review interval/);
  assert.doesNotMatch(page.text, /recalculated after a client settings change/);
});

test('marking a supplier Exited asks for the exit date and reason and cancels its open assessment with a history entry', async () => {
  const ws = await tprmClient('Register Exit Client');
  const id = await addThirdParty(ws, { name: 'Swift Parcels' });
  const started = await client.post(`/tprm/clients/${ws}/third-parties/${id}/assessments`, {});
  assert.equal(started.status, 302);
  const open = await db.prepare("SELECT id FROM tp_assessments WHERE workspace_id=? AND third_party_id=? AND status NOT IN ('completed','cancelled')").get(ws, id);
  assert.ok(open);
  const form = await client.get(`/tprm/clients/${ws}/third-parties/${id}/edit`);
  assert.match(form.text, /data-tprm-exit-fields[\s\S]*name="exit_date"[\s\S]*name="exit_reason"/);
  const rv = String((await row(id)).row_version);
  const missing = await client.post(`/tprm/clients/${ws}/third-parties/${id}`, { name: 'Swift Parcels', status: 'exited', row_version: rv });
  assert.equal(missing.status, 400);
  assert.match(missing.text, /Give the exit date/);
  assert.match(missing.text, /Say why the client is leaving/);
  assert.equal((await row(id)).status, 'in_use', 'nothing is saved');
  const saved = await client.post(`/tprm/clients/${ws}/third-parties/${id}`, { name: 'Swift Parcels', status: 'exited', row_version: rv,
    exit_date: await today(ws), exit_reason: 'Moved couriers to a national carrier' });
  assert.equal(saved.status, 302);
  assert.match(decodeURIComponent(saved.location), /marked exited and its open assessment cancelled/);
  const stored = await row(id);
  assert.deepEqual([stored.status, stored.exit_reason], ['exited', 'Moved couriers to a national carrier']);
  const a = await db.prepare('SELECT status, cancel_reason FROM tp_assessments WHERE id=?').get(open.id);
  assert.equal(a.status, 'cancelled');
  assert.match(a.cancel_reason, /The third party exited: Moved couriers/);
  const history = await client.get(`/tprm/clients/${ws}/third-parties/${id}/assessments/${open.id}?step=history`);
  assert.match(history.text, /cancelled the assessment: The third party exited: Moved couriers to a national carrier/);
  const page = await client.get(`/tprm/clients/${ws}/third-parties/${id}`);
  assert.match(page.text, /data-tprm-position>Exited on [^<]*: Moved couriers to a national carrier\./);
  assert.doesNotMatch(page.text, /data-tprm-open-assessment/);
});

test('annual spend has a currency, defaulting to the one the firm last used or INR, with grouping that suits the currency', async () => {
  const fmt = require('../lib/tprm/format');
  assert.equal(fmt.money(1200000, 'INR'), '₹12,00,000');
  assert.equal(fmt.money(1200000, 'GBP'), '£1,200,000');
  assert.match(fmt.money(48000.5, 'USD'), /\$48,000\.5$/);
  const ws = await tprmClient('Register Currency Client');
  const id = await addThirdParty(ws, { name: 'Harbour Cleaning' });
  const svcOf = async desc => db.prepare('SELECT annual_spend, spend_currency FROM tp_services WHERE workspace_id=? AND third_party_id=? AND description=?').get(ws, id, desc);
  const firmDefault = await require('../lib/tprm/register').defaultCurrency(db, firmId);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${id}/services`, { description: 'Office cleaning', annual_spend: '£48,000' })).status, 302);
  assert.deepEqual(await svcOf('Office cleaning'), { annual_spend: 48000, spend_currency: 'GBP' }, 'a pound sign is understood, not refused');
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${id}/services`, { description: 'Window cleaning', annual_spend: '1,200,000', spend_currency: 'GBP' })).status, 302);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${id}/services`, { description: 'Deep cleaning', annual_spend: '12,00,000' })).status, 302);
  assert.deepEqual(await svcOf('Deep cleaning'), { annual_spend: 1200000, spend_currency: 'GBP' }, 'no currency given: the one the firm last used');
  assert.notEqual(firmDefault, undefined);
  const page = await client.get(`/tprm/clients/${ws}/third-parties/${id}?tab=services`);
  assert.match(page.text, /£1,200,000/);
  assert.doesNotMatch(page.text, /12,00,000/, 'no Indian grouping for pounds');
  const form = await client.get(`/tprm/clients/${ws}/third-parties/new`);
  assert.match(form.text, /<option value="GBP" selected>GBP<\/option>/, 'the new-service form starts on the firm currency');
  await db.prepare("UPDATE tp_services SET spend_currency = NULL, annual_spend = 4321000 WHERE workspace_id=? AND description='Deep cleaning'").run(ws);
  const legacy = await client.get(`/tprm/clients/${ws}/third-parties/${id}?tab=services`);
  assert.match(legacy.text, />43,21,000</, 'an amount saved before currencies keeps its plain number, with no symbol nobody chose');
  const old = await db.prepare("SELECT id, row_version FROM tp_services WHERE workspace_id=? AND description='Deep cleaning'").get(ws);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${id}/services/${old.id}`, {
    description: 'Deep cleaning, quarterly', annual_spend: '43,21,000', spend_currency: 'GBP', row_version: String(old.row_version) })).status, 302);
  assert.deepEqual(await svcOf('Deep cleaning, quarterly'), { annual_spend: 4321000, spend_currency: null }, 'editing another field does not stamp a currency on old spend');
  const bad = await client.post(`/tprm/clients/${ws}/third-parties/${id}/services`, { description: 'Bad', annual_spend: '10', spend_currency: 'XYZ' });
  assert.equal(bad.status, 400);
});
