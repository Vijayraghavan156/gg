'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-vf-outbox-')), 'outbox.log');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { completeAnswer, answerFormFields, bootClient, makeClient } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tprm-question-bank.json'), 'utf8'));
const BANK_BY_ID = new Map(BANK.questions.map(q => [q.id, q]));
const good = (id, extra = {}) => completeAnswer(BANK_BY_ID.get(id), id, { ref: `Policy for ${id}`, date: '2026-01-15', ...extra });

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let vendorRoute;
const createdPaths = new Set();

const PASSWORD = 'vendor-findings-tests-password-1234';
const LOW = {
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no',
};

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  vendorRoute = require('../routes/tprm-vendor');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('vf-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('vf-senior@test.local', { role: 'senior_consultant' });
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
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const qBase = ctx => `${aBase(ctx.ws, ctx.tp, ctx.a)}/questionnaire`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const qRow = async a => db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(a);
const answerOf = async (a, qid) => db.prepare('SELECT * FROM tp_answers WHERE assessment_id=? AND question_id=?').get(a, qid);
const idsOf = q => q.sections.flatMap(s => s.ids);

async function addThirdParty(ws, name) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosted service' })).status, 302);
  return tp;
}

async function startAssessment(ws, tp, answers) {
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302);
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(answers)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  const res = await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) });
  assert.equal(res.status, 302);
  return a;
}

async function linked(name, { answers = LOW } = {}) {
  const ws = await tprmClient(`${name} Client`);
  const tp = await addThirdParty(ws, name);
  const a = await startAssessment(ws, tp, answers);
  const ctx = { ws, tp, a };
  assert.equal((await consultant.session.post(qBase(ctx), {})).status, 302);
  const row = await qRow(a);
  const res = await consultant.session.post(`${qBase(ctx)}/links`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(row.row_version),
  });
  const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
  assert.ok(url, 'a link was shown');
  return { ...ctx, token: url.split('/vendor/q/')[1] };
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
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8'), location: res.headers.location || null });
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}

const vget = (token, query = '') => request('GET', `/vendor/q/${token}${query}`);
async function sectionOf(a, id) {
  const q = await qRow(a);
  const index = q.sections.findIndex(s => s.ids.includes(id));
  assert.ok(index >= 0, `${id} is in the questionnaire`);
  return index + 1;
}
const vsection = async (token, a, id) => vget(token, `?s=${await sectionOf(a, id)}`);
const aftOf = text => (String(text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];

function multipart(fields, files = []) {
  const boundary = '----tprmvf' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of fields) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${f.field}"; filename="${f.filename}"`,
      `Content-Type: ${f.type || 'application/octet-stream'}`, '', f.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function save(token, answers, { files = [], intent = 'save', section = null, extra = [] } = {}) {
  const value = aftOf((await vget(token)).text);
  const fields = [['_aft', value], ...answerFormFields(answers, BANK_BY_ID), ['intent', intent], ...(section ? [['section', String(section)]] : []), ...extra];
  const form = multipart(fields, files);
  const res = await request('POST', `/vendor/q/${token}/save`, { body: form.body, headers: form.headers });
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(r.stored_path);
  return res;
}

async function postForm(token, suffix, fields) {
  const value = aftOf((await vget(token)).text);
  const body = new URLSearchParams([['_aft', value], ...fields]).toString();
  return await request('POST', `/vendor/q/${token}${suffix}`, { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
}

async function addDocument(token, name, content) {
  const value = aftOf((await vget(token, '?view=documents')).text);
  const form = multipart([['_aft', value], ['desc_1', '']], [{ field: 'doc_file_1', filename: name, content, type: 'text/plain' }]);
  const res = await request('POST', `/vendor/q/${token}/documents`, { body: form.body, headers: form.headers });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(r.stored_path);
  return Number((await db.prepare("SELECT id FROM tp_evidence WHERE original_name = ? ORDER BY id DESC LIMIT 1").get(name)).id);
}

const questionBlock = (text, id) => {
  const start = text.indexOf(`data-vendor-question="${id}"`);
  assert.ok(start >= 0, `${id} is on the page`);
  const next = text.indexOf('data-vendor-question="', start + 10);
  return text.slice(start, next < 0 ? undefined : next);
};

test('a section that fails to save keeps the chosen documents and removal ticks, names only what is saved, and points at the bad field', async () => {
  const ctx = await linked('Kept Picks Co');
  const policy = await addDocument(ctx.token, 'kept-policy.txt', 'policy text');
  const other = await addDocument(ctx.token, 'kept-other.txt', 'other text');
  const s = await sectionOf(ctx.a, 'PRV-07');
  const first = await save(ctx.token, { 'PRV-07': good('PRV-07', { pick: [other], ref: '' }) }, { section: s });
  assert.equal(first.status, 303, first.text.slice(0, 400));
  const bad = good('PRV-07', { ref: 'Breach procedure v2', pick: [policy], remove: [other] });
  bad.f = { ...bad.f, window_hours: '4 (same working day, usually sooner)' };
  const res = await save(ctx.token, { 'PRV-07': bad }, { section: s });
  assert.equal(res.status, 400);
  assert.match(res.text, /Nothing was saved/);
  const block = questionBlock(res.text, 'PRV-07');
  assert.match(block, new RegExp(`name="pick\\[PRV-07\\]" value="${policy}" checked`), 'the chosen document is still ticked');
  assert.match(block, new RegExp(`name="remove\\[PRV-07\\]" value="${other}" checked`), 'the removal tick is still ticked');
  assert.match(block, /<details class="vq-doc" open>/, 'the document chooser is open so the ticks can be seen');
  assert.doesNotMatch(block, /data-vendor-named/, 'a reference that was not saved is not shown as named');
  assert.match(block, /name="ref\[PRV-07\]"[^>]*value="Breach procedure v2"/, 'the typed reference stays in its box');
  assert.match(block, /data-vendor-field-error="window_hours">[^<]*write a number only, such as 4/, 'the error sits at the number field');
  assert.match(block, /id="f-PRV-07-window_hours"[^>]*aria-invalid="true"/);
  assert.match(res.text, /href="#f-PRV-07-window_hours">PRV-07<\/a>/, 'the summary links to the field itself');
  assert.equal((await db.prepare(`SELECT COUNT(*)::int AS n FROM tp_answer_evidence l JOIN tp_answers a ON a.id = l.answer_id
    WHERE a.assessment_id = ? AND a.question_id = 'PRV-07'`).get(ctx.a)).n, 1, 'one bad field still blocks the whole save');
});

test('number fields say they take numbers only and the unit, keep long input, and work as plain text boxes', async () => {
  const ctx = await linked('Number Hint Co');
  const page = await vsection(ctx.token, ctx.a, 'PRV-07');
  const block = questionBlock(page.text, 'PRV-07');
  const input = (block.match(/<input[^>]*id="f-PRV-07-window_hours"[^>]*>/) || [''])[0];
  assert.match(block, /data-vendor-number-hint>Numbers only, in hours, for example 4</);
  assert.match(input, /type="text"/);
  assert.match(input, /inputmode="decimal"/);
  assert.doesNotMatch(input, /maxlength/, 'long input is not cut silently');
  const long = good('PRV-07');
  long.f = { ...long.f, window_hours: '123456789012345678901234' };
  const res = await save(ctx.token, { 'PRV-07': long }, { section: await sectionOf(ctx.a, 'PRV-07') });
  assert.equal(res.status, 400);
  assert.match(res.text, /Notification window in hours: the number is too long/);
  const ok = good('PRV-07');
  ok.f = { ...ok.f, window_hours: '4' };
  assert.equal((await save(ctx.token, { 'PRV-07': ok })).status, 303);
  assert.match((await answerOf(ctx.a, 'PRV-07')).detail, /Notification window in hours: 4/);
});

test('short fields are two-line boxes, and a line break in one is saved, not counted twice', async () => {
  const ctx = await linked('Short Box Co');
  const page = await vsection(ctx.token, ctx.a, 'PRV-07');
  assert.match(questionBlock(page.text, 'PRV-07'), /<textarea[^>]*id="f-PRV-07-escalation_contact"[^>]*rows="2"[^>]*maxlength="300"/);
  const a = good('PRV-07');
  a.f = { ...a.f, window_hours: '4', escalation_contact: `${'x'.repeat(149)}\r\n${'y'.repeat(150)}` };
  const res = await save(ctx.token, { 'PRV-07': a });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  assert.equal((await answerOf(ctx.a, 'PRV-07')).fields.escalation_contact, `${'x'.repeat(149)}\n${'y'.repeat(150)}`);
});

function runVendorScript({ unsaved = false } = {}) {
  const vm = require('node:vm');
  const listeners = { window: {}, form: {} };
  const on = bag => (type, fn) => { (bag[type] = bag[type] || []).push(fn); };
  const form = { addEventListener: on(listeners.form), hasAttribute: name => unsaved && name === 'data-vendor-unsaved' };
  const document = {
    querySelectorAll: sel => (sel === 'form[data-vendor-answer-form]' ? [form] : []),
    querySelector: () => null,
    addEventListener: () => {},
  };
  const window = { addEventListener: on(listeners.window) };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'tprm-vendor.js'), 'utf8'), { document, window, Map, Set, FormData: undefined });
  const fire = (bag, type, event = {}) => (bag[type] || []).forEach(fn => fn(event));
  const leave = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    fire(listeners.window, 'beforeunload', event);
    return event.prevented;
  };
  return { leave, type: () => fire(listeners.form, 'input'), submit: () => fire(listeners.form, 'submit') };
}

test('leaving a section with unsaved changes asks first; saving does not; the page still works without the script', async () => {
  const page = runVendorScript();
  assert.equal(page.leave(), false, 'nothing typed, no warning');
  page.type();
  assert.equal(page.leave(), true, 'typed and not saved: the browser asks before leaving or reloading');
  page.submit();
  assert.equal(page.leave(), false, 'a save or a menu button submits the form, so no warning');
  assert.equal(runVendorScript({ unsaved: true }).leave(), true, 'a form shown again after a failed save is unsaved from the start');
  const ctx = await linked('Unsaved Warn Co');
  const failed = good('PRV-07');
  failed.f = { ...failed.f, window_hours: 'soon' };
  const res = await save(ctx.token, { 'PRV-07': failed }, { section: await sectionOf(ctx.a, 'PRV-07') });
  assert.match(res.text, /<form method="POST"[^>]*data-vendor-answer-form data-vendor-unsaved>/);
  const fresh = await vsection(ctx.token, ctx.a, 'PRV-07');
  assert.match(fresh.text, /<form method="POST" action="[^"]*\/save"[^>]*data-vendor-answer-form>/, 'a plain form post, so saving needs no script');
});

async function sheetText(token) {
  const res = await request('GET', `/vendor/q/${token}/spreadsheet`);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  const zip = await require('jszip').loadAsync(res.body);
  const names = Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  return { res, xml: (await Promise.all(names.map(n => zip.file(n).async('string')))).join('\n') };
}
const sheetRow = (xml, id) => (xml.match(new RegExp(`<row r="\\d+">(?:(?!</row>).)*?<t xml:space="preserve">${id}</t>(?:(?!</row>).)*</row>`, 's')) || [''])[0];

test('a file chosen without an answer does not say "Answered by", and the spreadsheet says when a file is already attached', async () => {
  const ctx = await linked('Answered By Co');
  const doc = await addDocument(ctx.token, 'answered-by.txt', 'a policy');
  const s = await sectionOf(ctx.a, 'PRV-07');
  const res = await save(ctx.token, { 'PRV-07': { pick: [doc] } }, { section: s });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  const a = await answerOf(ctx.a, 'PRV-07');
  assert.ok(a && a.saved_at && !a.response, 'a file is linked to a question with no answer yet');
  const page = await vsection(ctx.token, ctx.a, 'PRV-07');
  assert.doesNotMatch(questionBlock(page.text, 'PRV-07'), /data-vendor-answered-by/);
  assert.match(questionBlock(page.text, 'PRV-07'), /answered-by\.txt/);
  const { xml } = await sheetText(ctx.token);
  assert.match(sheetRow(xml, 'PRV-07'), /A file is attached in the portal\./);
  assert.doesNotMatch(sheetRow(xml, 'PRV-07'), /add the file in the portal/);
  assert.match(sheetRow(xml, 'INC-02'), /Evidence is required: add the file in the portal\./, 'a question with no file still asks for one');
});

test('an incomplete answer says it was saved and still needs something; the spreadsheet uses the portal evidence rule', async () => {
  const ctx = await linked('Saved Not Complete Co');
  const ids = idsOf(await qRow(ctx.a));
  const yesEvidence = ids.filter(id => BANK_BY_ID.get(id) && BANK_BY_ID.get(id).answer_type === 'yes_no_na' && BANK_BY_ID.get(id).evidence_mandatory
    && BANK_BY_ID.get(id).evidence_on === 'yes');
  assert.ok(yesEvidence.length >= 2, 'two questions that need evidence on Yes');
  const [partial, noAnswer] = yesEvidence;
  const res = await save(ctx.token, {
    [partial]: { r: 'yes' },
    [noAnswer]: { r: 'no', d: 'We do not do this yet.' },
    'INC-02': good('INC-02', { ref: 'Notification procedure v3.' }),
  });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  const block = questionBlock((await vsection(ctx.token, ctx.a, partial)).text, partial);
  assert.match(block, /data-vendor-saved-by>Saved by Priya Vendor on [^<]+\. Not complete yet: it still needs something before you can submit\./);
  assert.doesNotMatch(block, /data-vendor-answered-by|>Answered by/);
  const named = questionBlock((await vsection(ctx.token, ctx.a, 'INC-02')).text, 'INC-02');
  assert.match(named, /data-vendor-answered-by>Answered by Priya Vendor on /, 'a complete answer still says answered');
  const { xml } = await sheetText(ctx.token);
  assert.match(sheetRow(xml, 'INC-02'), /You named a document as evidence: Notification procedure v3\./);
  assert.doesNotMatch(sheetRow(xml, 'INC-02'), /Evidence is required/, 'a named document is accepted, as in the portal');
  assert.match(sheetRow(xml, noAnswer), /No evidence is needed for this answer\./);
  assert.doesNotMatch(sheetRow(xml, noAnswer), /Evidence is required/);
  assert.match(sheetRow(xml, partial), /Evidence is required: add the file in the portal\./, 'a Yes with nothing attached or named still asks for evidence');
});

async function answerAll(ctx, overrides = {}) {
  const q = await qRow(ctx.a);
  const answers = {};
  for (const id of idsOf(q)) answers[id] = good(id);
  answers['AIS-01'] = { r: 'no', d: 'No AI is used to provide the service.' };
  Object.assign(answers, overrides);
  const res = await save(ctx.token, answers);
  assert.equal(res.status, 303, `saved (${res.status}: ${res.text.slice(0, 300)})`);
  return answers;
}

test('a file kept on an answer changed to No stays visible to the supplier with a way to remove it, and is not shown to the reviewers as evidence', async () => {
  const ctx = await linked('Set Aside Co');
  const doc = await addDocument(ctx.token, 'erasure-procedure.txt', 'erasure procedure');
  const s = await sectionOf(ctx.a, 'PRV-08');
  assert.equal((await save(ctx.token, { 'PRV-08': good('PRV-08', { pick: [doc], ref: '' }) }, { section: s })).status, 303);
  assert.equal((await save(ctx.token, { 'PRV-08': { r: 'no', d: 'We return data instead of erasing it.' } }, { section: s })).status, 303);
  const answer = await answerOf(ctx.a, 'PRV-08');
  assert.equal(answer.response, 'no');
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS n FROM tp_answer_evidence WHERE answer_id = ?').get(answer.id)).n, 1, 'the supplier\'s file is not deleted');
  const block = questionBlock((await vsection(ctx.token, ctx.a, 'PRV-08')).text, 'PRV-08');
  const aside = (block.match(/<div class="vq-set-aside" data-vendor-set-aside="PRV-08">[\s\S]*?<\/div>/) || [''])[0];
  assert.match(aside, /With the answer "No", no document is needed, so the reviewers do not see this file/);
  assert.match(aside, /erasure-procedure\.txt/);
  assert.match(aside, new RegExp(`name="remove\\[PRV-08\\]" value="${doc}"`), 'the supplier can remove it');
  assert.doesNotMatch(aside, /class="vq-evidence/, 'not inside the block the page hides for a No');
  assert.deepEqual((await require('../lib/tprm/vendor-answers').evidenceInUse(db, ctx.ws, ctx.a)).filter(x => x.question_id === 'PRV-08'), []);
  await answerAll(ctx, { 'PRV-08': { r: 'no', d: 'We return data instead of erasing it.' } });
  const submitted = await postForm(ctx.token, '/submit', [['confirm_submit', '1']]);
  assert.ok([200, 303].includes(submitted.status), submitted.text.slice(0, 300));
  const review = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=review&answers=all`);
  assert.equal(review.status, 200);
  const at = review.text.indexOf('PRV-08');
  assert.ok(at >= 0, 'the answer is on the review step');
  assert.doesNotMatch(review.text, /erasure-procedure\.txt/, 'the file is not shown as evidence for a No');
});

test('removing a kept file from a No answer takes it off the answer', async () => {
  const ctx = await linked('Set Aside Remove Co');
  const doc = await addDocument(ctx.token, 'aside-remove.txt', 'aside remove');
  const s = await sectionOf(ctx.a, 'PRV-08');
  assert.equal((await save(ctx.token, { 'PRV-08': good('PRV-08', { pick: [doc], ref: '' }) }, { section: s })).status, 303);
  assert.equal((await save(ctx.token, { 'PRV-08': { r: 'no', d: 'Returned instead.' } }, { section: s })).status, 303);
  assert.equal((await save(ctx.token, { 'PRV-08': { r: 'no', d: 'Returned instead.', remove: [doc] } }, { section: s })).status, 303);
  const answer = await answerOf(ctx.a, 'PRV-08');
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS n FROM tp_answer_evidence WHERE answer_id = ?').get(answer.id)).n, 0);
});

test('an answer counts as answered only once it could be submitted, the same on the overview, the menu, the section and the review page', async () => {
  const ctx = await linked('Counts Co');
  const half = good('PRV-07');
  half.f = { window_hours: '4' };
  const s = await sectionOf(ctx.a, 'PRV-07');
  assert.equal((await save(ctx.token, { 'PRV-07': half }, { section: s })).status, 303);
  const title = (await qRow(ctx.a)).sections[s - 1].title;
  const total = (await qRow(ctx.a)).sections[s - 1].ids.length;
  const overview = (await vget(ctx.token)).text;
  const esc = title.replace(/&/g, '&amp;');
  assert.doesNotMatch(overview, /data-vendor-overview-section/, 'the section list carries the counts, not a table');
  const item = (overview.match(new RegExp(`data-vendor-section-link="${esc}"[\\s\\S]*?</a>`)) || [''])[0];
  assert.match(item, /data-vq-mark="part"/, 'started, so half marked');
  assert.match(item, new RegExp(`<span aria-hidden="true">0/${total}</span><span class="sr-only">0 of ${total} answered, 1 question needs attention</span>`), 'a half-filled answer is not complete');
  assert.match(overview, /data-vendor-progress>0 of \d+ questions answered/);
  assert.match(overview, /Continue where you left off/, 'the supplier has still started');
  const section = (await vget(ctx.token, `?s=${s}`)).text;
  assert.match(section, new RegExp(`data-vendor-section-link="${esc}"[^>]*><span>[^<]*</span><span class="vq-menu-state"><span aria-hidden="true">0/${total}<`));
  assert.match(section, new RegExp(`vq-section-progress">0 of ${total} answered\\.`));
  const review = (await vget(ctx.token, '?view=review')).text;
  const rrow = (review.match(new RegExp(`<tr data-vendor-review-section="${title.replace(/&/g, '&amp;')}">[\\s\\S]*?</tr>`)) || [''])[0];
  assert.match(rrow, new RegExp(`0 of ${total}</td>\\s*<td>${total - 1} unanswered, 1 needs attention`));
  const full = good('PRV-07');
  full.f = { ...full.f, window_hours: '4' };
  assert.equal((await save(ctx.token, { 'PRV-07': full }, { section: s })).status, 303);
  assert.match((await vget(ctx.token)).text, /data-vendor-progress>1 of \d+ questions answered/);
});

test('submitting redirects to the thank-you page, which carries the firm name and a copy of the submitted answers; the copy cannot be uploaded', async () => {
  const ctx = await linked('After Submit Co');
  await answerAll(ctx);
  await db.prepare(`UPDATE firms SET name = 'Northbridge Review Partners' WHERE id = ?`).run(firmId);
  const res = await postForm(ctx.token, '/submit', [['confirm_submit', '1']]);
  assert.equal(res.status, 303, 'post, redirect, get: Back does not ask to send the form again');
  assert.equal(res.location, `/vendor/q/${ctx.token}`);
  assert.equal((await qRow(ctx.a)).status, 'submitted');
  const page = await vget(ctx.token);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1 class="vq-page-title">Thank you<\/h1>/);
  assert.match(page.text, /data-vendor-brandbar="firm"/);
  assert.match(page.text, /data-vendor-firm>[^<]+</, 'the firm is named in the top bar');
  assert.match(page.text, new RegExp(`data-vendor-submitted-copy><a href="/vendor/q/${ctx.token}/spreadsheet">Download your answers as submitted</a>`));
  const { res: sheet, xml } = await sheetText(ctx.token);
  assert.match(String(sheet.headers['content-disposition']), /as-submitted\.xlsx/);
  assert.match(xml, /Your answers as submitted on [^<]+\. This copy is for your records: it cannot be uploaded/);
  assert.match(sheetRow(xml, 'PRV-07:window_hours'), /<t xml:space="preserve">24<\/t>/, 'the copy holds the answers');
  const again = await postForm(ctx.token, '/submit', [['confirm_submit', '1']]);
  assert.equal(again.status, 404, 'sending the form again changes nothing');
  const invalid = await vget('not-a-real-token-at-all-0000000000000000000');
  assert.match(invalid.text, /data-vendor-brandbar="plain"/, 'a bad link never shows whose portal it is');
});

const mails = async (ws, kind) => db.prepare('SELECT * FROM email_outbox WHERE workspace_id=? AND related_type=? ORDER BY id').all(ws, `tprm:${kind}`);

test('a supplier comment emails the reviewers with the comment, once, and the page says who sees it and where replies come from', async () => {
  const ctx = await linked('Comment Notice Co');
  const page = await vsection(ctx.token, ctx.a, 'PRV-07');
  const who = (questionBlock(page.text, 'PRV-07').match(/data-vendor-comment-who>([^<]*)</) || [])[1] || '';
  assert.match(who, /^The reviewers at .+ see your comment once you save\. Replies come by email from your reviewer, /);
  assert.match(who, /vf-consultant@test\.local/);
  const s = await sectionOf(ctx.a, 'PRV-07');
  const res = await save(ctx.token, {}, { section: s, extra: [['c[PRV-07]', 'Does "detection" mean our SOC or our provider?']] });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  const sent = await mails(ctx.ws, 'consultant_vendor_comment');
  assert.equal(sent.length, 1, 'the reviewer hears about the comment before the questionnaire is submitted');
  assert.equal(sent[0].to_email, 'vf-consultant@test.local');
  assert.match(sent[0].subject, /left a comment on PRV-07/);
  assert.match(sent[0].body_html, /Does &quot;detection&quot; mean our SOC or our provider\?|Does "detection" mean our SOC or our provider\?/);
  assert.match(sent[0].body_html, /priya@thirdparty\.example\.net/, 'the reviewer can reply to the supplier');
  assert.equal((await save(ctx.token, {}, { section: s })).status, 303);
  assert.equal((await mails(ctx.ws, 'consultant_vendor_comment')).length, 1, 'saving again without a new comment sends nothing');
});

test('the contract clauses page keeps the questionnaire menu with each section\'s progress', async () => {
  const ctx = await linked('Contract Menu Co');
  const page = await vget(ctx.token, '/contract');
  assert.equal(page.status, 200);
  const q = await qRow(ctx.a);
  assert.equal((page.text.match(/data-vendor-section-link=/g) || []).length, q.sections.length * 2, 'every section, in the side menu and the phone menu');
  assert.match(page.text, /data-vendor-nav="contract" class="vq-menu-item is-current" href="[^"]*\/contract" aria-current="page"/);
  assert.match(page.text, /data-vendor-nav="review" class="vq-menu-item" href="[^"]*\?view=review"/);
  assert.match(page.text, /data-vendor-progress>0 of \d+ questions answered</);
  assert.equal((page.text.match(/<span>Contract clauses<\/span>/g) || []).length, 2, 'contract clauses listed once per menu');
});

const HIGH_PERSONAL = {
  data_handled: 'personal', service_stops: 'slows', system_access: 'user', regulated: 'no', replaceability: 'with_effort',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no',
};

test('the certificate tip names what each document covers and what it needs, and holds: the Statement of Applicability counts as a file on ASR-02, not as a name', async () => {
  const ctx = await linked('Cert Tip Co', { answers: HIGH_PERSONAL });
  const p = await require('../lib/tprm/vendor-answers').pageData(db, await require('../lib/tprm/vendor-answers').linkContext(db, ctx.token));
  const tip = ((await vget(ctx.token)).text.match(/data-vendor-report-hint>([\s\S]*?)<\/p>/) || [])[1] || '';
  assert.ok(p.reports.others.iso27001 > 0 && p.reports.others.soc2_type2 > 0);
  assert.notEqual(p.reports.others.iso27001, p.reports.others.soc2_type2, 'the two counts differ, so one "up to" figure would mislead');
  assert.match(tip, new RegExp(`ISO 27001 certificate, answer ASR-01 with the certificate and your Statement of Applicability attached \\(as a second file on ASR-01, or on ASR-02\\): together they cover the documents for ${p.reports.others.iso27001} other questions`));
  assert.match(tip, new RegExp(`SOC 2 Type II report, answer ASR-03 with the report attached and its period end date: it covers the documents for ${p.reports.others.soc2_type2} other questions`));
  assert.doesNotMatch(tip, /up to/);
  const s = await sectionOf(ctx.a, 'ASR-01');
  const iso = { r: 'yes', f: { certificate_number: 'IS 1', certification_body: 'BSI', issue_date: '2025-01-10', expiry_date: '2099-01-09', scope: 'All services' } };
  const named = { r: 'yes', y: 'None excluded', ref: 'Statement of Applicability v3.2', date: '2026-01-15' };
  let res = await save(ctx.token, { 'ASR-01': iso, 'ASR-02': named }, { section: s, files: [{ field: 'file__ASR-01', filename: 'iso-cert.txt', content: 'certificate', type: 'text/plain' }] });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  const reports = () => db.prepare('SELECT kind FROM tp_assurance_reports WHERE assessment_id = ?').all(ctx.a);
  assert.equal((await reports()).length, 0, 'a named Statement of Applicability does not make the certificate count');
  assert.match((await vget(ctx.token, `?s=${s}`)).text, /data-vendor-report-note="iso27001">To use this certificate for \d+ other questions, attach the Statement of Applicability as a second file here or on ASR-02: naming it is not enough\.</);
  res = await save(ctx.token, { 'ASR-02': { r: 'yes', y: 'None excluded' } }, { section: s, files: [{ field: 'file__ASR-02', filename: 'soa.txt', content: 'statement of applicability', type: 'text/plain' }] });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  assert.deepEqual((await reports()).map(r => r.kind), ['iso27001'], 'the file on ASR-02 completes the certificate, as the tip says');
});

test('the contract checklist cites RBI, SEBI or Indian law only for a client whose rulebooks bring them in; others see neutral wording', async () => {
  const ctx = await linked('Neutral Basis Co');
  const start = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/contract-review/start`, {});
  assert.equal(start.status, 302);
  const page = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}/contract-review`);
  assert.equal(page.status, 200);
  const bases = page.text.match(/Basis: [^<]*/g) || [];
  assert.ok(bases.length > 20, 'the basis line is still shown');
  assert.deepEqual(bases.filter(b => /RBI|SEBI|DPDPA|IT Act|CERT-In/.test(b)), [], 'no Indian regulator is cited to a client without those rulebooks');
  assert.match(page.text, /data-tprm-clause="CT-01"[\s\S]*?Basis: Good practice</);
  assert.match(page.text, /data-tprm-clause="CT-38"[\s\S]*?Basis: Good practice</);
  const CR = require('../lib/tprm/contract-review');
  assert.equal(CR.basisFor('RBI Managing Risks in Outsourcing Directions 2025', ['RBI', 'Financial-sector (shared)', 'India baseline (CERT-In)']), 'RBI Managing Risks in Outsourcing Directions 2025');
  assert.equal(CR.basisFor('DPDPA 2023 / RBI Managing Risks in Outsourcing 2025', ['Financial-sector (shared)', 'India baseline (CERT-In)']), 'DPDPA 2023');
  assert.equal(CR.basisFor('SEBI CSCRF / <Client> addendum', []), '<Client> addendum');
});

test('bank version 8 for a supplier: a "none" needs no document, REG-07 reads one way, detail boxes are there, no repeated questions, one privacy section name', async () => {
  const ctx = await linked('Bank Eight Co', { answers: HIGH_PERSONAL });
  const q = await qRow(ctx.a);
  const ids = idsOf(q);
  for (const [repeat, twin] of [['CLM-11', 'EXT-08'], ['CLM-01', 'CLD-02'], ['PRM-04', 'PRV-06'], ['PRM-07', 'APP-06']]) {
    assert.ok(ids.includes(twin) && !ids.includes(repeat), `${repeat} is not asked on top of ${twin}`);
  }
  assert.ok(ids.includes('PRM-01') && ids.includes('CLM-05'), 'module questions that are not repeats stay');
  assert.deepEqual(q.sections.map(s => s.title).filter(t => /privacy/i.test(t)), ['Privacy Programme', 'Personal Data & Privacy']);
  const s = await sectionOf(ctx.a, 'ASR-04');
  assert.equal((await save(ctx.token, { 'ASR-04': { r: 'no' } }, { section: s })).status, 303, 'No, with nothing more, saves');
  const review = (await vget(ctx.token, '?view=review')).text;
  assert.doesNotMatch(review, /data-vendor-problem="ASR-04"/, 'an honest none needs no document and no explanation');
  const asr = questionBlock((await vget(ctx.token, `?s=${s}`)).text, 'ASR-04');
  assert.match(asr, /Do you hold any other current certifications or attestations/);
  assert.match(asr, /data-vendor-yes-details="ASR-04"/);
  const yes = await save(ctx.token, { 'ASR-04': { r: 'yes', y: 'ISO 22301, all sites, expires 2027' } }, { section: s });
  assert.equal(yes.status, 303);
  assert.match((await vget(ctx.token, '?view=review')).text, /data-vendor-problem="ASR-04" data-vendor-problem-kind="evidence"/, 'a certificate held still needs its document');
  const reg = questionBlock((await vsection(ctx.token, ctx.a, 'REG-07')).text, 'REG-07');
  assert.match(reg, /Can you confirm that no director, key managerial personnel or approver/);
  assert.match(reg, /Answer Yes to confirm there is no such relationship\. Answer No if there is one, and describe it in the explanation/);
  const carried = require('../lib/tprm/vendor-answers').normalisedCopy(require('../lib/tprm/vendor-answers').rulesMap(BANK).get('REG-07'), { response: 'no', detail: 'Our founder is related to a director at the client.', fields: null, evidence_ref: null, evidence_date: null });
  assert.deepEqual([carried.response, carried.detail], ['no', 'Our founder is related to a director at the client.'], 'a disclosure carried over from last time keeps its meaning and its words');
  for (const id of ['FTP-03', 'FTP-05']) assert.match(questionBlock((await vsection(ctx.token, ctx.a, id)).text, id), new RegExp(`data-vendor-yes-details="${id}"`));
  assert.match(questionBlock((await vsection(ctx.token, ctx.a, 'RET-03')).text, 'RET-03'), /id="f-RET-03-retention"/);
});

test('migration 151 makes version 8 from a published version 7 as a new version; questionnaires keep the version they were sent with', async () => {
  const m151 = require('../migrations/151_tprm_bank_v8_no_repeats');
  const V7 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'tprm-question-bank-v7.json'), 'utf8'));
  const ctx = await linked('Version Pin Co', { answers: HIGH_PERSONAL });
  const before = (await qRow(ctx.a)).bank_version_id;
  const last = (await db.prepare('SELECT COALESCE(MAX(version), 0)::int AS v FROM tp_question_bank_versions').get()).v;
  const raw = `${JSON.stringify(V7, null, 1)}\n`;
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, source, content, content_sha256, question_count) VALUES (?, ?, ?, ?::jsonb, ?, ?)`)
    .run(last + 1, V7.version, null, raw, crypto.createHash('sha256').update(raw).digest('hex'), V7.questions.length);
  await m151.up(db);
  const rows = await db.prepare('SELECT version, label, content FROM tp_question_bank_versions WHERE version > ? ORDER BY version').all(last);
  assert.deepEqual(rows.map(r => r.version), [last + 1, last + 2], 'a new version on top, the old one kept');
  assert.deepEqual(rows[1].content, BANK, 'the new version is the shipped bank');
  await m151.up(db);
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS n FROM tp_question_bank_versions WHERE version > ?').get(last)).n, 2, 'running it again adds nothing');
  assert.equal((await qRow(ctx.a)).bank_version_id, before, 'a questionnaire already made keeps its version');
});
