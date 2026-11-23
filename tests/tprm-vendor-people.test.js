'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-people-outbox-')), 'outbox.log');

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
  consultant = await makeUser('vp-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('vp-senior@test.local', { role: 'senior_consultant' });
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


const peopleOf = async (ws, tp) => db.prepare(`SELECT * FROM tp_vendor_people WHERE workspace_id=? AND third_party_id=? ORDER BY id`).all(ws, tp);
const tpBase = (ws, tp) => `/tprm/clients/${ws}/third-parties/${tp}`;

test('the firm adds the main contact and colleagues, and an email is used once per third party', async () => {
  const ws = await tprmClient('People Client');
  const tp = await addThirdParty(ws, 'People Co');
  const base = tpBase(ws, tp);
  const page = await consultant.session.get(`${base}?tab=people`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-people-empty/);

  const bad = await consultant.session.post(`${base}/people`, { name: 'Asha Rao', email: 'not-an-email', job_title: 'CISO' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Give a valid email address/);
  assert.match(bad.text, /value="Asha Rao"/, 'typed text is kept');

  const first = await consultant.session.post(`${base}/people`, { name: 'Asha Rao', email: 'Asha.Rao@PeopleCo.example', job_title: 'CISO', phone: '+91 98200 00000' });
  assert.equal(first.status, 302, toast(first));
  assert.match(toast(first), /Asha Rao added as the main contact/);
  const second = await consultant.session.post(`${base}/people`, { name: 'Ben Ito', email: 'ben@peopleco.example' });
  assert.match(toast(second), /Ben Ito added/);
  const dup = await consultant.session.post(`${base}/people`, { name: 'Asha again', email: 'asha.rao@peopleco.example' });
  assert.equal(dup.status, 400);
  assert.match(dup.text, /already one of the people/);

  let people = await peopleOf(ws, tp);
  assert.deepEqual(people.map(p => [p.email, p.role]), [['asha.rao@peopleco.example', 'main'], ['ben@peopleco.example', 'colleague']]);

  const asha = people[0];
  const ben = people[1];
  const noRemove = await consultant.session.post(`${base}/people/${asha.id}/remove`, {});
  assert.match(toast(noRemove), /main contact cannot be removed/);
  const swap = await consultant.session.post(`${base}/people/${ben.id}/main`, {});
  assert.match(toast(swap), /Ben Ito is now the main contact/);
  people = await peopleOf(ws, tp);
  assert.deepEqual(people.map(p => p.role), ['colleague', 'main']);

  const edit = await consultant.session.post(`${base}/people/${asha.id}`, { name: 'Asha R. Rao', email: 'asha.rao@peopleco.example', job_title: 'Head of security', phone: '', row_version: String(people[0].row_version) });
  assert.match(toast(edit), /Asha R\. Rao updated/);
  const stale = await consultant.session.post(`${base}/people/${asha.id}`, { name: 'Old', email: 'asha.rao@peopleco.example', row_version: String(people[0].row_version) });
  assert.match(toast(stale), /Someone else changed this person/);

  const removed = await consultant.session.post(`${base}/people/${asha.id}/remove`, {});
  assert.match(toast(removed), /Asha R\. Rao removed/);
  people = await peopleOf(ws, tp);
  assert.deepEqual(people.map(p => [p.name, p.status]), [['Asha R. Rao', 'removed'], ['Ben Ito', 'active']]);
  const again = await consultant.session.post(`${base}/people`, { name: 'Asha Rao', email: 'asha.rao@peopleco.example' });
  assert.equal(again.status, 302, 'a removed person can be added again');

  const view = await consultant.session.get(`${base}?tab=people`);
  assert.match(view.text, /data-tprm-person-role="main"/);
  const history = (await db.prepare(`SELECT action FROM tp_events WHERE workspace_id=? AND third_party_id=? ORDER BY id`).all(ws, tp)).map(e => e.action);
  for (const a of ['vendor_person.added', 'vendor_person.made_main', 'vendor_person.changed', 'vendor_person.removed']) assert.ok(history.includes(a), a);
  const historyPage = await consultant.session.get(`${base}?tab=history`);
  assert.match(historyPage.text, /made Ben Ito the main contact|Ben Ito/);
});

test('one main contact and one active email per third party are enforced by the database', async () => {
  const ws = await tprmClient('People Rules Client');
  const tp = await addThirdParty(ws, 'Rules Co');
  await db.prepare(`INSERT INTO tp_vendor_people (workspace_id, third_party_id, email, name, role) VALUES (?, ?, 'a@rules.example', 'A', 'main')`).run(ws, tp);
  await assert.rejects(db.prepare(`INSERT INTO tp_vendor_people (workspace_id, third_party_id, email, name, role) VALUES (?, ?, 'b@rules.example', 'B', 'main')`).run(ws, tp), /tp_vendor_people_main/);
  await assert.rejects(db.prepare(`INSERT INTO tp_vendor_people (workspace_id, third_party_id, email, name) VALUES (?, ?, 'a@rules.example', 'A2')`).run(ws, tp), /tp_vendor_people_email/);
  await assert.rejects(db.prepare(`INSERT INTO tp_vendor_people (workspace_id, third_party_id, email, name) VALUES (?, ?, 'Upper@rules.example', 'U')`).run(ws, tp), /check/i);
});

test('the main contact is filled in from the third party contact, or else from its latest questionnaire link', async () => {
  const sql = fs.readFileSync(path.join(ROOT, 'migrations', '126_tprm_vendor_people.sql'), 'utf8');
  const backfill = sql.slice(sql.indexOf('INSERT INTO tp_vendor_people (workspace_id, third_party_id, email, name, role)\nSELECT'));
  const withLink = await linked('Backfill Link Co');
  const ws = withLink.ws;
  const contactTp = await addThirdParty(ws, 'Backfill Contact Co');
  await db.prepare(`UPDATE tp_third_parties SET primary_contact_name='Dana Contact', primary_contact_email='Dana@Contact.example' WHERE id=?`).run(contactTp);
  const emptyTp = await addThirdParty(ws, 'Backfill Empty Co');
  await db.prepare('DELETE FROM tp_vendor_people WHERE workspace_id=?').run(ws);
  await db.exec(backfill);
  assert.deepEqual((await peopleOf(ws, withLink.tp)).map(p => [p.email, p.name, p.role]), [['priya@thirdparty.example.net', 'Priya Vendor', 'main']]);
  assert.deepEqual((await peopleOf(ws, contactTp)).map(p => [p.email, p.name, p.role]), [['dana@contact.example', 'Dana Contact', 'main']]);
  assert.deepEqual(await peopleOf(ws, emptyTp), []);
  await db.exec(backfill);
  assert.equal((await peopleOf(ws, withLink.tp)).length, 1, 'running it again adds no one');
});
