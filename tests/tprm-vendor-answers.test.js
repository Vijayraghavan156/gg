'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-va-outbox-')), 'outbox.log');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { completeAnswer, answerFormFields, bootClient, makeClient, allSteps } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tprm-question-bank.json'), 'utf8'));
const BANK_BY_ID = new Map(BANK.questions.map(q => [q.id, q]));
const AI_IDS = BANK.questions.filter(q => q.pack === 'AI Services').map(q => q.id);
function good(id, extra = {}) {
  return completeAnswer(BANK_BY_ID.get(id), id, { ref: `Policy for ${id}`, date: '2026-01-15', ...extra });
}

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let events;
let vendorRoute;
const createdPaths = new Set();

const PASSWORD = 'vendor-answers-tests-password-1234';
const LOW = {
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no',
};

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  events = require('../lib/tprm/events');
  vendorRoute = require('../routes/tprm-vendor');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('va-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('va-senior@test.local', { role: 'senior_consultant' });
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

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firm : null,
    type === 'firm' ? role : null)).lastInsertRowid);
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
const answersOf = async a => db.prepare(`SELECT *, to_char(evidence_date, 'YYYY-MM-DD') AS evidence_day FROM tp_answers
  WHERE assessment_id=? ORDER BY question_id`).all(a);
const answerOf = async (a, qid) => db.prepare('SELECT * FROM tp_answers WHERE assessment_id=? AND question_id=?').get(a, qid);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);
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
  assert.equal(started.status, 302, toast(started));
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(answers)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  const res = await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) });
  assert.equal(res.status, 302);
  assert.equal((await assessmentRow(a)).status, 'tier_confirmed');
  return a;
}

async function linked(name, { answers = LOW, ws = null } = {}) {
  const wsId = ws || await tprmClient(`${name} Client`);
  const tp = await addThirdParty(wsId, name);
  const a = await startAssessment(wsId, tp, answers);
  const ctx = { ws: wsId, tp, a };
  assert.equal((await consultant.session.post(qBase(ctx), {})).status, 302);
  const link = await createLink(ctx);
  assert.ok(link.token, 'a link was shown');
  return { ...ctx, token: link.token };
}

async function createLink(ctx, body = {}) {
  const row = await qRow(ctx.a);
  const res = await consultant.session.post(`${qBase(ctx)}/links`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(row.row_version), ...body,
  });
  const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
  return { res, token: url ? url.split('/vendor/q/')[1] : null };
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

const vget = token => request('GET', `/vendor/q/${token}`);
async function vsection(token, a, id) {
  const q = await db.prepare('SELECT sections FROM tp_questionnaires WHERE assessment_id=?').get(a);
  const index = q.sections.findIndex(s => s.ids.includes(id));
  assert.ok(index >= 0, `${id} is in the questionnaire`);
  return request('GET', `/vendor/q/${token}?s=${index + 1}`);
}
const aftOf = text => (String(text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];

function multipart(fields, files = []) {
  const boundary = '----tprmva' + crypto.randomBytes(8).toString('hex');
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

async function save(token, answers, { files = [], intent = 'save', aft, headers = {} } = {}) {
  const value = aft === undefined ? aftOf((await vget(token)).text) : aft;
  const fields = [...(value == null ? [] : [['_aft', value]]), ...answerFields(answers), ['intent', intent]];
  const form = multipart(fields, files);
  const res = await request('POST', `/vendor/q/${token}/save`, { body: form.body, headers: { ...form.headers, ...headers } });
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(r.stored_path);
  return res;
}

async function postForm(token, suffix, fields, { aft, headers = {} } = {}) {
  const value = aft === undefined ? aftOf((await vget(token)).text) : aft;
  const body = new URLSearchParams([...(value == null ? [] : [['_aft', value]]), ...fields]).toString();
  return await request('POST', `/vendor/q/${token}${suffix}`, { body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
}

const submitLink = (token, opts) => postForm(token, '/submit', [], opts);

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

async function submitted(name, opts) {
  const ctx = await linked(name, opts);
  await answerAll(ctx);
  const res = await submitLink(ctx.token);
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal((await qRow(ctx.a)).status, 'submitted');
  return ctx;
}

const firmPage = ctx => allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));

async function legacyInReview(ctx) {
  const rec = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations`, { row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(rec.status, 302);
  const rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=?').get(ctx.a)).id);
  const rv = String((await db.prepare('SELECT row_version FROM tp_recommendations WHERE id=?').get(rid)).row_version);
  const refused = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations/${rid}`, {
    outcome: 'approve', residual_rating: 'low', rationale: 'Fine.', valid_until: '2099-12-31', intent: 'submit', row_version: rv,
  });
  assert.equal(refused.status, 409, 'an open questionnaire blocks the submission');
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_draft');
  await db.transaction(async () => {
    await db.exec('ALTER TABLE tp_assessments DISABLE TRIGGER tp_assessments_review_questionnaire');
    await db.prepare(`UPDATE tp_recommendations SET status='in_review', submitted_at=now(), row_version=row_version+1 WHERE id=?`).run(rid);
    await db.prepare(`UPDATE tp_assessments SET status='recommendation_in_review', row_version=row_version+1 WHERE id=?`).run(ctx.a);
    await db.exec('ALTER TABLE tp_assessments ENABLE TRIGGER tp_assessments_review_questionnaire');
  })();
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_in_review');
  return rid;
}

test('opening the link shows the questionnaire by domain and module and changes nothing', async () => {
  const ctx = await linked('Open Answers Co');
  const q = await qRow(ctx.a);
  assert.equal(q.vendor_question_count, 36);
  const before = { q, link: (await linksOf(ctx.a))[0], answers: (await answersOf(ctx.a)).length, events: (await chain(ctx.ws, ctx.a)).length };
  const res = await vget(ctx.token);
  assert.equal(res.status, 200);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.match(res.headers['x-robots-tag'], /noindex/);
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(res.text, /Questionnaire for Open Answers Co Client/);
  assert.match(res.text, /Security questionnaire for <span data-vendor-client>Open Answers Co Client</);
  assert.match(res.text, /data-vendor-deadline>[^<]*<strong>\d{1,2} [A-Z][a-z]+ \d{4}<\/strong>/, 'the date the link stops working');
  assert.match(res.text, /data-vendor-view="start"/);
  assert.match(res.text, /data-vendor-start/);
  assert.match(res.text, /data-vendor-report-hint/, 'the certificate and report are asked in ASR-01 and ASR-03');
  for (const s of q.sections) assert.ok(res.text.includes(`data-vendor-section-link="${s.title.replace(/&/g, '&amp;')}"`), s.title);
  assert.doesNotMatch(res.text, /data-vendor-question=/, 'no questions on the start screen');
  for (const [i, s] of q.sections.entries()) {
    const page = await request('GET', `/vendor/q/${ctx.token}?s=${i + 1}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`data-vendor-section="${s.title.replace(/&/g, '&amp;')}"`), s.title);
    for (const id of s.ids) assert.ok(page.text.includes(`data-vendor-question="${id}"`), id);
    for (const id of idsOf(q).filter(x => !s.ids.includes(x))) assert.ok(!page.text.includes(`data-vendor-question="${id}"`), `${id} is on its own section`);
    assert.doesNotMatch(page.text, /value="partial"/, 'no Partially on bank version 2');
  }
  const gov = await vsection(ctx.token, ctx.a, 'GOV-01');
  assert.match(gov.text, /data-vendor-question="GOV-01"[\s\S]*?data-vendor-evidence-required/);
  assert.match(gov.text, /name="f\[GOV-01\]\[review_frequency\]"/, 'GOV-01 takes a written answer in named fields');
  assert.match(gov.text, /name="r\[GOV-02\]" value="yes"[\s\S]*?name="r\[GOV-02\]" value="no"[\s\S]*?name="r\[GOV-02\]" value="na"/);
  assert.doesNotMatch(gov.text, /expected:/i, 'no benchmark for the third party');
  assert.doesNotMatch(gov.text, /At least annually\./, 'GOV-01\'s firm-only benchmark is not shown');
  assert.doesNotMatch(res.text, /&lt;Client&gt;/, 'the client placeholder is filled in');
  assert.doesNotMatch(res.text, /Open Answers Co<|Hosted service/, 'no third-party details');
  assert.doesNotMatch(res.text, new RegExp(`/tprm/clients/${ctx.ws}|assessments/${ctx.a}`));
  assert.doesNotMatch(res.text.replace(/<script src="\/tprm-vendor\.js" defer><\/script>/g, ''), /<script/i, 'no JavaScript needed');
  await vget(ctx.token);
  assert.deepEqual(await qRow(ctx.a), before.q);
  assert.deepEqual((await linksOf(ctx.a))[0], before.link, 'last_opened_at stays empty on GET');
  assert.equal((await answersOf(ctx.a)).length, before.answers);
  assert.equal((await chain(ctx.ws, ctx.a)).length, before.events);
});

test('a POST needs this link\'s anti-forgery value and the same origin; a replay from another link is refused', async () => {
  const one = await linked('Forgery One Co');
  const two = await linked('Forgery Two Co');
  const answer = { 'GOV-02': { r: 'yes' } };
  const before = (await chain(one.ws, one.a)).length;
  const missing = await save(one.token, answer, { aft: null });
  assert.equal(missing.status, 403);
  assert.match(missing.text, /This form has expired/);
  const forged = await save(one.token, answer, { aft: `${Date.now().toString(36)}.${'A'.repeat(16)}.${'B'.repeat(43)}` });
  assert.equal(forged.status, 403);
  const replay = await save(one.token, answer, { aft: aftOf((await vget(two.token)).text) });
  assert.equal(replay.status, 403, 'the value of another link is refused');
  const old = require('../lib/tprm/vendor-answers').formToken(require('../lib/tprm/questionnaires').hashToken(one.token), Date.now() - 2 * 24 * 3600 * 1000);
  assert.equal((await save(one.token, answer, { aft: old })).status, 403, 'an expired value is refused');
  assert.equal((await save(one.token, answer, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await save(one.token, answer, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await submitLink(one.token, { aft: null })).status, 403);
  assert.equal((await answersOf(one.a)).length, 0);
  assert.equal((await chain(one.ws, one.a)).length, before);
  assert.equal((await qRow(one.a)).status, 'sent');
  const ok = await save(one.token, answer, { headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } });
  assert.equal(ok.status, 303);
  assert.equal((await answerOf(one.a, 'GOV-02')).response, 'yes');
});

test('POSTs are rate-limited per IP before the lookup, and bodies are limited', async () => {
  const ctx = await linked('Post Limit Co');
  const page = await vget(ctx.token);
  const aft = aftOf(page.text);
  const saved = vendorRoute.postLimiter.max;
  vendorRoute.postLimiter.max = 2;
  try {
    assert.equal((await save(ctx.token, { 'GOV-01': { t: 'Every year' } }, { aft })).status, 303);
    assert.equal((await save(ctx.token, { 'GOV-02': { r: 'yes' } }, { aft })).status, 303);
    const limited = await save(ctx.token, { 'GOV-03': { r: 'yes' } }, { aft });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(await answerOf(ctx.a, 'GOV-03'), undefined);
    assert.equal((await request('POST', `/vendor/q/${crypto.randomBytes(32).toString('base64url')}/save`, { body: 'x=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 429, 'an unknown link is limited too');
  } finally {
    vendorRoute.postLimiter.max = saved;
    vendorRoute.postLimiter.reset();
  }
  const big = await request('POST', `/vendor/q/${ctx.token}/save`, { body: 'x',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(vendorRoute.BODY_LIMITS.multipartBytes + 1) } })
    .catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  const plain = await postForm(ctx.token, '/submit', [['pad', 'x'.repeat(vendorRoute.BODY_LIMITS.formBytes + 10)]], { aft });
  assert.equal(plain.status, 413);
  const json = await request('POST', `/vendor/q/${ctx.token}/submit`, { body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(json.status, 415);
  assert.equal((await qRow(ctx.a)).status, 'in_progress');
});

test('saving: an explanation is required for No and Not applicable, Partially is refused; the first POST starts answering', async () => {
  const ctx = await linked('Validation Co');
  const refused = await save(ctx.token, {
    'ORG-02': { r: 'partial' }, 'GOV-02': { r: 'no', d: '' }, 'AIS-01': { r: 'na' }, 'IAM-01': { r: 'yes', date: '2999-01-01' },
    'GOV-01': { t: 'Reviewed every year by the board.' },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.text, /Nothing was saved/);
  assert.match(refused.text, /ORG-02<\/a>: Partially is not an answer to this question/);
  assert.match(refused.text, /href="[^"]*#q-GOV-02">GOV-02<\/a>: Explain your answer &#34;No&#34;/);
  assert.match(refused.text, /AIS-01<\/a>: Explain your answer &#34;Not applicable&#34;/);
  assert.match(refused.text, /The evidence date must be a real date/);
  assert.match(refused.text, /data-vendor-question="ORG-02"[^>]*aria-invalid="true"/);
  assert.doesNotMatch(refused.text, /value="partial"/, 'Partially is never offered');
  const gov = await save(ctx.token, { 'GOV-02': { r: 'no', d: '' }, 'GOV-01': { t: 'Reviewed every year by the board.' } });
  assert.equal(gov.status, 400);
  assert.match(gov.text, /name="r\[GOV-02\]" value="no" checked/);
  assert.match(gov.text, /Reviewed every year by the board\./, 'the written answer is kept on the refused form');
  assert.equal((await answersOf(ctx.a)).length, 0);
  assert.equal((await qRow(ctx.a)).status, 'sent');
  assert.equal((await linksOf(ctx.a))[0].last_opened_at, null);

  const ok = await save(ctx.token, {
    'GOV-01': { t: 'Approved, review overdue', ref: 'ISP v3', date: '2026-03-01' }, 'GOV-02': { r: 'yes' }, 'IAM-01': { d: '' },
  });
  assert.equal(ok.status, 303);
  assert.match(ok.location, /\/vendor\/q\/[A-Za-z0-9_-]+\?notice=saved$/);
  const rows = await answersOf(ctx.a);
  assert.deepEqual(rows.map(r => r.question_id), ['GOV-01', 'GOV-02'], 'an empty question stores no row');
  assert.equal(rows[0].response, 'text', 'a written answer');
  assert.equal(rows[0].fields.review_frequency, 'Approved, review overdue');
  assert.match(rows[0].detail, /^How often the policy is reviewed: Approved, review overdue\nWho approves the policy: /, 'the detail repeats the fields');
  assert.equal(rows[0].evidence_ref, 'ISP v3');
  assert.equal(rows[0].evidence_day, '2026-03-01');
  assert.ok(rows[0].saved_at && rows[0].saved_by_request_id);
  assert.equal((await qRow(ctx.a)).status, 'in_progress');
  assert.ok((await linksOf(ctx.a))[0].last_opened_at, 'last_opened_at set by the first POST');
  const page = await request('GET', ok.location);
  assert.match(page.text, /data-vendor-progress>2 of 36 questions answered/);
  assert.match(page.text, /data-vendor-notice>Your answers are saved/);
  assert.equal((await linksOf(ctx.a)).length, 1);
  await assert.rejects(db.prepare("UPDATE tp_answers SET detail = NULL WHERE assessment_id=? AND question_id='GOV-01'").run(ctx.a), /tp_answers_detail/);
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  assert.deepEqual(actions.slice(-2), ['questionnaire.answering_started', 'questionnaire.answers_saved']);
});

test('the third party touches only its own questionnaire: unknown question ids and other links\' files are refused', async () => {
  const one = await linked('Own Data Co');
  const two = await linked('Other Data Co');
  for (const id of ['ACC-99', 'AIM-01', 'GOV-03']) {
    const res = await save(one.token, { [id]: { r: 'yes' } });
    assert.equal(res.status, 400, id);
    assert.match(res.text, /does not belong to this questionnaire/);
  }
  const bogus = await save(one.token, { 'GOV-01': { r: 'maybe' } });
  assert.equal(bogus.status, 400);
  const up = await save(two.token, { 'GOV-01': { t: 'Yearly' } }, { files: [{ field: 'file__GOV-01', filename: 'policy.txt', content: 'other policy' }] });
  assert.equal(up.status, 303);
  const otherFile = await db.prepare("SELECT id FROM tp_evidence WHERE assessment_id=? AND source='vendor'").get(two.a);
  await save(one.token, { 'GOV-01': { t: 'Yearly' } });
  const cross = await save(one.token, { 'GOV-01': { t: 'Yearly', remove: otherFile.id } });
  assert.equal(cross.status, 400);
  assert.ok(await db.prepare('SELECT id FROM tp_evidence WHERE id=?').get(otherFile.id), 'the other file stays');
  const res = await postForm(one.token, '/clarifications/999999', [['response', 'x']]);
  assert.equal(res.status, 400);
  const q = await qRow(one.a);
  await assert.rejects(db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response)
    VALUES (?, ?, ?, 'AIM-01', 'yes')`).run(one.ws, one.a, q.id), /not a question of this questionnaire/);
  await assert.rejects(db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response)
    VALUES (?, ?, ?, 'GOV-02', 'yes')`).run(two.ws, one.a, q.id), /foreign key|violates|only while the questionnaire is being answered/);
});

test('files: attached to the question, checked like firm uploads, names only, never a storage path', async () => {
  const ctx = await linked('Files Co');
  const pdf = '%PDF-1.4\n% third party policy\n';
  const ok = await save(ctx.token, { 'GOV-01': { t: 'Every year' }, 'GOV-02': { r: 'yes' } }, { files: [
    { field: 'file__GOV-01', filename: 'Security Policy.pdf', content: pdf, type: 'application/pdf' },
    { field: 'file__GOV-02', filename: 'roles.txt', content: 'roles and responsibilities', type: 'text/plain' },
  ] });
  assert.equal(ok.status, 303, ok.text.slice(0, 300));
  const rows = await db.prepare("SELECT * FROM tp_evidence WHERE assessment_id=? ORDER BY id").all(ctx.a);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.source, 'vendor');
    assert.equal(r.uploaded_by, null);
    assert.ok(r.vendor_request_id);
    assert.ok(fs.existsSync(path.join(ROOT, 'uploads', `firm_${firmId}`, r.stored_path)));
  }
  const links = await db.prepare(`SELECT a.question_id, l.evidence_id FROM tp_answer_evidence l JOIN tp_answers a ON a.id = l.answer_id
    WHERE l.assessment_id=? ORDER BY a.question_id`).all(ctx.a);
  assert.deepEqual(links.map(l => l.question_id), ['GOV-01', 'GOV-02']);
  const page = await vsection(ctx.token, ctx.a, 'GOV-01');
  assert.match(page.text, /data-vendor-question="GOV-01"[\s\S]*?Security Policy\.pdf/);
  for (const r of rows) assert.ok(!page.text.includes(r.stored_path), 'no storage path on the page');
  assert.doesNotMatch(page.text, /uploads\/|firm_\d/);
  await save(ctx.token, { 'IAM-01': { r: 'yes' } }, { files: [{ field: 'file__IAM-01', filename: 'copy.pdf', content: pdf, type: 'application/pdf' }] });
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_evidence WHERE assessment_id=?').get(ctx.a)).c, 2);
  const count = async () => (await db.prepare('SELECT COUNT(*)::int c FROM tp_evidence WHERE assessment_id=?').get(ctx.a)).c;
  const dir = path.join(ROOT, 'uploads', `firm_${firmId}`);
  const filesBefore = new Set(fs.readdirSync(dir));
  const mark = `refused-${process.pid}-${Date.now()}`;
  const exe = await save(ctx.token, { 'ORG-02': { r: 'yes' } }, { files: [{ field: 'file__ORG-02', filename: 'tool.exe', content: `MZ ${mark}` }] });
  assert.equal(exe.status, 400);
  assert.match(exe.text, /This file type is not allowed/);
  const fake = await save(ctx.token, { 'ORG-02': { r: 'yes' } }, { files: [{ field: 'file__ORG-02', filename: 'fake.pdf', content: `not a pdf ${mark}` }] });
  assert.equal(fake.status, 400);
  assert.match(fake.text, /do not match its extension/);
  const many = await save(ctx.token, { 'ORG-02': { r: 'yes' } }, { files: Array.from({ length: 6 }, (_, i) => ({ field: 'file__ORG-02', filename: `n${i}.txt`, content: `note ${i} ${mark}` })) });
  assert.equal(many.status, 400);
  assert.match(many.text, /at most 5 files/);
  const huge = await save(ctx.token, { 'ORG-02': { r: 'yes' } }, { files: [{ field: 'file__ORG-02', filename: 'big.txt', content: 'a'.repeat(20 * 1024 * 1024 + 10) + mark }] });
  assert.equal(huge.status, 400);
  assert.match(huge.text, /larger than 20 MB/);
  const stray = await save(ctx.token, { 'ORG-02': { r: 'yes' } }, { files: [{ field: 'file__ACC-99', filename: 'x.txt', content: `x ${mark}` }] });
  assert.equal(stray.status, 400);
  assert.equal(await count(), 2);
  assert.equal(await answerOf(ctx.a, 'ORG-02'), undefined, 'nothing of a refused save is kept');
  const leftovers = fs.readdirSync(dir).filter(name => !filesBefore.has(name)).filter(name => {
    const file = path.join(dir, name);
    const size = fs.statSync(file).size;
    if (size === 20 * 1024 * 1024 + 10 + mark.length) return true;
    return size < 1024 * 1024 && fs.readFileSync(file, 'utf8').includes(mark);
  });
  assert.deepEqual(leftovers, [], 'refused files are not left in storage');
  const gov2 = rows.find(r => r.original_name === 'roles.txt');
  const removed = await save(ctx.token, { 'GOV-02': { r: 'yes', remove: gov2.id } });
  assert.equal(removed.status, 303);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_answer_evidence WHERE evidence_id=?').get(gov2.id)).c, 0, 'off the answer');
  assert.ok(await db.prepare('SELECT id FROM tp_evidence WHERE id=?').get(gov2.id), 'kept in Your documents');
  assert.ok(fs.existsSync(path.join(dir, gov2.stored_path)));
  const deleted = await postForm(ctx.token, `/documents/${gov2.id}`, [['delete', '1']]);
  assert.equal(deleted.status, 303);
  assert.equal(await db.prepare('SELECT id FROM tp_evidence WHERE id=?').get(gov2.id), undefined);
  assert.ok(!fs.existsSync(path.join(dir, gov2.stored_path)), 'its stored file is removed');
  const firm = await firmPage(ctx);
  assert.match(firm.text, /data-tprm-vendor-file>The third party/);
  const pdfRow = rows.find(r => r.original_name === 'Security Policy.pdf');
  assert.doesNotMatch(firm.text, new RegExp(`/evidence/${pdfRow.id}/delete`));
  const del = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${pdfRow.id}/delete`, { row_version: String(pdfRow.row_version) });
  assert.equal(del.status, 409);
  const rel = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${pdfRow.id}/release`, { row_version: String(pdfRow.row_version) });
  assert.equal(rel.status, 302);
  assert.equal((await db.prepare('SELECT released_to_client FROM tp_evidence WHERE id=?').get(pdfRow.id)).released_to_client, true);
  const dl = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${pdfRow.id}/download`);
  assert.equal(dl.status, 200);
  const keep = await save(ctx.token, { 'GOV-01': { t: 'Every year', remove: pdfRow.id } });
  assert.equal(keep.status, 409);
  await assert.rejects(db.prepare(`INSERT INTO tp_evidence (workspace_id, assessment_id, original_name, stored_path, size_bytes, sha256, source)
    VALUES (?, ?, 'x.txt', ?, 1, ?, 'vendor')`).run(ctx.ws, ctx.a, `x-${crypto.randomBytes(4).toString('hex')}.txt`, 'a'.repeat(64)), /tp_evidence_vendor_source/);
});

test('AIS-01 Yes adds the AI Services module; No removes it again, or keeps and flags it once AI questions are answered', async () => {
  const ctx = await linked('AI Co');
  const q0 = await qRow(ctx.a);
  const yes = await save(ctx.token, { 'AIS-01': { r: 'yes' } });
  assert.equal(yes.status, 303);
  assert.match(yes.location, /notice=ai_added#ai-services$/);
  let q = await qRow(ctx.a);
  assert.equal(q.vendor_question_count, q0.vendor_question_count + AI_IDS.length);
  const aiSection = q.sections.find(s => s.title === 'AI Services');
  assert.deepEqual(aiSection.ids, AI_IDS);
  const entry = q.modules.find(m => m.module === 'AI Services');
  assert.equal(entry.source, 'third_party_answer');
  assert.equal(entry.included, true);
  assert.equal(entry.changed_by, null);
  assert.ok(!q.dynamic_modules.some(d => d.module === 'AI Services'));
  const page = await vget(ctx.token);
  assert.match(page.text, /id="ai-services"[\s\S]*?added because you answered Yes to AIS-01/i);
  assert.match(page.text, /data-vendor-section-link="AI Services"/);
  const aiPage = await vsection(ctx.token, ctx.a, 'AIM-01');
  assert.match(aiPage.text, /data-vendor-section="AI Services"[\s\S]*?Added because you answered Yes to AIS-01/);
  assert.match(aiPage.text, /data-vendor-question="AIM-01"/);
  const firm = await firmPage(ctx);
  assert.match(firm.text, /data-tprm-module="AI Services" data-tprm-module-included="1"[\s\S]*?data-tprm-module-by-answer/);
  let e = (await chain(ctx.ws, ctx.a)).filter(x => x.action === 'questionnaire.module_added').pop();
  assert.equal(e.after_state.module, 'AI Services');
  assert.equal(e.after_state.by, 'third_party');
  assert.equal(e.actor_user_id, null);
  assert.match(firm.text, /data-tprm-history-third-party[^>]*>The third party/);

  const no = await save(ctx.token, { 'AIS-01': { r: 'no', d: 'We do not use AI.' } });
  assert.match(no.location, /notice=ai_removed/);
  q = await qRow(ctx.a);
  assert.equal(q.vendor_question_count, q0.vendor_question_count);
  assert.ok(!q.sections.some(s => s.title === 'AI Services'));
  assert.equal(q.modules.find(m => m.module === 'AI Services').included, false);

  await save(ctx.token, { 'AIS-01': { r: 'yes' } });
  await save(ctx.token, { 'AIM-01': { t: 'Two features use AI', ref: 'AI policy' } });
  const kept = await save(ctx.token, { 'AIS-01': { r: 'no', d: 'Changed our mind.' } });
  assert.match(kept.location, /notice=ai_kept/);
  q = await qRow(ctx.a);
  assert.ok(q.sections.some(s => s.title === 'AI Services'), 'kept: an AI question was answered');
  assert.match(q.modules.find(m => m.module === 'AI Services').flag, /kept/);
  assert.match((await firmPage(ctx)).text, /data-tprm-ai-flag/);
  e = (await chain(ctx.ws, ctx.a)).filter(x => x.action === 'questionnaire.module_kept').pop();
  assert.ok(e);

  await assert.rejects(db.prepare(`UPDATE tp_questionnaires SET sections = sections || '[{"kind":"module","title":"Physical & Data Centre","ids":["PHY-01"]}]'::jsonb,
    vendor_question_count = vendor_question_count + 1 WHERE id = ?`).run(q.id), /only a draft questionnaire can change its questions/);
  await assert.rejects(db.prepare(`UPDATE tp_questionnaires SET sections = jsonb_set(sections, '{0,ids}', '[]'::jsonb) WHERE id = ?`).run(q.id),
    /only a draft questionnaire can change its questions/);
  await assert.rejects(db.prepare(`UPDATE tp_questionnaires SET modules = jsonb_set(modules, ARRAY[(jsonb_array_length(modules) - 1)::text, 'source'], '"manual"') WHERE id = ?`).run(q.id),
    /only a draft questionnaire can change its questions/);
});

test('a consultant\'s own AI Services module is never removed by the third party\'s answer', async () => {
  const wsId = await tprmClient('Manual AI Client');
  const tp = await addThirdParty(wsId, 'Manual AI Co');
  const a = await startAssessment(wsId, tp, LOW);
  const ctx = { ws: wsId, tp, a };
  await consultant.session.post(qBase(ctx), {});
  const q = await qRow(a);
  await consultant.session.post(`${qBase(ctx)}/modules`, { op: 'add', module: 'AI Services', reason: 'Known AI product', row_version: String(q.row_version) });
  const { token } = await createLink(ctx);
  const before = await qRow(a);
  assert.equal((await save(token, { 'AIS-01': { r: 'no', d: 'None.' } })).status, 303);
  const after = await qRow(a);
  assert.deepEqual(after.sections, before.sections);
  assert.equal(after.modules.find(m => m.module === 'AI Services').source, 'manual');
});

test('submission needs every question answered and evidence for evidence-required Yes or Partially answers; then everything locks', async () => {
  const ctx = await linked('Submit Co');
  await save(ctx.token, { 'GOV-01': { t: 'Every year' } });
  const check = await save(ctx.token, { 'GOV-02': { r: 'yes' } }, { intent: 'review' });
  assert.equal(check.status, 200);
  assert.match(check.text, /data-vendor-view="confirm"/);
  assert.match(check.text, /data-vendor-problem="GOV-01" data-vendor-problem-kind="evidence"/);
  assert.match(check.text, /data-vendor-problem="ORG-02" data-vendor-problem-kind="unanswered"/);
  assert.doesNotMatch(check.text, /data-vendor-submit-form/);
  const early = await submitLink(ctx.token);
  assert.equal(early.status, 409);
  assert.equal((await qRow(ctx.a)).status, 'in_progress');
  const answers = await answerAll(ctx, { 'GOV-02': { r: 'na', d: 'No such function.' }, 'ORG-02': { r: 'no', d: 'Not yet.' } });
  const ready = await save(ctx.token, {}, { intent: 'review' });
  assert.match(ready.text, /data-vendor-ready>All 36 questions are answered/);
  assert.match(ready.text, /data-vendor-submit-form/);
  const done = await submitLink(ctx.token);
  assert.equal(done.status, 200);
  assert.match(done.text, /data-vendor-submitted>Submitted on \d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} [ap]m [A-Za-z0-9+:-]+\.</);
  assert.equal((done.text.match(/Thank you/g) || []).length, 1, 'one thank-you');
  const q = await qRow(ctx.a);
  assert.equal(q.status, 'submitted');
  assert.ok(q.submitted_at);
  const [link] = await linksOf(ctx.a);
  assert.equal(link.status, 'submitted');
  const rows = await answersOf(ctx.a);
  assert.equal(rows.length, 36);
  assert.ok(rows.every(r => r.submitted_at));
  const invalid = await vget(crypto.randomBytes(32).toString('base64url'));
  const after = await vget(ctx.token);
  assert.equal(after.status, 200);
  assert.match(after.text, /data-vendor-submitted>Submitted on \d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} [ap]m [A-Za-z0-9+:-]+\.</);
  assert.doesNotMatch(after.text, /data-vendor-answer-form|data-vendor-submit-form|<form/);
  const late = await save(ctx.token, { 'GOV-01': { r: 'no', d: 'x' } }, { aft: 'x.y.z' });
  assert.equal(late.status, 404);
  assert.equal(late.text, invalid.text);
  assert.equal((await submitLink(ctx.token, { aft: 'x' })).status, 404);
  assert.equal((await answerOf(ctx.a, 'GOV-01')).response, 'text');
  assert.deepEqual((await answerOf(ctx.a, 'GOV-01')).fields, answers['GOV-01'].f);
  await assert.rejects(db.prepare("UPDATE tp_answers SET detail='x' WHERE assessment_id=? AND question_id='GOV-01'").run(ctx.a),
    /locked once the questionnaire is submitted/);
  await assert.rejects(db.prepare("UPDATE tp_answers SET response='no', detail='x' WHERE assessment_id=? AND question_id='GOV-02'").run(ctx.a),
    /locked once the questionnaire is submitted/);
  await assert.rejects(db.prepare('DELETE FROM tp_answers WHERE assessment_id=?').run(ctx.a), /never deleted/);
  await assert.rejects(db.prepare("UPDATE tp_questionnaires SET status='in_progress' WHERE id=?").run(q.id), /never goes back/);
  const e = (await chain(ctx.ws, ctx.a)).map(x => x.action);
  assert.deepEqual(e.filter(x => !x.startsWith('ai_review.') && !x.startsWith('message.')).slice(-2), ['questionnaire.submitted', 'vendor_link.used']);
  assert.equal(e.filter(x => !x.startsWith('message.')).at(-1), 'ai_review.not_configured');
  const firm = await firmPage(ctx);
  assert.match(firm.text, /data-tprm-questionnaire-submitted[\s\S]*?Submitted by the third party on/);
});

test('the database refuses a submission with an unanswered question, and a review before submission', async () => {
  const ctx = await linked('DB Submit Co');
  await save(ctx.token, { 'GOV-01': { t: 'Yearly', ref: 'x' } });
  const q = await qRow(ctx.a);
  await assert.rejects(db.prepare("UPDATE tp_questionnaires SET status='submitted', submitted_at=now() WHERE id=?").run(q.id),
    /every question must be answered/);
  await assert.rejects(db.prepare(`UPDATE tp_answers SET review_conclusion='satisfactory', reviewed_by=1, reviewed_at=now()
    WHERE assessment_id=? AND question_id='GOV-01'`).run(ctx.a), /reviewed only after the questionnaire is submitted/);
  const a = await answerOf(ctx.a, 'GOV-01');
  const res = await consultant.session.post(`${qBase(ctx)}/answers/${a.id}/review`, { conclusion: 'satisfactory', row_version: String(a.row_version) });
  assert.equal(res.status, 302);
  assert.match(toast(res), /not submitted its answers yet/);
});

test('a revoked or expired link refuses POSTs with the generic page', async () => {
  const ctx = await linked('Revoke Post Co');
  const aft = aftOf((await vget(ctx.token)).text);
  const [link] = await linksOf(ctx.a);
  await consultant.session.post(`${qBase(ctx)}/links/${link.id}/revoke`, { row_version: String(link.row_version) });
  const invalid = await vget(crypto.randomBytes(32).toString('base64url'));
  const res = await save(ctx.token, { 'GOV-01': { r: 'yes' } }, { aft });
  assert.equal(res.status, 404);
  assert.equal(res.text, invalid.text);
  assert.equal((await submitLink(ctx.token, { aft })).text, invalid.text);
  assert.equal((await answersOf(ctx.a)).length, 0);
  const other = await linked('Expire Post Co');
  const aft2 = aftOf((await vget(other.token)).text);
  await db.prepare(`ALTER TABLE tp_vendor_requests DISABLE TRIGGER tp_vendor_requests_guard`).run();
  try {
    await db.prepare(`UPDATE tp_vendor_requests SET created_at = now() - interval '40 days', expires_at = now() - interval '1 day' WHERE assessment_id=?`).run(other.a);
  } finally {
    await db.prepare(`ALTER TABLE tp_vendor_requests ENABLE TRIGGER tp_vendor_requests_guard`).run();
  }
  const expired = await save(other.token, { 'GOV-01': { r: 'yes' } }, { aft: aft2 });
  assert.equal(expired.status, 404);
  assert.equal(expired.text, invalid.text);
  assert.equal((await answersOf(other.a)).length, 0);
  assert.equal((await request('GET', `/vendor/q/${other.token}/whatever`)).text, invalid.text);
});

test('the link that submitted shows only "Submitted on <date and time, zone>." until it expires, and opening it changes nothing', async () => {
  const ctx = await submitted('Thanks Page Vendor');
  await db.prepare("UPDATE workspaces SET timezone = 'Asia/Kolkata' WHERE id = ?").run(ctx.ws);
  const clientName = (await db.prepare('SELECT client_name FROM workspaces WHERE id=?').get(ctx.ws)).client_name;
  const q = await qRow(ctx.a);
  const [linkBefore] = await linksOf(ctx.a);
  const eventsBefore = (await chain(ctx.ws, ctx.a)).length;
  const invalid = await vget(crypto.randomBytes(32).toString('base64url'));
  for (let i = 0; i < 2; i += 1) {
    const page = await vget(ctx.token);
    assert.equal(page.status, 200);
    const when = require('../lib/tprm/format').dayTime(q.submitted_at, 'Asia/Kolkata', { zone: true });
    assert.match(when, /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} [ap]m IST$/);
    assert.ok(page.text.includes(`data-vendor-submitted>Submitted on ${when}.<`), 'the date and time with the zone');
    assert.doesNotMatch(page.text, /UTC/);
    assert.equal((page.text.match(/Thank you/g) || []).length, 1, 'one thank-you');
    assert.match(page.text, new RegExp(`data-vendor-client>${clientName}<`));
    assert.doesNotMatch(page.text, /Thanks Page Vendor<|Priya|GOV-01|<form|_aft/);
    assert.equal(page.headers['set-cookie'], undefined, 'no session or cookie');
    assert.match(String(page.headers['cache-control']), /no-store/);
    assert.match(String(page.headers['x-robots-tag']), /noindex/);
  }
  const [linkAfter] = await linksOf(ctx.a);
  assert.deepEqual(linkAfter, linkBefore, 'the link row is unchanged');
  assert.equal(Number((await qRow(ctx.a)).row_version), Number(q.row_version));
  assert.equal((await chain(ctx.ws, ctx.a)).length, eventsBefore, 'no event');
  assert.equal((await submitLink(ctx.token, { aft: 'x' })).text, invalid.text);

  await db.transaction(async () => {
    await db.exec('ALTER TABLE tp_vendor_requests DISABLE TRIGGER tp_vendor_requests_guard');
    await db.prepare(`UPDATE tp_vendor_requests SET expires_at = created_at + interval '1 millisecond' WHERE id=?`).run(linkBefore.id);
    await db.exec('ALTER TABLE tp_vendor_requests ENABLE TRIGGER tp_vendor_requests_guard');
  })();
  const expired = await vget(ctx.token);
  assert.equal(expired.status, 404);
  assert.equal(expired.text, invalid.text);

  const other = await submitted('Thanks Cancelled Vendor');
  assert.equal((await vget(other.token)).status, 200);
  const cancel = await consultant.session.post(`${aBase(other.ws, other.tp, other.a)}/cancel`,
    { row_version: String((await assessmentRow(other.a)).row_version), reason: 'Not needed' });
  assert.equal(cancel.status, 302, toast(cancel));
  const gone = await vget(other.token);
  assert.equal(gone.status, 404);
  assert.equal(gone.text, invalid.text);
});

test('a frozen assessment (recommendation in review) closes the link with the generic page, GET and POST', async () => {
  const ctx = await linked('Frozen Link Co');
  const aft = aftOf((await vget(ctx.token)).text);
  await legacyInReview(ctx);
  const invalid = await vget(crypto.randomBytes(32).toString('base64url'));
  const get = await vget(ctx.token);
  assert.equal(get.status, 404);
  assert.equal(get.text, invalid.text);
  const post = await save(ctx.token, { 'GOV-01': { r: 'yes' } }, { aft });
  assert.equal(post.status, 404);
  assert.equal(post.text, invalid.text);
  assert.equal((await answersOf(ctx.a)).length, 0);
  assert.equal((await linksOf(ctx.a))[0].status, 'active', 'the link itself is unchanged and can still be revoked');
});

test('an error while rendering the page is answered here, and nothing logged carries the token', async () => {
  const ctx = await linked('Render Error Co');
  const va = require('../lib/tprm/vendor-answers');
  const original = va.pageData;
  const logged = [];
  const originalError = console.error;
  va.pageData = async () => ({ ctx: null });
  console.error = (...args) => { logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  let res;
  try {
    res = await vget(ctx.token);
  } finally {
    va.pageData = original;
    console.error = originalError;
  }
  assert.equal(res.status, 500);
  assert.match(res.text, /Something went wrong/);
  assert.ok(logged.length > 0, 'the error is logged');
  for (const line of logged) assert.equal(line.includes(ctx.token), false, 'no log line holds the token');
  assert.ok(!res.text.includes(ctx.token));
});

test('the firm reviews the answers: what needs judgement, in questionnaire order; conclusions; raise a finding pre-filled from a No answer', async () => {
  const ctx = await linked('Review Co', { answers: { ...LOW, data_handled: 'internal' } });
  await answerAll(ctx, { 'GOV-02': { r: 'no', d: 'No named security officer.' }, 'GOV-03': { r: 'na', d: 'Drafted only.' } });
  await save(ctx.token, { 'GOV-02': { r: 'no', d: 'No named security officer.' } },
    { files: [{ field: 'file__GOV-02', filename: 'org-chart.txt', content: 'org chart' }] });
  assert.equal((await submitLink(ctx.token)).status, 200);
  let page = await firmPage(ctx);
  assert.match(page.text, /data-tprm-answers/);
  const shown = [...(await reviewPage(ctx)).text.matchAll(/data-tprm-answer-row="([A-Z]+-\d+)" data-tprm-answer-response="(\w+)"/g)].map(m => [m[1], m[2]]);
  const order = idsOf(await qRow(ctx.a));
  assert.deepEqual(shown.map(([id]) => id), [...shown.map(([id]) => id)].sort((x, y) => order.indexOf(x) - order.indexOf(y)));
  assert.deepEqual(shown.slice(0, 3), [['GOV-01', 'text'], ['GOV-02', 'no'], ['GOV-03', 'na']]);
  assert.ok(shown.some(([id, r]) => id === 'AIS-01' && r === 'no'));
  assert.ok(shown.every(([id, r]) => r !== 'yes' || BANK_BY_ID.get(id).fields_on === 'yes' || BANK_BY_ID.get(id).details_on_yes), 'a bare Yes is plain');
  assert.ok(shown.some(([id, r]) => id === 'GOV-03' && r === 'na'));
  assert.ok(shown.some(([id, r]) => id === 'GOV-01' && r === 'text'), 'written answers show in the first filter');
  const all = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?answers=all`);
  const q = await qRow(ctx.a);
  assert.equal([...all.text.matchAll(/data-tprm-answer-row=/g)].length, q.vendor_question_count);
  assert.match(page.text, /data-tprm-answer-row="GOV-02"[\s\S]*?No named security officer[\s\S]*?org-chart\.txt/);

  const gov2 = await answerOf(ctx.a, 'GOV-02');
  const bad = await consultant.session.post(`${qBase(ctx)}/answers/${gov2.id}/review`, { conclusion: 'not_reviewed', row_version: String(gov2.row_version) });
  assert.match(toast(bad), /Choose a conclusion/);
  const set = await consultant.session.post(`${qBase(ctx)}/answers/${gov2.id}/review`, { conclusion: 'unsatisfactory', comment: 'No owner', row_version: String(gov2.row_version), answers_filter: 'all' });
  assert.equal(set.status, 302);
  assert.match(set.location, /\?step=review&answers=all&toast=[^#]*#answer-\d+$/);
  const reviewed = await answerOf(ctx.a, 'GOV-02');
  assert.equal(reviewed.review_conclusion, 'unsatisfactory');
  assert.equal(Number(reviewed.reviewed_by), consultant.id);
  assert.equal((await qRow(ctx.a)).status, 'under_review');
  const stale = await consultant.session.post(`${qBase(ctx)}/answers/${gov2.id}/review`, { conclusion: 'satisfactory', row_version: String(gov2.row_version) });
  assert.match(toast(stale), /Someone else changed/);

  page = await firmPage(ctx);
  assert.match(page.text, new RegExp(`findings/new\\?answer=${gov2.id}`));
  const form = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/new?answer=${gov2.id}`);
  assert.equal(form.status, 200);
  const bank = BANK_BY_ID.get('GOV-02');
  assert.match(form.text, /data-tprm-finding-from-answer="GOV-02"/);
  assert.match(form.text, new RegExp(`name="control_ref" value="A\\.${bank.iso27001.replace('.', '\\.')}"`));
  assert.match(form.text, /<option value="medium" selected>/, 'severity from the tier');
  assert.ok(form.text.includes(`name="title" value="${bank.theme}"`), 'title from the theme');
  assert.match(form.text, /No named security officer/);
  const fileId = (await db.prepare("SELECT id FROM tp_evidence WHERE assessment_id=? AND original_name='org-chart.txt'").get(ctx.a)).id;
  assert.match(form.text, new RegExp(`name="evidence" value="${fileId}" checked[\\s\\S]{0,120}from the third party`));
  const add = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings`, {
    control_ref: `A.${bank.iso27001}`, severity: 'medium', title: bank.theme, description: 'From GOV-02', evidence: String(fileId),
  });
  assert.equal(add.status, 302);
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=?').get(ctx.a);
  assert.equal(finding.title, bank.theme);
  assert.deepEqual((await db.prepare('SELECT evidence_id FROM tp_finding_evidence WHERE finding_id=?').all(finding.id)).map(r => Number(r.evidence_id)), [Number(fileId)]);
  const other = await submitted('Review Other Co');
  const otherAnswer = await answerOf(other.a, 'GOV-01');
  assert.equal((await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/new?answer=${otherAnswer.id}`)).status, 404);
  assert.equal((await consultant.session.post(`${qBase(ctx)}/answers/${otherAnswer.id}/review`, { conclusion: 'satisfactory', row_version: '1' })).status, 404);
});

test('clarifications: asked on an answer, a new link for them, answered by the third party, closed by the firm; they block closing the review', async () => {
  const ctx = await submitted('Clarify Co');
  const gov1 = await answerOf(ctx.a, 'GOV-01');
  const ask = await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-01', body: 'Please send the approval minutes.' });
  assert.equal(ask.status, 302);
  assert.match(toast(ask), /issue a new link/);
  assert.equal((await qRow(ctx.a)).status, 'under_review');
  const c = await db.prepare('SELECT * FROM tp_clarifications WHERE assessment_id=?').get(ctx.a);
  assert.equal(c.status, 'open');
  assert.equal(Number(c.asked_by), consultant.id);
  assert.equal((await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'AIM-01', body: 'x' })).status, 404);
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-01', body: '' })), /Write the clarification/);
  const used = await vget(ctx.token);
  assert.equal(used.status, 200);
  assert.match(used.text, /data-vendor-submitted>Submitted on/);
  assert.doesNotMatch(used.text, /Please send the approval minutes/, 'the submitted page shows no clarification');
  let page = await firmPage(ctx);
  assert.match(page.text, /data-tprm-link-form/);
  const { token } = await createLink(ctx);
  assert.ok(token);
  const vendorPage = await vget(token);
  assert.equal(vendorPage.status, 200);
  assert.match(vendorPage.text, /data-vendor-mode="clarifying"/);
  assert.match(vendorPage.text, /data-vendor-clarifications[\s\S]*?Please send the approval minutes/);
  assert.match(vendorPage.text, /class="vq-item-sub vq-pre" data-vendor-clarify-answer>Your answer: How often the policy is reviewed: [^\n<]+\nWho approves the policy: /);
  assert.doesNotMatch(vendorPage.text, /data-vendor-answer-form/);
  assert.equal((await save(token, { 'GOV-01': { r: 'no', d: 'x' } }, { aft: aftOf(vendorPage.text) })).status, 404);
  assert.equal((await submitLink(token, { aft: aftOf(vendorPage.text) })).status, 404);
  let close = await consultant.session.post(`${qBase(ctx)}/close`, { row_version: String((await qRow(ctx.a)).row_version) });
  assert.match(toast(close), /no reviewer conclusion yet[\s\S]*clarification is not closed/);
  const empty = await postForm(token, `/clarifications/${c.id}`, [['response', '']]);
  assert.equal(empty.status, 400);
  const form = multipart([['_aft', aftOf(vendorPage.text)], ['response', 'Minutes attached.']], [{ field: 'file', filename: 'minutes.txt', content: 'board minutes' }]);
  const answered = await request('POST', `/vendor/q/${token}/clarifications/${c.id}`, { body: form.body, headers: form.headers });
  assert.equal(answered.status, 303);
  assert.match(answered.location, /notice=answered/);
  const c2 = await db.prepare('SELECT * FROM tp_clarifications WHERE id=?').get(c.id);
  assert.equal(c2.status, 'answered');
  assert.equal(c2.response, 'Minutes attached.');
  const file = await db.prepare('SELECT * FROM tp_evidence WHERE id=?').get(c2.response_evidence_id);
  assert.equal(file.source, 'vendor');
  createdPaths.add(file.stored_path);
  assert.equal((await postForm(token, `/clarifications/${c.id}`, [['response', 'again']], { aft: aftOf(vendorPage.text) })).status, 409, 'answered once');
  assert.match((await vget(token)).text, /data-vendor-clarification-answered/);
  page = await firmPage(ctx);
  assert.match(page.text, /data-tprm-clarification-status="answered"[\s\S]*?Minutes attached\.[\s\S]*?minutes\.txt/);
  assert.equal((await answerOf(ctx.a, 'GOV-01')).response, gov1.response);
  for (const a of await answersOf(ctx.a)) {
    const r = await consultant.session.post(`${qBase(ctx)}/answers/${a.id}/review`, { conclusion: 'satisfactory', row_version: String(a.row_version) });
    assert.equal(r.status, 302);
  }
  close = await consultant.session.post(`${qBase(ctx)}/close`, { row_version: String((await qRow(ctx.a)).row_version) });
  assert.match(toast(close), /clarification is not closed/);
  const q = await qRow(ctx.a);
  await assert.rejects(db.prepare("UPDATE tp_questionnaires SET status='closed', closed_at=now(), closed_reason='Reviewed' WHERE id=?").run(q.id),
    /close every clarification/);
  const closeC = await consultant.session.post(`${qBase(ctx)}/clarifications/${c.id}/close`, { row_version: String(c2.row_version), note: 'Minutes received' });
  assert.equal(closeC.status, 302);
  assert.equal((await db.prepare('SELECT status FROM tp_clarifications WHERE id=?').get(c.id)).status, 'closed');
  await assert.rejects(db.prepare("UPDATE tp_clarifications SET status='open' WHERE id=?").run(c.id), /closed clarification cannot be changed/);
  close = await consultant.session.post(`${qBase(ctx)}/close`, { row_version: String((await qRow(ctx.a)).row_version) });
  assert.match(toast(close), /Review of the answers closed/);
  const closed = await qRow(ctx.a);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closed_reason, 'Reviewed');
  assert.equal(Number(closed.closed_by), consultant.id);
  const links = await linksOf(ctx.a);
  assert.equal(links[links.length - 1].status, 'revoked');
  assert.equal(links[links.length - 1].revoke_reason, 'Review closed');
  assert.equal((await vget(token)).status, 404);
  const a1 = await answerOf(ctx.a, 'GOV-01');
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/answers/${a1.id}/review`, { conclusion: 'unsatisfactory', row_version: String(a1.row_version) })), /review of the answers is closed/);
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  for (const want of ['clarification.asked', 'questionnaire.review_started', 'clarification.answered', 'answer.reviewed', 'clarification.closed', 'questionnaire.reviewed']) {
    assert.ok(actions.includes(want), want);
  }
});

test('submitted questionnaires appear in the firm review queue with their open clarifications, until the review is closed', async () => {
  const ctx = await submitted('Queue Vendor Co');
  const q = await qRow(ctx.a);
  const row = new RegExp(`data-tprm-review-questionnaire="${q.id}"[\\s\\S]*?Queue Vendor Co[\\s\\S]*?Submitted by the third party[\\s\\S]*?`
    + `data-tprm-review-questionnaire-unreviewed>36 of 36<[\\s\\S]*?data-tprm-review-questionnaire-clarifications>0<`);
  let queue = await senior.session.get('/tprm/review');
  assert.equal(queue.status, 200);
  assert.match(queue.text, /data-tprm-review-questionnaires/);
  assert.match(queue.text, row);
  assert.match(queue.text, new RegExp(`href="${aBase(ctx.ws, ctx.tp, ctx.a)}\\?step=review#questionnaire-answers"`));
  const home = await senior.session.get('/tprm');
  const count = Number((home.text.match(/data-tprm-review-link>Review queue \((\d+)\)/) || [])[1]);
  assert.ok(count >= 1);
  await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-01', body: 'Which policy?' });
  queue = await senior.session.get('/tprm/review');
  assert.match(queue.text, new RegExp(`data-tprm-review-questionnaire="${q.id}"[\\s\\S]*?Under review[\\s\\S]*?data-tprm-review-questionnaire-clarifications>1<`));
  const consultantQueue = await consultant.session.get('/tprm/review');
  assert.equal(consultantQueue.status, 200);
  assert.match(consultantQueue.text, new RegExp(`data-tprm-review-questionnaire="${q.id}"`));
  const otherFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Queue Other Firm')").run()).lastInsertRowid);
  const outsider = await makeUser('queue-other-firm@test.local', { role: 'manager', firm: otherFirm });
  const outsiderSession = await signIn(outsider.email, outsider.password);
  try {
    assert.doesNotMatch((await outsiderSession.get('/tprm/review')).text, /Queue Vendor Co/);
  } finally {
    await outsiderSession.close();
  }
  const c = await db.prepare('SELECT * FROM tp_clarifications WHERE assessment_id=?').get(ctx.a);
  await consultant.session.post(`${qBase(ctx)}/clarifications/${c.id}/close`, { row_version: String(c.row_version) });
  for (const a of await answersOf(ctx.a)) {
    await consultant.session.post(`${qBase(ctx)}/answers/${a.id}/review`, { conclusion: 'satisfactory', row_version: String((await answerOf(ctx.a, a.question_id)).row_version) });
  }
  const close = await consultant.session.post(`${qBase(ctx)}/close`, { row_version: String((await qRow(ctx.a)).row_version) });
  assert.match(toast(close), /Review of the answers closed/);
  queue = await senior.session.get('/tprm/review');
  assert.doesNotMatch(queue.text, new RegExp(`data-tprm-review-questionnaire="${q.id}"`));
});

test('clarifications and conclusions follow the evidence freeze', async () => {
  const ctx = await submitted('Freeze Review Co');
  await legacyInReview(ctx);
  const a = await answerOf(ctx.a, 'GOV-01');
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/answers/${a.id}/review`, { conclusion: 'satisfactory', row_version: String(a.row_version) })), /frozen/);
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-01', body: 'x' })), /frozen/);
  await assert.rejects(db.prepare(`UPDATE tp_answers SET review_conclusion='satisfactory', reviewed_by=1, reviewed_at=now() WHERE id=?`).run(a.id), /frozen/);
  const page = await firmPage(ctx);
  assert.doesNotMatch(page.text, /data-tprm-conclusion-form|data-tprm-raise-finding/);
});

test('a reassessment is prefilled from the last submitted questionnaire; the third party confirms or changes each answer', async () => {
  const first = await submitted('Prefill Co');
  const firstQ = await qRow(first.a);
  const cancel = await consultant.session.post(`${aBase(first.ws, first.tp, first.a)}/cancel`,
    { row_version: String((await assessmentRow(first.a)).row_version), reason: 'Superseded' });
  assert.equal(cancel.status, 302, toast(cancel));
  const a = await startAssessment(first.ws, first.tp, LOW);
  assert.equal((await assessmentRow(a)).type, 'reassessment');
  const ctx = { ws: first.ws, tp: first.tp, a };
  await consultant.session.post(qBase(ctx), {});
  assert.equal((await answersOf(a)).length, 0, 'nothing is prefilled before the questionnaire is sent');
  const { token } = await createLink(ctx);
  ctx.token = token;
  const rows = await answersOf(a);
  assert.equal(rows.length, firstQ.vendor_question_count);
  assert.ok(rows.every(r => r.prefilled_from_answer_id && !r.prefill_confirmed_at && !r.saved_at));
  const gov1 = rows.find(r => r.question_id === 'GOV-01');
  const prev = await db.prepare('SELECT * FROM tp_answers WHERE id=?').get(gov1.prefilled_from_answer_id);
  assert.equal(Number(prev.assessment_id), first.a);
  assert.equal(gov1.evidence_ref, prev.evidence_ref);
  const prefilled = (await chain(ctx.ws, a)).find(e => e.action === 'questionnaire.prefilled');
  assert.equal(prefilled.after_state.count, rows.length);
  assert.equal(Number(prefilled.actor_user_id), consultant.id);
  let page = await vget(token);
  assert.match(page.text, /data-vendor-last-time-note/);
  page = await vsection(token, a, 'GOV-01');
  assert.match(page.text, /data-vendor-question="GOV-01"[\s\S]*?data-vendor-from-last-time[\s\S]*?name="confirm\[GOV-01\]"/);
  const check = await save(token, {}, { intent: 'review' });
  assert.match(check.text, /data-vendor-problem="GOV-01" data-vendor-problem-kind="confirm"/);
  assert.deepEqual(gov1.fields, prev.fields, 'the named fields are copied');
  await save(token, { 'GOV-01': { f: gov1.fields, ref: gov1.evidence_ref, date: '2026-01-15', confirm: true }, 'GOV-02': { r: 'no', d: 'Officer left.' } });
  assert.ok((await answerOf(a, 'GOV-01')).prefill_confirmed_at);
  assert.equal((await answerOf(a, 'GOV-01')).response, 'text');
  const g2 = await answerOf(a, 'GOV-02');
  assert.ok(g2.prefill_confirmed_at);
  assert.equal(g2.response, 'no');
  assert.ok(!(await answerOf(a, 'ORG-02')).prefill_confirmed_at);
  page = await vsection(token, a, 'GOV-01');
  assert.doesNotMatch(page.text, /name="confirm\[GOV-01\]"/);
  page = await vsection(token, a, 'ORG-02');
  assert.match(page.text, /name="confirm\[ORG-02\]"/);
  const all = {};
  for (const r of await answersOf(a)) {
    if (r.prefill_confirmed_at) continue;
    all[r.question_id] = asPosted(r);
  }
  await save(token, all);
  assert.equal((await submitLink(token)).status, 200);
  assert.equal((await qRow(a)).status, 'submitted');
});

test('the firm review writes the client\'s name in a question\'s title, as in its text (High tier: IAM-07, LOG-07)', async () => {
  const ctx = await submitted('Titles Co', { answers: { ...LOW, data_handled: 'personal', service_stops: 'slows', system_access: 'user', replaceability: 'with_effort' } });
  const page = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=review&answers=all`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-answer-row="IAM-07"[\s\S]*?data-tprm-answer-theme>Named access to Titles Co Client</);
  assert.match(page.text, /data-tprm-answer-row="LOG-07"[\s\S]*?data-tprm-answer-theme>Titles Co Client log access</);
  assert.doesNotMatch(page.text, /&lt;Client&gt;/);
  const step = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=questionnaire`);
  assert.match(step.text, /data-tprm-question-row="IAM-07"[\s\S]*?restricted to a named, Titles Co Client-approved list/);
  assert.doesNotMatch(step.text, /&lt;Client&gt;/);
});

const plainOnBank = (id, response) => response === 'yes' && !(BANK_BY_ID.get(id).fields_on === 'yes' || BANK_BY_ID.get(id).details_on_yes);
const reviewPage = (ctx, filter = '') => consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=review${filter ? `&answers=${filter}` : ''}`);
const jsonPost = (session, url, body) => session.post(url, body, { json: true, csrf: true });
const acceptIdsOf = (text, which = 'all') => ((text.match(new RegExp(`data-tprm-accept-plain-form="${which}"[\\s\\S]*?name="ids" value="([\\d,]+)"`)) || [])[1] || '');

test('the workbench: plain answers are hidden and counted; the list, the panes and the accept button agree', async () => {
  const ctx = await submitted('Bench Co');
  const page = await reviewPage(ctx);
  assert.equal(page.status, 200);
  const items = [...page.text.matchAll(/data-tprm-answer-item="([A-Z]+-\d+)"/g)].map(m => m[1]);
  const panes = [...page.text.matchAll(/data-tprm-answer-row="([A-Z]+-\d+)"/g)].map(m => m[1]);
  assert.deepEqual(items, panes, 'one list item per answer shown, in the same order');
  const rows = await answersOf(ctx.a);
  const plain = rows.filter(r => plainOnBank(r.question_id, r.response)).map(r => r.question_id);
  assert.ok(plain.length >= 1, 'on bank version 5 most Yes questions have boxes; a bare Yes is plain');
  for (const id of plain) assert.ok(!items.includes(id), `${id} is plain: hidden by default`);
  assert.deepEqual(items.sort(), rows.filter(r => !plain.includes(r.question_id)).map(r => r.question_id).sort());
  assert.match(page.text, /data-tprm-answer-row="GOV-02"[\s\S]*?data-tprm-answer-reasons>Needs judgement: yes with details to read\./);
  assert.match(page.text, /data-tprm-answer-row="AIS-01"[\s\S]*?data-tprm-answer-reasons>Needs judgement: answered no\./);
  assert.match(page.text, new RegExp(`data-tprm-plain-line>[\\s\\S]*?${plain.length} plain answers hidden`));
  const ids = acceptIdsOf(page.text).split(',').map(Number).sort((a, b) => a - b);
  assert.deepEqual(ids, rows.filter(r => plain.includes(r.question_id)).map(r => Number(r.id)).sort((a, b) => a - b), 'the button accepts exactly the plain ones');
  assert.match(page.text, /data-tprm-accept-plain-form="all"[\s\S]*?name="_tp_confirm_title" value="Accept \d+ plain answers as Satisfactory\?"/);
  assert.match(page.text, /<p class="tpa-meta tpw-keys" hidden data-tprm-keys>/, 'the keys are mentioned only once the script runs');
  assert.match(page.text, /data-tprm-answer-row="GOV-02"[\s\S]*?type="radio" name="conclusion" value="satisfactory" data-tprm-key="1"[\s\S]*?value="partially_satisfactory" data-tprm-key="2"[\s\S]*?value="unsatisfactory" data-tprm-key="3"[\s\S]*?data-tprm-save-conclusion/);
  const all = await reviewPage(ctx, 'all');
  assert.equal([...all.text.matchAll(/data-tprm-answer-pane=/g)].length, (await qRow(ctx.a)).vendor_question_count);
});

test('conclusion.json: saves with the versions the page needs; stale, unsigned, outsiders and client users are refused', async () => {
  const ctx = await submitted('Bench Json Co');
  await reviewPage(ctx);
  const gov2 = await answerOf(ctx.a, 'GOV-02');
  const url = `${qBase(ctx)}/answers/${gov2.id}/conclusion.json`;
  const ok = await jsonPost(consultant.session, url, { conclusion: 'partially_satisfactory', comment: 'Reporting line unclear', row_version: String(gov2.row_version) });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /application\/json/);
  const body = JSON.parse(ok.text);
  assert.equal(body.ok, true);
  assert.deepEqual([body.answer.conclusion, body.answer.comment, body.answer.row_version], ['partially_satisfactory', 'Reporting line unclear', Number(gov2.row_version) + 1]);
  assert.match(body.answer.reviewed_line, /, \d{1,2} [A-Z][a-z]{2} \d{4}$/);
  const q = await qRow(ctx.a);
  assert.equal(q.status, 'under_review', 'the first conclusion starts the review');
  assert.equal(body.questionnaire.row_version, Number(q.row_version), 'the close form gets the new version');
  assert.equal(body.blockers.unreviewed, (await answersOf(ctx.a)).filter(r => r.review_conclusion === 'not_reviewed').length);
  const saved = await answerOf(ctx.a, 'GOV-02');
  assert.deepEqual([saved.review_conclusion, saved.review_comment, Number(saved.reviewed_by)], ['partially_satisfactory', 'Reporting line unclear', consultant.id]);
  const same = JSON.parse((await jsonPost(consultant.session, url, { conclusion: 'partially_satisfactory', comment: 'Reporting line unclear', row_version: String(saved.row_version) })).text);
  assert.deepEqual([same.ok, same.unchanged], [true, true]);
  const stale = await jsonPost(consultant.session, url, { conclusion: 'unsatisfactory', row_version: String(gov2.row_version) });
  assert.equal(stale.status, 409);
  assert.deepEqual(Object.keys(JSON.parse(stale.text)).sort(), ['error', 'ok']);
  assert.match(JSON.parse(stale.text).error, /Someone else changed/);
  assert.equal((await answerOf(ctx.a, 'GOV-02')).review_conclusion, 'partially_satisfactory');
  const bad = await jsonPost(consultant.session, url, { conclusion: 'not_reviewed', row_version: String(saved.row_version) });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).error, /Choose a conclusion/);
  const unsigned = await consultant.session.post(url, { conclusion: 'unsatisfactory', row_version: String(saved.row_version) }, { json: true });
  assert.equal(unsigned.status, 403);
  assert.doesNotMatch(String(unsigned.headers['content-type']), /json/);
  const outsider = await makeUser('bench-outsider@test.local');
  outsider.session = await signIn(outsider.email, outsider.password);
  await outsider.session.get('/tprm');
  assert.equal((await jsonPost(outsider.session, url, { conclusion: 'unsatisfactory', row_version: String(saved.row_version) })).status, 404);
  const owner = await makeUser('bench-owner@test.local', { type: 'client' });
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(ctx.ws, owner.id, 'client_owner');
  owner.session = await signIn(owner.email, owner.password);
  await owner.session.get('/dashboard');
  assert.ok([403, 404].includes((await jsonPost(owner.session, url, { conclusion: 'unsatisfactory', row_version: String(saved.row_version) })).status));
  for (const u of [outsider, owner]) await u.session.close();
  assert.equal((await answerOf(ctx.a, 'GOV-02')).review_conclusion, 'partially_satisfactory');
});

test('accept-plain.json: accepts exactly the plain answers, one History event each; a changed set saves nothing; the review then closes', async () => {
  const ctx = await submitted('Bench Bulk Co');
  const page = await reviewPage(ctx);
  const ids = acceptIdsOf(page.text);
  const count = ids.split(',').length;
  const url = `${qBase(ctx)}/accept-plain.json`;
  const first = (await answersOf(ctx.a)).find(r => ids.split(',').includes(String(r.id)));
  const fewer = await jsonPost(consultant.session, url, { ids: ids.split(',').filter(x => x !== String(first.id)).join(',') });
  assert.equal(fewer.status, 409);
  assert.match(JSON.parse(fewer.text).error, /changed since the page was loaded [^.]*\. Nothing was saved/);
  assert.equal((await answersOf(ctx.a)).filter(r => r.review_conclusion !== 'not_reviewed').length, 0);
  assert.equal((await qRow(ctx.a)).status, 'submitted', 'a refused accept starts nothing');
  const empty = await jsonPost(consultant.session, url, { ids: '' });
  assert.equal(empty.status, 400);
  const ok = await jsonPost(consultant.session, url, { ids });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([JSON.parse(ok.text).accepted, JSON.parse(ok.text).scope], [count, 'all sections']);
  const rows = await answersOf(ctx.a);
  const accepted = rows.filter(r => ids.split(',').includes(String(r.id)));
  assert.ok(accepted.every(r => r.review_conclusion === 'satisfactory' && Number(r.reviewed_by) === consultant.id));
  assert.ok(rows.filter(r => !ids.split(',').includes(String(r.id))).every(r => r.review_conclusion === 'not_reviewed'), 'answers that need judgement are left alone');
  const bulk = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'answer.accepted_in_bulk');
  assert.equal(bulk.length, count, 'one event per answer');
  assert.ok(bulk.every(e => e.after_state.accepted_with === count && e.after_state.conclusion === 'satisfactory' && Number(e.actor_user_id) === consultant.id));
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
  const history = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=history`);
  assert.match(history.text, /data-tprm-history-action="answer.accepted_in_bulk"/, 'History shows the accept');
  assert.equal((await jsonPost(consultant.session, url, { ids })).status, 409);
  let last = null;
  for (const r of rows.filter(x => x.review_conclusion === 'not_reviewed')) {
    const res = await jsonPost(consultant.session, `${qBase(ctx)}/answers/${r.id}/conclusion.json`, { conclusion: 'satisfactory', row_version: String(r.row_version) });
    assert.equal(res.status, 200, res.text);
    last = JSON.parse(res.text);
  }
  assert.equal(last.blockers.unreviewed, 0);
  const close = await consultant.session.post(`${qBase(ctx)}/close`, { row_version: String(last.questionnaire.row_version) });
  assert.match(toast(close), /Review of the answers closed/);
});

test('accept-plain as a form: confirmed once (without the script, a confirmation page); a section at a time', async () => {
  const ctx = await linked('Bench Form Co', { answers: { ...LOW, data_handled: 'internal' } });
  await answerAll(ctx);
  assert.equal((await submitLink(ctx.token)).status, 200);
  const page = await reviewPage(ctx);
  const section = (page.text.match(/data-tprm-accept-plain-form="(\d+)"/) || [])[1];
  assert.ok(section !== undefined, 'a section with plain answers has its own button');
  const ids = acceptIdsOf(page.text, section);
  const fields = { section, ids, answers_filter: 'unexpected', _tp_confirm_title: 'Accept?', _tp_confirm_body: 'x', _tp_confirm_action: 'Accept' };
  const ask = await consultant.session.post(`${qBase(ctx)}/accept-plain`, { ...fields });
  assert.equal(ask.status, 200, 'without the script the server asks first');
  assert.equal((await answersOf(ctx.a)).filter(r => r.review_conclusion !== 'not_reviewed').length, 0);
  const done = await consultant.session.post(`${qBase(ctx)}/accept-plain`, { ...fields, _tp_confirmed: '1' });
  assert.equal(done.status, 302);
  const title = (await qRow(ctx.a)).sections[Number(section)].title;
  assert.match(toast(done), new RegExp(`${ids.split(',').length} plain answers? accepted as Satisfactory \\(${title.replace(/[&]/g, '.')}\\)`));
  assert.match(done.location, /\?step=review&answers=unexpected&toast=/);
  assert.equal((await answersOf(ctx.a)).filter(r => r.review_conclusion === 'satisfactory').length, ids.split(',').length);
});

test('raise a finding without leaving the review: the form opens under the answer, filled in, and saving returns to it', async () => {
  const ctx = await submitted('Bench Finding Co');
  const ais = await answerOf(ctx.a, 'AIS-01');
  const page = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=review&answers=unexpected&raise=${ais.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-tprm-answer-row="AIS-01"[\\s\\S]*?data-tprm-inline-finding="AIS-01"[\\s\\S]*?name="return_answer" value="${ais.id}"[\\s\\S]*?name="title" value="${BANK_BY_ID.get('AIS-01').theme}"`));
  assert.equal([...page.text.matchAll(/data-tprm-inline-finding=/g)].length, 1, 'one form, for the answer asked for');
  assert.match(page.text, new RegExp(`href="[^"]*\\?step=review&amp;answers=unexpected&amp;raise=${ais.id}#answer-${ais.id}" data-tprm-raise-finding`));
  const add = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings`, {
    control_ref: 'A.5.23', severity: 'low', title: 'AI screening not evidenced', description: 'From AIS-01', return_to: 'review', return_answer: String(ais.id), answers_filter: 'unexpected',
  });
  assert.equal(add.status, 302);
  assert.match(add.location, new RegExp(`\\?step=review&answers=unexpected&toast=[^#]*#answer-${ais.id}$`));
  assert.equal((await db.prepare('SELECT title FROM tp_findings WHERE assessment_id=?').get(ctx.a)).title, 'AI screening not evidenced');
  const plain = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings`, { severity: 'low', title: 'Second', return_to: 'https://example.com', return_answer: 'x' });
  assert.match(plain.location, /\?step=evidence&toast=[^#]*#findings$/);
  const other = await submitted('Bench Finding Other Co');
  const foreign = await answerOf(other.a, 'AIS-01');
  assert.doesNotMatch((await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=review&raise=${foreign.id}`)).text, /data-tprm-inline-finding=/);
});

test('the evidence of an answer previews in place: a PDF or image inline, a text file as text in a sandbox', async () => {
  const ctx = await linked('Bench Preview Co');
  await save(ctx.token, { 'GOV-02': good('GOV-02') }, { files: [{ field: 'file__GOV-02', filename: 'appointment.txt', content: 'Appointment of A. Rao as CISO, reporting to the CEO.' }] });
  await answerAll(ctx);
  assert.equal((await submitLink(ctx.token)).status, 200);
  const page = await reviewPage(ctx);
  const file = await db.prepare("SELECT id FROM tp_evidence WHERE assessment_id=? AND original_name='appointment.txt'").get(ctx.a);
  const textUrl = `${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${file.id}/text`;
  assert.match(page.text, new RegExp(`data-tprm-answer-row="GOV-02"[\\s\\S]*?data-tp-preview="${textUrl.replace(/\//g, '\\/')}"[^>]*data-tprm-preview-text>Show text<`));
  const res = await consultant.session.get(textUrl);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
  assert.match(res.headers['content-security-policy'], /sandbox/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.text, /Appointment of A\. Rao as CISO/);
  const other = await submitted('Bench Preview Other Co');
  assert.equal((await consultant.session.get(`${aBase(other.ws, other.tp, other.a)}/evidence/${file.id}/text`)).status, 404);
});

test('the TPRM home leads with the pipeline: step, who it waits on, late; filters in the address; the queues are tabs', async () => {
  const sent = await linked('Pipeline Sent Co');
  const done = await submitted('Pipeline Done Co');
  await db.prepare("UPDATE tp_assessments SET due_date = CURRENT_DATE - 3 WHERE id = ?").run(done.a);
  const home = await consultant.session.get('/tprm');
  assert.equal(home.status, 200);
  assert.match(home.text, /data-tprm-pipeline[\s\S]*data-tprm-client-list[\s\S]*data-tprm-firm-settings|data-tprm-pipeline[\s\S]*data-tprm-client-list/, 'the pipeline comes before the clients');
  assert.match(home.text, new RegExp(`data-tprm-pipeline-row="${sent.a}" data-tprm-waiting="third_party"`));
  assert.match(home.text, new RegExp(`data-tprm-pipeline-row="${done.a}" data-tprm-waiting="consultant" data-tprm-late`));
  assert.match(home.text, new RegExp(`data-tprm-pipeline-row="${done.a}"[\\s\\S]*?Review of answers[\\s\\S]*?late`));
  assert.match(home.text, /data-tprm-home-tabs[\s\S]*href="\/tprm\/review" data-tprm-review-link>Review queue \(\d+\)[\s\S]*href="\/tprm\/due" data-tprm-due-link[\s\S]*href="\/tprm\/conditions" data-tprm-conditions-link/);
  const waitingVendor = await consultant.session.get('/tprm?waiting=third_party');
  assert.match(waitingVendor.text, new RegExp(`data-tprm-pipeline-row="${sent.a}"`));
  assert.doesNotMatch(waitingVendor.text, new RegExp(`data-tprm-pipeline-row="${done.a}"`));
  const late = await consultant.session.get('/tprm?late=1');
  assert.match(late.text, new RegExp(`data-tprm-pipeline-row="${done.a}"`));
  assert.doesNotMatch(late.text, new RegExp(`data-tprm-pipeline-row="${sent.a}"`));
  for (const [path, current] of [['/tprm/due', 'Reassessments due'], ['/tprm/conditions', 'Conditions due']]) {
    const page = await consultant.session.get(path);
    assert.equal(page.status, 200, path);
    assert.match(page.text, new RegExp(`data-tprm-home-tabs[\\s\\S]*is-current" aria-current="page"[^>]*>${current}<`));
  }
});

function asPosted(r) {
  const row = BANK_BY_ID.get(r.question_id) || {};
  const common = { ref: r.evidence_ref || '', date: r.evidence_day || '', confirm: true };
  if (r.response === 'text') return r.fields ? { f: r.fields, ...common } : { t: r.detail || '', ...common };
  if (r.response === 'yes' && r.fields) return { r: 'yes', f: r.fields, ...common };
  if (r.response === 'yes' && row.details_on_yes) return { r: 'yes', y: r.detail || '', ...common };
  return { r: r.response, d: r.detail || '', ...common };
}

test('another client\'s or another firm\'s review is not found', async () => {
  const mine = await submitted('Iso Review Co');
  const other = await linked('Iso Review Other Co');
  const a = await answerOf(mine.a, 'GOV-01');
  const wrong = { ws: other.ws, tp: mine.tp, a: mine.a };
  assert.equal((await consultant.session.post(`${qBase(wrong)}/answers/${a.id}/review`, { conclusion: 'satisfactory', row_version: String(a.row_version) })).status, 404);
  assert.equal((await consultant.session.post(`${qBase(wrong)}/clarifications`, { question_id: 'GOV-01', body: 'x' })).status, 404);
  assert.equal((await consultant.session.post(`${qBase(wrong)}/close`, { row_version: '1' })).status, 404);
  const otherFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Other Vendor Answers Firm')").run()).lastInsertRowid);
  const outsider = await makeUser('va-outsider@test.local', { role: 'manager', firm: otherFirm });
  const session = await signIn(outsider.email, outsider.password);
  try {
    assert.equal((await session.post(`${qBase(mine)}/answers/${a.id}/review`, { conclusion: 'satisfactory', row_version: String(a.row_version) })).status, 404);
    assert.equal((await session.post(`${qBase(mine)}/clarifications`, { question_id: 'GOV-01', body: 'x' })).status, 404);
    assert.equal((await session.get(`${aBase(mine.ws, mine.tp, mine.a)}/findings/new?answer=${a.id}`)).status, 404);
  } finally { await session.close(); }
  assert.equal((await answerOf(mine.a, 'GOV-01')).review_conclusion, 'not_reviewed');
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_clarifications WHERE assessment_id=?').get(mine.a)).c, 0);
  const q = await qRow(mine.a);
  await assert.rejects(db.prepare(`INSERT INTO tp_clarifications (workspace_id, assessment_id, questionnaire_id, question_id, body)
    VALUES (?, ?, ?, 'GOV-01', 'x')`).run(other.ws, mine.a, q.id), /foreign key|violates|asked once the questionnaire is submitted/);
  const fks = (await db.prepare(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid IN ('tp_answers'::regclass, 'tp_answer_evidence'::regclass, 'tp_clarifications'::regclass) AND contype = 'f'`).all()).map(r => r.def);
  assert.ok(fks.includes('FOREIGN KEY (workspace_id, assessment_id, questionnaire_id) REFERENCES tp_questionnaires(workspace_id, assessment_id, id)'), fks.join('; '));
  assert.ok(fks.includes('FOREIGN KEY (workspace_id, assessment_id, evidence_id) REFERENCES tp_evidence(workspace_id, assessment_id, id)'), fks.join('; '));
});

test('every change is an event in the assessment chain, the chain verifies, and deleting the client removes answers, files and clarifications', async () => {
  const ctx = await linked('Events Answers Co');
  await save(ctx.token, { 'AIS-01': { r: 'yes' } });
  await answerAll(ctx, { 'AIS-01': { r: 'yes' }, ...Object.fromEntries(AI_IDS.map(id => [id, good(id, { ref: 'AI doc' })])) });
  await save(ctx.token, { 'GOV-01': { t: 'Yearly', ref: 'x' } }, { files: [{ field: 'file__GOV-01', filename: 'evt.txt', content: 'event file' }] });
  assert.equal((await submitLink(ctx.token)).status, 200);
  await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-01', body: 'More please' });
  const rows = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  for (const want of ['questionnaire.answering_started', 'questionnaire.answers_saved', 'questionnaire.module_added', 'evidence.uploaded',
    'questionnaire.submitted', 'vendor_link.used', 'questionnaire.review_started', 'clarification.asked']) assert.ok(rows.includes(want), want);
  const all = await chain(ctx.ws, ctx.a);
  for (const e of all) assert.equal(JSON.stringify(e).includes('token'), false, 'no event carries a token');
  for (const e of all.filter(x => x.after_state && x.after_state.by === 'third_party')) assert.equal(e.actor_user_id, null);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
  const stored = (await db.prepare('SELECT stored_path FROM tp_evidence WHERE workspace_id=?').all(ctx.ws)).map(r => r.stored_path);
  assert.ok(stored.length >= 1);
  const name = (await db.prepare('SELECT client_name FROM workspaces WHERE id=?').get(ctx.ws)).client_name;
  assert.equal((await client.post(`/workspaces/${ctx.ws}/delete`, { confirm_name: name })).status, 302);
  for (const table of ['tp_answers', 'tp_answer_evidence', 'tp_clarifications', 'tp_evidence', 'tp_questionnaires', 'tp_vendor_requests', 'tp_events']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ctx.ws)).c, 0, table);
  }
  for (const s of stored) assert.ok(!fs.existsSync(path.join(ROOT, 'uploads', `firm_${firmId}`, s)), 'stored file removed');
});

test('Your documents: upload once with a description, choose on several questions; never a firm file; take off, then delete', async () => {
  const ctx = await linked('Shelf Co');
  const vq = (token, query) => request('GET', `/vendor/q/${token}${query}`);
  const start = await vget(ctx.token);
  assert.match(start.text, /data-vendor-questions-left="\d+" data-vendor-progress>\d+ of \d+ questions answered</);
  assert.doesNotMatch(start.text, /<dt>/, 'no details sheet on the overview');
  assert.doesNotMatch(start.text, /Dear /, 'no letter');
  assert.doesNotMatch(start.text, /hours?\b|minutes?\b/, 'no time estimate');
  assert.match(start.text, /data-vendor-nav="documents"/);
  await db.prepare(`INSERT INTO tp_evidence (workspace_id, assessment_id, original_name, stored_path, size_bytes, sha256, source, uploaded_by, description)
    VALUES (?, ?, 'firm-internal-notes.txt', 'firm-shelf-test.txt', 5, ?, 'consultant', ?, 'FIRM-ONLY-DESCRIPTION')`)
    .run(ctx.ws, ctx.a, crypto.createHash('sha256').update('firm-shelf').digest('hex'), consultant.id);
  const page = await vq(ctx.token, '?view=documents');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-vendor-shelf-empty/);
  const form = multipart([['_aft', aftOf(page.text)], ['desc_1', 'Our information security policy, version 4'], ['desc_2', '']],
    [{ field: 'doc_file_1', filename: 'policy.txt', content: `policy ${crypto.randomBytes(6).toString('hex')}`, type: 'text/plain' },
      { field: 'doc_file_2', filename: 'pentest.txt', content: `pentest ${crypto.randomBytes(6).toString('hex')}`, type: 'text/plain' }]);
  const added = await request('POST', `/vendor/q/${ctx.token}/documents`, { body: form.body, headers: form.headers });
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(r.stored_path);
  assert.equal(added.status, 303, added.text.slice(0, 300));
  assert.match(added.headers.location, /\?view=documents&notice=documents_added$/);
  const docs = await db.prepare("SELECT * FROM tp_evidence WHERE assessment_id=? AND source='vendor' ORDER BY original_name").all(ctx.a);
  assert.deepEqual(docs.map(d => [d.original_name, d.description]), [['pentest.txt', null], ['policy.txt', 'Our information security policy, version 4']]);
  const shelf = (await vq(ctx.token, '?view=documents')).text;
  assert.match(shelf, /data-vendor-shelf-item="\d+"[\s\S]*?pentest\.txt/);
  assert.match(shelf, /value="Our information security policy, version 4"/);
  assert.doesNotMatch(shelf, /firm-internal-notes|FIRM-ONLY-DESCRIPTION/);
  const policy = docs.find(d => d.original_name === 'policy.txt');
  const sec = (await vq(ctx.token, '?s=1')).text;
  assert.match(sec, new RegExp(`name="pick\\[GOV-01\\]" value="${policy.id}"`));
  assert.doesNotMatch(sec, /firm-internal-notes/);
  const firmFile = await db.prepare("SELECT id FROM tp_evidence WHERE assessment_id=? AND source='consultant'").get(ctx.a);
  assert.equal((await save(ctx.token, { 'GOV-01': { t: 'Every year', pick: firmFile.id } })).status, 400, 'a firm file cannot be chosen');
  const chosen = await save(ctx.token, { 'GOV-01': { t: 'Every year', pick: policy.id }, 'GOV-02': { r: 'yes', pick: policy.id } });
  assert.equal(chosen.status, 303, chosen.text.slice(0, 300));
  const links = async () => (await db.prepare('SELECT a.question_id FROM tp_answer_evidence l JOIN tp_answers a ON a.id = l.answer_id WHERE l.evidence_id=? ORDER BY 1').all(policy.id)).map(r => r.question_id);
  assert.deepEqual(await links(), ['GOV-01', 'GOV-02']);
  assert.doesNotMatch((await vq(ctx.token, '?s=1')).text, new RegExp(`name="pick\\[GOV-01\\]" value="${policy.id}"`), 'not offered again where it is chosen');
  assert.match((await vq(ctx.token, '?view=documents')).text, /Chosen for 2 answers\./);
  const refused = await postForm(ctx.token, `/documents/${policy.id}`, [['delete', '1']]);
  assert.equal(refused.status, 409);
  assert.match(refused.text, /still chosen for an answer/);
  assert.equal((await save(ctx.token, { 'GOV-01': { t: 'Every year', remove: policy.id }, 'GOV-02': { r: 'yes', remove: policy.id } })).status, 303);
  assert.deepEqual(await links(), []);
  assert.ok(await db.prepare('SELECT id FROM tp_evidence WHERE id=?').get(policy.id), 'still in Your documents');
  assert.equal((await postForm(ctx.token, `/documents/${policy.id}`, [['description', 'Policy v5']])).status, 303);
  assert.equal((await db.prepare('SELECT description FROM tp_evidence WHERE id=?').get(policy.id)).description, 'Policy v5');
  assert.equal((await postForm(ctx.token, `/documents/${firmFile.id}`, [['description', 'x']])).status, 400);
  assert.equal((await postForm(ctx.token, `/documents/${policy.id}`, [['delete', '1']])).status, 303);
  assert.equal(await db.prepare('SELECT id FROM tp_evidence WHERE id=?').get(policy.id), undefined);
  const chain = (await db.prepare("SELECT action FROM tp_events WHERE workspace_id=? AND chain_id=? ORDER BY chain_seq").all(ctx.ws, ctx.a)).map(e => e.action);
  assert.ok(chain.includes('evidence.described') && chain.includes('evidence.deleted'));
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});
