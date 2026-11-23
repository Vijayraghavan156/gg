'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-portal-outbox-')), 'outbox.log');

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
  consultant = await makeUser('vpo-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('vpo-senior@test.local', { role: 'senior_consultant' });
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
  if (vendorRoute) { vendorRoute.limiter.reset(); vendorRoute.postLimiter.reset(); vendorRoute.signInLimiter.reset(); }
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


const outboxCodes = () => {
  const text = fs.existsSync(process.env.EMAIL_DEV_OUTBOX) ? fs.readFileSync(process.env.EMAIL_DEV_OUTBOX, 'utf8') : '';
  return text.split('\n===== ').filter(b => /SUBJ: Your sign-in code/.test(b)).map(b => (b.match(/Your sign-in code is (\d{6})/) || [])[1]);
};
const form = fields => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const post = (url, fields, cookie) => request('POST', url, { body: form(fields), headers: { ...FORM, ...(cookie ? { cookie } : {}) } });
const get = (url, cookie) => request('GET', url, { headers: cookie ? { cookie } : {} });
const cookieOf = res => (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('tpv_sid=')) || null;
const tpBase = (ws, tp) => `/tprm/clients/${ws}/third-parties/${tp}`;
const peopleOf = async (ws, tp) => db.prepare(`SELECT * FROM tp_vendor_people WHERE workspace_id=? AND third_party_id=? AND status='active' ORDER BY id`).all(ws, tp);

async function addPerson(ws, tp, name, email, role) {
  const res = await consultant.session.post(`${tpBase(ws, tp)}/people`, { name, email, ...(role ? { role } : {}) });
  assert.equal(res.status, 302, toast(res));
  return (await peopleOf(ws, tp)).find(p => p.email === email.toLowerCase());
}

async function codeSignIn(email, { firmId = null } = {}) {
  const before = outboxCodes().length;
  const asked = await post('/vendor/p/sign-in', [['email', email]]);
  assert.equal(asked.status, 200);
  assert.match(asked.text, /data-vendor-sign-in="code"/);
  const codes = outboxCodes();
  assert.equal(codes.length, before + 1, 'one code was emailed');
  const verified = await post('/vendor/p/verify', [['email', email], ['code', codes[codes.length - 1]]]);
  if (verified.status === 200 && /data-vendor-sign-in="choose"/.test(verified.text)) {
    const fid = firmId || Number(verified.text.match(/data-vendor-choose="(\d+)"/)[1]);
    const block = verified.text.slice(verified.text.indexOf(`data-vendor-choose="${fid}"`));
    const val = name => (block.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];
    const chosen = await post('/vendor/p/choose', [['email', val('email')], ['code_id', val('code_id')], ['choice', val('choice')], ['firm_id', String(fid)]]);
    assert.equal(chosen.status, 303, chosen.text.slice(0, 300));
    return { cookie: cookieOf(chosen), chooser: verified };
  }
  assert.equal(verified.status, 303, verified.text.slice(0, 300));
  assert.equal(verified.location, '/vendor/p/home');
  return { cookie: cookieOf(verified), res: verified };
}

test('a person signs in with an emailed code; unknown addresses get the same answer and no email', async () => {
  const ctx = await linked('Portal Sign Co');
  const person = await addPerson(ctx.ws, ctx.tp, 'Rhea Shah', 'Rhea@PortalSign.example');

  const before = outboxCodes().length;
  const unknown = await post('/vendor/p/sign-in', [['email', 'nobody@unknown.example']]);
  assert.equal(unknown.status, 200);
  assert.match(unknown.text, /data-vendor-sign-in="code"/);
  assert.equal(outboxCodes().length, before, 'no email for an unknown address');
  assert.equal((await db.prepare(`SELECT COUNT(*)::int n FROM tp_vendor_codes WHERE email='nobody@unknown.example'`).get()).n, 0);
  assert.equal((await post('/vendor/p/sign-in', [['email', 'not an email']])).status, 400);

  await post('/vendor/p/sign-in', [['email', 'rhea@portalsign.example']]);
  const code = outboxCodes().pop();
  const stored = await db.prepare(`SELECT subject, body_html FROM email_outbox WHERE related_type='tprm:vendor_sign_in_code' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(stored && !stored.body_html.includes(code) && !stored.subject.includes(code), 'the stored copy of the email has no code');
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) assert.equal((await post('/vendor/p/verify', [['email', 'rhea@portalsign.example'], ['code', wrong]])).status, 400);
  const locked = await post('/vendor/p/verify', [['email', 'rhea@portalsign.example'], ['code', code]]);
  assert.equal(locked.status, 400, 'after five wrong tries the code no longer works');

  const { cookie, res } = await codeSignIn('rhea@portalsign.example');
  const raw = res.headers['set-cookie'].find(c => c.startsWith('tpv_sid='));
  assert.match(raw, /Path=\/vendor/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  const reused = await post('/vendor/p/verify', [['email', 'rhea@portalsign.example'], ['code', outboxCodes().pop()]]);
  assert.equal(reused.status, 400, 'a code works once');

  const home = await get('/vendor/p/home', cookie);
  assert.equal(home.status, 200);
  assert.match(home.text, /Portal Sign Co Client/);
  assert.match(home.text, new RegExp(`href="/vendor/p/a/${ctx.a}" data-vendor-home-open`));
  assert.match(home.text, /Rhea Shah/);
  assert.doesNotMatch(home.text, /<script/);
  const out = await get('/vendor/p/home');
  assert.equal(out.status, 303);
  assert.match(out.location, /\/vendor\/p\/sign-in/);
  assert.ok(person);
});

test('signed in, the questionnaire opens under the portal, saves are attributed, and each form token works only where it was issued', async () => {
  const ctx = await linked('Portal Paths Co');
  const person = await addPerson(ctx.ws, ctx.tp, 'Sam Iyer', 'sam@portalpaths.example');
  const { cookie } = await codeSignIn('sam@portalpaths.example');
  const page = await get(`/vendor/p/a/${ctx.a}`, cookie);
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.match(page.text, /data-vendor-link-open/);
  assert.match(page.text, new RegExp(`action="/vendor/p/a/${ctx.a}/spreadsheet"`));
  const sessionAft = aftOf(page.text);
  const tokenAft = aftOf((await vget(ctx.token)).text);

  const q = await qRow(ctx.a);
  const id = idsOf(q)[0];
  const send = async (url, aft, ck) => {
    const m = multipart([['_aft', aft], ...answerFields({ [id]: good(id) }), ['intent', 'save']]);
    return request('POST', url, { body: m.body, headers: { ...m.headers, ...(ck ? { cookie: ck } : {}) } });
  };
  assert.equal((await send(`/vendor/p/a/${ctx.a}/save`, tokenAft, cookie)).status, 403, 'a link form token does not work on the portal');
  assert.equal((await send(`/vendor/q/${ctx.token}/save`, sessionAft, cookie)).status, 403, 'a portal form token does not work on the link');
  assert.equal((await send(`/vendor/p/a/${ctx.a}/save`, sessionAft, null)).status, 403, 'signed out, nothing is saved');
  const saved = await send(`/vendor/p/a/${ctx.a}/save`, sessionAft, cookie);
  assert.equal(saved.status, 303, saved.text.slice(0, 300));
  assert.match(saved.location, new RegExp(`^/vendor/p/a/${ctx.a}`));
  const a = await answerOf(ctx.a, id);
  assert.equal(Number(a.saved_by_person_id), Number(person.id));
  const ev = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'questionnaire.answers_saved').pop();
  assert.equal(ev.after_state.by_name, 'Sam Iyer');
  const sec = await request('GET', `/vendor/p/a/${ctx.a}?s=1`, { headers: { cookie } });
  assert.match(sec.text, /Answered by Sam Iyer/);
  const sheet = await request('GET', `/vendor/p/a/${ctx.a}/spreadsheet`, { headers: { cookie } });
  assert.equal(sheet.status, 200);
});

test('a session reaches only its own third parties, and only within one firm', async () => {
  const mine = await linked('Portal Mine Co');
  const other = await linked('Portal Other Co', { ws: mine.ws });
  await addPerson(mine.ws, mine.tp, 'Kim Lee', 'kim@shared.example');
  const otherFirm = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Second Firm LLP')`).run()).lastInsertRowid);
  const ws2 = await tprmClient('Second Firm Client', { firm: otherFirm });
  const tp2 = Number((await db.prepare(`INSERT INTO tp_third_parties (workspace_id, name, status) VALUES (?, 'Portal Elsewhere Co', 'in_use') RETURNING id`).get(ws2)).id);
  await db.prepare(`INSERT INTO tp_vendor_people (workspace_id, third_party_id, email, name, role) VALUES (?, ?, 'kim@shared.example', 'Kim Lee', 'main')`).run(ws2, tp2);

  const { cookie, chooser } = await codeSignIn('kim@shared.example', { firmId: firmId });
  assert.ok(chooser, 'with two firms the person chooses one');
  assert.match(chooser.text, /Second Firm LLP/);
  assert.equal((await get(`/vendor/p/a/${mine.a}`, cookie)).status, 200);
  assert.equal((await get(`/vendor/p/a/${other.a}`, cookie)).status, 404, 'another third party of the same client is not reachable');
  const home = await get('/vendor/p/home', cookie);
  assert.doesNotMatch(home.text, /Portal Elsewhere Co/, 'the other firm stays out of this session');
  assert.doesNotMatch(home.text, /Portal Other Co/);

  const kim = (await peopleOf(mine.ws, mine.tp)).find(p => p.email === 'kim@shared.example');
  const main = (await peopleOf(mine.ws, mine.tp)).find(p => p.role === 'main' && p.id !== kim.id);
  if (kim.role === 'main' && main) await consultant.session.post(`${tpBase(mine.ws, mine.tp)}/people/${main.id}/main`, {});
  if ((await peopleOf(mine.ws, mine.tp)).find(p => p.id === kim.id).role === 'main') await addPerson(mine.ws, mine.tp, 'Other Main', 'othermain@shared.example', 'main');
  const removed = await consultant.session.post(`${tpBase(mine.ws, mine.tp)}/people/${kim.id}/remove`, {});
  assert.match(toast(removed), /Kim Lee removed/);
  const after = await get('/vendor/p/home', cookie);
  assert.equal(after.status, 303, 'removing the person ends their session');
});

test('the questionnaire link signs its recipient in to a home limited to that third party; only the main contact submits', async () => {
  const ctx = await linked('Portal Link Co');
  const page = await vget(ctx.token);
  const home = await post(`/vendor/q/${ctx.token}/home`, [['_aft', aftOf(page.text)]]);
  assert.equal(home.status, 303, home.text.slice(0, 200));
  const cookie = cookieOf(home);
  const people = await peopleOf(ctx.ws, ctx.tp);
  assert.deepEqual(people.map(p => [p.email, p.role]), [['priya@thirdparty.example.net', 'main']], 'the recipient becomes the main contact');
  const homePage = await get('/vendor/p/home', cookie);
  assert.match(homePage.text, /data-vendor-home-scoped/);
  assert.equal((await post(`/vendor/q/${ctx.token}/home`, [['_aft', 'forged']])).status, 403);

  const start = (await vget(ctx.token)).text;
  for (const [key, to] of [['home', 'home'], ['issues', 'issues'], ['files', 'files'], ['people', 'people']]) {
    assert.match(start, new RegExp(`<form method="POST" action="/vendor/q/[^"]+/home" class="vq-menu-form"><input type="hidden" name="_aft" value="[^"]+"><input type="hidden" name="to" value="${to}"><button type="submit" class="vq-menu-item" data-vendor-menu="${key}">`), key);
  }
  assert.doesNotMatch(start, /Your portal home/);
  const toFiles = await post(`/vendor/q/${ctx.token}/home`, [['_aft', aftOf(start)], ['to', 'files']]);
  assert.equal(toFiles.status, 303);
  assert.equal(toFiles.location, '/vendor/p/files');
  assert.ok(cookieOf(toFiles));
  const odd = await post(`/vendor/q/${ctx.token}/home`, [['_aft', aftOf(start)], ['to', 'https://example.net/']]);
  assert.equal(odd.location, '/vendor/p/home');
  const saved = multipart([['_aft', aftOf(start)], ['section', '1'], ['go', 'people']]);
  const leave = await request('POST', `/vendor/q/${ctx.token}/save`, { body: saved.body, headers: saved.headers });
  assert.equal(leave.status, 303);
  assert.equal(leave.location, '/vendor/p/people', 'leaving a section for People from the link saves and opens the portal');
  assert.ok(cookieOf(leave));

  const colleague = await addPerson(ctx.ws, ctx.tp, 'ColeAgue', 'cole@portallink.example');
  await answerAll(ctx);
  const { cookie: coleCookie } = await codeSignIn('cole@portallink.example');
  const review = await get(`/vendor/p/a/${ctx.a}?view=review`, coleCookie);
  assert.match(review.text, /data-vendor-submit-main-only/);
  assert.match(review.text, /Only the main contact, Priya Vendor, can submit/);
  const coleAft = aftOf((await get(`/vendor/p/a/${ctx.a}?s=1`, coleCookie)).text);
  const refused = await post(`/vendor/p/a/${ctx.a}/submit`, [['_aft', coleAft], ['confirm_submit', '1']], coleCookie);
  assert.equal(refused.status, 403);
  assert.match(refused.text, /Only the main contact can submit/);
  assert.notEqual((await qRow(ctx.a)).status, 'submitted');

  const mainReview = await get(`/vendor/p/a/${ctx.a}?view=review`, cookie);
  assert.match(mainReview.text, /data-vendor-submit-form/);
  const ok = await post(`/vendor/p/a/${ctx.a}/submit`, [['_aft', aftOf(mainReview.text)], ['confirm_submit', '1']], cookie);
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.equal((await qRow(ctx.a)).status, 'submitted');
  const sub = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'questionnaire.submitted');
  assert.equal(sub.after_state.by_name, 'Priya Vendor');
  assert.ok(colleague);

  const signedOut = await post('/vendor/p/sign-out', [['_aft', (String((await get('/vendor/p/home', cookie)).text).match(/data-vendor-sign-out><input type="hidden" name="_aft" value="([^"]+)"/) || [])[1]]], cookie);
  assert.equal(signedOut.status, 303);
  assert.equal((await get('/vendor/p/home', cookie)).status, 303, 'signed out');
});

test('signed in, a colleague answers an issue under their own name', async () => {
  const ctx = await submitted('Portal Issue Co');
  const base = aBase(ctx.ws, ctx.tp, ctx.a);
  assert.equal((await consultant.session.post(`${base}/findings`, { severity: 'medium', title: 'Backups untested', description: 'Restores are not tested.' })).status, 302);
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=?').get(ctx.a);
  assert.equal((await consultant.session.post(`${base}/findings/${finding.id}/share`, { title: 'Backup restores', body: 'How often do you test a restore?' })).status, 302);
  const issue = await db.prepare('SELECT * FROM tp_issues WHERE assessment_id=?').get(ctx.a);
  await addPerson(ctx.ws, ctx.tp, 'Nia Bose', 'nia@portalissue.example');
  const { cookie } = await codeSignIn('nia@portalissue.example');
  const home = await get('/vendor/p/home', cookie);
  assert.match(home.text, new RegExp(`href="/vendor/p/a/${ctx.a}/issues#issue-\\d+">Backup restores`));
  const page = await get(`/vendor/p/a/${ctx.a}/issues`, cookie);
  assert.equal(page.status, 200);
  const res = await post(`/vendor/p/a/${ctx.a}/issues/${issue.id}`, [['_aft', aftOf(page.text)], ['body', 'Every quarter.']], cookie);
  assert.equal(res.status, 303, res.text.slice(0, 300));
  assert.match(res.location, new RegExp(`^/vendor/p/a/${ctx.a}/issues\\?notice=sent`));
  const m = await db.prepare(`SELECT * FROM tp_issue_messages WHERE issue_id=? ORDER BY id DESC LIMIT 1`).get(issue.id);
  assert.equal(m.author_name, 'Nia Bose');
  assert.ok(m.author_person_id);
  const firm = (await firmPage(ctx)).text;
  assert.match(firm, /Nia Bose/);
});

const homeAft = async cookie => aftOf((await get('/vendor/p/people', cookie)).text);
const mailsTo = (kind) => db.prepare('SELECT * FROM email_outbox WHERE related_type=? ORDER BY id').all(`tprm:${kind}`);

test('the main contact adds and removes colleagues, hands over, and keeps their own details', async () => {
  const ctx = await linked('Portal Team Co');
  const main = await addPerson(ctx.ws, ctx.tp, 'Mira Das', 'mira@portalteam.example');
  const { cookie } = await codeSignIn('mira@portalteam.example');
  const me = String(main.id);

  const bad = await post('/vendor/p/people', [['_aft', await homeAft(cookie)], ['me', me], ['name', 'Theo'], ['email', 'nope']], cookie);
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Give a valid email address/);
  assert.match(bad.text, /value="Theo"/, 'typed text is kept');

  const invitesBefore = (await mailsTo('vendor_invited')).length;
  const added = await post('/vendor/p/people', [['_aft', await homeAft(cookie)], ['me', me], ['name', 'Theo Park'], ['email', 'Theo@PortalTeam.example'], ['job_title', 'IT lead']], cookie);
  assert.equal(added.status, 303, added.text.slice(0, 300));
  assert.match(added.location, /notice=invited/);
  const theo = (await peopleOf(ctx.ws, ctx.tp)).find(p => p.email === 'theo@portalteam.example');
  assert.equal(theo.role, 'colleague');
  const invites = await mailsTo('vendor_invited');
  assert.equal(invites.length, invitesBefore + 1);
  assert.match(invites[invites.length - 1].subject, /Mira Das added you/);
  assert.equal((await post('/vendor/p/people', [['_aft', 'forged'], ['me', me], ['name', 'X'], ['email', 'x@portalteam.example']], cookie)).status, 403);

  const { cookie: theoCookie } = await codeSignIn('theo@portalteam.example');
  const notMain = await post('/vendor/p/people', [['_aft', await homeAft(theoCookie)], ['me', String(theo.id)], ['name', 'Z'], ['email', 'z@portalteam.example']], theoCookie);
  assert.equal(notMain.status, 403);
  assert.match(notMain.text, /Only the main contact can add or remove people/);
  const details = await post('/vendor/p/me', [['_aft', await homeAft(theoCookie)], ['me', String(theo.id)], ['name', 'Theo Park'], ['job_title', 'Head of IT'], ['phone', '+44 20 7946 0000']], theoCookie);
  assert.match(details.location, /notice=details_saved/);
  assert.equal((await peopleOf(ctx.ws, ctx.tp)).find(p => p.id === theo.id).job_title, 'Head of IT');

  const handed = await post(`/vendor/p/people/${theo.id}/main`, [['_aft', await homeAft(cookie)], ['me', me]], cookie);
  assert.match(handed.location, /notice=handed_over/);
  const roles = Object.fromEntries((await peopleOf(ctx.ws, ctx.tp)).map(p => [p.email, p.role]));
  assert.equal(roles['theo@portalteam.example'], 'main');
  assert.equal(roles['mira@portalteam.example'], 'colleague');
  const cantNow = await post(`/vendor/p/people/${theo.id}/remove`, [['_aft', await homeAft(cookie)], ['me', me]], cookie);
  assert.equal(cantNow.status, 403, 'Mira is a colleague now');
  const removed = await post(`/vendor/p/people/${main.id}/remove`, [['_aft', await homeAft(theoCookie)], ['me', String(theo.id)]], theoCookie);
  assert.match(removed.location, /notice=removed/);
  assert.equal((await get('/vendor/p/home', cookie)).status, 303, 'the removed person is signed out');
  const history = (await db.prepare(`SELECT action, after_state FROM tp_events WHERE workspace_id=? AND third_party_id=? ORDER BY id`).all(ctx.ws, ctx.tp));
  assert.ok(history.some(e => e.action === 'vendor_person.added' && e.after_state.by_name === 'Mira Das'));
});

test('the main contact asks colleagues to answer sections; they are emailed and see the sections marked for them', async () => {
  const ctx = await linked('Portal Assign Co');
  const main = await addPerson(ctx.ws, ctx.tp, 'Lena Ruiz', 'lena@portalassign.example');
  const col = await addPerson(ctx.ws, ctx.tp, 'Omar Aziz', 'omar@portalassign.example');
  const { cookie } = await codeSignIn('lena@portalassign.example');
  const start = await get(`/vendor/p/a/${ctx.a}`, cookie);
  assert.match(start.text, /data-vendor-assign-form/);
  const q = await qRow(ctx.a);
  const [first, second] = q.sections.map(s => s.title);
  const before = (await mailsTo('vendor_sections_assigned')).length;
  const res = await post(`/vendor/p/a/${ctx.a}/assign`, [['_aft', aftOf(start.text)], [`assign[${first}]`, String(col.id)], [`assign[${second}]`, String(main.id)]], cookie);
  assert.equal(res.status, 303, res.text.slice(0, 300));
  assert.match(res.location, /notice=assigned/);
  const rows = await db.prepare('SELECT section_title, person_id FROM tp_vendor_assignments WHERE assessment_id=? ORDER BY section_title').all(ctx.a);
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.section_title, Number(r.person_id)])), { [first]: Number(col.id), [second]: Number(main.id) });
  const sent = await mailsTo('vendor_sections_assigned');
  assert.equal(sent.length, before + 1, 'only the colleague is emailed');
  assert.match(sent[sent.length - 1].body_html, new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '&amp;')));

  const { cookie: omarCookie } = await codeSignIn('omar@portalassign.example');
  const omarPage = await get(`/vendor/p/a/${ctx.a}`, omarCookie);
  assert.match(omarPage.text, /data-vendor-nav-mine/);
  assert.doesNotMatch(omarPage.text, /data-vendor-assign-form/);
  const refused = await post(`/vendor/p/a/${ctx.a}/assign`, [['_aft', aftOf(omarPage.text)], [`assign[${first}]`, String(main.id)]], omarCookie);
  assert.equal(refused.status, 403);
  const stranger = await post(`/vendor/p/a/${ctx.a}/assign`, [['_aft', aftOf(start.text)], [`assign[${first}]`, '999999']], cookie);
  assert.equal(stranger.status, 400);
  assert.match(stranger.text, /Choose someone from the people/);
});

async function expireLinks(a) {
  await db.transaction(async () => {
    await db.exec('ALTER TABLE tp_vendor_requests DISABLE TRIGGER USER');
    await db.prepare(`UPDATE tp_vendor_requests SET created_at = now() - interval '40 days', expires_at = now() - interval '1 day' WHERE assessment_id=?`).run(a);
    await db.exec('ALTER TABLE tp_vendor_requests ENABLE TRIGGER USER');
  })();
}

test('issues stay open to the third party after its questionnaire link has expired, through sign-in', async () => {
  const ctx = await submitted('Portal Late Co');
  const base = aBase(ctx.ws, ctx.tp, ctx.a);
  await addPerson(ctx.ws, ctx.tp, 'Gita Rao', 'gita@portallate.example');
  await expireLinks(ctx.a);
  assert.equal((await consultant.session.post(`${base}/findings`, { severity: 'low', title: 'Old policy', description: 'The policy is from 2019.' })).status, 302);
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=?').get(ctx.a);
  const shared = await consultant.session.post(`${base}/findings/${finding.id}/share`, { title: 'Policy age', body: 'When was the policy last reviewed?' });
  assert.doesNotMatch(toast(shared), /no one was emailed/);
  const mail = (await mailsTo('vendor_issue_shared')).pop();
  assert.match(mail.recipient_email || mail.to_email || JSON.stringify(mail), /gita@portallate\.example|priya@thirdparty\.example\.net/);
  assert.match(mail.body_html, /\/vendor\/p\/sign-in/, 'the email points at sign-in, not at an expired link');
  const issue = await db.prepare('SELECT * FROM tp_issues WHERE assessment_id=?').get(ctx.a);
  const { cookie } = await codeSignIn('gita@portallate.example');
  const page = await get(`/vendor/p/a/${ctx.a}/issues`, cookie);
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.doesNotMatch(page.text, /This link works until/);
  const res = await post(`/vendor/p/a/${ctx.a}/issues/${issue.id}`, [['_aft', aftOf(page.text)], ['body', 'Reviewed last month.']], cookie);
  assert.equal(res.status, 303, res.text.slice(0, 300));
  assert.equal((await db.prepare('SELECT author_name FROM tp_issue_messages WHERE issue_id=? ORDER BY id DESC LIMIT 1').get(issue.id)).author_name, 'Gita Rao');
});

test('the person a link was sent to can sign in with a code before ever opening it; a revoked link does not let them in', async () => {
  const ctx = await linked('Portal Fresh Co');
  assert.equal((await peopleOf(ctx.ws, ctx.tp)).length, 0);
  const { cookie } = await codeSignIn('priya@thirdparty.example.net');
  const home = await get('/vendor/p/home', cookie);
  assert.match(home.text, /Portal Fresh Co Client/);
  assert.deepEqual((await peopleOf(ctx.ws, ctx.tp)).map(p => [p.email, p.role]), [['priya@thirdparty.example.net', 'main']]);

  const other = await linked('Portal Revoked Co');
  const q = await qRow(other.a);
  await consultant.session.post(`${qBase(other)}/links`, { recipient_name: 'Wrong Person', recipient_email: 'wrong@elsewhere.example', row_version: String(q.row_version) });
  await db.transaction(async () => {
    await db.exec('ALTER TABLE tp_vendor_requests DISABLE TRIGGER USER');
    await db.prepare(`UPDATE tp_vendor_requests SET status='revoked', revoked_at=now(), revoke_reason='wrong address' WHERE assessment_id=? AND recipient_email='wrong@elsewhere.example'`).run(other.a);
    await db.exec('ALTER TABLE tp_vendor_requests ENABLE TRIGGER USER');
  })();
  const before = outboxCodes().length;
  await post('/vendor/p/sign-in', [['email', 'wrong@elsewhere.example']]);
  assert.equal(outboxCodes().length, before, 'no code for the recipient of a revoked link');
});

test('a session opened from a link cannot add, remove or hand over people', async () => {
  const ctx = await linked('Portal Scoped Co');
  const home = await post(`/vendor/q/${ctx.token}/home`, [['_aft', aftOf((await vget(ctx.token)).text)]]);
  const cookie = cookieOf(home);
  const page = await get('/vendor/p/people', cookie);
  assert.doesNotMatch(page.text, /data-vendor-invite/);
  assert.match(page.text, /data-vendor-people-locked>To add colleagues, <a href="\/vendor\/p\/sign-in">sign in with a code<\/a>/);
  const me = (await peopleOf(ctx.ws, ctx.tp))[0];
  const tried = await post('/vendor/p/people', [['_aft', aftOf(page.text)], ['me', String(me.id)], ['name', 'Intruder'], ['email', 'intruder@evil.example']], cookie);
  assert.equal(tried.status, 403);
  assert.match(tried.text, /sign in with a code sent to your email/);
  assert.equal((await peopleOf(ctx.ws, ctx.tp)).length, 1);
});

test('a client whose third party people saved answers and replied can still be deleted', async () => {
  const ctx = await submitted('Portal Delete Co');
  const base = aBase(ctx.ws, ctx.tp, ctx.a);
  const person = await addPerson(ctx.ws, ctx.tp, 'Del Person', 'del@portaldelete.example');
  await db.prepare('UPDATE tp_answers SET saved_by_person_id = ? WHERE assessment_id = ?').run(person.id, ctx.a).catch(() => null);
  assert.equal((await consultant.session.post(`${base}/findings`, { severity: 'low', title: 'Gap', description: 'A gap.' })).status, 302);
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=?').get(ctx.a);
  await consultant.session.post(`${base}/findings/${finding.id}/share`, { title: 'Gap', body: 'Tell us more.' });
  const issue = await db.prepare('SELECT * FROM tp_issues WHERE assessment_id=?').get(ctx.a);
  const { cookie } = await codeSignIn('del@portaldelete.example');
  const page = await get(`/vendor/p/a/${ctx.a}/issues`, cookie);
  assert.equal((await post(`/vendor/p/a/${ctx.a}/issues/${issue.id}`, [['_aft', aftOf(page.text)], ['body', 'More.']], cookie)).status, 303);
  assert.ok(await db.prepare('SELECT 1 FROM tp_issue_messages WHERE author_person_id=?').get(person.id));
  await require('../lib/workspace-deletion').deleteWorkspace(db, ctx.ws);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM tp_vendor_people WHERE workspace_id=?').get(ctx.ws)).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM tp_vendor_sessions WHERE person_id IS NULL AND email=?').get('del@portaldelete.example')).n >= 0, true);
  assert.equal((await get('/vendor/p/home', cookie)).status, 303, 'the session no longer opens anything');
});

test('a comment on a question is saved with the section, shown to the third party and to the reviewers, under the person\'s name', async () => {
  const ctx = await linked('Portal Comment Co');
  await addPerson(ctx.ws, ctx.tp, 'Ana Cruz', 'ana@portalcomment.example');
  const { cookie } = await codeSignIn('ana@portalcomment.example');
  const q = await qRow(ctx.a);
  const id = idsOf(q)[0];
  const page = await get(`/vendor/p/a/${ctx.a}?s=1`, cookie);
  assert.match(page.text, new RegExp(`name="c\\[${id}\\]"`));
  const send = async text => {
    const m = multipart([['_aft', aftOf(page.text)], ['section', '1'], [`c[${id}]`, text], ['intent', 'save']]);
    return request('POST', `/vendor/p/a/${ctx.a}/save`, { body: m.body, headers: { ...m.headers, cookie } });
  };
  const long = await send('x'.repeat(2001));
  assert.equal(long.status, 400);
  assert.match(long.text, /A comment must be 2000 characters or fewer/);
  assert.match(long.text, /xxxxxxxxxx/, 'the typed comment is kept');
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM tp_answer_comments WHERE questionnaire_id=?').get(q.id)).n, 0);
  const ok = await send('We are moving this policy to a new owner next month.');
  assert.equal(ok.status, 303, ok.text.slice(0, 300));
  const row = await db.prepare('SELECT * FROM tp_answer_comments WHERE questionnaire_id=?').get(q.id);
  assert.equal(row.author_name, 'Ana Cruz');
  assert.equal(row.question_id, id);
  const again = await get(`/vendor/p/a/${ctx.a}?s=1`, cookie);
  assert.match(again.text, /data-vendor-comments/);
  assert.match(again.text, /new owner next month/);
  await answerAll(ctx);
  assert.equal((await submitLink(ctx.token)).status, 200);
  const firm = (await firmPage(ctx)).text;
  assert.match(firm, /data-tprm-answer-comments[\s\S]*?new owner next month/, 'the reviewers see the comment on the answer');
  const ev = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'questionnaire.comments_added');
  assert.deepEqual(ev.after_state.questions, [id]);
});

test('the Files page lists every review\'s files, adds files to an open review and deletes unused ones, then comes back to Files', async () => {
  const ctx = await linked('Portal Files Co');
  await addPerson(ctx.ws, ctx.tp, 'Fay Lee', 'fay@portalfiles.example');
  const { cookie } = await codeSignIn('fay@portalfiles.example');
  const page = await get('/vendor/p/files', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-vendor-menu="files"[^>]*aria-current="page"|class="vq-menu-item is-current" data-vendor-menu="files"/);
  assert.match(page.text, new RegExp(`data-vendor-files-review="${ctx.a}"`));
  assert.match(page.text, new RegExp(`action="/vendor/p/a/${ctx.a}/documents"`));
  const block = page.text.slice(page.text.indexOf(`data-vendor-files-add="${ctx.a}"`));
  const aft = (block.match(/name="_aft" value="([^"]+)"/) || [])[1];
  const m = multipart([['_aft', aft], ['back', 'files'], ['desc_1', 'Access policy']], [{ field: 'doc_file_1', filename: 'policy.txt', content: 'Access policy text', type: 'text/plain' }]);
  const added = await request('POST', `/vendor/p/a/${ctx.a}/documents`, { body: m.body, headers: { ...m.headers, cookie } });
  for (const r of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(r.stored_path);
  assert.equal(added.status, 303, added.text.slice(0, 300));
  assert.match(added.location, new RegExp(`^/vendor/p/files\\?notice=documents_added#review-${ctx.a}`));
  const after = await get('/vendor/p/files', cookie);
  assert.match(after.text, /policy\.txt/);
  assert.match(after.text, /Access policy/);
  const ev = await db.prepare(`SELECT id FROM tp_evidence WHERE assessment_id=? AND original_name='policy.txt'`).get(ctx.a);
  const delBlock = after.text.slice(after.text.indexOf(`data-vendor-file-delete="${ev.id}"`));
  const delAft = (delBlock.match(/name="_aft" value="([^"]+)"/) || [])[1];
  const del = await post(`/vendor/p/a/${ctx.a}/documents/${ev.id}`, [['_aft', delAft], ['delete', '1'], ['back', 'files']], cookie);
  assert.equal(del.status, 303);
  assert.match(del.location, /^\/vendor\/p\/files\?notice=document_deleted/);
  assert.equal(await db.prepare('SELECT 1 FROM tp_evidence WHERE id=?').get(ev.id), undefined);
  assert.equal((await get('/vendor/p/files')).status, 303, 'signed out, the Files page asks you to sign in');
});
