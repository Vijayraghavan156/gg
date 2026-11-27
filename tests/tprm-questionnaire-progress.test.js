'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-qp-outbox-')), 'outbox.log');

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
const PASSWORD = 'q-progress-tests-password-1234';
const LOW = {
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no',
};

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let vendorRoute;
const sessions = [];

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const qRow = async a => db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(a);
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const portal = ws => `/workspaces/${ws}/client-portal/third-party-risk`;

async function makeUser(email, { type = 'firm', role = 'consultant', workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firmId : null, type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email, firm_role: role };
}

async function signIn(user) {
  if (user.session) return user.session;
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email: user.email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302);
  await session.get('/dashboard');
  sessions.push(session);
  user.session = session;
  return session;
}

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id,
    owner: await makeUser(`qp-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' }),
    contributor: await makeUser(`qp-contrib-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'contributor' }),
  };
}

async function supplier(ws, name) {
  const s = await signIn(consultant);
  const res = await s.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await s.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosted service' })).status, 302);
  return tp;
}

async function confirmed(ws, tp) {
  const s = await signIn(consultant);
  const started = await s.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await s.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  assert.equal((await (await signIn(senior)).post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await s.post(`${aBase(ws, tp, a)}/questionnaire`, {})).status, 302);
  return a;
}

async function sendLink(ws, tp, a) {
  const row = await qRow(a);
  const res = await (await signIn(consultant)).post(`${aBase(ws, tp, a)}/questionnaire/links`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(row.row_version),
  });
  const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
  assert.ok(url, 'a link was made');
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
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }); });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}

async function vendorSave(token, answers) {
  const page = await request('GET', `/vendor/q/${token}`);
  const aft = (String(page.text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];
  const boundary = '----tprmqp' + crypto.randomBytes(8).toString('hex');
  const fields = [['_aft', aft], ...answerFormFields(answers, BANK_BY_ID), ['intent', 'save']];
  const parts = [];
  for (const [k, v] of fields) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  parts.push(`--${boundary}--`, '');
  const res = await request('POST', `/vendor/q/${token}/save`, { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(res.status, 303, res.text.slice(0, 200));
}

async function vendorCounts(ws, a) {
  const q = await qRow(a);
  const w = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(ws);
  const page = await require('../lib/tprm/vendor-answers').pageData(db, {
    workspaceId: ws, questionnaireId: Number(q.id), assessmentId: a, firmId: Number(w.firm_id), clientName: w.client_name, mode: 'clarifying',
  });
  return { answered: page.answered, total: page.total };
}

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  vendorRoute = require('../routes/tprm-vendor');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('qp-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('qp-senior@test.local', { role: 'senior_consultant' });
});

test.beforeEach(() => { if (vendorRoute) { vendorRoute.limiter.reset(); vendorRoute.postLimiter.reset(); } });

test.after(async () => {
  for (const s of sessions) await s.close();
  if (client) await client.close();
});

test('the client sees questionnaire status, dates and the share answered, counted as the supplier side counts it', async () => {
  const A = await tprmClient('Progress Client A');
  const tp = await supplier(A.id, 'Progress Supplier');
  const a = await confirmed(A.id, tp);
  const c = await signIn(A.contributor);

  let page = await c.get(`${portal(A.id)}/third-parties/${tp}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-cv-questionnaire="not_sent"/);
  assert.match(page.text, /Not sent yet/);

  const token = await sendLink(A.id, tp, a);
  page = await c.get(`${portal(A.id)}/third-parties/${tp}`);
  assert.match(page.text, /data-tprm-cv-questionnaire="sent"/);
  assert.match(page.text, /data-tprm-cv-questionnaire-percent="0"/);
  const link = await db.prepare('SELECT created_at, expires_at FROM tp_vendor_requests WHERE assessment_id=? ORDER BY id DESC LIMIT 1').get(a);
  const day = require('../lib/tprm/format').forZone('UTC', { ymdInZone: require('../lib/dates').ymdInZone }).day;
  const dueDay = day(new Date(link.expires_at).toISOString().slice(0, 10));
  assert.match(page.text.match(/<dd data-tprm-cv-questionnaire-due>[^<]*<\/dd>/)[0], new RegExp(dueDay));

  const q = await qRow(a);
  const ids = q.sections.flatMap(s => s.ids).slice(0, 3);
  const answers = {};
  for (const id of ids) answers[id] = completeAnswer(BANK_BY_ID.get(id), id, { ref: `Policy for ${id}`, date: '2026-01-15' });
  await vendorSave(token, answers);
  const counts = await vendorCounts(A.id, a);
  assert.ok(counts.answered > 0 && counts.answered < counts.total, `part answered (${counts.answered} of ${counts.total})`);
  const percent = Math.round((counts.answered / counts.total) * 100);

  page = await c.get(`${portal(A.id)}/third-parties/${tp}`);
  assert.match(page.text, /data-tprm-cv-questionnaire="in_progress"/);
  assert.match(page.text, new RegExp(`data-tprm-cv-questionnaire-percent="${percent}"`));
  assert.match(page.text, new RegExp(`${counts.answered} of ${counts.total} questions`));
  for (const id of ids) assert.doesNotMatch(page.text, new RegExp(`Policy for ${id}`), 'no answer text reaches the client');

  const list = await c.get(portal(A.id));
  assert.match(list.text, /data-tprm-cv-q-progress="in_progress"/);
  assert.match(list.text, new RegExp(`Questionnaire: being answered, ${percent}% answered`));
  const dates = list.text.match(/<span[^>]*data-tprm-cv-q-dates>[^<]*<\/span>/)[0];
  assert.match(dates, /Sent /);
  assert.match(dates, new RegExp(`due ${dueDay}`));

  const all = {};
  for (const id of q.sections.flatMap(x => x.ids)) all[id] = completeAnswer(BANK_BY_ID.get(id), id, { ref: `Policy for ${id}`, date: '2026-01-15' });
  all['AIS-01'] = { r: 'no', d: 'No AI is used to provide the service.' };
  await vendorSave(token, all);
  const form = await request('GET', `/vendor/q/${token}`);
  const aft = (String(form.text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];
  const sent = await request('POST', `/vendor/q/${token}/submit`, { body: new URLSearchParams([['_aft', aft]]).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(sent.status, 303, sent.text.slice(0, 300));
  assert.equal((await qRow(a)).status, 'submitted');
  page = await c.get(`${portal(A.id)}/third-parties/${tp}`);
  assert.match(page.text, /data-tprm-cv-questionnaire="submitted"/);
  assert.match((await c.get(portal(A.id))).text, /data-tprm-cv-q-progress="submitted"/);
});

test('no progress shows without an open review, and other clients and firm users never see it', async () => {
  const B = await tprmClient('Progress Client B');
  const idle = await supplier(B.id, 'Idle Supplier');
  const s = await signIn(B.owner);
  const page = await s.get(`${portal(B.id)}/third-parties/${idle}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /data-tprm-cv-questionnaire=/);
  assert.doesNotMatch((await s.get(portal(B.id))).text, /data-tprm-cv-q-progress/);

  const C = await tprmClient('Progress Client C');
  const other = await supplier(C.id, 'C Supplier');
  await confirmed(C.id, other);
  assert.equal((await s.get(`${portal(C.id)}/third-parties/${other}`)).status, 403);
  assert.equal((await s.get(`${portal(B.id)}/third-parties/${other}`)).status, 404);
  assert.equal((await client.get(`${portal(C.id)}/third-parties/${other}`)).status, 404);
});

test('the client progress uses a light count that matches the supplier page, and the portal works without building the full pages', async () => {
  const D = await tprmClient('Progress Client D');
  const tp = await supplier(D.id, 'Light Supplier');
  const a = await confirmed(D.id, tp);
  const token = await sendLink(D.id, tp, a);
  const q = await qRow(a);
  const ids = q.sections.flatMap(x => x.ids).slice(0, 4);
  const answers = {};
  for (const id of ids) answers[id] = completeAnswer(BANK_BY_ID.get(id), id, { ref: `Policy for ${id}`, date: '2026-01-15' });
  answers[ids[3]] = { r: 'yes' };
  await vendorSave(token, answers);
  const w = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(D.id);
  const ctx = { workspaceId: D.id, questionnaireId: Number(q.id), assessmentId: a, firmId: Number(w.firm_id), clientName: w.client_name, mode: 'clarifying' };
  const vendorAnswers = require('../lib/tprm/vendor-answers');
  const full = await vendorAnswers.pageData(db, ctx);
  const light = await vendorAnswers.progressCounts(db, ctx);
  assert.deepEqual(light, { answered: full.answered, total: full.total, responded: full.responded });
  assert.ok(light.answered > 0 && light.responded > light.answered, JSON.stringify(light));

  const idle = await supplier(D.id, 'Idle Light Supplier');
  const clientView = require('../lib/tprm/client-view');
  const realPage = vendorAnswers.pageData;
  const realParty = clientView.thirdParty;
  const s = await signIn(D.owner);
  assert.equal((await s.get(portal(D.id))).status, 200);
  vendorAnswers.pageData = async () => { throw new Error('the full supplier page was built'); };
  try {
    const home = await s.get(portal(D.id));
    assert.equal(home.status, 200);
    assert.match(home.text, new RegExp(`Questionnaire: being answered, ${Math.round((light.answered / light.total) * 100)}% answered`));
    const page = await s.get(`${portal(D.id)}/third-parties/${tp}`);
    assert.match(page.text, new RegExp(`${light.answered} of ${light.total} questions`));
    clientView.thirdParty = async () => { throw new Error('the full client page was built'); };
    assert.equal((await s.get(`${portal(D.id)}/third-parties/${tp}/documents/999999/download`)).status, 404);
    const asked = await s.post(`${portal(D.id)}/third-parties/${idle}/reassessment-requests`, { reason: 'New data centre' });
    assert.equal(asked.status, 302);
    assert.match(String(asked.location), /requests\/\d+/);
    assert.equal((await s.post(`${portal(D.id)}/third-parties/999999/reassessment-requests`, { reason: 'Nobody' })).status, 404);
  } finally {
    vendorAnswers.pageData = realPage;
    clientView.thirdParty = realParty;
  }
});

test('a questionnaire the supplier has started shows as being answered even while every answer still needs work', async () => {
  const E = await tprmClient('Progress Client E');
  const tp = await supplier(E.id, 'Started Supplier');
  const a = await confirmed(E.id, tp);
  const token = await sendLink(E.id, tp, a);
  const q = await qRow(a);
  const first = q.sections.flatMap(x => x.ids).find(id => {
    const row = BANK_BY_ID.get(id);
    return row && row.answer_type !== 'free_text' && row.evidence_mandatory && row.evidence_on !== 'no' && !row.fields && !row.details_on_yes;
  });
  assert.ok(first, 'a yes or no question that needs evidence');
  await vendorSave(token, { [first]: { r: 'yes' } });
  const w = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(E.id);
  const counts = await require('../lib/tprm/vendor-answers').progressCounts(db, {
    workspaceId: E.id, questionnaireId: Number(q.id), assessmentId: a, firmId: Number(w.firm_id), clientName: w.client_name, mode: 'clarifying',
  });
  assert.equal(counts.responded, 1);
  assert.equal(counts.answered, 0, 'the one answer still has a problem');
  await db.prepare("UPDATE tp_questionnaires SET status = 'sent' WHERE id = ?").run(q.id);
  const c = await signIn(E.contributor);
  const page = await c.get(`${portal(E.id)}/third-parties/${tp}`);
  assert.match(page.text, /data-tprm-cv-questionnaire="in_progress"/);
  assert.match(page.text, /data-tprm-cv-questionnaire-percent="0"/);
  assert.match((await c.get(portal(E.id))).text, /data-tprm-cv-q-progress="in_progress"/);
});
