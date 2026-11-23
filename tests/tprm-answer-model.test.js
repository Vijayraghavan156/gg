'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-am-outbox-')), 'outbox.log');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { completeAnswer, answerFormFields, bootClient, makeClient } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const BANK_FILE = path.join(ROOT, 'data', 'tprm-question-bank.json');
const BANK = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
const BANK_BY_ID = new Map(BANK.questions.map(q => [q.id, q]));
const V4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tprm-question-bank-v4.json'), 'utf8'));
const V4_BY_ID = new Map(V4.questions.map(q => [q.id, q]));
const rulesLib = require('../lib/tprm/answer-rules');

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let events;
let vendorRoute;
const createdPaths = new Set();

const PASSWORD = 'answer-model-tests-password-1234';
const LOW = {
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no',
};
const SOC2_COVERED = ['IAM-01', 'INC-01', 'ORG-02'];

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  events = require('../lib/tprm/events');
  vendorRoute = require('../routes/tprm-vendor');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('am-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('am-senior@test.local', { role: 'senior_consultant' });
  for (const u of [consultant, senior]) u.session = await signIn(u.email, u.password);
});

test.after(async () => {
  for (const p of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  for (const u of [consultant, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

test.beforeEach(() => {
  if (vendorRoute) { vendorRoute.limiter.reset(); vendorRoute.postLimiter.reset(); }
});

async function makeUser(email, { role = 'consultant' } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, 'firm', firmId, role)).lastInsertRowid);
  return { id, email, password: PASSWORD, firm_role: role };
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

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  return id;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const qBase = ctx => `${aBase(ctx.ws, ctx.tp, ctx.a)}/questionnaire`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const qRow = async a => db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(a);
const answerOf = async (a, qid) => db.prepare('SELECT * FROM tp_answers WHERE assessment_id=? AND question_id=?').get(a, qid);
const answersOf = async a => db.prepare('SELECT * FROM tp_answers WHERE assessment_id=? ORDER BY question_id').all(a);
const reportsOf = async a => db.prepare('SELECT * FROM tp_assurance_reports WHERE assessment_id=? ORDER BY kind').all(a);
const clarsOf = async a => db.prepare('SELECT * FROM tp_clarifications WHERE assessment_id=? ORDER BY id').all(a);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);
const idsOf = q => q.sections.flatMap(s => s.ids);
const firmPage = (ctx, query = '') => consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}${query}`);

async function addThirdParty(ws, name) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosted service' })).status, 302);
  return tp;
}

async function startAssessment(ws, tp, answers = LOW) {
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(answers)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  return a;
}

async function createLink(ctx) {
  const row = await qRow(ctx.a);
  const res = await consultant.session.post(`${qBase(ctx)}/links`, {
    recipient_name: 'Asha Vendor', recipient_email: 'asha@thirdparty.example.net', row_version: String(row.row_version),
  });
  const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
  return url ? url.split('/vendor/q/')[1] : null;
}

async function linked(name, { ws = null, answers = LOW } = {}) {
  const wsId = ws || await tprmClient(`${name} Client`);
  const tp = await addThirdParty(wsId, name);
  const a = await startAssessment(wsId, tp, answers);
  const ctx = { ws: wsId, tp, a };
  assert.equal((await consultant.session.post(qBase(ctx), {})).status, 302);
  ctx.token = await createLink(ctx);
  assert.ok(ctx.token);
  return ctx;
}

function request(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = env.app.listen(0, '127.0.0.1', () => {
      const h = { ...headers };
      if (body != null && h['content-length'] == null) h['content-length'] = Buffer.byteLength(body);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: urlPath, headers: h }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), location: res.headers.location || null });
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}

const vget = (token, query = '') => request('GET', `/vendor/q/${token}${query}`);
const aftOf = text => (String(text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];
async function vsection(ctx, id) {
  const q = await qRow(ctx.a);
  const index = q.sections.findIndex(s => s.ids.includes(id));
  return { index: index + 1, page: await vget(ctx.token, `?s=${index + 1}`) };
}

function multipart(fields, files = []) {
  const boundary = '----tprmam' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of fields) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${f.field}"; filename="${f.filename}"`,
      `Content-Type: ${f.type || 'application/octet-stream'}`, '', f.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function answerFields(answers) {
  return answerFormFields(answers, BANK_BY_ID);
}

async function save(token, answers, { files = [], intent = 'save', section = null, go = null, jump = null } = {}) {
  const fields = [['_aft', aftOf((await vget(token, '?s=1')).text)]];
  if (section) fields.push(['section', String(section)]);
  fields.push(...answerFields(answers));
  if (jump !== null) fields.push(['jump', jump], ['go', 'jump']);
  else fields.push(go ? ['go', go] : ['intent', intent]);
  const form = multipart(fields, files);
  const res = await request('POST', `/vendor/q/${token}/save`, { body: form.body, headers: form.headers });
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(r.stored_path);
  return res;
}

const PDF = label => `%PDF-1.4\n% ${label}\n`;
async function uploadReport(token, kind, fields = {}, files = null) {
  const defaults = kind === 'iso27001'
    ? [{ field: 'report_file', filename: 'iso-certificate.pdf', content: PDF('certificate'), type: 'application/pdf' },
      { field: 'soa_file', filename: 'statement-of-applicability.pdf', content: PDF('soa'), type: 'application/pdf' }]
    : [{ field: 'report_file', filename: 'soc2-type2.pdf', content: PDF(`soc2 ${crypto.randomBytes(4).toString('hex')}`), type: 'application/pdf' }];
  const form = multipart([['_aft', aftOf((await vget(token)).text)], ['kind', kind], ...Object.entries(fields)], files || defaults);
  const res = await request('POST', `/vendor/q/${token}/reports`, { body: form.body, headers: form.headers });
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(r.stored_path);
  return res;
}

async function submitLink(token) {
  const body = new URLSearchParams([['_aft', aftOf((await vget(token, '?s=1')).text)], ['confirm_submit', '1']]).toString();
  return await request('POST', `/vendor/q/${token}/submit`, { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
}

async function answerAll(ctx, { bare = [], overrides = {} } = {}) {
  const q = await qRow(ctx.a);
  const answers = {};
  for (const id of idsOf(q)) {
    const row = BANK_BY_ID.get(id) || {};
    const ev = bare.includes(id) ? {} : { ref: `Doc for ${id}`, date: '2026-01-15' };
    answers[id] = completeAnswer(row, id, ev);
  }
  answers['AIS-01'] = { r: 'no', d: 'No AI is used.' };
  Object.assign(answers, overrides);
  const res = await save(ctx.token, answers);
  assert.equal(res.status, 303, `saved (${res.status}: ${(res.text.match(/data-vendor-errors[\s\S]{0,400}/) || [''])[0]})`);
}

async function submittedWithReports(name, { iso = false } = {}) {
  const ctx = await linked(name);
  assert.equal((await uploadReport(ctx.token, 'soc2_type2', { period_end: '2026-06-30' })).status, 303);
  if (iso) assert.equal((await uploadReport(ctx.token, 'iso27001', { expires_on: '2099-01-31', scope: 'Hosting of the service in Mumbai' })).status, 303);
  await answerAll(ctx, { bare: SOC2_COVERED });
  const res = await submitLink(ctx.token);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  return ctx;
}

const checkReport = async (ctx, kind, body) => {
  const r = (await reportsOf(ctx.a)).find(x => x.kind === kind);
  return consultant.session.post(`${qBase(ctx)}/reports/${r.id}/check`, { row_version: String(r.row_version), ...body });
};

test('bank version 2: answer types, benchmarks out of the wording, report coverage and the evidence flags', async () => {
  const types = new Set(V4.questions.map(q => q.answer_type));
  assert.deepEqual([...types].sort(), ['free_text', 'yes_no_na']);
  assert.equal(V4.questions.filter(q => q.answer_type === 'free_text').length, 104);
  for (const q of V4.questions) {
    assert.doesNotMatch(q.question, /\((expected|required):|expects|requires at least/i, `${q.id}: no benchmark in the wording`);
    assert.ok(rulesLib.COVERAGES.includes(q.report_coverage), q.id);
  }
  assert.equal(V4_BY_ID.get('GOV-01').benchmark, 'At least annually.');
  assert.equal(V4.questions.filter(q => q.benchmark).length, 64);
  assert.equal(V4.questions.filter(q => q.report_coverage === 'iso').length, 4);
  assert.equal(V4.questions.filter(q => q.report_coverage === 'soc2').length, 15);
  assert.equal(V4.questions.filter(q => q.report_coverage === 'either').length, 14);
  assert.equal(V4.questions.filter(q => q.report_coverage === 'both').length, 0);
  for (const id of ['UAE-03', 'RBI-03', 'AIM-18']) assert.equal(V4_BY_ID.get(id).evidence_mandatory, true, id);
  assert.equal(V4_BY_ID.get('IND-07').evidence_mandatory, false);
  assert.deepEqual([V4_BY_ID.get('PFR-02').evidence_on, V4_BY_ID.get('PFR-02').explain_on], ['no', ['yes', 'na']]);
  assert.ok(V4_BY_ID.get('AIM-21'), 'AIM-08 is split: AIM-21 asks the second part');
  const latest = await db.prepare('SELECT content, content_sha256 FROM tp_question_bank_versions ORDER BY version DESC LIMIT 1').get();
  assert.equal(latest.content_sha256, crypto.createHash('sha256').update(fs.readFileSync(BANK_FILE)).digest('hex'));
  assert.ok(rulesLib.bankTyped(latest.content));
});

test('bank version 3: the hosting module has its own name; the third party\'s text carries no internal notes', async () => {
  assert.match(V4.version, /version [34]$/);
  const assembly = require('../lib/tprm/questionnaire-assembly');
  const modules = assembly.moduleCatalog(V4);
  assert.ok(modules.includes('Hosting Platform & Cloud Provider'));
  assert.ok(!modules.includes('Cloud & Hosting'));
  assert.equal(V4.questions.filter(q => q.pack === 'Hosting Platform & Cloud Provider').length, 12);
  assert.equal(V4.questions.filter(q => q.set === 'Base' && q.domain === 'Cloud & Hosting Security').length, 6, 'the base domain keeps its name');
  assert.ok(V4.module_triggers.some(t => t.module === 'Hosting Platform & Cloud Provider'));
  assert.deepEqual(V4.contract_checklist.filter(c => c.module === 'Hosting Platform & Cloud Provider').map(c => c.id), ['CT-39', 'CT-40', 'CT-41']);
  assert.ok(V4.questions.every(q => !('report_partly_supported' in q)), 'nothing reads it since extra waivers went');
  const internal = /unverified|\bverif(y|ied)\b before|confirm (it )?before relying|para refs|Nuvama|\(see [A-Z]{2,6}-\d+\)|\b(covered by|see|Base question) [A-Z]{2,6}-\d+|\bArt \d|\bCFR \d|\bNYCRR\b|\bRTS 20|\bReq\. \d|§|\bthe consultant should\b|\breassessment\b|raises the [\w' ]*tier|\brecommendation\b|as at \w+ 20\d\d|\babout May 2027|\[|\]|,,/i;
  for (const q of V4.questions) {
    if (q.answered_by === 'Consultant') continue;
    for (const f of ['question', 'guidance', 'evidence']) {
      if (q[f] == null) continue;
      if (q.id === 'IND-06' && f === 'question') continue;
      assert.doesNotMatch(q[f], internal, `${q.id}.${f}: ${q[f]}`);
    }
  }
  assert.equal(V4_BY_ID.get('UAE-03').guidance, null);
  assert.match(V4_BY_ID.get('UAE-03').benchmark, /not yet verified/);
  assert.match(V4_BY_ID.get('DOR-02').benchmark, /^Basis: DORA Art 30\(2\)\(b\)\.$/);
  assert.match(V4_BY_ID.get('AIM-08').benchmark, /tier to at least High/);
  const rows = await db.prepare('SELECT content_sha256 FROM tp_question_bank_versions ORDER BY version').all();
  assert.equal(rows[rows.length - 1].content_sha256, crypto.createHash('sha256').update(fs.readFileSync(BANK_FILE)).digest('hex'));
});

test('bank version 4: no Indian client assumed in base and module questions; answer hints fit the control; UAE-03 names no number', async () => {
  assert.match(V4.version, /version 4$/);
  assert.ok(fs.existsSync(path.join(ROOT, 'migrations', '119_tprm_bank_v4.js')), 'migration 119 publishes it');
  const VENDOR_FIELDS = ['question', 'guidance', 'evidence', 'theme', 'domain', 'pack'];
  const india = /\bIndia|\bIndian\b|\bRBI\b|\bSEBI\b|CERT-In|\bDPDP|Data Principal|\bIRDAI\b|\bIFSCA\b|\bPFRDA\b|\bMeitY\b|\bNPCI\b/i;
  for (const q of V4.questions.filter(x => x.set === 'Base' || x.set === 'Module')) {
    for (const f of VENDOR_FIELDS) if (q[f] != null) assert.doesNotMatch(q[f], india, `${q.id}.${f}: ${q[f]}`);
  }
  for (const q of V4.questions.filter(x => x.answer_type === 'yes_no_na')) {
    for (const f of VENDOR_FIELDS) if (q[f] != null) assert.doesNotMatch(q[f], /\bAnswer:/, `${q.id}.${f}: ${q[f]}`);
  }
  for (const q of V4.questions.filter(x => x.answer_type === 'free_text')) {
    assert.deepEqual([q.evidence_on, q.explain_on], ['answer', ['na']], q.id);
  }
  const Q = id => V4_BY_ID.get(id);
  assert.match(Q('GOV-06').guidance, /laws and regulations that apply/);
  assert.match(Q('GOV-06').benchmark, /Indian financial-sector rules/);
  assert.match(Q('LOG-03').guidance, /retention period required by applicable law/);
  assert.match(Q('LOG-03').benchmark, /rolling 180 days/);
  assert.match(Q('PRM-06').guidance, /outside <Client>'s country/);
  assert.match(Q('PRM-06').benchmark, /outside India/);
  assert.equal(Q('REG-07').guidance, 'Disclose any such relationship. Any exception needs approval under <Client>\'s governance.');
  assert.match(Q('REG-07').benchmark, /RBI-regulated client.*Board or a Board-level committee/);
  assert.doesNotMatch(Q('PRV-06').question, /Principal/);
  assert.match(Q('PRV-06').benchmark, /Data Principal/);
  assert.deepEqual([Q('PRV-06').theme, Q('PRM-04').theme], ['Data subject rights', 'Data subject rights']);
  const shape = id => [Q(id).answer_type, Q(id).evidence_on, Q(id).explain_on];
  assert.deepEqual(shape('AIM-02'), ['yes_no_na', 'no', ['yes', 'na']], 'AIM-02: the contract clause backs a No; a Yes is explained');
  assert.match(Q('AIM-02').question, /without <Client>'s written opt-in\?$/);
  assert.deepEqual(shape('AIM-17'), ['yes_no_na', 'yes', ['no', 'na']]);
  assert.match(Q('AIM-17').guidance, /^If you can list only some of them, answer No/);
  assert.deepEqual(shape('PCI-01'), ['yes_no_na', 'yes', ['no', 'na']]);
  assert.match(Q('PCI-01').benchmark, /QSA Report on Compliance.*To be verified/);
  assert.deepEqual(shape('RBI-02'), ['yes_no_na', 'yes', ['no', 'na']], 'RBI-02 keeps Yes / No: the data-location check flags a No');
  assert.match(Q('RBI-02').guidance, /^If No, list the other countries/);
  assert.deepEqual(shape('RBI-07'), ['free_text', 'answer', ['na']]);
  assert.match(Q('RBI-07').guidance, /^Say which: both, only the certificate, only the source code or escrow, or neither\.$/);
  assert.deepEqual(shape('SEB-04'), ['free_text', 'answer', ['na']]);
  assert.match(Q('SEB-04').question, /and to how many\?$/);
  assert.equal(Q('SEB-04').evidence_mandatory, false);
  assert.deepEqual(shape('AIM-10'), ['free_text', 'answer', ['na']]);
  assert.match(Q('AIM-10').guidance, /date of the last test/);
  const rulebooks = require('../lib/tprm/rulebooks');
  assert.deepEqual(rulebooks.DATA_LOCATION_QUESTIONS['RBI-02'].flagOn, ['no', 'partial']);
  assert.equal(Q('UAE-03').question, 'Within how many hours of a material incident will you alert <Client>?');
  for (const f of VENDOR_FIELDS) if (Q('UAE-03')[f] != null) assert.doesNotMatch(Q('UAE-03')[f], /\d+\s*hours|Central Bank/i, f);
  assert.match(Q('UAE-03').benchmark, /To be verified: .*Central Bank within 4 hours/);
  const vendorAnswers = require('../lib/tprm/vendor-answers');
  const v3 = { ...Q('SEB-04'), answer_type: 'yes_no_na', evidence_on: 'yes', explain_on: ['no', 'na'] };
  assert.deepEqual(rulesLib.questionRules(v3).responses, ['yes', 'no', 'na']);
  assert.deepEqual(rulesLib.questionRules(Q('SEB-04')).responses, ['text', 'na']);
  assert.equal(vendorAnswers.normalisedCopy(rulesLib.questionRules(Q('SEB-04')), { response: 'yes', detail: null }), null);
  assert.equal(vendorAnswers.normalisedCopy(rulesLib.questionRules(Q('AIM-02')), { response: 'yes', detail: null }), null,
    'a Yes on AIM-02 now needs an explanation');
  const aimNo = vendorAnswers.normalisedCopy(rulesLib.questionRules(Q('AIM-02')), { response: 'no', detail: 'Contract clause 9', evidence_ref: null, evidence_date: null });
  assert.deepEqual([aimNo.response, aimNo.detail], ['no', null], 'a No needs no explanation now; its evidence is asked for');
});

test('a renamed module: assembly names it as the pinned bank does; the contract checklist matches either name', () => {
  const assembly = require('../lib/tprm/questionnaire-assembly');
  const CR = require('../lib/tprm/contract-review');
  const v2 = withOldModuleName(BANK);
  assert.deepEqual(assembly.autoModules({}, 'vendor_hosted', v2).map(m => m.module), ['Cloud & Hosting']);
  assert.deepEqual(assembly.autoModules({}, 'vendor_hosted', BANK).map(m => m.module), ['Hosting Platform & Cloud Provider']);
  assert.equal(assembly.moduleNameIn(v2, 'Hosting Platform & Cloud Provider'), 'Cloud & Hosting');
  assert.ok(assembly.sameModule('Cloud & Hosting', 'Hosting Platform & Cloud Provider'));
  assert.ok(!assembly.sameModule('Cloud & Hosting Security', 'Hosting Platform & Cloud Provider'));
  const r = assembly.assemble(v2, { tier: 'low', deliveryModel: 'vendor_hosted', modules: ['Cloud & Hosting'] });
  assert.deepEqual(r.sections.filter(s => s.kind === 'module').map(s => [s.title, s.ids.length]), [['Cloud & Hosting', 12]]);
  assert.throws(() => assembly.assemble(v2, { tier: 'low', deliveryModel: 'vendor_hosted', modules: ['Hosting Platform & Cloud Provider'] }), /not a module/);
  const clause = { clause_id: 'CT-39', conditional: true, module: 'Cloud & Hosting', applies_to: 'All clients (good practice)', status: 'not_reviewed' };
  assert.equal(CR.visibleRows([clause], ['Hosting Platform & Cloud Provider']).length, 1);
  assert.equal(CR.visibleRows([{ ...clause, module: 'Hosting Platform & Cloud Provider' }], ['Cloud & Hosting']).length, 1);
  assert.equal(CR.visibleRows([clause], ['Personal Data & Privacy']).length, 0);
});

function withOldModuleName(bank) {
  const rename = n => (n === 'Hosting Platform & Cloud Provider' ? 'Cloud & Hosting' : n);
  return {
    ...bank,
    questions: bank.questions.map(q => (q.set === 'Module' ? { ...q, pack: rename(q.pack), domain: rename(q.domain) } : q)),
    module_triggers: bank.module_triggers.map(t => ({ ...t, module: rename(t.module) })),
    contract_checklist: bank.contract_checklist.map(c => ({ ...c, module: rename(c.module) })),
  };
}

test('the evidence rule (on version 4): evidence_on and explain_on, PFR-02 on No, written answers, the waiver coverage', () => {
  const vendorAnswers = require('../lib/tprm/vendor-answers');
  const R = id => rulesLib.questionRules(V4_BY_ID.get(id));
  assert.deepEqual(R('GOV-02').responses, ['yes', 'no', 'na']);
  assert.deepEqual(R('GOV-01').responses, ['text', 'na']);
  assert.deepEqual(rulesLib.questionRules({ evidence_mandatory: true }).responses, ['yes', 'partial', 'no', 'na'], 'a bank without answer types');
  const pfr = R('PFR-02');
  assert.deepEqual([pfr.evidenceOn, pfr.explainOn], [['no'], ['yes', 'na']]);
  assert.equal(rulesLib.vendorBadge(pfr, 'PFR-02').label, 'Evidence required if No');
  const q = { sections: [{ ids: ['PFR-02', 'GOV-01', 'GOV-02'] }] };
  const check = (answers, files = new Map(), reports = []) => vendorAnswers.submissionProblems(q, V4, new Map(Object.entries(answers)), files, reports)
    .map(p => `${p.id}:${p.kind}`);
  assert.deepEqual(check({
    'PFR-02': { response: 'no' }, 'GOV-01': { response: 'text', detail: 'Yearly' }, 'GOV-02': { response: 'no', detail: 'None yet' },
  }), ['PFR-02:evidence', 'GOV-01:evidence'], 'PFR-02: the written commitment backs a No; a written answer needs its evidence');
  assert.deepEqual(check({
    'PFR-02': { response: 'yes' }, 'GOV-01': { response: 'na', detail: 'Not ours' }, 'GOV-02': { response: 'yes', evidence_ref: 'Org chart' },
  }), ['PFR-02:explain'], 'PFR-02: a Yes is explained, needs no evidence; N/A needs no evidence');
  assert.deepEqual(check({
    'PFR-02': { response: 'no', evidence_ref: 'Board letter' }, 'GOV-01': { response: 'text', detail: 'Yearly' }, 'GOV-02': { response: 'yes' },
  }, new Map([['GOV-01', [{ id: 1 }]]])), ['GOV-02:evidence']);
  const rulesOf = id => R(id);
  const parsed = vendorAnswers.parseAnswerForm({
    r: { 'PFR-02': 'no', 'GOV-02': 'yes' }, d: { 'PFR-02': 'stale', 'GOV-02': 'stale' }, ref: { 'PFR-02': 'Letter', 'GOV-02': 'Chart' },
    t: { 'GOV-01': 'Every year' },
  }, [], ['PFR-02', 'GOV-02', 'GOV-01'], rulesOf);
  assert.deepEqual(parsed.posted.get('PFR-02'), { response: 'no', detail: '', evidence_ref: 'Letter', evidence_date: '', confirm: false, fields: null });
  assert.deepEqual(parsed.posted.get('GOV-02'), { response: 'yes', detail: '', evidence_ref: 'Chart', evidence_date: '', confirm: false, fields: null });
  assert.deepEqual(parsed.posted.get('GOV-01'), { response: 'text', detail: 'Every year', evidence_ref: '', evidence_date: '', confirm: false, fields: null });
  assert.throws(() => vendorAnswers.parseAnswerForm({ r: { 'PFR-02': 'yes' } }, [], ['PFR-02'], rulesOf), /Explain your answer/);
  assert.equal(vendorAnswers.normalisedCopy(pfr, { response: 'yes', detail: null }), null, 'a Yes without the explanation PFR-02 needs');
  assert.equal(vendorAnswers.normalisedCopy(R('AIM-08'), { response: 'yes', detail: '' }), null);
  assert.deepEqual(vendorAnswers.normalisedCopy(pfr, { response: 'no', detail: 'old note', evidence_ref: 'Letter', evidence_date: '2026-01-01' }),
    { response: 'no', detail: null, fields: null, evidence_ref: 'Letter', evidence_date: '2026-01-01' });
  assert.equal(vendorAnswers.normalisedCopy(R('GOV-02'), { response: 'partial', detail: 'x' }), null);
  assert.equal(vendorAnswers.normalisedCopy(R('GOV-01'), { response: 'yes', detail: 'x' }), null);
  assert.throws(() => vendorAnswers.parseAnswerForm({ r: { 'GOV-02': 'partial' } }, [], ['GOV-02'], rulesOf), /Partially is not an answer/);
  assert.throws(() => vendorAnswers.parseAnswerForm({ t: { 'GOV-02': 'x' } }, [], ['GOV-02'], rulesOf), /does not belong/);
  const iso = { kind: 'iso27001', check_status: 'pending', exception_question_ids: [] };
  const soc = { kind: 'soc2_type2', check_status: 'accepted', exception_question_ids: ['X-1'] };
  const cov = c => rulesLib.questionRules({ answer_type: 'yes_no_na', evidence_mandatory: true, report_coverage: c });
  assert.deepEqual(rulesLib.coveringKinds(cov('iso'), 'Q-1', [soc]), []);
  assert.deepEqual(rulesLib.coveringKinds(cov('soc2'), 'Q-1', [soc]), ['soc2_type2']);
  assert.deepEqual(rulesLib.coveringKinds(cov('soc2'), 'X-1', [soc]), [], 'an exception is not covered');
  assert.deepEqual(rulesLib.coveringKinds(cov('either'), 'Q-1', [iso]), ['iso27001']);
  assert.deepEqual(rulesLib.coveringKinds(cov('both'), 'Q-1', [iso]), [], 'both needs both reports');
  assert.deepEqual(rulesLib.coveringKinds(cov('both'), 'Q-1', [iso, soc]), ['iso27001', 'soc2_type2']);
  assert.deepEqual(rulesLib.coveringKinds(cov('iso'), 'Q-1', [{ ...iso, check_status: 'rejected' }]), [], 'a rejected report covers nothing');
  const state = (extra) => rulesLib.evidenceState({ rules: cov('either'), questionId: 'Q-1', response: 'yes', ...extra }).key;
  assert.equal(state({ reports: [iso, soc] }), 'waived_both');
  assert.equal(state({ reports: [] }), 'missing');
  assert.equal(state({ reports: [], extraWaiver: true }), 'missing', 'there are no extra waivers (migration 117)');
  assert.ok(!('extra_waiver' in rulesLib.STATES));
  assert.ok(!rulesLib.WAIVED.includes('extra_waiver'));
  assert.equal(state({ reports: [], request: { status: 'open', responded: false } }), 'requested');
  assert.equal(state({ reports: [], request: { status: 'answered', responded: true } }), 'provided_in_clarification');
  assert.equal(state({ ownEvidence: true }), 'provided');
  assert.equal(rulesLib.evidenceState({ rules: cov('either'), questionId: 'Q-1', response: 'no' }).key, 'not_needed');
  assert.equal(rulesLib.questionRules({ answer_type: 'yes_no_na', report_coverage: 'iso', report_partly_supported: true }).partlySupported, undefined,
    'partly supported questions need their own evidence like any other: nothing reads the flag');
});

test('no Partially on bank version 2, written answers as response text, in the domain and the database', async () => {
  const ctx = await linked('Types Co');
  const refused = await save(ctx.token, { 'GOV-02': { r: 'partial', d: 'Half done' } });
  assert.equal(refused.status, 400);
  assert.match(refused.text, /Partially is not an answer to this question/);
  assert.equal(await answerOf(ctx.a, 'GOV-02'), undefined);
  assert.equal((await save(ctx.token, { 'FTP-01': { t: 'Every year, by the board.' }, 'ORG-03': { r: 'na', d: 'No staff of ours touch the service.' } })).status, 303);
  const gov = await answerOf(ctx.a, 'FTP-01');
  assert.deepEqual([gov.response, gov.detail], ['text', 'Every year, by the board.']);
  const org = await answerOf(ctx.a, 'ORG-03');
  assert.deepEqual([org.response, org.detail], ['na', 'No staff of ours touch the service.']);
  const { page } = await vsection(ctx, 'FTP-01');
  assert.match(page.text, /name="t\[FTP-01\]"[^>]*>Every year, by the board\.<\/textarea>/);
  const orgPage = (await vsection(ctx, 'ORG-03')).page;
  assert.match(orgPage.text, /data-vendor-na[^>]*type="checkbox" name="r\[ORG-03\]" value="na" checked/);
  const q = await qRow(ctx.a);
  await assert.rejects(db.prepare("UPDATE tp_answers SET response='partial', detail='x' WHERE id=?").run(gov.id), /takes a written answer or Not applicable/);
  await assert.rejects(db.prepare("UPDATE tp_answers SET response='yes' WHERE id=?").run(gov.id), /takes a written answer/);
  await assert.rejects(db.prepare("UPDATE tp_answers SET detail=NULL WHERE id=?").run(gov.id), /tp_answers_detail/);
  await assert.rejects(db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response, detail)
    VALUES (?, ?, ?, 'GOV-02', 'partial', 'x')`).run(ctx.ws, ctx.a, q.id), /no Partially/);
  await assert.rejects(db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response)
    VALUES (?, ?, ?, 'GOV-02', 'no')`).run(ctx.ws, ctx.a, q.id), /tp_answers_detail.*explanation/);
  await assert.rejects(db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response, detail)
    VALUES (?, ?, ?, 'GOV-02', 'text', 'x')`).run(ctx.ws, ctx.a, q.id), /Yes, No or Not applicable/);
  assert.equal((await save(ctx.token, { 'GOV-02': { r: 'yes', d: 'left over', ref: 'Org chart' } })).status, 303);
  const g2 = await answerOf(ctx.a, 'GOV-02');
  assert.deepEqual([g2.response, g2.detail, g2.evidence_ref], ['yes', null, 'Org chart']);
});

test('saving one section leaves the other sections as they are; Save stays, Save and continue moves on', async () => {
  const ctx = await linked('Sections Co');
  const q = await qRow(ctx.a);
  const [s1, s2] = q.sections;
  assert.equal((await save(ctx.token, { 'GOV-02': { r: 'yes', ref: 'Chart' } }, { section: 1 })).status, 303);
  const other = await save(ctx.token, { 'ORG-02': { r: 'no', d: 'Not all contractors signed yet.' } }, { section: 2, intent: 'next' });
  assert.equal(other.status, 303);
  assert.match(other.location, /\?s=3&notice=saved$/, 'Save and continue goes to the next section');
  const form = {};
  for (const id of s1.ids) form[id] = id === 'GOV-02' ? { r: 'no', d: 'Changed my mind.' } : {};
  const stay = await save(ctx.token, form, { section: 1 });
  assert.match(stay.location, /\?s=1&notice=saved$/, 'Save stays on the section');
  assert.equal((await answerOf(ctx.a, 'GOV-02')).response, 'no');
  const org = await answerOf(ctx.a, 'ORG-02');
  assert.deepEqual([org.response, org.detail], ['no', 'Not all contractors signed yet.'], 'section 2 untouched');
  assert.ok(s2.ids.includes('ORG-02'));
  const last = q.sections.length;
  const lastId = q.sections[last - 1].ids[0];
  const end = await save(ctx.token, { [lastId]: BANK_BY_ID.get(lastId).answer_type === 'free_text' ? { t: 'x' } : { r: 'yes' } }, { section: last, intent: 'next' });
  assert.match(end.location, /\?view=review&notice=saved$/);
  const review = await request('GET', end.location);
  assert.match(review.text, /data-vendor-view="confirm"/);
  assert.match(review.text, /data-vendor-review-section="Governance, Risk &amp; Compliance"/);
  assert.match(review.text, /data-vendor-problem="GOV-01" data-vendor-problem-kind="unanswered"/);
  const sectionPage = await vget(ctx.token, '?s=1');
  assert.match(sectionPage.text, /data-vendor-section-link="Organisational &amp; Personnel Security"/);
  assert.match(sectionPage.text, /aria-current="page" data-vendor-section-link="Governance, Risk &amp; Compliance"/);
  const before = (await chain(ctx.ws, ctx.a)).length;
  for (let i = 1; i <= 3; i++) await vget(ctx.token, `?s=${i}`);
  await vget(ctx.token, '?view=review');
  assert.equal((await chain(ctx.ws, ctx.a)).length, before);
});

test('leaving a section saves it first: the section list, the picker, Previous and Review are submit buttons of its form', async () => {
  const ctx = await linked('Navigation Co');
  const q = await qRow(ctx.a);
  const page = (await vget(ctx.token, '?s=2')).text;
  assert.match(page, /<form method="POST" action="\/vendor\/q\/[^"]+\/save"[^>]*id="vq-answer-form" data-vendor-answer-form>/);
  const navButtons = page.match(/<button type="submit" form="vq-answer-form" name="go" value="[^"]+" formnovalidate data-vendor-nav="(start|section|review)"/g) || [];
  assert.equal(navButtons.length, 2 * (q.sections.length + 2), 'the sticky list and the picker: start, every section, review');
  assert.match(page, /name="go" value="start" formnovalidate data-vendor-nav="start"/);
  assert.match(page, /name="go" value="review" formnovalidate data-vendor-nav="review"/);
  assert.match(page, new RegExp(`name="go" value="${q.sections[1].ids[0]}" formnovalidate data-vendor-nav="section"[^>]*aria-current="page" data-vendor-section-link=`));
  assert.match(page, new RegExp(`type="submit" name="go" value="${q.sections[0].ids[0]}" formnovalidate data-vendor-prev>Previous section</button>`));
  assert.doesNotMatch(page, /<a data-vendor-nav=/);
  assert.doesNotMatch(page, /Use Save before you leave/);
  assert.ok(page.indexOf('data-vendor-default-submit') < page.indexOf('name="go"'));
  for (const other of [await vget(ctx.token), await vget(ctx.token, '?view=review')]) {
    assert.match(other.text, /<a data-vendor-nav="section"[^>]*href="\/vendor\/q\/[^"]+\?s=1"/);
    assert.doesNotMatch(other.text, /name="go"/);
  }
  const target = q.sections[3];
  let res = await save(ctx.token, { 'ORG-02': { r: 'no', d: 'Contractors sign from next month.' } }, { section: 2, go: target.ids[0] });
  assert.equal(res.status, 303);
  assert.match(res.location, /\?s=4&notice=saved$/);
  assert.deepEqual([(await answerOf(ctx.a, 'ORG-02')).response, (await answerOf(ctx.a, 'ORG-02')).detail], ['no', 'Contractors sign from next month.']);
  res = await save(ctx.token, { 'ORG-03': { t: 'Yearly, tracked in the LMS.' } }, { section: 2, go: 'review' });
  assert.match(res.location, /\?view=review&notice=saved$/);
  assert.equal((await answerOf(ctx.a, 'ORG-03')).response, 'text', 'missing evidence does not stop you moving on');
  res = await save(ctx.token, { 'ORG-02': { r: 'yes', ref: 'NDA register' } }, { section: 2, go: 'start' });
  assert.match(res.location, /\/vendor\/q\/[^?]+\?notice=saved$/);
  const before = (await chain(ctx.ws, ctx.a)).length;
  res = await save(ctx.token, {}, { section: 2, go: q.sections[0].ids[0] });
  assert.match(res.location, /\?s=1&notice=saved$/);
  assert.equal((await chain(ctx.ws, ctx.a)).length, before);
  res = await save(ctx.token, {}, { section: 2, go: 'https://example.net/' });
  assert.match(res.location, /^\/vendor\/q\/[^?]+\?s=2&notice=saved$/);
  const sectionPage = (await vget(ctx.token, '?s=2')).text;
  assert.match(sectionPage, /<select class="vq-input vq-jump-select" id="vq-jump" name="jump">/);
  assert.ok(sectionPage.includes(`<option value="${q.sections[1].ids[0]}" selected>Section 2 of ${q.sections.length}: `), 'the current section is chosen');
  assert.match(sectionPage, /name="go" value="jump" formnovalidate data-vendor-jump-go>Save and go</);
  res = await save(ctx.token, { 'ORG-03': { t: 'Yearly, by the LMS.' } }, { section: 2, jump: q.sections[2].ids[0] });
  assert.match(res.location, /\?s=3&notice=saved$/);
  assert.match((await answerOf(ctx.a, 'ORG-03')).detail, /Yearly, by the LMS\./, 'the dropdown saves before it goes');
  res = await save(ctx.token, {}, { section: 2, jump: 'review' });
  assert.match(res.location, /\?view=review&notice=saved$/);
  res = await save(ctx.token, {}, { section: 2, jump: 'https://example.net/' });
  assert.match(res.location, /^\/vendor\/q\/[^?]+\?s=2&notice=saved$/);
  const overview = (await vget(ctx.token)).text;
  assert.match(overview, /<form method="GET" action="\/vendor\/q\/[^"]+" class="vq-jump" data-vendor-jump>/);
  assert.match(overview, /<option value="3">Section 3 of \d+: /);
});

test('leaving a section whose save is refused stays on it with the errors; nothing is saved', async () => {
  const ctx = await linked('Navigation Errors Co');
  const q = await qRow(ctx.a);
  let res = await save(ctx.token, { 'ORG-02': { r: 'no' }, 'ORG-03': { t: 'Yearly' } }, { section: 2, go: q.sections[3].ids[0] });
  assert.equal(res.status, 400);
  assert.match(res.text, /data-vendor-view="section"/);
  assert.match(res.text, /data-vendor-section="Organisational &amp; Personnel Security"/);
  assert.match(res.text, /data-vendor-errors[\s\S]*?ORG-02<\/a>: Explain your answer/);
  assert.match(res.text, /id="r-ORG-02-no"[^>]*checked/, 'the refused answers are shown again');
  assert.equal(await answerOf(ctx.a, 'ORG-02'), undefined);
  assert.equal(await answerOf(ctx.a, 'ORG-03'), undefined, 'all or nothing');
  res = await save(ctx.token, { 'ORG-03': { t: 'Yearly' } }, { section: 2, go: 'review', files: [{ field: 'file__ORG-03', filename: 'tool.exe', content: 'MZ' }] });
  assert.equal(res.status, 400);
  assert.match(res.text, /This file type is not allowed/);
  assert.match(res.text, /data-vendor-section="Organisational &amp; Personnel Security"/);
  assert.equal(await answerOf(ctx.a, 'ORG-03'), undefined);
  res = await save(ctx.token, { 'ORG-02': { r: 'no', d: 'x'.repeat(4001) } }, { section: 2, go: 'start' });
  assert.equal(res.status, 400);
  assert.match(res.text, /must be 4000 characters or fewer/);
  assert.match(res.text, /data-vendor-view="section"/);
});

test('reports: uploaded at the start, their coverage shown and counted, the covered evidence waived at submission', async () => {
  const ctx = await linked('Reports Co');
  let start = await vget(ctx.token);
  assert.doesNotMatch(start.text, /data-vendor-reports/, 'no separate upload box: ASR-01 and ASR-03 are asked even at the low tier');
  assert.match(start.text, /data-vendor-report-hint>If you hold a current ISO 27001 certificate or SOC 2 Type II report, answer ASR-01 and ASR-03 in <a href="[^"]+">Assurance &amp; Certification<\/a> first: it covers the documents for up to 3 other questions\.</);
  const asr = (await vsection(ctx, 'ASR-01')).page.text;
  assert.match(asr, /data-vendor-report-note="iso27001">Answer Yes with the certificate attached and it covers the documents for 2 other questions\.</);
  assert.match(asr, /data-vendor-report-note="soc2_type2">Answer Yes with the report attached and it covers the documents for 3 other questions\.</);
  let res = await uploadReport(ctx.token, 'iso27001', { expires_on: '2020-01-01', scope: 'All' });
  assert.equal(res.status, 400);
  assert.match(res.text, /already expired/);
  res = await uploadReport(ctx.token, 'iso27001', { expires_on: '2099-01-01', scope: 'All' },
    [{ field: 'report_file', filename: 'cert.pdf', content: PDF('cert only'), type: 'application/pdf' }]);
  assert.match(res.text, /Attach the Statement of Applicability/);
  res = await uploadReport(ctx.token, 'soc2_type2', {});
  assert.match(res.text, /Give the date the report period ended/);
  assert.equal((await reportsOf(ctx.a)).length, 0);
  res = await uploadReport(ctx.token, 'soc2_type2', { period_end: '2026-06-30' });
  assert.equal(res.status, 303);
  assert.match(res.location, /notice=report_added#reports$/);
  const [rep] = await reportsOf(ctx.a);
  assert.deepEqual([rep.kind, rep.check_status], ['soc2_type2', 'pending']);
  const file = await db.prepare('SELECT * FROM tp_evidence WHERE id=?').get(rep.evidence_id);
  assert.deepEqual([file.source, file.uploaded_by], ['vendor', null], 'an ordinary third-party file');
  start = await vget(ctx.token);
  assert.match(start.text, /data-vendor-report-covered>Your certificate or report covers the documents for 4 questions/, "three other questions and ASR-03 itself");
  assert.match((await vsection(ctx, 'ASR-03')).page.text, /data-vendor-report-note="soc2_type2">Saved as your SOC 2 Type II report\. It covers the documents for 3 other questions \(file: [^)]+\)\.</, 'a report from the earlier upload box is shown at ASR-03');
  const { page } = await vsection(ctx, 'IAM-01');
  assert.match(page.text, /data-vendor-question="IAM-01"[\s\S]*?data-vendor-evidence-covered>Covered by your SOC 2 report</);
  assert.doesNotMatch(page.text, /data-vendor-question="IAM-01"[^]*?data-vendor-evidence-required[^]*?data-vendor-question="IAM-03"/);
  await answerAll(ctx, { bare: SOC2_COVERED });
  let check = await vget(ctx.token, '?view=review');
  assert.match(check.text, /data-vendor-ready>All 36 questions are answered/);
  res = await uploadReport(ctx.token, 'soc2_type2', { remove: '1' }, []);
  assert.match(res.location, /notice=report_removed/);
  assert.equal((await reportsOf(ctx.a)).length, 0);
  assert.equal(await db.prepare('SELECT id FROM tp_evidence WHERE id=?').get(rep.evidence_id), undefined, 'its unused file is removed');
  check = await vget(ctx.token, '?view=review');
  for (const id of SOC2_COVERED) assert.match(check.text, new RegExp(`data-vendor-problem="${id}" data-vendor-problem-kind="evidence"`));
  assert.equal((await submitLink(ctx.token)).status, 409);
  assert.equal((await uploadReport(ctx.token, 'soc2_type2', { period_end: '2026-06-30' })).status, 303);
  assert.equal((await submitLink(ctx.token)).status, 200);
  const locked = (await reportsOf(ctx.a))[0];
  await assert.rejects(db.prepare("UPDATE tp_assurance_reports SET period_end='2026-01-01' WHERE id=?").run(locked.id), /locked once the questionnaire is submitted/);
  await assert.rejects(db.prepare('DELETE FROM tp_assurance_reports WHERE id=?').run(locked.id), /removed only by the third party/);
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  for (const want of ['assurance_report.uploaded', 'assurance_report.removed']) assert.ok(actions.includes(want), want);
  const submittedEvent = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'questionnaire.submitted');
  assert.deepEqual(submittedEvent.after_state.reports.map(r => r.kind), ['soc2_type2']);
});

test('the certificate and the report are given as answers to ASR-01 and ASR-03; they cover other questions and stop when the answer changes', async () => {
  const ctx = await linked('Report Questions Co', { answers: { ...LOW, data_handled: 'confidential' } });
  const { index } = await vsection(ctx, 'ASR-03');
  const soc2Fields = { period_covered: '1 Jul 2025 to 30 Jun 2026', period_end: '2026-06-30', trust_services_criteria: 'Security', exceptions: 'None',
    subservice_organisations: 'AWS, carved out', user_entity_controls: 'Listed in section 4' };
  let res = await save(ctx.token, { 'ASR-03': { r: 'yes', f: soc2Fields } }, { section: index,
    files: [{ field: 'file__ASR-03', filename: 'soc2.pdf', content: PDF('soc2 report'), type: 'application/pdf' }] });
  assert.equal(res.status, 303);
  let reports = await reportsOf(ctx.a);
  assert.deepEqual(reports.map(r => [r.kind, r.check_status]), [['soc2_type2', 'pending']]);
  const dayOf = async (col, id) => (await db.prepare(`SELECT to_char(${col}, 'YYYY-MM-DD') AS d FROM tp_assurance_reports WHERE id = ?`).get(id)).d;
  assert.equal(await dayOf('period_end', reports[0].id), '2026-06-30');
  let page = (await vget(ctx.token, `?s=${index}`)).text;
  assert.match(page, /data-vendor-report-note="soc2_type2">Saved as your SOC 2 Type II report\. It covers the documents for \d+ other questions\.</);
  assert.match(page, /name="f\[ASR-03\]\[period_end\]" type="date"/);
  const { page: iam } = await vsection(ctx, 'IAM-01');
  assert.match(iam.text, /data-vendor-question="IAM-01"[\s\S]*?data-vendor-evidence-covered>Covered by your SOC 2 report</);
  assert.doesNotMatch((await vget(ctx.token)).text, /data-vendor-reports/);

  const isoAnswer = { r: 'yes', f: { certificate_number: 'IS 1', certification_body: 'BSI', issue_date: '2025-01-10', expiry_date: '2099-01-09', scope: 'All services' } };
  res = await save(ctx.token, { 'ASR-01': isoAnswer }, { section: index, files: [{ field: 'file__ASR-01', filename: 'cert.pdf', content: PDF('cert'), type: 'application/pdf' }] });
  assert.equal(res.status, 303);
  assert.equal((await reportsOf(ctx.a)).length, 1, 'no certificate without the Statement of Applicability');
  page = (await vget(ctx.token, `?s=${index}`)).text;
  assert.match(page, /data-vendor-report-note="iso27001">To use this certificate for \d+ other questions, attach the Statement of Applicability as a second file\.</);
  res = await save(ctx.token, { 'ASR-01': isoAnswer }, { section: index, files: [{ field: 'file__ASR-01', filename: 'soa.pdf', content: PDF('soa'), type: 'application/pdf' }] });
  reports = await reportsOf(ctx.a);
  assert.deepEqual(reports.map(r => r.kind).sort(), ['iso27001', 'soc2_type2']);
  const iso = reports.find(r => r.kind === 'iso27001');
  assert.equal(await dayOf('certificate_expires_on', iso.id), '2099-01-09');
  assert.equal(iso.scope, 'All services');
  assert.ok(iso.soa_evidence_id && Number(iso.soa_evidence_id) !== Number(iso.evidence_id));

  res = await save(ctx.token, { 'ASR-03': { r: 'no', d: 'The report is being renewed.' } }, { section: index });
  assert.equal(res.status, 303);
  assert.deepEqual((await reportsOf(ctx.a)).map(r => r.kind), ['iso27001'], 'answering No removes the report');
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  for (const want of ['assurance_report.uploaded', 'assurance_report.removed']) assert.ok(actions.includes(want), want);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('the firm checks each report once; a reject asks for the waived evidence through clarifications; closing waits for every check', async () => {
  const ctx = await submittedWithReports('Reject Co', { iso: true });
  let page = await firmPage(ctx, '?answers=all');
  assert.match(page.text, /data-tprm-reports[\s\S]*?data-tprm-report="iso27001" data-tprm-report-status="pending"/);
  assert.match(page.text, /data-tprm-report-check-form="soc2_type2"/);
  assert.match(page.text, /data-tprm-answer-row="IAM-01"[\s\S]*?data-tprm-evidence-state="waived_soc2"/);
  const close = await consultant.session.post(`${qBase(ctx)}/close`, { row_version: String((await qRow(ctx.a)).row_version) });
  assert.match(toast(close), /assurance reports are not checked yet/);
  assert.match(toast(await checkReport(ctx, 'soc2_type2', { decision: 'accept', reason: 'Clean', in_date: '1', scope: '1' })), /confirm every check/);
  assert.match(toast(await checkReport(ctx, 'soc2_type2', { decision: 'reject' })), /Give the reason/);
  const rej = await checkReport(ctx, 'soc2_type2', { decision: 'reject', reason: 'Qualified opinion on CC6', in_date: '1', scope: '1' });
  assert.equal(rej.status, 302);
  assert.match(toast(rej), /SOC 2 Type II report rejected\. Evidence is asked for again on 1 question: issue a new link/);
  const rep = (await reportsOf(ctx.a)).find(r => r.kind === 'soc2_type2');
  assert.deepEqual([rep.check_status, Number(rep.checked_by), rep.check_reason], ['rejected', consultant.id, 'Qualified opinion on CC6']);
  let clars = await clarsOf(ctx.a);
  assert.deepEqual(clars.map(c => [c.question_id, c.raised_for]).sort(), [['IAM-01', 'report_rejected']]);
  assert.ok(clars.every(c => !c.body.includes('Qualified opinion')), 'the firm\'s reason stays with the firm');
  assert.equal((await qRow(ctx.a)).status, 'under_review');
  assert.match(toast(await checkReport(ctx, 'soc2_type2', { decision: 'accept', reason: 'x', in_date: '1', scope: '1', opinion: '1', period: '1' })),
    /already been checked|Someone else changed/);
  await assert.rejects(db.prepare("UPDATE tp_assurance_reports SET check_status='accepted', check_opinion=true, check_period=true WHERE id=?").run(rep.id),
    /checked once/);
  await assert.rejects(db.prepare("UPDATE tp_clarifications SET raised_for=NULL, report_id=NULL WHERE id=?").run(clars[0].id), /never changes/);
  page = await firmPage(ctx, '?answers=all');
  assert.match(page.text, /data-tprm-answer-row="IAM-01"[\s\S]*?data-tprm-evidence-state="requested"/);
  assert.match(page.text, /data-tprm-answer-row="ORG-02"[\s\S]*?data-tprm-evidence-state="waived_iso"/);
  assert.match(page.text, /data-tprm-clarification-raised-for="report_rejected"/);
  const token = await createLink(ctx);
  const vendor = await vget(token);
  assert.match(vendor.text, /data-vendor-mode="clarifying"/);
  assert.match(vendor.text, /data-vendor-clarification="\d+"[\s\S]*?data-vendor-clarification-document[\s\S]*?could not rely on your SOC 2 Type II report/);
  const c = clars.find(x => x.question_id === 'IAM-01');
  const form = multipart([['_aft', aftOf(vendor.text)], ['response', 'Access policy attached.']],
    [{ field: 'file', filename: 'access-policy.pdf', content: PDF('access'), type: 'application/pdf' }]);
  assert.equal((await request('POST', `/vendor/q/${token}/clarifications/${c.id}`, { body: form.body, headers: form.headers })).status, 303);
  page = await firmPage(ctx);
  assert.match(page.text, /data-tprm-answer-row="IAM-01"[\s\S]*?data-tprm-evidence-state="provided_in_clarification"/);
  assert.equal((await checkReport(ctx, 'iso27001', { decision: 'accept', reason: 'In date, scope fits', in_date: '1', scope: '1' })).status, 302);
  clars = await clarsOf(ctx.a);
  for (const x of clars) await consultant.session.post(`${qBase(ctx)}/clarifications/${x.id}/close`, { row_version: String(x.row_version) });
  for (const a of await answersOf(ctx.a)) {
    await consultant.session.post(`${qBase(ctx)}/answers/${a.id}/review`, { conclusion: 'satisfactory', row_version: String(a.row_version) });
  }
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/close`, { row_version: String((await qRow(ctx.a)).row_version) })), /Review of the answers closed/);
  const actions = (await chain(ctx.ws, ctx.a));
  const rejected = actions.find(e => e.action === 'assurance_report.rejected');
  assert.equal(Number(rejected.actor_user_id), consultant.id);
  assert.equal(rejected.after_state.reason, 'Qualified opinion on CC6');
  assert.equal(actions.filter(e => e.action === 'clarification.asked' && e.after_state.raised_for === 'report_rejected').length, 1);
  assert.ok(actions.some(e => e.action === 'assurance_report.accepted'));
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('SOC 2 exceptions put the evidence back on the questions they affect', async () => {
  const ctx = await submittedWithReports('Exceptions Co');
  const bad = await checkReport(ctx, 'soc2_type2', { decision: 'accept', reason: 'Fine', in_date: '1', scope: '1', opinion: '1', period: '1', exceptions: 'IAM-01, NOPE-1' });
  assert.match(toast(bad), /NOPE-1 is not a question of this questionnaire/);
  const ok = await checkReport(ctx, 'soc2_type2', { decision: 'accept', reason: 'Unqualified, period recent', in_date: '1', scope: '1', opinion: '1', period: '1', exceptions: 'iam-01' });
  assert.match(toast(ok), /accepted\. Evidence is asked for again on 1 question/);
  const rep = (await reportsOf(ctx.a))[0];
  assert.deepEqual(rep.exception_question_ids, ['IAM-01']);
  const clars = await clarsOf(ctx.a);
  assert.deepEqual(clars.map(c => [c.question_id, c.raised_for]), [['IAM-01', 'report_exception']]);
  assert.match(clars[0].body, /notes an exception that affects this question/);
  const page = await firmPage(ctx, '?answers=all');
  assert.match(page.text, /data-tprm-report-exceptions>Exceptions affect: IAM-01/);
  assert.match(page.text, /data-tprm-answer-row="IAM-01"[\s\S]*?data-tprm-evidence-state="requested"/);
  assert.match(page.text, /data-tprm-answer-row="INC-01"[\s\S]*?data-tprm-evidence-state="waived_(soc2|both)"/);
});

test('extra waivers are gone: no form, no route, no table; partly supported questions need their own evidence', async () => {
  const ctx = await submittedWithReports('No Waiver Co');
  assert.equal((await checkReport(ctx, 'soc2_type2', { decision: 'accept', reason: 'Unqualified', in_date: '1', scope: '1', opinion: '1', period: '1' })).status, 302);
  const page = await firmPage(ctx, '?answers=all');
  assert.match(page.text, /data-tprm-answer-row="GOV-02"[\s\S]*?data-tprm-evidence-state="provided"/);
  assert.doesNotMatch(page.text, /data-tprm-waive|data-tprm-waiver|Extra waiver|Withdrawn extra waivers|\/questionnaire\/waivers/);
  const before = (await chain(ctx.ws, ctx.a)).length;
  for (const url of [`${qBase(ctx)}/waivers`, `${qBase(ctx)}/waivers/1/withdraw`]) {
    const res = await consultant.session.post(url, { question_id: 'GOV-02', note: 'CC1.3', reason: 'x', row_version: '1' });
    assert.equal(res.status, 404, url);
  }
  assert.equal((await chain(ctx.ws, ctx.a)).length, before, 'nothing written');
  assert.equal((await db.prepare("SELECT to_regclass('public.tp_evidence_waivers') AS t").get()).t, null);
  assert.equal((await db.prepare("SELECT COUNT(*)::int AS c FROM pg_proc WHERE proname = 'tp_evidence_waivers_guard_fn'").get()).c, 0);
  const labels = require('../lib/tprm/assurance-reports').EVENT_LABELS;
  assert.ok(labels['evidence_waiver.added'] && labels['evidence_waiver.withdrawn']);
});

test('the firm review shows written answers, the firm-only benchmark and the evidence state; the AI review gets them too', async () => {
  const ctx = await submittedWithReports('Review Page Co');
  const page = await firmPage(ctx, '?answers=all');
  assert.match(page.text, /data-tprm-answer-counts>\d+ Yes · \d+ No · \d+ Not applicable · \d+ written answers?\./);
  assert.doesNotMatch(page.text, /data-tprm-answer-counts>[^<]*Partially/);
  assert.match(page.text, /data-tprm-answer-row="GOV-01" data-tprm-answer-response="text"[\s\S]*?data-tprm-answer-benchmark>Benchmark \(firm only\): At least annually\.[\s\S]*?Written answer[\s\S]*?data-tprm-answer-text>How often the policy is reviewed: Answer for GOV-01\nWho approves the policy: Answer for GOV-01/);
  assert.match(page.text, /data-tprm-evidence-counts>Evidence: \d+ provided · 3 waived by a report/);
  const first = await firmPage(ctx);
  assert.match(first.text, /data-tprm-answer-filter-current="unexpected"/);
  const vendor = await vget(ctx.token);
  assert.doesNotMatch(vendor.text, /At least annually\./);
  const aiReview = require('../lib/tprm/ai-review');
  const input = await aiReview.buildInput(db, { workspace_id: ctx.ws, assessment_id: ctx.a }, { mode: 'openrouter' });
  const user = input.body.messages[0].content;
  const gov = user.slice(user.indexOf('"question_id": "GOV-01"'), user.indexOf('"question_id": "GOV-02"'));
  assert.match(gov, /"answer_type": "free_text"/);
  assert.match(gov, /"benchmark": "At least annually\."/);
  assert.match(gov, /"written_answer": "How often the policy is reviewed: Answer for GOV-01\\nWho approves the policy: Answer for GOV-01/);
  const iam = user.slice(user.indexOf('"question_id": "IAM-01"'), user.indexOf('"question_id": "IAM-03"'));
  assert.match(iam, /"evidence_state": "waived_soc2"/);
  assert.match(user, /kind=assurance_reports>>>[\s\S]*?"kind": "soc2_type2",\s*"check_status": "pending"/);
  assert.equal(input.summary.assurance_reports, 1);
});

test('the benchmark and the firm\'s report decision never reach the client or the third party: no client-facing code reads them', () => {
  const clientFacing = ['routes/client-portal.js', 'lib/tprm/report.js', 'routes/tprm-report.js', 'views/tprm_assessment_report.ejs',
    'views/tprm_portal_home.ejs', 'views/tprm_portal_recommendation.ejs', 'views/tprm_portal_conditions.ejs', 'views/tprm_portal_concentration.ejs',
    'views/tprm_vendor_questionnaire.ejs', 'views/tprm_vendor_link.ejs', 'views/tprm_vendor_conditions.ejs'];
  for (const file of clientFacing) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /benchmark|check_reason|exception_question_ids|tp_evidence_waivers/, `${file} reads no firm-only field`);
  }
});

test('the third party\'s pages are light only, whatever the device prefers', async () => {
  for (const view of ['tprm_vendor_questionnaire.ejs', 'tprm_vendor_conditions.ejs', 'tprm_vendor_link.ejs']) {
    const text = fs.readFileSync(path.join(ROOT, 'views', view), 'utf8');
    assert.match(text, /<meta name="color-scheme" content="light">/, view);
    assert.match(text, /<html lang="en" class="page-standalone" data-theme="light">/, view);
  }
  const css = fs.readFileSync(path.join(ROOT, 'public', 'tprm-vendor.css'), 'utf8');
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.match(css, /html\.page-standalone \{\s*color-scheme: light;/);
  const ctx = await linked('Light Co');
  for (const page of [await vget(ctx.token), await vget(ctx.token, '?s=1'), await vget('not-a-valid-token')]) {
    assert.match(page.text, /content="light"/);
    assert.match(page.text, /data-theme="light"/);
  }
});

test('the vendor pages are branded: the firm, a cover with the facts and a contact, section summaries; link states stay anonymous', async () => {
  const ctx = await linked('Cover Co');
  const start = (await vget(ctx.token)).text;
  assert.match(start, /data-vendor-brandbar="firm"[\s\S]*?data-vendor-firm>[^<]+</);
  assert.match(start, /data-vendor-cover-title>Security questionnaire for <span data-vendor-client>Cover Co Client<\/span><\/h1>/);
  assert.match(start, /Sent to <span data-vendor-recipient>Asha Vendor</);
  assert.match(start, /data-vendor-questions-left="36"/, '36 questions left to answer');
  assert.match(start, /data-vendor-reviewer>[\s\S]*?href="mailto:am-consultant@test\.local"/, 'the consultant who issued the link');
  assert.equal((start.match(/am-consultant@test\.local"/g) || []).length, 1, 'the contact shown once');
  assert.match(start, /data-vendor-footer/);
  const q = await qRow(ctx.a);
  for (let i = 1; i <= q.sections.length; i++) {
    const page = (await vget(ctx.token, `?s=${i}`)).text;
    assert.match(page, /data-vendor-section-summary>Covers [^<]+\.</, `section ${i}`);
    assert.doesNotMatch(page, /&lt;Client&gt;/, `section ${i}: <Client> is always replaced, themes included`);
  }
  const invalid = (await vget('not-a-valid-token')).text;
  assert.match(invalid, /data-vendor-brandbar="plain"/);
  assert.doesNotMatch(invalid, /data-vendor-firm|mailto:/);
});

test('a questionnaire on a bank without answer types keeps Partially; a reassessment on the new bank does not copy what no longer fits', async () => {
  const old = withOldModuleName(BANK);
  const legacy = { ...old, version: 'legacy-test', questions: old.questions.map(q => {
    const { answer_type: _a, evidence_on: _e, explain_on: _x, report_coverage: _r, report_partly_supported: _p, benchmark: _b, ...rest } = q;
    return rest;
  }) };
  const json = JSON.stringify(legacy);
  const next = async () => (await db.prepare('SELECT COALESCE(MAX(version), 0)::int + 1 AS v FROM tp_question_bank_versions').get()).v;
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, content, content_sha256, question_count) VALUES (?, 'legacy-test', ?::jsonb, ?, ?)`)
    .run(await next(), json, crypto.createHash('sha256').update(json).digest('hex'), legacy.questions.length);
  const ctx = await linked('Legacy Co');
  const legacyQ = await qRow(ctx.a);
  assert.deepEqual(legacyQ.modules.filter(m => m.included).map(m => m.module), ['Cloud & Hosting']);
  assert.ok(legacyQ.sections.some(s => s.kind === 'module' && s.title === 'Cloud & Hosting' && s.ids.length === 12));
  assert.match((await vget(ctx.token)).text, /data-vendor-section-link="Cloud &amp; Hosting"/);
  const sec = (await vsection(ctx, 'GOV-01')).page;
  assert.match(sec.text, /name="r\[GOV-01\]" value="partial"/, 'Partially is offered');
  assert.match(sec.text, /data-kind="legacy"/);
  assert.doesNotMatch((await vget(ctx.token)).text, /data-vendor-reports/, 'no report waiver on the old bank');
  const refused = await save(ctx.token, { 'GOV-01': { r: 'partial' } });
  assert.match(refused.text, /Give supporting detail for &#34;Partially&#34;/);
  assert.equal((await save(ctx.token, { 'GOV-01': { r: 'partial', d: 'Approved, review overdue', ref: 'ISP v3' } })).status, 303);
  assert.equal((await answerOf(ctx.a, 'GOV-01')).response, 'partial');
  const q = await qRow(ctx.a);
  await assert.rejects(db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response, detail)
    VALUES (?, ?, ?, 'GOV-02', 'text', 'x')`).run(ctx.ws, ctx.a, q.id), /no written answers/);
  await assert.rejects(db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response)
    VALUES (?, ?, ?, 'GOV-02', 'no')`).run(ctx.ws, ctx.a, q.id), /tp_answers_detail/);
  const answers = {};
  for (const id of idsOf(q)) answers[id] = { r: 'yes', ref: `Doc ${id}` };
  Object.assign(answers, { 'AIS-01': { r: 'no', d: 'None' }, 'ORG-02': { r: 'partial', d: 'Most signed', ref: 'NDA log' },
    'GOV-01': { r: 'partial', d: 'Approved, review overdue', ref: 'ISP v3' } });
  assert.equal((await save(ctx.token, answers)).status, 303);
  assert.equal((await submitLink(ctx.token)).status, 200);
  const review = await firmPage(ctx);
  assert.match(review.text, /data-tprm-answer-counts>\d+ Yes · 2 Partially/);
  const fresh = { ...BANK, version: 'v2-again-test' };
  const fjson = JSON.stringify(fresh);
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, content, content_sha256, question_count) VALUES (?, 'v2-again-test', ?::jsonb, ?, ?)`)
    .run(await next(), fjson, crypto.createHash('sha256').update(fjson).digest('hex'), fresh.questions.length);
  const cancel = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/cancel`, { row_version: String((await assessmentRow(ctx.a)).row_version), reason: 'Superseded' });
  assert.equal(cancel.status, 302, toast(cancel));
  const a2 = await startAssessment(ctx.ws, ctx.tp);
  const ctx2 = { ws: ctx.ws, tp: ctx.tp, a: a2 };
  assert.equal((await consultant.session.post(qBase(ctx2), {})).status, 302);
  ctx2.token = await createLink(ctx2);
  const rows = await answersOf(a2);
  const ids = rows.map(r => r.question_id);
  assert.ok(!ids.includes('ORG-02'), 'Partially is not copied');
  assert.ok(!ids.includes('GOV-01'), 'a Partially on a question that now takes a written answer is not copied');
  assert.ok(!ids.includes('ORG-03'), 'a Yes on a question that now takes a written answer is not copied');
  const g2 = rows.find(r => r.question_id === 'GOV-02');
  assert.deepEqual([g2.response, g2.fields], ['yes', null], 'a Yes is copied; the fields version 5 adds on Yes stay empty');
  assert.equal(rows.find(r => r.question_id === 'CLM-01').response, 'yes', 'a Yes that still fits is copied');
  const prefilled = (await chain(ctx.ws, a2)).find(e => e.action === 'questionnaire.prefilled');
  assert.ok(prefilled.after_state.not_copied > 0);
});
