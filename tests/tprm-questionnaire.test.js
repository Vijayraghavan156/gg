'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
const DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-q-outbox-')), 'outbox.log');
process.env.EMAIL_DEV_OUTBOX = DEV_OUTBOX;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient, allSteps } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const BANK_FILE = path.join(ROOT, 'data', 'tprm-question-bank.json');
const BANK = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
const assembly = require('../lib/tprm/questionnaire-assembly');

let env;
let client;
let db;
let firmId;
let managerId;
let consultant;
let senior;
let events;
let vendorRoute;

const PASSWORD = 'questionnaire-tests-password-1234';
const HIGH_PERSONAL = {
  data_handled: 'personal', service_stops: 'slows', system_access: 'user', regulated: 'no', replaceability: 'with_effort',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no',
};
const VALID_UNTIL = '2099-12-31';

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  events = require('../lib/tprm/events');
  vendorRoute = require('../routes/tprm-vendor');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
  consultant = await makeUser('q-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('q-senior@test.local', { role: 'senior_consultant' });
  for (const u of [consultant, senior]) u.session = await signIn(u.email, u.password);
});

test.after(async () => {
  for (const u of [consultant, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

test.beforeEach(() => { if (vendorRoute) vendorRoute.limiter.reset(); });

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId, workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firm : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email, password: PASSWORD, firm_id: firm, firm_role: role, user_type: type };
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

async function tprmClient(name, { firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firm, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (firm === firmId) {
    for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  }
  return id;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const qBase = ctx => `${aBase(ctx.ws, ctx.tp, ctx.a)}/questionnaire`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const qRow = async a => db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(a);
const linksOf = async a => db.prepare('SELECT * FROM tp_vendor_requests WHERE assessment_id=? ORDER BY id').all(a);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);
const sha = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

async function addThirdParty(ws, name) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
  assert.equal(res.status, 302, `create redirects (got ${res.status})`);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Payroll processing' })).status, 302);
  return tp;
}

async function assessment(name, { answers = HIGH_PERSONAL, confirm = true, ws = null } = {}) {
  const wsId = ws || await tprmClient(`${name} Client`);
  const tp = await addThirdParty(wsId, name);
  const started = await consultant.session.post(`/tprm/clients/${wsId}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302);
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(wsId, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(answers)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(wsId, tp, a)}/scope`, body)).status, 302);
  assert.equal((await assessmentRow(a)).status, 'tier_proposed');
  if (confirm) {
    const res = await senior.session.post(`${aBase(wsId, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) });
    assert.equal(res.status, 302);
    assert.equal((await assessmentRow(a)).status, 'tier_confirmed');
  }
  return { ws: wsId, tp, a };
}

async function prepare(ctx, body = {}, session = consultant.session) {
  const res = await session.post(qBase(ctx), body);
  assert.equal(res.status, 302, `prepare redirects (got ${res.status})`);
  const row = await qRow(ctx.a);
  assert.ok(row, `prepared (${toast(res)})`);
  return row;
}

async function createLink(ctx, body = {}, session = consultant.session) {
  const row = await qRow(ctx.a);
  const res = await session.post(`${qBase(ctx)}/links`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(row.row_version), ...body,
  });
  const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
  return { res, url, token: url ? url.split('/vendor/q/')[1] : null };
}

const vendor = () => makeClient(env.app);

test('base questions are nested by tier for a vendor-hosted service, and AIS-01 is always asked', () => {
  const counts = {};
  const sets = {};
  for (const tier of ['low', 'medium', 'high', 'critical']) {
    const r = assembly.assemble(BANK, { tier, deliveryModel: 'vendor_hosted' });
    counts[tier] = r.counts.base;
    sets[tier] = new Set(r.sections.flatMap(s => s.ids));
    assert.ok(sets[tier].has('AIS-01'), `AIS-01 at ${tier}`);
    const rank = { Low: 1, 'All tiers': 1, Medium: 2, High: 3, Critical: 4 };
    for (const id of sets[tier]) {
      const row = BANK.questions.find(q => q.id === id);
      assert.equal(row.set, 'Base');
      if (!['AIS-01', 'ASR-01', 'ASR-03'].includes(id)) assert.ok(rank[row.min_tier] <= assembly.TIER_RANK[tier], `${id} (${row.min_tier}) is not above ${tier}`);
    }
  }
  assert.deepEqual(counts, { low: 24, medium: 54, high: 112, critical: 137 }, 'low gains ASR-03 for the report');
  for (const [lower, higher] of [['low', 'medium'], ['medium', 'high'], ['high', 'critical']]) {
    for (const id of sets[lower]) assert.ok(sets[higher].has(id), `${id} at ${lower} is also asked at ${higher}`);
  }
  const r = assembly.assemble(BANK, { tier: 'critical', deliveryModel: 'vendor_hosted' });
  const domains = [...new Set(BANK.questions.filter(q => q.set === 'Base').map(q => q.domain))];
  assert.deepEqual(r.sections.map(s => s.title), domains);
  assert.ok(r.sections.every(s => s.kind === 'base'));
});

test('every questionnaire with questions a certificate or report can cover asks ASR-01 and ASR-03', () => {
  for (const model of assembly.DELIVERY_MODELS) {
    for (const tier of ['low', 'medium', 'high', 'critical']) {
      const r = assembly.assemble(BANK, { tier, deliveryModel: model });
      const section = r.sections.find(s => s.ids.includes('ASR-01'));
      assert.ok(section && section.ids.includes('ASR-03'), `${model} at ${tier}`);
      assert.equal(section.title, 'Assurance & Certification');
      assert.ok(section.ids.indexOf('ASR-01') < section.ids.indexOf('ASR-03'), 'bank order kept');
    }
  }
  const tiny = { ...BANK, questions: BANK.questions.filter(q => q.set !== 'Base' || ['AIS-01', 'ASR-01', 'ASR-03', 'GOV-01'].includes(q.id))
    .map(q => (q.id === 'GOV-01' ? { ...q, report_coverage: 'none' } : q)) };
  const none = assembly.assemble(tiny, { tier: 'low', deliveryModel: 'non_technology' }).sections.flatMap(s => s.ids);
  assert.ok(!none.includes('ASR-03'), 'nothing to cover, nothing added');
});

test('client-hosted and non-technology services get their flat Base sets at every tier', () => {
  const tagged = tag => BANK.questions.filter(q => q.set === 'Base'
    && assembly.parseDeliveryTags(q.delivery_models).some(t => t.tag === tag)).map(q => q.id);
  for (const [model, tag, expected] of [['client_hosted', 'Client-hosted', 19], ['non_technology', 'Non-technology services', 20]]) {
    const want = new Set([...tagged(tag), 'AIS-01', 'ASR-01', 'ASR-03']);
    for (const tier of ['low', 'medium', 'high', 'critical']) {
      const r = assembly.assemble(BANK, { tier, deliveryModel: model });
      const got = r.sections.flatMap(s => s.ids);
      assert.equal(got.length, expected, `${model} at ${tier}`);
      assert.deepEqual(new Set(got), want, `${model} at ${tier}: exactly the rows tagged ${tag}, plus AIS-01 and the certificate and report questions`);
    }
  }
  assert.deepEqual(assembly.assemble(BANK, { tier: 'high', deliveryModel: 'staff_in_client_environment' }).sections,
    assembly.assemble(BANK, { tier: 'high', deliveryModel: 'vendor_hosted' }).sections);
  assert.match(assembly.DELIVERY_MODEL_NOTES.staff_in_client_environment, /switched off/);
});

test('the module mapping table adds modules from the answers; disabled modules cannot be chosen', () => {
  const modules = (answers, model) => assembly.autoModules(answers, model).map(m => m.module);
  assert.deepEqual(modules({ data_handled: 'personal' }, 'vendor_hosted'), ['Personal Data & Privacy', 'Hosting Platform & Cloud Provider']);
  assert.deepEqual(modules({ data_handled: 'special_financial' }, 'non_technology'), ['Personal Data & Privacy', 'Non-Technology Services']);
  assert.deepEqual(modules({ data_handled: 'confidential' }, 'vendor_hosted'), ['Hosting Platform & Cloud Provider']);
  assert.deepEqual(modules({ system_access: 'privileged' }, 'client_hosted'),
    ['Privileged Access & Managed Security', 'Software & Application Security', 'Client-Hosted Software']);
  assert.deepEqual(modules({ payments_records: 'yes', sites_data: 'yes' }, 'non_technology'),
    ['Transaction & Client-Asset Systems', 'Physical & Data Centre', 'Non-Technology Services']);
  assert.deepEqual(modules({ payments_records: 'no', sites_data: 'no' }, 'staff_in_client_environment'), ['Hosting Platform & Cloud Provider']);
  assert.deepEqual(modules({ supplies_software: 'yes' }, 'vendor_hosted'), ['Hosting Platform & Cloud Provider', 'Software & Application Security']);
  assert.deepEqual(modules({ supplies_software: 'yes' }, 'non_technology'), ['Software & Application Security', 'Non-Technology Services']);
  assert.deepEqual(modules({ supplies_software: 'no' }, 'vendor_hosted'), ['Hosting Platform & Cloud Provider']);
  const installed = assembly.autoModules({ supplies_software: 'yes' }, 'client_hosted');
  assert.deepEqual(installed.map(m => m.module), ['Software & Application Security', 'Client-Hosted Software'], 'no module twice');
  assert.match(installed[0].because, /installed in the client/);
  assert.match(assembly.autoModules({ supplies_software: 'yes' }, 'vendor_hosted')[1].because, /software or APIs/);
  const starter = require('../lib/tprm/criticality').STARTER_QUESTIONS;
  for (const rule of assembly.MODULE_RULES.filter(r => r.question)) {
    const q = starter.find(x => x.id === rule.question);
    assert.ok(q, `${rule.question} is a starter question`);
    for (const id of rule.answers) assert.ok(q.answers.some(a => a.id === id), `${rule.question} has answer ${id}`);
  }
  assert.equal(assembly.deliveryModelFromAnswers({ delivery_model: 'installed' }), 'client_hosted');
  assert.equal(assembly.deliveryModelFromAnswers({}), null);
  const catalog = assembly.moduleCatalog(BANK);
  for (const rule of assembly.MODULE_RULES) assert.ok(catalog.includes(rule.module), rule.module);
  assert.ok(!assembly.offeredModules(BANK).includes('Vendor Staff in Client Environment'));
  assert.throws(() => assembly.assemble(BANK, { tier: 'high', deliveryModel: 'vendor_hosted', modules: ['Vendor Staff in Client Environment'] }), /switched off/);
  assert.throws(() => assembly.assemble(BANK, { tier: 'high', deliveryModel: 'vendor_hosted', modules: ['Nope'] }), /not a module/);
  const r = assembly.assemble(BANK, { tier: 'high', deliveryModel: 'vendor_hosted', modules: ['Personal Data & Privacy', 'Hosting Platform & Cloud Provider'] });
  assert.deepEqual(r.counts.modules, { 'Hosting Platform & Cloud Provider': 12, 'Personal Data & Privacy': 9 });
  assert.equal(r.counts.vendorTotal, 133);
  assert.deepEqual(r.sections.filter(s => s.kind === 'module').map(s => s.title), ['Hosting Platform & Cloud Provider', 'Personal Data & Privacy']);
});

test('rulebook packs and consultant rows are never sent to the third party', () => {
  const r = assembly.assemble(BANK, { tier: 'critical', deliveryModel: 'vendor_hosted', modules: assembly.offeredModules(BANK) });
  const ids = new Set(r.sections.flatMap(s => s.ids));
  for (const row of BANK.questions.filter(q => q.set === 'Rulebook pack')) assert.ok(!ids.has(row.id), row.id);
  assert.equal(r.counts.consultant, 0);
  const bank = { questions: [
    { id: 'B-1', set: 'Base', pack: '-', domain: 'D1', min_tier: 'Low', delivery_models: 'Vendor-hosted', answered_by: 'Vendor' },
    { id: 'B-2', set: 'Base', pack: '-', domain: 'D1', min_tier: 'Low', delivery_models: 'Vendor-hosted', answered_by: 'Consultant' },
    { id: 'B-3', set: 'Base', pack: '-', domain: 'D2', min_tier: 'Critical', delivery_models: 'Vendor-hosted', answered_by: 'Vendor' },
    { id: 'M-1', set: 'Module', pack: 'Mod', domain: 'D1', min_tier: 'All tiers', delivery_models: 'Any (when module triggered)', answered_by: 'Consultant' },
    { id: 'M-2', set: 'Module', pack: 'Mod', domain: 'D1', min_tier: 'High', delivery_models: 'Any (when module triggered)', answered_by: 'Vendor' },
    { id: 'R-1', set: 'Rulebook pack', pack: 'RB', domain: 'D1', min_tier: 'All tiers', delivery_models: 'Any (when rulebook ticked)', answered_by: 'Vendor' },
  ] };
  const s = assembly.assemble(bank, { tier: 'medium', deliveryModel: 'vendor_hosted', modules: ['Mod'] });
  assert.deepEqual(s.sections, [{ kind: 'base', title: 'D1', ids: ['B-1'] }]);
  assert.deepEqual(s.consultantChecks.map(c => c.id), ['B-2', 'M-1']);
  assert.deepEqual(assembly.assemble(bank, { tier: 'high', deliveryModel: 'vendor_hosted', modules: ['Mod'] }).sections.map(x => x.ids),
    [['B-1'], ['M-2']], 'module rows are nested by tier too');
  assert.deepEqual(assembly.assemble(bank, { tier: 'low', deliveryModel: 'vendor_hosted', rulebooks: ['RB'] }).sections.pop(),
    { kind: 'rulebook', title: 'RB', ids: ['R-1'] });
});

test('bank version 1 is the approved file, published once and immutable', async () => {
  const rows = await db.prepare('SELECT * FROM tp_question_bank_versions ORDER BY version').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 1);
  assert.equal(rows[0].content_sha256, crypto.createHash('sha256').update(fs.readFileSync(BANK_FILE)).digest('hex'),
    'version 1 is the file as it is: a changed bank is published as a new version by a new migration');
  assert.equal(rows[0].question_count, BANK.questions.length);
  assert.deepEqual(rows[0].content.questions.map(q => q.id), BANK.questions.map(q => q.id));
  await assert.rejects(db.prepare("UPDATE tp_question_bank_versions SET label='x' WHERE id=?").run(rows[0].id), /immutable/);
  await assert.rejects(db.prepare('DELETE FROM tp_question_bank_versions WHERE id=?').run(rows[0].id), /immutable/);
});

test('the questionnaire is prepared only once the tier is confirmed', async () => {
  const ctx = await assessment('Early Co', { confirm: false });
  const res = await consultant.session.post(qBase(ctx), {});
  assert.equal(res.status, 302);
  assert.match(toast(res), /confirm the tier first/);
  assert.equal(await qRow(ctx.a), undefined);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-questionnaire-blocked/);
  assert.doesNotMatch(page.text, /data-tprm-prepare-form/);
  const bank = await db.prepare('SELECT id, version FROM tp_question_bank_versions LIMIT 1').get();
  await assert.rejects(db.prepare(`INSERT INTO tp_questionnaires (workspace_id, assessment_id, bank_version_id, bank_version, tier,
      delivery_model, delivery_model_source, sections, vendor_question_count) VALUES (?, ?, ?, ?, 'high', 'vendor_hosted', 'consultant', '[]', 0)`)
    .run(ctx.ws, ctx.a, bank.id, bank.version), /confirmed tier/, 'the database refuses too');
});

test('a High vendor-hosted third party with personal data: base by domain, Cloud and Personal Data modules, bank version pinned', async () => {
  const ctx = await assessment('Preview Co');
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-prepare-form/);
  assert.doesNotMatch(page.text, /data-tprm-delivery-choice/, 'the delivery model comes from the answers');
  const q = await prepare(ctx);
  assert.equal(q.status, 'draft');
  assert.equal(q.tier, 'high');
  assert.equal(q.delivery_model, 'vendor_hosted');
  assert.equal(q.delivery_model_source, 'assessment_answer');
  assert.equal(q.bank_version, 1);
  assert.equal(q.vendor_question_count, 133);
  assert.deepEqual(q.modules.map(m => [m.module, m.source, m.included]),
    [['Personal Data & Privacy', 'auto', true], ['Hosting Platform & Cloud Provider', 'auto', true]]);
  assert.deepEqual(q.dynamic_modules.map(d => d.module), ['AI Services']);
  assert.deepEqual(q.consultant_check_ids, []);
  const ids = q.sections.flatMap(s => s.ids);
  assert.equal(ids.length, 133);
  assert.equal(new Set(ids).size, 133, 'no question twice');
  assert.ok(ids.includes('AIS-01'));
  assert.deepEqual(q.sections.filter(s => s.kind === 'module').map(s => [s.title, s.ids.length]), [['Hosting Platform & Cloud Provider', 12], ['Personal Data & Privacy', 9]]);
  assert.equal(q.sections.filter(s => s.kind === 'base').reduce((n, s) => n + s.ids.length, 0), 112);

  const shown = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(shown.text, /data-tprm-vendor-count>133</);
  assert.match(shown.text, /data-tprm-base-count>112</);
  assert.match(shown.text, /data-tprm-module="Hosting Platform &amp; Cloud Provider" data-tprm-module-included="1"[\s\S]*?data-tprm-module-count>12</);
  assert.match(shown.text, /data-tprm-module="Personal Data &amp; Privacy" data-tprm-module-included="1"[\s\S]*?data-tprm-module-count>9</);
  assert.match(shown.text, /data-tprm-section="Identity &amp; Access Management"[\s\S]*?data-tprm-section-count>8</);
  assert.match(shown.text, /data-tprm-consultant-checks-empty/);
  assert.match(shown.text, /data-tprm-dynamic-modules[\s\S]*AI Services/);
  assert.match(shown.text, /data-tprm-bank-version>Version 1</);

  const again = await consultant.session.post(qBase(ctx), {});
  assert.match(toast(again), /already prepared/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_questionnaires WHERE assessment_id=?').get(ctx.a)).c, 1);
  await assert.rejects(db.prepare('UPDATE tp_questionnaires SET bank_version = bank_version + 1 WHERE id=?').run(q.id), /never change|violates/);
});

test('without a delivery answer the consultant chooses the delivery model, and the choice is recorded', async () => {
  const answers = { ...HIGH_PERSONAL };
  delete answers.delivery_model;
  const ctx = await assessment('No Delivery Co', { answers });
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-delivery-choice/);
  const refused = await consultant.session.post(qBase(ctx), {});
  assert.match(toast(refused), /Choose the delivery model/);
  assert.equal(await qRow(ctx.a), undefined);
  const q = await prepare(ctx, { delivery_model: 'client_hosted' });
  assert.equal(q.delivery_model, 'client_hosted');
  assert.equal(q.delivery_model_source, 'consultant');
  assert.deepEqual(q.modules.map(m => m.module), ['Personal Data & Privacy', 'Software & Application Security', 'Client-Hosted Software']);
  assert.equal(q.sections.filter(s => s.kind === 'base').reduce((n, s) => n + s.ids.length, 0), 19, 'the flat client-hosted set');
  const prepared = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'questionnaire.prepared');
  assert.equal(prepared.after_state.delivery_model_source, 'consultant');
});

test('a hosted service whose third party supplies software or APIs gets Software & Application Security', async () => {
  const ctx = await assessment('Hosted API Co', { answers: { ...HIGH_PERSONAL, supplies_software: 'yes' } });
  const q = await prepare(ctx);
  assert.equal(q.delivery_model, 'vendor_hosted');
  assert.deepEqual(q.modules.map(m => [m.module, m.source]),
    [['Personal Data & Privacy', 'auto'], ['Hosting Platform & Cloud Provider', 'auto'], ['Software & Application Security', 'auto']]);
  assert.match(q.modules[2].because, /software or APIs/);
  assert.ok(q.sections.some(s => s.kind === 'module' && s.title === 'Software & Application Security' && s.ids.length > 0));
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-module="Software &amp; Application Security" data-tprm-module-included="1"/);
});

test('modules are added and removed by hand with a reason, recorded, until the questionnaire is sent', async () => {
  const ctx = await assessment('Modules Co');
  let q = await prepare(ctx);
  const post = async (body, rv = q.row_version) => consultant.session.post(`${qBase(ctx)}/modules`, { row_version: String(rv), ...body });

  assert.match(toast(await post({ op: 'remove', module: 'Hosting Platform & Cloud Provider' })), /Say why/);
  assert.match(toast(await post({ op: 'add', module: 'Vendor Staff in Client Environment', reason: 'x' })), /switched off/);
  assert.match(toast(await post({ op: 'add', module: 'Personal Data & Privacy', reason: 'x' })), /already in/);

  let res = await post({ op: 'remove', module: 'Hosting Platform & Cloud Provider', reason: 'Runs on the client\'s own servers' });
  assert.match(toast(res), /Hosting Platform & Cloud Provider removed: 121 questions/);
  q = await qRow(ctx.a);
  const cloud = q.modules.find(m => m.module === 'Hosting Platform & Cloud Provider');
  assert.deepEqual([cloud.source, cloud.included, cloud.changed_by, cloud.reason], ['auto', false, consultant.id, 'Runs on the client\'s own servers']);
  assert.equal(q.vendor_question_count, 121);

  res = await post({ op: 'add', module: 'AI Services', reason: 'The client knows it uses AI' });
  assert.match(toast(res), /AI Services added: 142 questions/);
  q = await qRow(ctx.a);
  assert.deepEqual(q.modules.find(m => m.module === 'AI Services').source, 'manual');
  assert.deepEqual(q.dynamic_modules, [], 'AI Services is no longer added while answering: it is in already');

  assert.match(toast(await post({ op: 'add', module: 'Physical & Data Centre', reason: 'x' }, q.row_version - 1)), /Someone else changed/);

  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-module="Hosting Platform &amp; Cloud Provider" data-tprm-module-included="0"/);
  assert.match(page.text, /Removed by q-consultant@test\.local[^<]*: Runs on the client&#39;s own servers/);
  const history = (await chain(ctx.ws, ctx.a)).filter(e => e.action.startsWith('questionnaire.module'));
  assert.deepEqual(history.map(e => [e.action, e.after_state.module, e.after_state.reason]), [
    ['questionnaire.module_removed', 'Hosting Platform & Cloud Provider', 'Runs on the client\'s own servers'],
    ['questionnaire.module_added', 'AI Services', 'The client knows it uses AI'],
  ]);

  const { res: created } = await createLink(ctx);
  assert.equal(created.status, 200);
  q = await qRow(ctx.a);
  assert.equal(q.status, 'sent');
  assert.match(toast(await post({ op: 'remove', module: 'AI Services', reason: 'x' })), /has been sent/);
  await assert.rejects(db.prepare(`UPDATE tp_questionnaires SET vendor_question_count = 1 WHERE id=?`).run(q.id), /only a draft/);
  await assert.rejects(db.prepare(`UPDATE tp_questionnaires SET status = 'draft' WHERE id=?`).run(q.id), /never goes back/);
});

test('the link is shown once, only its hash is stored, and the token reaches no table, event, session or email', async () => {
  const ctx = await assessment('Token Co');
  await prepare(ctx);
  const { res, url, token } = await createLink(ctx, { send_email: '1' });
  assert.equal(res.status, 200);
  assert.match(res.text, /data-tprm-new-link/);
  assert.ok(token && /^[A-Za-z0-9_-]{43}$/.test(token), 'a 32-byte base64url token');
  assert.ok(url.endsWith(`/vendor/q/${token}`));
  assert.match(res.text, /data-tprm-link-emailed>Emailed to priya@thirdparty\.example\.net/);
  const [link] = await linksOf(ctx.a);
  assert.equal(link.token_hash, sha(token));
  assert.equal(link.status, 'active');
  assert.equal(link.recipient_name, 'Priya Vendor');
  assert.equal(link.created_by, consultant.id);
  assert.ok(link.emailed_at);
  assert.equal(link.last_opened_at, null);
  const days = (new Date(link.expires_at) - new Date(link.created_at)) / 86400000;
  assert.ok(Math.abs(days - 30) < 0.01, `default expiry is 30 days (${days})`);

  for (const [table, where] of [['tp_vendor_requests', 'workspace_id = $1'], ['tp_questionnaires', 'workspace_id = $1'],
    ['tp_events', 'workspace_id = $1'], ['email_outbox', 'workspace_id = $1'], ['sessions', 'true']]) {
    const found = await db.prepare(`SELECT COUNT(*)::int c FROM ${table} t WHERE ${where.replace('$1', '?')} AND t::text LIKE ?`)
      .get(...(where === 'true' ? [] : [ctx.ws]), `%${token}%`);
    assert.equal(found.c, 0, `${table} never holds the token`);
  }
  const mail = await db.prepare(`SELECT * FROM email_outbox WHERE workspace_id=? AND related_type='tp_vendor_request'`).get(ctx.ws);
  assert.ok(mail, 'the email is in the outbox');
  assert.match(mail.body_text, /\[link removed\]/);
  assert.equal(mail.to_email, 'priya@thirdparty.example.net');
  assert.match(mail.subject, /^Security questionnaire from .+ for /);
  assert.match(mail.body_text, /is reviewing, on behalf of /);
  assert.match(mail.body_text, /Please submit your answers by \d{1,2} [A-Z][a-z]{2} \d{4}, when the link stops working\./);
  assert.match(mail.body_text, /There are \d+ questions in \d+ sections?\. You can stop and return at any time/);
  assert.doesNotMatch(mail.body_text, /we expect|\bhours?\b/);
  assert.match(mail.body_text, /(?:answers? asks? for a supporting document|documents to hand)/);
  assert.ok(mail.body_text.includes(consultant.email), 'who to contact');
  assert.doesNotMatch(mail.body_text, /UTC/);

  assert.ok(fs.readFileSync(DEV_OUTBOX, 'utf8').includes(url), 'the dev outbox file stands in for the mailbox and gets the link');

  process.env.EMAIL_DELIVERY_DISABLED = '1';
  try {
    const off = await createLink(ctx, { send_email: '1' });
    assert.match(off.res.text, /data-tprm-link-emailed>The email could not be sent \(email delivery is switched off/);
    assert.equal((await linksOf(ctx.a))[1].emailed_at, null);
  } finally { process.env.EMAIL_DELIVERY_DISABLED = '0'; }
  const tokenOff = (await linksOf(ctx.a))[1];
  assert.equal(tokenOff.status, 'active');

  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.ok(!page.text.includes(token));
  assert.doesNotMatch(page.text, /data-tprm-new-link/);
  assert.match(page.text, new RegExp(`data-tprm-link-row="${tokenOff.id}" data-tprm-link-status="active"`));
  assert.match(page.text, new RegExp(`data-tprm-link-row="${link.id}" data-tprm-link-status="revoked"`));
  const again = await consultant.session.post(`${qBase(ctx)}/links`, { recipient_name: 'P', recipient_email: 'p@thirdparty.example.net', row_version: '1' });
  assert.match(toast(again), /Someone else changed/);
  assert.equal((await linksOf(ctx.a)).length, 2);
  await assert.rejects(db.prepare(`UPDATE tp_vendor_requests SET token_hash=? WHERE id=?`).run(sha('other'), link.id), /never change/);
  await assert.rejects(db.prepare(`UPDATE tp_vendor_requests SET expires_at = expires_at + interval '1 day' WHERE id=?`).run(link.id), /never change/);
});

test('opening a valid link shows the client name and changes nothing: no session, no cookie, no row, no event', async () => {
  const ctx = await assessment('Open Co');
  await prepare(ctx);
  const { token } = await createLink(ctx);
  const before = {
    link: (await linksOf(ctx.a))[0],
    q: await qRow(ctx.a),
    sessions: (await db.prepare('SELECT COUNT(*)::int c FROM sessions').get()).c,
    events: (await chain(ctx.ws, ctx.a)).length,
  };
  const visitor = vendor();
  try {
    const res = await visitor.get(`/vendor/q/${token}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Questionnaire for Open Co Client/);
    assert.match(res.text, /data-vendor-link-open/);
    assert.equal(res.headers['set-cookie'], undefined, 'no cookie');
    assert.match(res.headers['x-robots-tag'], /noindex/);
    assert.match(res.text, /<meta name="robots" content="noindex/);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.ok(!res.text.includes('Open Co<') && !res.text.includes('Payroll'), 'no third-party details');
    assert.doesNotMatch(res.text, new RegExp(`/tprm/clients/${ctx.ws}|assessments/${ctx.a}`), 'no internal ids');
    await visitor.get(`/vendor/q/${token}`);
  } finally { await visitor.close(); }
  assert.deepEqual((await linksOf(ctx.a))[0], before.link, 'the link row is unchanged (last_opened_at stays empty)');
  assert.deepEqual(await qRow(ctx.a), before.q);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM sessions').get()).c, before.sessions, 'no session created');
  assert.equal((await chain(ctx.ws, ctx.a)).length, before.events, 'no event');
});

test('unknown, malformed, revoked, expired and cancelled links all get the same page and status', async () => {
  const visitor = vendor();
  const pages = [];
  const open = async (label, token) => { const r = await visitor.get(`/vendor/q/${token}`); pages.push({ label, r }); return r; };
  try {
    await open('unknown', crypto.randomBytes(32).toString('base64url'));
    await open('malformed', 'not-a-token');
    await open('too long', 'A'.repeat(200));

    const revoked = await assessment('Revoked Link Co');
    await prepare(revoked);
    const r1 = await createLink(revoked);
    assert.equal((await open('revoked: before', r1.token)).status, 200);
    pages.pop();
    const [link] = await linksOf(revoked.a);
    const res = await consultant.session.post(`${qBase(revoked)}/links/${link.id}/revoke`, { row_version: String(link.row_version), reason: 'Wrong contact' });
    assert.match(toast(res), /Link revoked/);
    await open('revoked', r1.token);

    const expired = await assessment('Expired Link Co');
    const q = await prepare(expired);
    const token = crypto.randomBytes(32).toString('base64url');
    await db.prepare(`INSERT INTO tp_vendor_requests (workspace_id, assessment_id, questionnaire_id, token_hash, recipient_name,
        recipient_email, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, 'Old', 'old@thirdparty.example.net',
        now() - interval '31 days', now() - interval '1 day', ?)`).run(expired.ws, expired.a, q.id, sha(token), consultant.id);
    await open('expired', token);
    const page = await allSteps(consultant.session, aBase(expired.ws, expired.tp, expired.a));
    assert.match(page.text, /data-tprm-link-status="expired"/);

    const cancelled = await assessment('Cancelled Link Co');
    await prepare(cancelled);
    const r2 = await createLink(cancelled);
    const cancel = await consultant.session.post(`${aBase(cancelled.ws, cancelled.tp, cancelled.a)}/cancel`,
      { row_version: String((await assessmentRow(cancelled.a)).row_version), reason: 'Not needed' });
    assert.equal(cancel.status, 302);
    await open('cancelled', r2.token);
  } finally { await visitor.close(); }
  const first = pages[0].r;
  assert.equal(first.status, vendorRoute.INVALID_STATUS);
  assert.match(first.text, /This link is not valid/);
  for (const { label, r } of pages) {
    assert.equal(r.status, first.status, `${label}: same status`);
    assert.equal(r.text, first.text, `${label}: same page, byte for byte`);
    assert.equal(r.headers['set-cookie'], undefined, `${label}: no cookie`);
  }
});

test('issuing a new link revokes the old one; one active link per questionnaire', async () => {
  const ctx = await assessment('Reissue Co');
  await prepare(ctx);
  const first = await createLink(ctx);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-create-link>Issue a new link</);
  const second = await createLink(ctx, { recipient_name: 'Ravi Vendor', recipient_email: 'ravi@thirdparty.example.net', expires_in_days: '7' });
  assert.equal(second.res.status, 200);
  assert.match(second.res.text, /The previous link no longer works/);
  assert.notEqual(first.token, second.token);
  const links = await linksOf(ctx.a);
  assert.deepEqual(links.map(l => [l.status, l.revoke_reason]), [['revoked', 'Replaced by a new link'], ['active', null]]);
  const days = (new Date(links[1].expires_at) - new Date(links[1].created_at)) / 86400000;
  assert.ok(Math.abs(days - 7) < 0.01, 'the firm sets the expiry per link');
  const visitor = vendor();
  try {
    assert.equal((await visitor.get(`/vendor/q/${first.token}`)).status, vendorRoute.INVALID_STATUS);
    assert.equal((await visitor.get(`/vendor/q/${second.token}`)).status, 200);
  } finally { await visitor.close(); }
  const q = await qRow(ctx.a);
  await assert.rejects(db.prepare(`INSERT INTO tp_vendor_requests (workspace_id, assessment_id, questionnaire_id, token_hash, recipient_name,
      recipient_email, expires_at) VALUES (?, ?, ?, ?, 'X', 'x@thirdparty.example.net', now() + interval '1 day')`)
    .run(ctx.ws, ctx.a, q.id, sha('x')), /one_active|duplicate/);
  const bad = await consultant.session.post(`${qBase(ctx)}/links`, { recipient_name: 'X', recipient_email: 'x@thirdparty.example.net',
    expires_in_days: '91', row_version: String(q.row_version) });
  assert.match(toast(bad), /from 1 to 90 days/);
  const noEmail = await consultant.session.post(`${qBase(ctx)}/links`, { recipient_name: 'X', recipient_email: 'nope', row_version: String(q.row_version) });
  assert.match(toast(noEmail), /valid email/);
  assert.equal((await linksOf(ctx.a)).length, 2);
});

test('cancelling the assessment revokes the link and closes the questionnaire; the database refuses a cancel with an active link', async () => {
  const ctx = await assessment('Cancel Co');
  await prepare(ctx);
  await createLink(ctx);
  const res = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/cancel`,
    { row_version: String((await assessmentRow(ctx.a)).row_version), reason: 'Client dropped the vendor' });
  assert.equal(res.status, 302);
  const [link] = await linksOf(ctx.a);
  assert.equal(link.status, 'revoked');
  assert.equal(link.revoke_reason, 'Assessment cancelled');
  assert.equal(Number(link.revoked_by), consultant.id);
  const q = await qRow(ctx.a);
  assert.equal(q.status, 'closed');
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  assert.deepEqual(actions.slice(-3), ['vendor_link.revoked', 'questionnaire.closed', 'assessment.cancelled']);

  const raw = await assessment('Raw Cancel Co');
  await prepare(raw);
  await createLink(raw);
  await assert.rejects(db.prepare(`UPDATE tp_assessments SET status='cancelled', cancelled_at=now(), cancel_reason='x' WHERE id=?`).run(raw.a),
    /revoke the third party/);
});

test('the public link is rate-limited per IP before any lookup', async () => {
  const ctx = await assessment('Limit Co');
  await prepare(ctx);
  const { token } = await createLink(ctx);
  const saved = vendorRoute.limiter.max;
  vendorRoute.limiter.max = 3;
  const visitor = vendor();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await visitor.get(`/vendor/q/${crypto.randomBytes(32).toString('base64url')}`)).status, 404);
    const limited = await visitor.get(`/vendor/q/${token}`);
    assert.equal(limited.status, 429, 'a valid token is refused too once the limit is reached');
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.match(limited.text, /Too many requests/);
    assert.ok(!limited.text.includes('Limit Co'), 'the refusal says nothing about the link');
    assert.equal((await visitor.get('/vendor/q/unknown')).status, 429);
  } finally {
    vendorRoute.limiter.max = saved;
    vendorRoute.limiter.reset();
    await visitor.close();
  }
});

async function recommendationDraft(ctx) {
  const rec = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations`, { row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(rec.status, 302);
  const rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=?').get(ctx.a)).id);
  const saved = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations/${rid}`, {
    outcome: 'approve', residual_rating: 'low', rationale: 'Adequate controls.', valid_until: VALID_UNTIL, intent: 'save',
    row_version: String((await db.prepare('SELECT row_version FROM tp_recommendations WHERE id=?').get(rid)).row_version),
  });
  assert.equal(saved.status, 302);
  return rid;
}

const submitRecommendation = async (ctx, rid) => consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations/${rid}`, {
  outcome: 'approve', residual_rating: 'low', rationale: 'Adequate controls.', valid_until: VALID_UNTIL, intent: 'submit',
  row_version: String((await db.prepare('SELECT row_version FROM tp_recommendations WHERE id=?').get(rid)).row_version),
});

test('a sent questionnaire must be closed before the recommendation goes to review; "Close as not returned" revokes the link and keeps the reason', async () => {
  const ctx = await assessment('Not Returned Co');
  await prepare(ctx);
  const { token } = await createLink(ctx);
  const rid = await recommendationDraft(ctx);

  let page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-questionnaire-blocked>The questionnaire was sent to the third party and is not closed/);
  assert.match(page.text, /data-tprm-not-returned-form/);
  const refused = await submitRecommendation(ctx, rid);
  assert.equal(refused.status, 409);
  assert.match(refused.text, /close it as not returned, before the recommendation is submitted for review/);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_draft');
  assert.equal((await db.prepare('SELECT status FROM tp_recommendations WHERE id=?').get(rid)).status, 'draft');
  await assert.rejects(db.prepare(`UPDATE tp_assessments SET status='recommendation_in_review' WHERE id=?`).run(ctx.a),
    /close the questionnaire review/);

  const q = await qRow(ctx.a);
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/not-returned`, { reason: ' ', row_version: String(q.row_version) })), /Say why/);
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/not-returned`, { reason: 'x', row_version: String(q.row_version - 1) })), /Someone else changed/);
  const closed = await consultant.session.post(`${qBase(ctx)}/not-returned`, { reason: 'No answer after three reminders.', row_version: String(q.row_version) });
  assert.match(toast(closed), /closed as not returned: the link no longer works/);
  const after = await qRow(ctx.a);
  assert.equal(after.status, 'closed');
  assert.equal(after.not_returned, true);
  assert.equal(after.not_returned_reason, 'No answer after three reminders.');
  assert.equal(after.closed_reason, 'Not returned by the third party');
  assert.equal(Number(after.closed_by), consultant.id);
  const [link] = await linksOf(ctx.a);
  assert.equal(link.status, 'revoked');
  assert.equal(link.revoke_reason, 'Questionnaire closed as not returned');
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  assert.deepEqual(actions.slice(-2), ['vendor_link.revoked', 'questionnaire.not_returned']);
  const ev = (await chain(ctx.ws, ctx.a)).pop();
  assert.equal(ev.after_state.not_returned_reason, 'No answer after three reminders.');
  assert.equal((await vendor().get(`/vendor/q/${token}`)).status, 404, 'the link is invalid');
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/not-returned`, { reason: 'Again', row_version: String(after.row_version) })),
    /only a sent questionnaire the third party has not submitted/);
  await assert.rejects(db.prepare(`UPDATE tp_questionnaires SET not_returned_reason='changed' WHERE id=?`).run(after.id), /closed questionnaire cannot be changed|never changes/);

  const ok = await submitRecommendation(ctx, rid);
  assert.equal(ok.status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_in_review');
  page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-not-returned[\s\S]*?Questionnaire not returned: No answer after three reminders\./);
  assert.match(page.text, /data-tprm-not-returned>[\s\S]*?Questionnaire not returned/);
  assert.doesNotMatch(page.text, /data-tprm-not-returned-form|data-tprm-rec-questionnaire-blocked/);
});

test('a questionnaire never sent does not hold up the recommendation; the database guards "not returned"', async () => {
  const ctx = await assessment('Draft Questionnaire Co');
  const q = await prepare(ctx);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.doesNotMatch(page.text, /data-tprm-not-returned-form|data-tprm-rec-questionnaire-blocked/);
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/not-returned`, { reason: 'x', row_version: String(q.row_version) })), /has not been sent/);
  const notReturned = `UPDATE tp_questionnaires SET status='closed', closed_at=now(), closed_reason='Not returned by the third party',
    not_returned=true, not_returned_reason='x' WHERE id=?`;
  await assert.rejects(db.prepare(notReturned).run(q.id), /only a sent questionnaire/);
  const rid = await recommendationDraft(ctx);
  assert.equal((await submitRecommendation(ctx, rid)).status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_in_review');

  const sent = await assessment('Sent Raw Co');
  await prepare(sent);
  await createLink(sent);
  await assert.rejects(db.prepare(notReturned).run((await qRow(sent.a)).id), /revoke the third party's link/);
  await assert.rejects(db.prepare(`UPDATE tp_questionnaires SET not_returned_reason='x' WHERE id=?`).run((await qRow(sent.a)).id),
    /recorded once and never changes/);
});

async function legacyInReview(ctx) {
  const rid = await recommendationDraft(ctx);
  await db.transaction(async () => {
    await db.exec('ALTER TABLE tp_assessments DISABLE TRIGGER tp_assessments_review_questionnaire');
    await db.prepare(`UPDATE tp_recommendations SET status='in_review', submitted_at=now(), row_version=row_version+1 WHERE id=?`).run(rid);
    await db.prepare(`UPDATE tp_assessments SET status='recommendation_in_review', row_version=row_version+1 WHERE id=?`).run(ctx.a);
    await db.exec('ALTER TABLE tp_assessments ENABLE TRIGGER tp_assessments_review_questionnaire');
  })();
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_in_review');
  return rid;
}

test('a legacy recommendation in review with the questionnaire still out: frozen, an active link can still be revoked, and it can be closed as not returned', async () => {
  const ctx = await assessment('Frozen Co');
  await prepare(ctx);
  await createLink(ctx);
  await legacyInReview(ctx);

  const q = await qRow(ctx.a);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-questionnaire-frozen/);
  assert.doesNotMatch(page.text, /data-tprm-link-form/);
  assert.match(page.text, /data-tprm-revoke-form/);
  assert.match(page.text, /data-tprm-not-returned-form/);
  const reissue = await consultant.session.post(`${qBase(ctx)}/links`, { recipient_name: 'X', recipient_email: 'x@thirdparty.example.net', row_version: String(q.row_version) });
  assert.match(toast(reissue), /frozen|cannot be changed or sent/);
  assert.equal((await linksOf(ctx.a)).length, 1);
  const [link] = await linksOf(ctx.a);
  const revoke = await consultant.session.post(`${qBase(ctx)}/links/${link.id}/revoke`, { row_version: String(link.row_version) });
  assert.match(toast(revoke), /Link revoked/);
  assert.equal((await linksOf(ctx.a))[0].revoke_reason, 'Revoked by the firm');
  const closed = await consultant.session.post(`${qBase(ctx)}/not-returned`, { reason: 'Never answered.', row_version: String((await qRow(ctx.a)).row_version) });
  assert.match(toast(closed), /closed as not returned/);
  assert.equal((await qRow(ctx.a)).not_returned, true);
});

test('another client\'s or another firm\'s questionnaire is not found', async () => {
  const mine = await assessment('Isolation Co');
  const q = await prepare(mine);
  await createLink(mine);
  const [link] = await linksOf(mine.a);
  const other = await assessment('Isolation Other Co');
  await prepare(other);
  const cross = await consultant.session.post(`${qBase(other)}/links/${link.id}/revoke`, { row_version: String(link.row_version) });
  assert.equal(cross.status, 404);
  const wrongWs = { ws: other.ws, tp: mine.tp, a: mine.a };
  assert.equal((await consultant.session.post(qBase(wrongWs), {})).status, 404);
  assert.equal((await consultant.session.post(`${qBase(wrongWs)}/modules`, { op: 'add', module: 'AI Services', reason: 'x', row_version: String(q.row_version) })).status, 404);
  const otherFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Other Questionnaire Firm')").run()).lastInsertRowid);
  const outsider = await makeUser('q-outsider@test.local', { role: 'manager', firm: otherFirm });
  const session = await signIn(outsider.email, outsider.password);
  try {
    assert.equal((await allSteps(session, aBase(mine.ws, mine.tp, mine.a))).status, 404);
    assert.equal((await session.post(`${qBase(mine)}/links/${link.id}/revoke`, { row_version: String(link.row_version) })).status, 404);
    assert.equal((await session.post(`${qBase(mine)}/links`, { recipient_name: 'X', recipient_email: 'x@thirdparty.example.net', row_version: '1' })).status, 404);
  } finally { await session.close(); }
  assert.equal((await linksOf(mine.a))[0].status, 'active');
  await assert.rejects(db.prepare(`INSERT INTO tp_vendor_requests (workspace_id, assessment_id, questionnaire_id, token_hash, recipient_name,
      recipient_email, expires_at) VALUES (?, ?, ?, ?, 'X', 'x@thirdparty.example.net', now() + interval '1 day')`)
    .run(other.ws, mine.a, q.id, sha('cross')), /foreign key|violates|needs an open questionnaire/);
  const fks = (await db.prepare(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid IN ('tp_vendor_requests'::regclass, 'tp_questionnaires'::regclass) AND contype = 'f'`).all()).map(r => r.def);
  assert.ok(fks.includes('FOREIGN KEY (workspace_id, assessment_id, questionnaire_id) REFERENCES tp_questionnaires(workspace_id, assessment_id, id)'), fks.join('; '));
  assert.ok(fks.includes('FOREIGN KEY (workspace_id, assessment_id) REFERENCES tp_assessments(workspace_id, id)'), fks.join('; '));
});

test('CSRF is required on every questionnaire form', async () => {
  const ctx = await assessment('CSRF Q Co');
  const q0 = await prepare(ctx);
  const base = qBase(ctx);
  for (const p of [base, `${base}/modules`, `${base}/links`, `${base}/links/1/revoke`]) {
    assert.equal((await client.post(p, { row_version: String(q0.row_version) }, { csrf: false })).status, 403, `${p} without a token`);
    assert.equal((await client.post(p, { _csrf: 'f'.repeat(64), row_version: String(q0.row_version) }, { csrf: false })).status, 403, `${p} forged`);
  }
  assert.equal((await linksOf(ctx.a)).length, 0);
  assert.equal((await qRow(ctx.a)).row_version, q0.row_version);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-link-form[\s\S]*?name="_csrf" value="[a-f0-9]+"/);
  assert.match(page.text, /data-tprm-add-module-form[\s\S]*?name="_csrf" value="[a-f0-9]+"/);
});

test('every change is an event in the assessment chain, the chain verifies, and deleting the client removes it all', async () => {
  const ctx = await assessment('Events Q Co');
  let q = await prepare(ctx);
  await consultant.session.post(`${qBase(ctx)}/modules`, { op: 'add', module: 'Physical & Data Centre', reason: 'Data centre visit', row_version: String(q.row_version) });
  q = await qRow(ctx.a);
  await consultant.session.post(`${qBase(ctx)}/modules`, { op: 'remove', module: 'Physical & Data Centre', reason: 'Not needed', row_version: String(q.row_version) });
  await createLink(ctx, { send_email: '1' });
  await createLink(ctx);
  const [, link] = await linksOf(ctx.a);
  await consultant.session.post(`${qBase(ctx)}/links/${link.id}/revoke`, { row_version: String(link.row_version), reason: 'Contact left' });
  const rows = (await chain(ctx.ws, ctx.a)).filter(e => /^(questionnaire|vendor_link)\./.test(e.action));
  assert.deepEqual(rows.map(e => e.action), [
    'questionnaire.prepared', 'questionnaire.module_added', 'questionnaire.module_removed',
    'questionnaire.sent', 'vendor_link.created', 'vendor_link.emailed',
    'vendor_link.revoked', 'vendor_link.created', 'vendor_link.revoked',
  ]);
  assert.ok(rows.every(e => Number(e.actor_user_id) === consultant.id));
  assert.equal(rows[0].after_state.bank_version, 1);
  assert.equal(rows[0].after_state.vendor_question_count, 133);
  assert.equal(rows[6].after_state.reason, 'Replaced by a new link');
  assert.equal(rows[8].after_state.reason, 'Contact left');
  for (const e of rows) assert.equal(JSON.stringify(e).includes('token'), false, 'no event carries a token or its hash');
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-assessment-history[\s\S]*data-tprm-history-action="vendor_link.revoked"/);
  assert.match(page.text, /data-tprm-history-action="questionnaire.module_added"[\s\S]{0,400}Physical &amp; Data Centre/);

  const name = (await db.prepare('SELECT client_name FROM workspaces WHERE id=?').get(ctx.ws)).client_name;
  assert.equal((await client.post(`/workspaces/${ctx.ws}/delete`, { confirm_name: name })).status, 302);
  for (const table of ['tp_questionnaires', 'tp_vendor_requests', 'tp_events']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ctx.ws)).c, 0, table);
  }
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_question_bank_versions').get()).c, 1, 'the bank stays');
});

test('a questionnaire keeps the bank version it pinned when a newer version is published', async () => {
  const ctx = await assessment('Pinned Co');
  const q1 = await prepare(ctx);
  assert.equal(q1.bank_version, 1);
  const v2 = { ...BANK, version: 'test-v2', questions: BANK.questions.filter(x => x.id !== 'GOV-01') };
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, content, content_sha256, question_count)
    VALUES (2, 'test-v2', ?::jsonb, ?, ?)`).run(JSON.stringify(v2), sha(JSON.stringify(v2)), v2.questions.length);
  await consultant.session.post(`${qBase(ctx)}/modules`, { op: 'add', module: 'AI Services', reason: 'x', row_version: String(q1.row_version) });
  const after = await qRow(ctx.a);
  assert.equal(after.bank_version, 1);
  assert.ok(after.sections.flatMap(s => s.ids).includes('GOV-01'), 'still version 1 questions');
  const other = await assessment('Pinned New Co');
  const q2 = await prepare(other);
  assert.equal(q2.bank_version, 2);
  assert.ok(!q2.sections.flatMap(s => s.ids).includes('GOV-01'));
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-bank-version>Version 1</);
});
