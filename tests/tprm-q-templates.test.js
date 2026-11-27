'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-qt-outbox-')), 'outbox.log');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient, allSteps } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'q-templates-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no' };
const BASE = '/tprm/settings/questionnaires';
let EMPTY;

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let vendorRoute;
let templateId;
const createdPaths = new Set();

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  vendorRoute = require('../routes/tprm-vendor');
  EMPTY = require('../lib/tprm/vendor-answers').answerHash(null);
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('qt-consultant@test.local', 'consultant');
  senior = await makeUser('qt-senior@test.local', 'senior_consultant');
  for (const u of [consultant, senior]) u.session = await signIn(u.email);
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

test.beforeEach(() => { if (vendorRoute) { vendorRoute.limiter.reset(); vendorRoute.postLimiter.reset(); } });

async function makeUser(email, role) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, firmId, role)).lastInsertRowid);
  return { id, email, firm_role: role };
}

async function signIn(email) {
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302);
  await session.get('/dashboard');
  return session;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const qBase = ctx => `${aBase(ctx.ws, ctx.tp, ctx.a)}/questionnaire`;
const qRow = async a => db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(a);
const answerOf = async (a, qid) => db.prepare('SELECT * FROM tp_answers WHERE assessment_id=? AND question_id=?').get(a, qid);
const draftOf = async () => db.prepare('SELECT draft, row_version FROM tp_q_templates WHERE id = ?').get(templateId);

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  return id;
}

async function tierConfirmed(name) {
  const ws = await tprmClient(`${name} Client`);
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosted service' })).status, 302);
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  const a = idIn(started.location, /assessments\/(\d+)/);
  const row = async () => db.prepare('SELECT row_version FROM tp_assessments WHERE id=?').get(a);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await row()).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await row()).row_version) })).status, 302);
  return { ws, tp, a };
}

async function link(ctx) {
  const row = await qRow(ctx.a);
  const res = await consultant.session.post(`${qBase(ctx)}/links`, { recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(row.row_version) });
  const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1];
  assert.ok(url, 'a link was shown');
  return url.split('/vendor/q/')[1];
}

function request(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = env.app.listen(0, '127.0.0.1', () => {
      const h = { ...headers };
      if (body != null && h['content-length'] == null) h['content-length'] = Buffer.byteLength(body);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: urlPath, headers: h }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), location: res.headers.location || null }); });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}
const vget = (token, s = '') => request('GET', `/vendor/q/${token}${s}`);
const aftOf = text => (String(text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];
function multipart(fields, files = []) {
  const boundary = '----tprmqt' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of fields) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  for (const f of files) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${f.field}"; filename="${f.filename}"`, `Content-Type: ${f.type || 'text/plain'}`, '', f.content);
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
async function vsave(token, fields, files = []) {
  const form = multipart([['_aft', aftOf((await vget(token)).text)], ...fields, ['intent', 'save']], files);
  const res = await request('POST', `/vendor/q/${token}/save`, { body: form.body, headers: form.headers });
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(r.stored_path);
  return res;
}
async function vsubmit(token) {
  const body = new URLSearchParams([['_aft', aftOf((await vget(token)).text)]]).toString();
  return request('POST', `/vendor/q/${token}/submit`, { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
}

const q = (fields, extra = {}) => ({ section: 's1', required: '1', ...fields, ...extra });
async function add(fields) {
  const res = await client.post(`${BASE}/${templateId}/questions`, fields);
  return res;
}

test('a manager builds a questionnaire: sections, eight answer types, required and optional, show-when rules, AI instructions; then publishes it', async () => {
  const list = await client.get(BASE);
  assert.equal(list.status, 200);
  assert.match(list.text, /data-tprm-q-bank-row/);
  const clash = await client.post(BASE, { name: 'Clash', prefix: 'GOV' });
  assert.match(toast(clash), /GOV is already used by the question bank/);
  const made = await client.post(BASE, { name: 'Continuity checks', description: 'BCP and DR', prefix: 'CNT' });
  assert.equal(made.status, 302, toast(made));
  templateId = idIn(made.location, /questionnaires\/(\d+)/);
  assert.ok(templateId);
  assert.match(toast(await client.post(`${BASE}/${templateId}/sections/s1`, { title: 'Business continuity' })), /Section renamed/);
  assert.match(toast(await client.post(`${BASE}/${templateId}/sections`, { title: 'Disaster recovery' })), /Section added/);

  const steps = [
    q({ answer_type: 'yes_no_na', question: 'Do you have a business continuity plan?' }),
    q({ answer_type: 'date', question: 'When was it last approved?', show_mode: 'when', show_join: 'all', cond_question: ['CNT-01'], cond_op: ['is'], cond_value: ['yes'] }),
    q({ answer_type: 'multiple_choice', question: 'Which events does it cover?', options: ['Site loss', 'Staff loss', 'Cyber attack'], allow_other: '1' }, { required: '' }),
    q({ answer_type: 'number', question: 'Recovery time objective, in hours?' }),
    q({ answer_type: 'free_text', question: 'Why is it longer than four hours?', show_mode: 'when', cond_question: ['CNT-04'], cond_op: ['more_than'], cond_value: ['4'],
      ai_valid: 'Gives a reason.', ai_meets: 'Satisfactory with a reason and a tested workaround.', ai_red_flags: 'No workaround at all.' }),
    q({ answer_type: 'single_choice', question: 'How often do you test recovery?', options: ['Never', 'Yearly'], section: 's2' }),
    q({ answer_type: 'url', question: 'Public status page?', section: 's2' }, { required: '' }),
    q({ answer_type: 'file', question: 'Upload the latest recovery test report.', section: 's2', evidence: 'The test report' }),
  ];
  for (const s of steps) {
    const res = await add(s);
    assert.equal(res.status, 302, `added: ${res.text ? (res.text.match(/data-tprm-q-errors[\s\S]{0,400}/) || [''])[0] : toast(res)}`);
  }
  const { draft } = await draftOf();
  assert.deepEqual(draft.questions.map(x => [x.id, x.answer_type, x.required]), [
    ['CNT-01', 'yes_no_na', true], ['CNT-02', 'date', true], ['CNT-03', 'multiple_choice', false], ['CNT-04', 'number', true],
    ['CNT-05', 'free_text', true], ['CNT-06', 'single_choice', true], ['CNT-07', 'url', false], ['CNT-08', 'file', true]]);
  assert.deepEqual(draft.questions[4].show_when, { mode: 'all', conditions: [{ question: 'CNT-04', op: 'more_than', value: '4' }] });
  assert.equal(draft.questions[4].ai_meets, 'Satisfactory with a reason and a tested workaround.');
  assert.equal(draft.questions[4].ai_red_flags, 'No workaround at all.');

  const oneOption = await add(q({ answer_type: 'single_choice', question: 'Pick one', options: ['Only'] }));
  assert.equal(oneOption.status, 400);
  assert.match(oneOption.text, /needs at least two options/);
  assert.match(oneOption.text, /<textarea[^>]*name="question"[^>]*>Pick one<\/textarea>/, 'the typed question is kept');
  const forward = await client.post(`${BASE}/${templateId}/questions/CNT-01`, q({ answer_type: 'yes_no_na', question: 'Plan?', show_mode: 'when', cond_question: ['CNT-04'], cond_op: ['is'], cond_value: ['1'] }));
  assert.equal(forward.status, 400);
  assert.match(forward.text, /CNT-04 is not a question you can use in a condition here|comes after this question/);
  const used = await client.post(`${BASE}/${templateId}/questions/CNT-04`, { intent: 'remove' });
  assert.equal(used.status, 400);
  assert.match(used.text, /CNT-05 is shown depending on this answer/);
  assert.match(toast(await client.post(`${BASE}/${templateId}/sections/s1/remove`, {})), /Move or remove the questions in this section first/);

  const page = await client.get(`${BASE}/${templateId}?s=s1`);
  assert.match(page.text, /data-tprm-q-question="CNT-05"[\s\S]*?Shown when CNT-04 is more than 4\. Marking rules set\./);
  const pub = await client.post(`${BASE}/${templateId}/publish`, { row_version: String((await draftOf()).row_version) });
  assert.match(toast(pub), /Version 1 published/);
  const v = await db.prepare('SELECT version, question_count FROM tp_q_template_versions WHERE template_id = ?').get(templateId);
  assert.deepEqual([v.version, v.question_count], [1, 8]);
  await assert.rejects(db.prepare('UPDATE tp_q_template_versions SET question_count = 9 WHERE template_id = ?').run(templateId), /never changes/);
  assert.equal((await consultant.session.post(BASE, { name: 'Not mine' })).status, 403, 'only managers build questionnaires');
});

test('sending it instead of the automatic questionnaire: the supplier answers each type, rules show and hide questions, optional ones may stay blank', async () => {
  const ctx = await tierConfirmed('Template Supplier');
  const panel = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(panel.text, /data-tprm-questionnaire-mode[\s\S]*?Continuity checks \(version 1, 8 questions\)/);
  const prep = await consultant.session.post(qBase(ctx), { questionnaire_mode: 'instead', template_id: String(templateId) });
  assert.equal(prep.status, 302, toast(prep));
  let row = await qRow(ctx.a);
  assert.deepEqual(row.sections.map(s => [s.kind, s.title, s.ids, s.optional || []]), [
    ['template', 'Business continuity', ['CNT-01', 'CNT-03', 'CNT-04'], ['CNT-03']],
    ['template', 'Disaster recovery', ['CNT-06', 'CNT-07', 'CNT-08'], ['CNT-07']]]);
  assert.deepEqual(row.sections[0].followups.map(f => [f.id, f.parent]), [['CNT-02', 'CNT-01'], ['CNT-05', 'CNT-04']]);
  assert.equal(row.vendor_question_count, 6);
  assert.equal(row.custom_questions.length, 8);
  assert.equal(row.template.mode, 'instead');

  const prepared = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(prepared.text, /data-tprm-template-sections[\s\S]*?Your questionnaire: Continuity checks[\s\S]*?sent instead of the automatic questions/);
  assert.match(prepared.text, /data-tprm-template-count>6</);
  assert.doesNotMatch(prepared.text, /data-tprm-base-sections/);
  const token = await link(ctx);
  row = await qRow(ctx.a);
  await assert.rejects(db.prepare('UPDATE tp_questionnaires SET custom_questions = ?::jsonb WHERE id = ?').run('[]', row.id), /firm questionnaire of a sent questionnaire never changes/);
  const page1 = await vget(token, '?s=1');
  assert.equal(page1.status, 200);
  assert.match(page1.text, /data-vendor-question="CNT-02"[^>]*data-vendor-followup-rule="[^"]*CNT-01[^"]*"[^>]* hidden/);
  assert.match(page1.text, /name="f\[CNT-03\]\[value\]\[\]" value="Cyber attack"/);
  assert.match(page1.text, /data-vendor-question="CNT-03"[\s\S]*?Optional: you can leave this blank\./);
  assert.match(page1.text, /name="f\[CNT-04\]\[value\]"[^>]*inputmode="decimal"/);

  const bad = await vsave(token, [['r[CNT-01]', 'yes'], ['f[CNT-04][value]', 'six'], ['v[CNT-01]', EMPTY], ['v[CNT-04]', EMPTY]]);
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Write a number only, such as 4\./);

  const saved = await vsave(token, [
    ['r[CNT-01]', 'yes'], ['f[CNT-02][value]', '2026-03-01'], ['f[CNT-04][value]', '6'], ['t[CNT-05]', 'Mainframe restore takes six hours; payroll runs from a standby.'],
    ...['CNT-01', 'CNT-02', 'CNT-04', 'CNT-05'].map(id => [`v[${id}]`, EMPTY]),
  ]);
  assert.equal(saved.status, 303, saved.text.slice(0, 400));
  const date = await answerOf(ctx.a, 'CNT-02');
  assert.deepEqual([date.response, date.fields.value], ['value', '2026-03-01']);
  assert.match(date.detail, /1 Mar 2026/);
  assert.equal((await answerOf(ctx.a, 'CNT-05')).response, 'text');

  const page2 = await vget(token, '?s=2');
  const choiceBad = await vsave(token, [['f[CNT-06][value]', 'Monthly'], ['v[CNT-06]', EMPTY]]);
  assert.equal(choiceBad.status, 400);
  assert.match(choiceBad.text, /&#34;Monthly&#34; is not one of the choices\./);
  const urlBad = await vsave(token, [['f[CNT-07][value]', 'ftp://status.example'], ['v[CNT-07]', EMPTY]]);
  assert.equal(urlBad.status, 400);
  assert.match(urlBad.text, /Give a web address starting with https:\/\//);
  assert.match(page2.text, /data-vendor-question="CNT-08"[\s\S]*?Upload the file below/);

  const early = await vsubmit(token);
  assert.match(early.text, /CNT-06|not answered|still needed|Still needed/i, 'a required question left blank stops the submission');
  assert.equal((await qRow(ctx.a)).status !== 'submitted', true);

  const rest = await vsave(token, [['f[CNT-06][value]', 'Yearly'], ['v[CNT-06]', EMPTY], ['v[CNT-08]', EMPTY]],
    [{ field: 'file__CNT-08', filename: 'dr-test.txt', content: 'DR test report, April 2026' }]);
  assert.equal(rest.status, 303, rest.text.slice(0, 400));
  assert.deepEqual([(await answerOf(ctx.a, 'CNT-06')).fields.value, (await answerOf(ctx.a, 'CNT-08')).response], ['Yearly', 'value']);

  const done = await vsubmit(token);
  assert.equal(done.status, 303, done.text.slice(0, 300));
  assert.equal((await qRow(ctx.a)).status, 'submitted', 'optional CNT-03 and CNT-07 were left blank');

  const review = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=review&answers=all`);
  assert.match(review.text, /data-tprm-answer-row="CNT-06"[\s\S]*?data-tprm-answer-text>Yearly</);
  assert.match(review.text, /data-tprm-answer-row="CNT-02"[\s\S]*?data-tprm-answer-text>1 Mar 2026</);
});

test('a rule that stops applying hides the question and clears its answer', async () => {
  const ctx = await tierConfirmed('Template Rules');
  assert.equal((await consultant.session.post(qBase(ctx), { questionnaire_mode: 'instead', template_id: String(templateId) })).status, 302);
  const token = await link(ctx);
  const v = id => [`v[${id}]`, EMPTY];
  assert.equal((await vsave(token, [['f[CNT-04][value]', '8'], ['t[CNT-05]', 'Restores take eight hours.'], v('CNT-04'), v('CNT-05')])).status, 303);
  assert.equal((await answerOf(ctx.a, 'CNT-05')).response, 'text');
  const fresh = await answerOf(ctx.a, 'CNT-04');
  const vers = (await vget(token, '?s=1')).text.match(/name="v\[CNT-04\]" value="([0-9a-f]{20})"/)[1];
  assert.equal((await vsave(token, [['f[CNT-04][value]', '2'], ['v[CNT-04]', vers]])).status, 303);
  assert.equal((await answerOf(ctx.a, 'CNT-04')).fields.value, '2');
  const cleared = await answerOf(ctx.a, 'CNT-05');
  assert.ok(!cleared || !cleared.response, 'the answer to a question no longer asked is cleared');
  assert.ok(fresh);
});

test('sending it as well as the automatic questionnaire adds its sections after the automatic ones', async () => {
  const ctx = await tierConfirmed('Template Both');
  assert.equal((await consultant.session.post(qBase(ctx), { questionnaire_mode: 'with', template_id: String(templateId) })).status, 302);
  const row = await qRow(ctx.a);
  const kinds = row.sections.map(s => s.kind);
  assert.ok(kinds.includes('base'));
  assert.deepEqual(kinds.slice(-2), ['template', 'template']);
  assert.ok(row.sections.some(s => s.ids.includes('AIS-01')));
  assert.equal(row.vendor_question_count, row.sections.reduce((n, s) => n + s.ids.length, 0));
  const ev = await db.prepare(`SELECT after_state FROM tp_events WHERE chain_type='assessment' AND chain_id=? AND action='questionnaire.prepared'`).get(ctx.a);
  assert.deepEqual(ev.after_state.firm_questionnaire, { id: templateId, name: 'Continuity checks', version: 1, mode: 'with' });
});

function requestRaw(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = env.app.listen(0, '127.0.0.1', () => {
      const h = { ...headers };
      if (body != null) h['content-length'] = body.length;
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: urlPath, headers: h }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { server.close(); const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8') }); });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}

test('the supplier spreadsheet carries the new answer types and an unchanged upload changes nothing', async () => {
  const ctx = await tierConfirmed('Template Sheet');
  assert.equal((await consultant.session.post(qBase(ctx), { questionnaire_mode: 'instead', template_id: String(templateId) })).status, 302);
  const token = await link(ctx);
  assert.equal((await vsave(token, [['r[CNT-01]', 'yes'], ['f[CNT-04][value]', '3'], ['v[CNT-01]', EMPTY], ['v[CNT-04]', EMPTY]])).status, 303);
  const down = await requestRaw('GET', `/vendor/q/${token}/spreadsheet`);
  assert.equal(down.status, 200, down.text.slice(0, 200));
  assert.match(String(down.headers['content-type']), /spreadsheetml\.sheet/);
  const before = (await db.prepare('SELECT question_id, response, detail FROM tp_answers WHERE assessment_id = ? ORDER BY question_id').all(ctx.a)).map(r => `${r.question_id}:${r.response}:${r.detail}`);
  const aft = aftOf((await vget(token)).text);
  const boundary = '----tprmqtsheet' + crypto.randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_aft"\r\n\r\n${aft}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sheet"; filename="answers.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    down.body, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const up = await requestRaw('POST', `/vendor/q/${token}/spreadsheet`, { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.ok([200, 303].includes(up.status), up.text.slice(0, 400));
  assert.doesNotMatch(up.text, /vq-error|is not an answer to this question/);
  const after = (await db.prepare('SELECT question_id, response, detail FROM tp_answers WHERE assessment_id = ? ORDER BY question_id').all(ctx.a)).map(r => `${r.question_id}:${r.response}:${r.detail}`);
  assert.deepEqual(after, before);
});

test('with the automatic questionnaire: AI screening answered Yes after sending still adds the AI Services questions', async () => {
  const ctx = await tierConfirmed('Template AI');
  assert.equal((await consultant.session.post(qBase(ctx), { questionnaire_mode: 'with', template_id: String(templateId) })).status, 302);
  const token = await link(ctx);
  const res = await vsave(token, [['r[AIS-01]', 'yes'], ['v[AIS-01]', EMPTY]]);
  assert.equal(res.status, 303, res.text.slice(0, 400));
  const row = await qRow(ctx.a);
  assert.ok(row.sections.some(s => s.kind === 'module' && s.title === 'AI Services'), 'the AI Services section was added');
  assert.deepEqual(row.sections.filter(s => s.kind === 'template').map(s => s.title), ['Business continuity', 'Disaster recovery'], 'the firm sections stay');
  assert.equal(row.vendor_question_count, row.sections.reduce((n, s) => n + s.ids.length, 0));
});

test('a question several steps deep is asked only while each question above it is asked', () => {
  const assembly = require('../lib/tprm/questionnaire-assembly');
  const q = { sections: [{ ids: ['XA-01'], followups: [
    { id: 'XA-02', parent: 'XA-01', when: 'yes' },
    { id: 'XA-03', parent: 'XA-02', rule: { mode: 'all', conditions: [{ question: 'XA-02', op: 'answered', value: '' }] } },
    { id: 'XA-04', parent: 'XA-03', rule: { mode: 'all', conditions: [{ question: 'XA-03', op: 'not_answered', value: '' }] } }] }] };
  assert.deepEqual([...assembly.activeFollowups(q, id => ({ 'XA-01': 'no', 'XA-02': 'yes' })[id] || null)], [], 'a stale answer below a hidden question asks nothing');
  assert.deepEqual([...assembly.activeFollowups(q, id => ({ 'XA-01': 'yes', 'XA-02': 'yes' })[id] || null)], ['XA-02', 'XA-03', 'XA-04']);
  assert.deepEqual(assembly.askedIds(q, id => ({ 'XA-01': 'yes', 'XA-02': 'yes' })[id] || null), [['XA-01', 'XA-02', 'XA-03', 'XA-04']]);
});

test('editing after publishing: answer types stay, numbers are not reused, rule values must match the question, options a rule uses cannot go', async () => {
  const rv = async () => String((await draftOf()).row_version);
  const typeChange = await client.post(`${BASE}/${templateId}/questions/CNT-04`, q({ answer_type: 'date', question: 'Recovery date?' }));
  assert.equal(typeChange.status, 400);
  assert.match(typeChange.text, /CNT-04 is published, so how it is answered cannot change/);
  const badOption = await add(q({ answer_type: 'yes_no_na', question: 'Monthly tests?', section: 's2', show_mode: 'when', cond_question: ['CNT-06'], cond_op: ['is'], cond_value: ['Monthly'] }));
  assert.equal(badOption.status, 400);
  assert.match(badOption.text, /&#34;Monthly&#34; is not one of the options of CNT-06/);
  const badYes = await add(q({ answer_type: 'yes_no_na', question: 'Plan tested?', show_mode: 'when', cond_question: ['CNT-01'], cond_op: ['is'], cond_value: ['maybe'] }));
  assert.equal(badYes.status, 400);
  assert.match(badYes.text, /For CNT-01 the value must be yes, no or na/);
  const textRule = await add(q({ answer_type: 'yes_no_na', question: 'Follow up?', show_mode: 'when', cond_question: ['CNT-05'], cond_op: ['is'], cond_value: ['x'] }));
  assert.equal(textRule.status, 400);
  assert.match(textRule.text, /CNT-05 has no fixed answers/);
  assert.equal((await add(q({ answer_type: 'yes_no_na', question: 'Is yearly testing signed off?', section: 's2', show_mode: 'when', cond_question: ['CNT-06'], cond_op: ['is'], cond_value: ['Yearly'] }))).status, 302);
  const renamed = await client.post(`${BASE}/${templateId}/questions/CNT-06`, q({ answer_type: 'single_choice', question: 'How often do you test recovery?', options: ['Never', 'Annually'], section: 's2' }));
  assert.equal(renamed.status, 400);
  assert.match(renamed.text, /A rule uses an option you removed or renamed: CNT-09 \(Yearly\)/);
  assert.equal((await client.post(`${BASE}/${templateId}/questions/CNT-09`, { intent: 'remove', section: 's2', row_version: await rv() })).status, 302);
  assert.equal((await add(q({ answer_type: 'yes_no_na', question: 'Any recovery incidents this year?', section: 's2' }))).status, 302);
  const ids = (await draftOf()).draft.questions.map(x => x.id);
  assert.ok(!ids.includes('CNT-09'), 'a removed number is not handed out again');
  assert.ok(ids.includes('CNT-10'));
});

test('also ask for: a file only when they answer No, an explanation only for No; options can be edited one by one', async () => {
  const made = await client.post(BASE, { name: 'Exceptions check', prefix: 'EXP' });
  const id = idIn(made.location, /questionnaires\/(\d+)/);
  const addTo = fields => client.post(`${BASE}/${id}/questions`, { section: 's1', required: '1', settings_shown: '1', ...fields });
  assert.equal((await addTo({ answer_type: 'yes_no_na', question: 'Do you follow the patching policy without exceptions?', ask_file: '1', file_when: 'no',
    evidence: 'The exception record', evidence_mandatory: '1', explain_on: ['no'] })).status, 302);
  assert.equal((await addTo({ answer_type: 'multiple_choice', question: 'Which systems are covered?', options: ['Servers', 'Laptops', 'Phones'] })).status, 302);
  const draft = async () => (await db.prepare('SELECT draft, row_version FROM tp_q_templates WHERE id = ?').get(id));
  let d = (await draft()).draft;
  assert.deepEqual([d.questions[0].evidence_on, d.questions[0].evidence_mandatory, d.questions[0].explain_on, d.questions[0].evidence], ['no', true, ['no'], 'The exception record']);
  const edit = await client.get(`${BASE}/${id}/questions/EXP-02`);
  assert.match(edit.text, /data-tprm-q-option>[\s\S]*?value="Servers"[\s\S]*?data-tprm-q-remove-option/);
  assert.match(edit.text, /name="file_when" value="no"|data-tprm-q-also/);
  assert.equal((await client.post(`${BASE}/${id}/questions/EXP-02`, { section: 's1', required: '1', settings_shown: '1', answer_type: 'multiple_choice', question: 'Which systems are covered?', options: ['Servers', 'Laptops and desktops'] })).status, 302);
  d = (await draft()).draft;
  assert.deepEqual(d.questions[1].options, ['Servers', 'Laptops and desktops']);
  assert.match(toast(await client.post(`${BASE}/${id}/publish`, { row_version: String((await draft()).row_version) })), /Version 1 published/);

  const ctx = await tierConfirmed('Exceptions Supplier');
  assert.equal((await consultant.session.post(qBase(ctx), { questionnaire_mode: 'instead', template_id: String(id) })).status, 302);
  const token = await link(ctx);
  assert.equal((await vsave(token, [['r[EXP-01]', 'na'], ['v[EXP-01]', EMPTY]])).status, 303, 'Not applicable needs no explanation here');
  const vers = (await vget(token, '?s=1')).text.match(/name="v\[EXP-01\]" value="([0-9a-f]{20})"/)[1];
  const noReason = await vsave(token, [['r[EXP-01]', 'no'], ['v[EXP-01]', vers]]);
  assert.equal(noReason.status, 400);
  assert.match(noReason.text, /Explain your answer/);
  assert.equal((await vsave(token, [['r[EXP-01]', 'no'], ['d[EXP-01]', 'Two legacy servers are patched monthly.'], ['f[EXP-02][value][]', 'Servers'], ['v[EXP-01]', vers], ['v[EXP-02]', EMPTY]])).status, 303);
  const blocked = await vsubmit(token);
  assert.notEqual((await qRow(ctx.a)).status, 'submitted', 'the file asked for on No is still missing');
  assert.match(blocked.text, /document|evidence|file/i);
  const v2 = (await vget(token, '?s=1')).text.match(/name="v\[EXP-01\]" value="([0-9a-f]{20})"/)[1];
  assert.equal((await vsave(token, [['r[EXP-01]', 'no'], ['d[EXP-01]', 'Two legacy servers are patched monthly.'], ['v[EXP-01]', v2]], [{ field: 'file__EXP-01', filename: 'exceptions.txt', content: 'Exception record' }])).status, 303);
  const done = await vsubmit(token);
  assert.equal(done.status, 303, done.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(/(Still needed|not|must|Answer)[^.]{0,200}/g));
  assert.equal((await qRow(ctx.a)).status, 'submitted');
});

test('a questionnaire goes to Excel and back: unchanged changes nothing; edits, a new question in a new section and a removal arrive in the draft', async () => {
  const sheet = require('../lib/tprm/q-template-sheet');
  const writer = require('../lib/tprm/sheet-writer');
  const made = await client.post(BASE, { name: 'Sheet round trip', prefix: 'SHT' });
  const id = idIn(made.location, /questionnaires\/(\d+)/);
  const addTo = fields => client.post(`${BASE}/${id}/questions`, { section: 's1', required: '1', settings_shown: '1', ...fields });
  assert.equal((await addTo({ answer_type: 'yes_no_na', question: 'Do you have a written recovery plan?', ask_file: '1', file_when: 'no', evidence: 'The exception record', explain_on: ['no'], ai_meets: 'A plan tested this year.' })).status, 302);
  assert.equal((await addTo({ answer_type: 'single_choice', question: 'How often is it tested?', options: ['Yearly', 'Never'] })).status, 302);
  assert.equal((await addTo({ answer_type: 'number', question: 'How many sites does it cover?', show_mode: 'when', show_join: 'all', cond_question: ['SHT-01'], cond_op: ['is'], cond_value: ['yes'] })).status, 302);
  const before = await db.prepare('SELECT draft, row_version FROM tp_q_templates WHERE id = ?').get(id);

  const file = await fetch(`${await client.baseUrl()}${BASE}/${id}/export.xlsx`, { headers: { cookie: client.getCookies() } });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /sheet-round-trip-draft\.xlsx/);
  const buffer = Buffer.from(await file.arrayBuffer());
  const upload = async (buf, session = client) => {
    await session.get(BASE);
    const form = new FormData();
    form.append('_csrf', session.getCsrfToken());
    form.append('sheet', new Blob([buf]), 'questionnaire.xlsx');
    const res = await fetch(`${await session.baseUrl()}${BASE}/${id}/import`, { method: 'POST', body: form, redirect: 'manual', headers: { cookie: session.getCookies() } });
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  const same = await upload(buffer);
  assert.equal(same.status, 302, (same.text.match(/<main[\s\S]{0,600}/) || [same.text.slice(-600)])[0]);
  assert.match(toast(same), /nothing in it differs/);
  assert.equal(Number((await db.prepare('SELECT row_version FROM tp_q_templates WHERE id = ?').get(id)).row_version), Number(before.row_version));

  const titles = new Map(before.draft.sections.map(s => [s.key, s.title]));
  const rows = before.draft.questions.map(x => sheet.rowOf(x, titles));
  rows[0] = { ...rows[0], question: 'Do you have a written and approved recovery plan?', required: 'No', red_flags: 'No owner named.' };
  rows[1] = { ...rows[1], options: 'Yearly; Twice a year; Never', allow_other: 'Yes' };
  rows[2] = { ...rows[2], remove: 'Remove' };
  rows.push({ id: '', section: 'Extra checks', question: 'When was it last tested?', answer_type: 'Date', required: 'Yes', show_when: 'all: SHT-01 is Yes' });
  const edited = await writer.buildWorkbook({ sheet: sheet.SHEET, title: 'Edited', note: '', headerRow: 3, columns: sheet.COLUMNS, rows });
  const up = await upload(edited);
  assert.equal(up.status, 302, up.text.slice(0, 300));
  assert.match(toast(up), /1 question added, 2 questions changed, 1 question removed, 1 section added/);
  const after = (await db.prepare('SELECT draft FROM tp_q_templates WHERE id = ?').get(id)).draft;
  const by = new Map(after.questions.map(x => [x.id, x]));
  assert.equal(by.get('SHT-01').required, false);
  assert.equal(by.get('SHT-01').ai_meets, 'A plan tested this year.');
  assert.equal(by.get('SHT-01').ai_red_flags, 'No owner named.');
  assert.deepEqual([by.get('SHT-01').evidence_on, by.get('SHT-01').explain_on], ['no', ['no']]);
  assert.deepEqual(by.get('SHT-02').options, ['Yearly', 'Twice a year', 'Never']);
  assert.equal(by.get('SHT-02').allow_other, true);
  assert.ok(!by.has('SHT-03'));
  assert.ok(after.retired_ids.includes('SHT-03'));
  const added = by.get('SHT-04');
  assert.equal(added.answer_type, 'date');
  assert.equal(after.sections.find(s => s.key === added.section).title, 'Extra checks');
  assert.deepEqual(added.show_when, { mode: 'all', conditions: [{ question: 'SHT-01', op: 'is', value: 'yes' }] });

  const bad = await sheet.parseUpload(await writer.buildWorkbook({ sheet: sheet.SHEET, title: 'Bad', note: '', headerRow: 3, columns: sheet.COLUMNS,
    rows: [{ ...sheet.rowOf(by.get('SHT-01'), new Map(after.sections.map(s => [s.key, s.title]))), show_when: '' }, { id: '', section: 'Extra checks', question: 'Tested often?', answer_type: 'Yes, No, Not applicable', show_when: 'SHT-02 is Monthly' }] }));
  await assert.rejects(() => qtLib().importRows(db, { id: 1, user_type: 'firm', firm_id: firmId, firm_role: 'manager' }, id, bad), /Row 5: &#34;Monthly&#34;|Row 5: "Monthly" is not one of the options of SHT-02/);
  await assert.rejects(async () => sheet.parseUpload(await writer.buildWorkbook({ sheet: sheet.SHEET, title: 'Bad', note: '', headerRow: 3, columns: sheet.COLUMNS,
    rows: [{ id: '', section: 'Extra checks', question: 'Colour?', answer_type: 'Colour' }] })), /Row 4: Answer type should be one of/);
  const refused = await upload(buffer, consultant.session);
  assert.equal(refused.status, 403);
});

const qtLib = () => require('../lib/tprm/q-templates');

test('review before publishing shows what changed; the history lists versions, compares each with the one before and restores one into the draft', async () => {
  const made = await client.post(BASE, { name: 'History check', prefix: 'HIS' });
  const id = idIn(made.location, /questionnaires\/(\d+)/);
  const addTo = fields => client.post(`${BASE}/${id}/questions`, { section: 's1', required: '1', settings_shown: '1', ...fields });
  const rv = async () => String((await db.prepare('SELECT row_version FROM tp_q_templates WHERE id = ?').get(id)).row_version);
  assert.equal((await addTo({ answer_type: 'yes_no_na', question: 'Is there an incident plan?' })).status, 302);
  assert.equal((await addTo({ answer_type: 'single_choice', question: 'Who owns it?', options: ['IT', 'Risk'] })).status, 302);
  const first = await client.get(`${BASE}/${id}/publish`);
  assert.equal(first.status, 200);
  assert.match(first.text, /This is the first version/);
  assert.match(first.text, /data-tprm-q-changes-added[\s\S]*HIS-01[\s\S]*HIS-02/);
  assert.match(toast(await client.post(`${BASE}/${id}/publish`, { row_version: await rv(), note: 'First cut' })), /Version 1 published/);
  const again = await client.post(`${BASE}/${id}/publish`, { row_version: await rv() });
  assert.match(toast(again), /Nothing has changed since version 1/);

  assert.equal((await client.post(`${BASE}/${id}/questions/HIS-01`, { section: 's1', required: '', settings_shown: '1', answer_type: 'yes_no_na', question: 'Is there a tested incident plan?', ai_red_flags: 'Never tested.' })).status, 302);
  assert.equal((await client.post(`${BASE}/${id}/questions/HIS-02`, { intent: 'remove', section: 's1', row_version: await rv() })).status, 302);
  assert.equal((await client.post(`${BASE}/${id}/sections`, { title: 'Recovery', row_version: await rv() })).status, 302);
  assert.equal((await addTo({ section: 's2', answer_type: 'date', question: 'When was it last tested?' })).status, 302);
  const review = await client.get(`${BASE}/${id}/publish`);
  assert.match(review.text, /1 question changed, 1 question added, 1 question removed, 1 section added/);
  assert.match(review.text, /data-tprm-q-changes-changed[\s\S]*HIS-01[\s\S]*Question[\s\S]*Is there an incident plan\?[\s\S]*Is there a tested incident plan\?[\s\S]*Answer required[\s\S]*Yes[\s\S]*No[\s\S]*Marking rule: red flags[\s\S]*Not set[\s\S]*Never tested\./);
  assert.match(review.text, /data-tprm-q-changes-removed[\s\S]*HIS-02/);
  assert.match(toast(await client.post(`${BASE}/${id}/publish`, { row_version: await rv() })), /Version 2 published/);

  const list = await client.get(`${BASE}/${id}/versions`);
  assert.equal(list.status, 200);
  assert.match(list.text, /data-tprm-q-version="2"[\s\S]*Latest[\s\S]*data-tprm-q-version="1"[\s\S]*First cut/);
  const v2 = await client.get(`${BASE}/${id}/versions/2`);
  assert.match(v2.text, /What changed from version 1/);
  assert.match(v2.text, /data-tprm-q-restore-form/);
  const restored = await client.post(`${BASE}/${id}/versions/1/restore`, { row_version: await rv() });
  assert.match(toast(restored), /The draft now holds version 1/);
  const d = (await db.prepare('SELECT draft FROM tp_q_templates WHERE id = ?').get(id)).draft;
  assert.deepEqual(d.questions.map(x => x.id), ['HIS-01', 'HIS-02']);
  assert.equal(d.questions[0].question, 'Is there an incident plan?');
  assert.ok(d.retired_ids.includes('HIS-03'), 'numbers used since are not handed out again');
  assert.equal((await addTo({ answer_type: 'yes_no_na', question: 'Anything else?' })).status, 302);
  assert.ok((await db.prepare('SELECT draft FROM tp_q_templates WHERE id = ?').get(id)).draft.questions.some(x => x.id === 'HIS-04'));
  assert.equal((await consultant.session.post(`${BASE}/${id}/versions/1/restore`, {})).status, 403);
  assert.equal((await client.get(`${BASE}/${id}/versions/9`)).status, 404);
});

test('reordering by drag and changing several questions at once: required, optional, move to a section, remove; rules keep their order', async () => {
  const made = await client.post(BASE, { name: 'Bulk check', prefix: 'BLK' });
  const id = idIn(made.location, /questionnaires\/(\d+)/);
  const addTo = fields => client.post(`${BASE}/${id}/questions`, { section: 's1', required: '1', settings_shown: '1', ...fields });
  for (const question of ['First?', 'Second?', 'Third?']) assert.equal((await addTo({ answer_type: 'yes_no_na', question })).status, 302);
  assert.equal((await addTo({ answer_type: 'free_text', question: 'Why not?', show_mode: 'when', show_join: 'all', cond_question: ['BLK-01'], cond_op: ['is'], cond_value: ['no'] })).status, 302);
  assert.equal((await client.post(`${BASE}/${id}/sections`, { title: 'Later' })).status, 302);
  const draft = async () => (await db.prepare('SELECT draft FROM tp_q_templates WHERE id = ?').get(id)).draft;
  const order = async () => qtLib().ordered(await draft()).map(x => x.id);
  const json = (path, body) => client.post(`${BASE}/${id}${path}`, body, { headers: { accept: 'application/json' } });

  const page = await client.get(`${BASE}/${id}`);
  assert.match(page.text, /form="qb-bulk"[^>]*data-tprm-q-tick/);
  assert.match(page.text, /data-tprm-q-bulk[\s\S]*value="required"[\s\S]*value="optional"[\s\S]*value="move"[\s\S]*value="remove"/);
  assert.match(page.text, /data-tprm-q-base="\/tprm\/settings\/questionnaires\/\d+"/);

  const ok = await json('/questions/order', { section: 's1', order: ['BLK-01', 'BLK-03', 'BLK-02', 'BLK-04'] });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).ok, true);
  assert.deepEqual(await order(), ['BLK-01', 'BLK-03', 'BLK-02', 'BLK-04']);
  const broken = await json('/questions/order', { section: 's1', order: ['BLK-04', 'BLK-01', 'BLK-03', 'BLK-02'] });
  assert.equal(broken.status, 400);
  assert.match(JSON.parse(broken.text).message, /BLK-04 would then come before BLK-01, which its rule depends on/);
  assert.deepEqual(await order(), ['BLK-01', 'BLK-03', 'BLK-02', 'BLK-04']);
  assert.equal((await json('/questions/order', { section: 's1', order: ['BLK-01', 'BLK-02'] })).status, 400);
  assert.equal((await json('/sections/order', { order: ['s2', 's1'] })).status, 200);
  assert.deepEqual((await draft()).sections.map(s => s.key), ['s2', 's1']);
  assert.equal((await json('/sections/order', { order: ['s1', 's2'] })).status, 200);

  assert.match(toast(await client.post(`${BASE}/${id}/questions/bulk`, { s: 's1', bulk: 'optional', ids: ['BLK-02', 'BLK-03'] })), /2 questions now optional/);
  assert.deepEqual((await draft()).questions.filter(x => !x.required).map(x => x.id).sort(), ['BLK-02', 'BLK-03']);
  assert.match(toast(await client.post(`${BASE}/${id}/questions/bulk`, { s: 's1', bulk: 'required', ids: ['BLK-03'] })), /1 question now required/);
  const moved = await client.post(`${BASE}/${id}/questions/bulk`, { s: 's1', bulk: 'move', ids: ['BLK-02', 'BLK-03'], to_section: 's2' });
  assert.match(toast(moved), /2 questions moved/);
  assert.match(String(moved.location), /\?s=s2/);
  assert.deepEqual((await draft()).questions.filter(x => x.section === 's2').map(x => x.id), ['BLK-03', 'BLK-02']);
  assert.match(toast(await client.post(`${BASE}/${id}/questions/bulk`, { s: 's1', bulk: 'remove', ids: ['BLK-01'] })), /BLK-04 is shown depending on a question you ticked/);
  assert.match(toast(await client.post(`${BASE}/${id}/questions/bulk`, { s: 's1', bulk: 'remove', ids: ['BLK-01', 'BLK-04'] })), /2 questions removed/);
  const d = await draft();
  assert.deepEqual(d.questions.map(x => x.id).sort(), ['BLK-02', 'BLK-03']);
  assert.ok(d.retired_ids.includes('BLK-01') && d.retired_ids.includes('BLK-04'));
  assert.match(toast(await client.post(`${BASE}/${id}/questions/bulk`, { s: 's2', bulk: 'optional' })), /Tick at least one question first/);
  assert.equal((await consultant.session.post(`${BASE}/${id}/questions/bulk`, { s: 's2', bulk: 'optional', ids: ['BLK-02'] })).status, 403);
});

test('Excel keeps rules on options that start with words like Not or More than', async () => {
  const sheet = require('../lib/tprm/q-template-sheet');
  const qsheet = require('../lib/tprm/question-sheet');
  const made = await client.post(BASE, { name: 'Tricky options', prefix: 'TRK' });
  const id = idIn(made.location, /questionnaires\/(\d+)/);
  const addTo = fields => client.post(`${BASE}/${id}/questions`, { section: 's1', required: '1', settings_shown: '1', ...fields });
  assert.equal((await addTo({ answer_type: 'single_choice', question: 'Is it tested?', options: ['Yes, yearly', 'Not sure', 'More than 10'] })).status, 302);
  assert.equal((await addTo({ answer_type: 'free_text', question: 'Why not sure?', show_mode: 'when', show_join: 'any', cond_question: ['TRK-01', 'TRK-01'], cond_op: ['is', 'is_not'], cond_value: ['Not sure', 'More than 10'] })).status, 302);
  const t = await qtLib().get(db, firmId, id);
  const rows = await sheet.parseUpload(await sheet.buildWorkbook(t, qtLib().ordered(t.draft), 'x'));
  assert.equal(rows[1].input.cond_value.join('|'), 'Not sure|More than 10');
  const manager = { id: 1, user_type: 'firm', firm_id: firmId, firm_role: 'manager' };
  assert.equal((await qtLib().importRows(db, manager, id, rows)).unchanged, true);
  const typed = qsheet.fixRuleValues(qsheet.inputFromCells(k => ({ answer_type: 'Written answer', show_when: 'TRK-01 is Not sure' })[k] || '', 'Row', []), x => t.draft.questions.find(q => q.id === x));
  assert.deepEqual([typed.cond_op, typed.cond_value], [['is'], ['Not sure']]);
  const lower = qsheet.fixRuleValues(qsheet.inputFromCells(k => ({ answer_type: 'Written answer', show_when: 'TRK-01 is more than 10' })[k] || '', 'Row', []), x => t.draft.questions.find(q => q.id === x));
  assert.deepEqual([lower.cond_op, lower.cond_value], [['is'], ['More than 10']]);
});

test('sent instead of the automatic one: the client\'s rulebook questions are still added after yours, unless someone unticks them, which is recorded', async () => {
  const rb = await db.prepare(`SELECT r.id, r.key, r.name FROM tp_rulebooks r WHERE r.firm_id = ? AND r.status = 'active' AND r.enabled ORDER BY r.position, r.id LIMIT 1`).get(firmId);
  assert.ok(rb, 'the firm has an active rulebook');
  const tick = async ws => db.prepare(`INSERT INTO tp_client_rulebooks (workspace_id, firm_id, rulebook_id, rulebook_key) VALUES (?, ?, ?, ?)`).run(ws, firmId, rb.id, rb.key);

  const kept = await tierConfirmed('Rulebook Kept Supplier');
  await tick(kept.ws);
  const form = await allSteps(consultant.session, aBase(kept.ws, kept.tp, kept.a));
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(form.text, new RegExp(`data-tprm-instead-rulebooks[\\s\\S]*?name="include_rulebooks" value="1" checked[\\s\\S]*?${esc(rb.name)}`));
  assert.equal((await consultant.session.post(qBase(kept), { questionnaire_mode: 'instead', template_id: String(templateId), rulebooks_choice_shown: '1', include_rulebooks: '1' })).status, 302);
  const row = await qRow(kept.a);
  const kinds = row.sections.map(s => s.kind);
  assert.equal(row.rulebooks.length, 1);
  assert.ok(!kinds.includes('base') && !kinds.includes('module'));
  assert.ok(kinds.includes('rulebook'), JSON.stringify(kinds));
  assert.ok(kinds.lastIndexOf('template') < kinds.indexOf('rulebook'), 'rulebook questions come after yours');
  const page = await allSteps(consultant.session, aBase(kept.ws, kept.tp, kept.a));
  assert.match(page.text, /data-tprm-questionnaire-instead-note[^>]*>[^<]*rulebooks require are added after yours/);
  assert.match(page.text, /data-tprm-regulatory/);

  const left = await tierConfirmed('Rulebook Left Supplier');
  await tick(left.ws);
  assert.equal((await consultant.session.post(qBase(left), { questionnaire_mode: 'instead', template_id: String(templateId), rulebooks_choice_shown: '1' })).status, 302);
  const lrow = await qRow(left.a);
  assert.deepEqual(lrow.rulebooks, []);
  assert.ok(!lrow.sections.some(s => s.kind === 'rulebook'));
  assert.equal(lrow.template.rulebooks_left_out.rulebooks[0].name, rb.name);
  assert.equal(lrow.template.rulebooks_left_out.by, consultant.id);
  const ev = await db.prepare(`SELECT actor_user_id, after_state FROM tp_events WHERE assessment_id = ? AND action = 'questionnaire.prepared'`).get(left.a);
  assert.equal(Number(ev.actor_user_id), consultant.id);
  assert.deepEqual(ev.after_state.rulebooks_left_out, [rb.name]);
  const lpage = await allSteps(consultant.session, aBase(left.ws, left.tp, left.a));
  assert.match(lpage.text, new RegExp(`data-tprm-rulebooks-left-out>The questions ${esc(rb.name)} requires were left out by qt-consultant@test.local`));
});
