'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-closed-screens-outbox-')), 'outbox.log');

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
  consultant = await makeUser('cls-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('cls-senior@test.local', { role: 'senior_consultant' });
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
  assert.equal(res.status, 303, res.text.slice(0, 300));
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

const mailsTo = (kind) => db.prepare('SELECT * FROM email_outbox WHERE related_type=? ORDER BY id').all(`tprm:${kind}`);
const lastMail = async kind => (await mailsTo(kind)).pop();

async function linkedTo(name, email, recipientName = 'Dan Roy') {
  const ws = await tprmClient(`${name} Client`);
  const tp = await addThirdParty(ws, name);
  const ctx = { ws, tp, a: await startAssessment(ws, tp, LOW) };
  assert.equal((await consultant.session.post(qBase(ctx), {})).status, 302);
  const link = await createLink(ctx, { recipient_name: recipientName, recipient_email: email });
  assert.ok(link.token, 'a link was shown');
  return { ...ctx, token: link.token, email };
}

async function danLeaves(ctx, domain) {
  const dan = await addPerson(ctx.ws, ctx.tp, 'Dan Roy', ctx.email);
  const eve = await addPerson(ctx.ws, ctx.tp, 'Eve Lal', `eve@${domain}`);
  assert.match(toast(await consultant.session.post(`${tpBase(ctx.ws, ctx.tp)}/people/${eve.id}/main`, {})), /Eve Lal is now the main contact/);
  assert.match(toast(await consultant.session.post(`${tpBase(ctx.ws, ctx.tp)}/people/${dan.id}/remove`, {})), /Dan Roy removed/);
  return { dan, eve };
}

const outRow = (text, a) => {
  const at = text.indexOf(`data-tprm-out-row="${a}"`);
  assert.ok(at >= 0, 'the questionnaire is listed');
  return text.slice(at, text.indexOf('</tr>', at));
};
const registerRow = (text, tp) => {
  const at = text.indexOf(`/third-parties/${tp}/assessments/`);
  assert.ok(at >= 0, 'the third party is in the register with its open review');
  return text.slice(at, text.indexOf('</td>', at));
};
const linkRow = (text, id) => {
  const at = text.indexOf(`data-tprm-link-row="${id}"`);
  assert.ok(at >= 0, 'the link is listed');
  return text.slice(at, text.indexOf('</tr>', at));
};

test('when the link\'s recipient was removed, the register and Questionnaires out say the work waits on the main contact by sign-in, not that the link works', async () => {
  const ctx = await linkedTo('Waiting Moved Co', 'dan@waitingmoved.example');
  const before = await consultant.session.get(`/tprm/clients/${ctx.ws}`);
  assert.match(registerRow(before.text, ctx.tp), /Waiting on: third party, Dan Roy/);
  await danLeaves(ctx, 'waitingmoved.example');

  const reg = registerRow((await consultant.session.get(`/tprm/clients/${ctx.ws}`)).text, ctx.tp);
  assert.match(reg, /Waiting on: third party, Eve Lal \(main contact, by sign-in\)/);
  assert.doesNotMatch(reg, /Dan Roy/);
  const pipe = await consultant.session.get('/tprm');
  assert.equal(pipe.status, 200);
  assert.match(pipe.text, /Eve Lal \(main contact, by sign-in\)/);

  const row = outRow((await consultant.session.get('/tprm/questionnaires')).text, ctx.a);
  assert.match(row, /data-tprm-out-state="link_closed"/);
  assert.match(row, /Link no longer opens/);
  assert.match(row, /It no longer opens because Dan Roy is no longer one of the people at this third party\./);
  assert.match(row, /data-tprm-out-sign-in-only>By sign-in only/);
  assert.doesNotMatch(row, /days? left/, 'it does not count down a link that no longer opens');
  assert.match(row, /data-tprm-out-remind-to>Reminders go to Eve Lal, the main contact/);
  assert.match(row, /data-tprm-out-remind/);
  assert.doesNotMatch(row, /data-tprm-out-reopen/, 'no new link goes to the removed person');
  const filtered = await consultant.session.get('/tprm/questionnaires?show=link_closed');
  assert.match(filtered.text, /<option value="link_closed" selected>Link no longer opens \((\d+)\)<\/option>/, 'the state has its own filter and count');
  assert.ok(outRow(filtered.text, ctx.a));
  assert.doesNotMatch((await consultant.session.get('/tprm/questionnaires?show=not_opened')).text, new RegExp(`data-tprm-out-row="${ctx.a}"`));
});

test('an exited third party\'s questionnaire is shown as not open to anyone, with no reminder offered', async () => {
  const ctx = await linkedTo('Waiting Exit Co', 'dan@waitingexit.example');
  await addPerson(ctx.ws, ctx.tp, 'Dan Roy', ctx.email);
  await db.prepare(`UPDATE tp_third_parties SET status = 'exited', exit_date = '2026-11-27', exit_reason = 'Contract ended.' WHERE id = ?`).run(ctx.tp);
  const row = outRow((await consultant.session.get('/tprm/questionnaires')).text, ctx.a);
  assert.match(row, /data-tprm-out-state="link_closed"/);
  assert.match(row, /It no longer opens because the third party has exited\./);
  assert.match(row, /No one can open it/);
  assert.doesNotMatch(row, /data-tprm-out-remind/);
  const q = (await firmPage(ctx)).text;
  assert.doesNotMatch(q, /data-tprm-remind-form/, 'no reminder is offered for an exited third party');
});

test('the questionnaire step offers the reminder for a link that no longer opens, naming the main contact it goes to; the bulk reminder names each person', async () => {
  const ctx = await linkedTo('Remind Moved Co', 'dan@remindmoved.example');
  await danLeaves(ctx, 'remindmoved.example');
  const page = (await firmPage(ctx)).text;
  assert.match(page, /data-tprm-remind-form/);
  assert.match(page, /data-tprm-remind-to="main">The link sent to Dan Roy no longer opens, so a reminder goes to Eve Lal, the main contact, at eve@remindmoved\.example, with a button to sign in\./);
  const sent = await consultant.session.post(`${qBase(ctx)}/remind`, {});
  assert.match(toast(sent), /Reminder sent to Eve Lal at eve@remindmoved\.example/);
  assert.match(JSON.stringify(await lastMail('vendor_reminder_7')), /eve@remindmoved\.example/);

  const other = await linkedTo('Remind Bulk Co', 'ravi@remindbulk.example', 'Ravi Shah');
  await addPerson(other.ws, other.tp, 'Ravi Shah', other.email);
  const live = (await firmPage(other)).text;
  assert.match(live, /data-tprm-remind-to="recipient">A reminder goes to Ravi Shah at ravi@remindbulk\.example\./);
  const bulk = await consultant.session.post(`/tprm/clients/${other.ws}/third-parties/bulk-remind`, { ids: String(other.tp), _tp_confirmed: '1' });
  assert.match(toast(bulk), /1 reminder sent: Remind Bulk Co to Ravi Shah/);
  assert.doesNotMatch(String(bulk.location), /remindbulk\.example|%40/, 'no email address travels in the redirect');
  const email = require('../lib/email');
  const real = email.sendEmail;
  email.sendEmail = async () => ({ ok: false, error: 'mailbox unavailable' });
  const failing = await linkedTo('Remind Fail Co', 'ravi@remindfail.example', 'Ravi Shah');
  await addPerson(failing.ws, failing.tp, 'Ravi Shah', failing.email);
  let failed;
  try {
    failed = await consultant.session.post(`/tprm/clients/${failing.ws}/third-parties/bulk-remind`, { ids: String(failing.tp), _tp_confirmed: '1' });
  } finally { email.sendEmail = real; }
  assert.match(toast(failed), /Remind Fail Co: the email to Ravi Shah could not be sent \(mailbox unavailable\)/);
  assert.doesNotMatch(String(failed.location), /remindfail\.example|%40/, 'nor when it fails');
});

test('the link form is filled in with the main contact', async () => {
  const ws = await tprmClient('Prefill Co Client');
  const tp = await addThirdParty(ws, 'Prefill Co');
  const ctx = { ws, tp, a: await startAssessment(ws, tp, LOW) };
  assert.equal((await consultant.session.post(qBase(ctx), {})).status, 302);
  const empty = (await firmPage(ctx)).text;
  assert.match(empty, /id="link-name" name="recipient_name"[^>]*value=""/);
  await addPerson(ws, tp, 'Mira Das', 'mira@prefill.example');
  const page = (await firmPage(ctx)).text;
  assert.match(page, /id="link-name" name="recipient_name"[^>]*value="Mira Das"/);
  assert.match(page, /id="link-email" type="email" name="recipient_email"[^>]*value="mira@prefill\.example"/);
});

test('after an email change the link panel gives that reason, and the edit form warns before the change that the open link will stop opening', async () => {
  const ctx = await linkedTo('Email Reason Co', 'raj@emailreason.example', 'Raj Iyer');
  const raj = await addPerson(ctx.ws, ctx.tp, 'Raj Iyer', ctx.email);
  const other = await addPerson(ctx.ws, ctx.tp, 'Asha Pal', 'asha@emailreason.example');
  const people = (await consultant.session.get(`${tpBase(ctx.ws, ctx.tp)}?tab=people`)).text;
  assert.match(people, new RegExp(`data-tprm-person-open-link="${raj.id}">A link sent to raj@emailreason\\.example is open\\. If you change the email, that link stops opening\\.`));
  assert.doesNotMatch(people, new RegExp(`data-tprm-person-open-link="${other.id}"`), 'no warning for someone without an open link');

  const row = await db.prepare('SELECT row_version FROM tp_vendor_people WHERE id=?').get(raj.id);
  const moved = await consultant.session.post(`${tpBase(ctx.ws, ctx.tp)}/people/${raj.id}`, { name: 'Raj K. Iyer', email: 'raj.iyer@emailreason.example', job_title: '', phone: '', row_version: String(row.row_version) });
  assert.match(toast(moved), /Links sent to their old address no longer open/);
  const link = (await linksOf(ctx.a))[0];
  const panel = linkRow((await firmPage(ctx)).text, link.id);
  assert.match(panel, /data-tprm-link-status="closed"/);
  assert.match(panel, /It no longer opens because the email address it was sent to was changed\./);
  assert.doesNotMatch(panel, /is no longer one of the people at this third party/);
  const after = (await consultant.session.get(`${tpBase(ctx.ws, ctx.tp)}?tab=people`)).text;
  assert.doesNotMatch(after, new RegExp(`data-tprm-person-open-link="${raj.id}"`), 'the new address has no open link');
  const row2 = outRow((await consultant.session.get('/tprm/questionnaires')).text, ctx.a);
  assert.match(row2, /It no longer opens because the email address it was sent to was changed\./);
});

test('the link table keeps the status on its own and the revoke reason behind a Revoke button, so the columns fit', async () => {
  const ctx = await linkedTo('Link Table Co', 'dan@linktable.example');
  await danLeaves(ctx, 'linktable.example');
  const link = (await linksOf(ctx.a))[0];
  const row = linkRow((await firmPage(ctx)).text, link.id);
  const cells = row.split('<td').slice(1);
  assert.equal(cells.length, 4, 'recipient, created, status and actions: the expiry sits with the creation date');
  assert.match(cells[0], /data-tprm-link-closed>It no longer opens because Dan Roy/, 'the reason sits with the recipient');
  assert.match(cells[1], /data-tprm-link-valid-until>Valid until /);
  assert.match(cells[2], /^ class="tprm-nowrap">\s*<span class="tp-status[^"]*">No longer opens<\/span>\s*<\/td>/, 'the status cell holds only the status');
  assert.match(cells[3], /^ class="tprm-right">/, 'the actions cell can wrap');
  assert.match(cells[3], /<details class="tpu-inline" data-tprm-revoke-panel="\d+">\s*<summary class="btn btn-secondary btn-xs">Revoke<\/summary>/);
  assert.match(cells[3], /data-tprm-revoke-form/);
});

test('the sign-in page does not promise that an emailed link works, and tells a removed person or one at an exited third party that their access ended', async () => {
  const page = await get('/vendor/p/sign-in');
  assert.doesNotMatch(page.text, /it still works/);
  assert.match(page.text, /data-vendor-link-hint>If you have a questionnaire link from an email, you can also open it\./);

  const ctx = await linkedTo('Access Ended Co', 'dan@accessended.example');
  const { dan } = await danLeaves(ctx, 'accessended.example');
  await addPerson(ctx.ws, ctx.tp, 'Dan Roy', ctx.email);
  const signedIn = await codeSignIn(ctx.email);
  assert.equal((await get('/vendor/p/home', signedIn.cookie)).status, 200);
  const again = (await peopleOf(ctx.ws, ctx.tp)).find(p => p.email === ctx.email);
  assert.notEqual(Number(again.id), Number(dan.id));
  assert.match(toast(await consultant.session.post(`${tpBase(ctx.ws, ctx.tp)}/people/${again.id}/remove`, {})), /Dan Roy removed/);
  const home = await get('/vendor/p/home', signedIn.cookie);
  assert.equal(home.status, 303);
  const ended = await get(home.location, signedIn.cookie);
  assert.equal(ended.status, 200);
  assert.match(ended.text, /data-vendor-notice>Your access to Access Ended Co has ended, so you were signed out\./);
  assert.doesNotMatch(ended.text, /data-vendor-link-hint/, 'no hint that a link still opens');
  assert.match(String(ended.headers['set-cookie'] || ''), /tpv_sid=;/);

  const exit = await linkedTo('Access Exit Co', 'omar@accessexit.example', 'Omar Sen');
  await addPerson(exit.ws, exit.tp, 'Omar Sen', exit.email);
  const omar = await codeSignIn(exit.email);
  await db.prepare(`UPDATE tp_third_parties SET status = 'exited', exit_date = '2026-11-27', exit_reason = 'Contract ended.' WHERE id = ?`).run(exit.tp);
  const exitHome = await get('/vendor/p/home', omar.cookie);
  assert.equal(exitHome.status, 303);
  assert.match((await get(exitHome.location, omar.cookie)).text, /Your access to Access Exit Co has ended/);

  const moved = await linkedTo('Access Moved Co', 'lee@accessmoved.example', 'Lee Ho');
  const lee = await addPerson(moved.ws, moved.tp, 'Lee Ho', moved.email);
  const leeIn = await codeSignIn(moved.email);
  const row = await db.prepare('SELECT row_version FROM tp_vendor_people WHERE id=?').get(lee.id);
  await consultant.session.post(`${tpBase(moved.ws, moved.tp)}/people/${lee.id}`, { name: 'Lee Ho', email: 'lee.ho@accessmoved.example', job_title: '', phone: '', row_version: String(row.row_version) });
  const movedHome = await get('/vendor/p/home', leeIn.cookie);
  assert.equal(movedHome.status, 303);
  const movedPage = await get(movedHome.location, leeIn.cookie);
  assert.doesNotMatch(movedPage.text, /has ended, so you were signed out/, 'an email change is not called the end of access');
  assert.match(movedPage.text, /Your session ended\. Sign in again to continue\./);
});
