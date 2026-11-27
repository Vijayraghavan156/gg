'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-msg-outbox-')), 'outbox.log');

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
const PASSWORD = 'tprm-messages-tests-password-1234';
const DAY = 24 * 3600 * 1000;
const LOW = {
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no',
};
const VENDOR = 'priya@thirdparty.example.net';

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let messages;
let email;
let vendorRoute;
const sessions = [];
const createdPaths = new Set();

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  messages = require('../lib/tprm/messages');
  email = require('../lib/email');
  vendorRoute = require('../routes/tprm-vendor');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('msg-consultant@test.local', { role: 'consultant', name: 'Casey Consultant' });
  senior = await makeUser('msg-senior@test.local', { role: 'senior_consultant', name: 'Sam Senior' });
  for (const u of [consultant, senior]) u.session = await signIn(u.email, u.password);
});

test.beforeEach(() => {
  for (const l of [vendorRoute.limiter, vendorRoute.postLimiter, vendorRoute.conditionsLimiter, vendorRoute.conditionsPostLimiter]) if (l) l.reset();
});

test.after(async () => {
  for (const t of ['tp_evidence', 'tp_condition_proof_files']) for (const p of await db.prepare(`SELECT stored_path FROM ${t}`).all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  for (const s of sessions) await s.close();
  for (const u of [consultant, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

async function makeUser(emailAddr, { type = 'firm', role = 'consultant', workspaceId = null, memberRole = null, name = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(emailAddr, bcrypt.hashSync(PASSWORD, 4), name || emailAddr, type, type === 'firm' ? firmId : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email: emailAddr, password: PASSWORD, firm_role: type === 'firm' ? role : null };
}

async function signIn(emailAddr, password) {
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email: emailAddr, password, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${emailAddr} signs in`);
  await session.get('/dashboard');
  return session;
}

async function sessionFor(user) {
  if (!user.session) { user.session = await signIn(user.email, user.password); sessions.push(user.session); }
  return user.session;
}

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`msg-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner', name: `Owner of ${name}` });
  return { id, owner };
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const qBase = ctx => `${aBase(ctx.ws, ctx.tp, ctx.a)}/questionnaire`;
const rBase = (ws, tp, a) => `${aBase(ws, tp, a)}/recommendations`;
const recPage = (ws, rid) => `/workspaces/${ws}/client-portal/third-party-risk/recommendations/${rid}`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const qRow = async a => db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(a);
const recRow = async id => db.prepare('SELECT * FROM tp_recommendations WHERE id=?').get(id);
const vlinks = async a => db.prepare('SELECT * FROM tp_vendor_requests WHERE assessment_id=? ORDER BY id').all(a);
const mails = async (ws, kind) => db.prepare(`SELECT * FROM email_outbox WHERE workspace_id=? AND related_type=? ORDER BY id`).all(ws, kind);
const sent = async (ws, a) => db.prepare(`SELECT after_state FROM tp_events WHERE workspace_id=? AND chain_type='assessment' AND chain_id=?
  AND action='message.sent' ORDER BY chain_seq`).all(ws, a);

async function tokenNowhere(ws, token) {
  for (const table of ['email_outbox', 'tp_events']) {
    const found = await db.prepare(`SELECT COUNT(*)::int c FROM ${table} t WHERE workspace_id=? AND t::text LIKE ?`).get(ws, `%${token}%`);
    assert.equal(found.c, 0, `${table} never holds the token`);
  }
}

async function addThirdParty(ws, name, status = 'in_use') {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosted service' })).status, 302);
  return tp;
}

async function startAssessment(ws, tp) {
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302, toast(started));
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  return a;
}

async function createLink(ctx, body = {}) {
  const row = await qRow(ctx.a);
  const res = await consultant.session.post(`${qBase(ctx)}/links`, {
    recipient_name: 'Priya Vendor', recipient_email: VENDOR, row_version: String(row.row_version), ...body });
  const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
  return { res, token: url ? url.split('/vendor/q/')[1] : null };
}

async function linked(c, name, linkBody = {}) {
  const tp = await addThirdParty(c.id, name);
  const a = await startAssessment(c.id, tp);
  const ctx = { ws: c.id, tp, a, c };
  assert.equal((await consultant.session.post(qBase(ctx), {})).status, 302);
  const { token } = await createLink(ctx, linkBody);
  assert.ok(token, 'a link was shown');
  return { ...ctx, token };
}

function request(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = env.app.listen(0, '127.0.0.1', () => {
      const h = { ...headers };
      if (body != null && h['content-length'] == null) h['content-length'] = Buffer.byteLength(body);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: urlPath, headers: h }, res => {
        const chunks = [];
        res.on('data', ch => chunks.push(ch));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), location: res.headers.location || null }); });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}
const aftOf = text => (String(text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];
function multipart(fields, files = []) {
  const boundary = '----tprmmsg' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of fields) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  for (const f of files) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${f.field || 'files'}"; filename="${f.filename}"`, `Content-Type: ${f.type || 'text/plain'}`, '', f.content);
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
async function vpost(prefix, token, suffix, fields, files = []) {
  const aft = aftOf((await request('GET', `${prefix}${token}`)).text);
  const form = multipart([['_aft', aft], ...fields], files);
  return await request('POST', `${prefix}${token}${suffix}`, { body: form.body, headers: form.headers });
}

async function answerAndSubmit(ctx) {
  const q = await qRow(ctx.a);
  const answers = {};
  for (const id of q.sections.flatMap(s => s.ids)) answers[id] = completeAnswer(BANK_BY_ID.get(id), id, { ref: `Policy for ${id}`, date: '2026-01-15' });
  answers['AIS-01'] = { r: 'no', d: 'No AI is used to provide the service.' };
  const saved = await vpost('/vendor/q/', ctx.token, '/save', [...answerFormFields(answers, BANK_BY_ID), ['intent', 'save']]);
  assert.equal(saved.status, 303);
  const res = await vpost('/vendor/q/', ctx.token, '/submit', []);
  assert.equal(res.status, 303, res.text.slice(0, 200));
  assert.equal((await qRow(ctx.a)).status, 'submitted');
}

test('1. every template renders in plain words, and the reminders to a third party carry no link', () => {
  const d = { toName: 'Priya', firmName: 'Northbridge Advisory', clientName: 'Acme Bank', thirdPartyName: 'Lumen Print', contact: { name: 'Casey', email: 'casey@firm.example' },
    until: '22 Dec 2026', sentDay: '22 Nov 2026', total: 66, answered: 28, files: 3, submittedDay: '1 Dec 2026', questionId: 'GOV-01', body: 'Who approves the policy?',
    url: 'https://app.example/x', response: 'The board.', outcomeLabel: 'Onboard with conditions', recommendedLabel: 'Onboard', version: 2, deciderName: 'Anita',
    position: 1, conditionText: 'Encrypt the print servers', note: 'Done', issuedDay: '1 Dec 2026', dueDay: '31 Dec 2026', conditions: [{ text: 'Encrypt', due: '28 Feb 2027' }],
    issueTitle: 'Access reviews', issueBody: 'How is access reviewed?', proposedFix: 'Quarterly reviews', proposedDay: '31 Mar 2027', agreedFix: 'Quarterly reviews', agreedDay: '31 Mar 2027', code: '482913', minutes: 10, inviterName: 'Mira Das', sections: ['Access control'] };
  for (const kind of Object.keys(email.TPRM_TEMPLATES)) {
    const m = email.renderTprmEmail(kind, d);
    assert.ok(m.subject.length > 5, `${kind}: a subject`);
    const text = email.stripHtml(m.html);
    assert.doesNotMatch(`${m.subject} ${text}`, /undefined|null|NaN|—/, `${kind}: no placeholders and no em dash`);
    assert.ok(messages.KIND_LABELS[kind], `${kind}: a label for the history`);
    if (kind === 'vendor_overdue') assert.doesNotMatch(m.html, /href="https:\/\/app\.example/, `${kind}: no link once it has stopped working`);
    if (/^vendor_reminder/.test(kind)) {
      assert.match(m.html, /href="https:\/\/app\.example\/x"/, `${kind}: the same link when it is kept`);
      assert.doesNotMatch(email.renderTprmEmail(kind, { ...d, url: null }).html, /href="https:\/\/app\.example/, `${kind}: no link for an older link`);
    }
  }
  assert.match(email.renderTprmEmail('vendor_reminder_7', d).subject, /^Reminder: security questionnaire for Acme Bank, due 22 Dec 2026$/);
  assert.match(email.stripHtml(email.renderTprmEmail('vendor_reminder_7', d).html), /28 of 66 questions are answered so far/);
});

test('2. which reminder a link is due, and not for a link created with too little time left', () => {
  const now = new Date('2026-12-01T09:00:00Z');
  const link = (createdDaysAgo, expiresInHours) => ({ created_at: new Date(now - createdDaysAgo * DAY), expires_at: new Date(now.getTime() + expiresInHours * 3600 * 1000) });
  assert.equal(messages.vendorReminderKind(link(20, 6 * 24), now), 'vendor_reminder_7');
  assert.equal(messages.vendorReminderKind(link(20, 8 * 24), now), null);
  assert.equal(messages.vendorReminderKind(link(20, 12), now), 'vendor_reminder_1');
  assert.equal(messages.vendorReminderKind(link(1, 6 * 24), now), null, 'created less than 8 days before expiry: no 7-day reminder');
  assert.equal(messages.vendorReminderKind(link(0.5, 12), now), null, 'created the day before: no reminder');
  assert.equal(messages.vendorReminderKind(link(30, -24), now), 'vendor_overdue');
  assert.equal(messages.vendorReminderKind(link(30, -4 * 24), now), null, 'only for 3 days after it stopped working');
});

test('3. the questionnaire: reminders once each, the receipt and the consultant\'s notice on submission, nothing to a submitted or revoked link', async () => {
  const c = await tprmClient('Msg Questionnaire Client');
  const ctx = await linked(c, 'Remindable Hosting', { send_email: '1' });
  await tokenNowhere(c.id, ctx.token);
  const [link] = await vlinks(ctx.a);
  const exp = new Date(link.expires_at).getTime();
  assert.ok(link.token_sealed && !link.token_sealed.includes(ctx.token), 'an encrypted copy, not the token');
  assert.equal(require('../lib/encryption').decrypt(link.token_sealed, c.id), ctx.token);

  assert.equal(await messages.reminders(db, { now: new Date(exp - 6 * DAY) }), 1);
  let [m] = await mails(c.id, 'tprm:vendor_reminder_7');
  assert.equal(m.to_email, VENDOR);
  assert.match(m.subject, /^Reminder: security questionnaire for Msg Questionnaire Client, due \d{1,2} [A-Z][a-z]{2} \d{4}$/);
  assert.match(m.body_text, /Open it with the button below/);
  assert.match(m.body_text, /0 of \d+ questions are answered so far/);
  assert.ok(m.body_text.includes(consultant.email), 'who to write to');
  assert.match(m.body_text, /\[link removed\]/);
  assert.ok(fs.readFileSync(process.env.EMAIL_DEV_OUTBOX, 'utf8').includes(`/vendor/q/${ctx.token}`), 'the delivered reminder carries the same link');
  await tokenNowhere(c.id, ctx.token);
  assert.equal(await messages.reminders(db, { now: new Date(exp - 6 * DAY + 3600 * 1000) }), 0, 'once');
  assert.equal(await messages.reminders(db, { now: new Date(exp - 12 * 3600 * 1000) }), 1);
  [m] = await mails(c.id, 'tprm:vendor_reminder_1');
  assert.match(m.subject, /^Due tomorrow: security questionnaire for /);
  const events = (await sent(c.id, ctx.a)).filter(e => e.after_state.to === 'third_party');
  assert.deepEqual(events.map(e => e.after_state.kind), ['vendor_reminder_7', 'vendor_reminder_1']);
  assert.deepEqual([events[0].after_state.to, events[0].after_state.recipient_email], ['third_party', VENDOR]);

  const page = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=history`);
  assert.match(page.text, /Email sent to the third party \(Priya Vendor\): the reminder 7 days before the questionnaire link stops working/);

  await answerAndSubmit(ctx);
  [m] = await mails(c.id, 'tprm:vendor_receipt');
  assert.equal(m.to_email, VENDOR);
  assert.match(m.subject, /^Received: your security questionnaire for Msg Questionnaire Client$/);
  assert.match(m.body_text, /were received on \d{1,2} [A-Z][a-z]{2} \d{4}: \d+ questions/);
  [m] = await mails(c.id, 'tprm:consultant_submitted');
  assert.equal(m.to_email, consultant.email);
  assert.match(m.subject, /^\[Msg Questionnaire Client\] Remindable Hosting submitted the questionnaire$/);
  assert.match(m.body_html, /\/assessments\/\d+\?step=review/);
  assert.equal(await messages.reminders(db, { now: new Date(exp + DAY) }), 0, 'nothing to a submitted link');
  assert.equal((await vlinks(ctx.a))[0].token_sealed, null, 'the encrypted copy goes with the submission');

  const revoked = await linked(c, 'Revoked Hosting');
  const [rl] = await vlinks(revoked.a);
  assert.equal((await consultant.session.post(`${qBase(revoked)}/links/${rl.id}/revoke`, { reason: 'Wrong person', row_version: String(rl.row_version) })).status, 302);
  assert.equal((await vlinks(revoked.a))[0].status, 'revoked');
  assert.equal((await vlinks(revoked.a))[0].token_sealed, null, 'the encrypted copy goes with the revocation');
  const off = await tprmClient('Msg Reminders Off Client');
  const quiet = await linked(off, 'Quiet Hosting');
  const settings = await consultant.session.get(`/tprm/clients/${off.id}/settings`);
  const rv = (await db.prepare('SELECT row_version FROM tp_client_settings WHERE workspace_id=?').get(off.id)).row_version;
  const saved = await client.post(`/tprm/clients/${off.id}/settings`, { row_version: String(rv), vendor_reminders_shown: '1' });
  assert.equal(saved.status, 302, `${settings.status} ${toast(saved)}`);
  assert.equal((await db.prepare('SELECT vendor_reminders FROM tp_client_settings WHERE workspace_id=?').get(off.id)).vendor_reminders, false);
  const qexp = new Date((await vlinks(quiet.a))[0].expires_at).getTime();
  assert.equal(await messages.reminders(db, { now: new Date(qexp - 6 * DAY) }), 0, 'revoked and switched-off links get nothing');
  assert.equal((await mails(off.id, 'tprm:vendor_reminder_7')).length, 0);
  const rv2 = (await db.prepare('SELECT row_version FROM tp_client_settings WHERE workspace_id=?').get(off.id)).row_version;
  await client.post(`/tprm/clients/${off.id}/settings`, { row_version: String(rv2), interval_months_high: '12' });
  assert.equal((await db.prepare('SELECT vendor_reminders FROM tp_client_settings WHERE workspace_id=?').get(off.id)).vendor_reminders, false);

  const late = await linked(c, 'Late Hosting');
  const lexp = new Date((await vlinks(late.a))[0].expires_at).getTime();
  assert.equal(await messages.reminders(db, { now: new Date(lexp + 5 * DAY) }), 0, 'too long ago');
  assert.equal(await messages.reminders(db, { now: new Date(lexp + DAY) }), 1);
  [m] = await mails(c.id, 'tprm:vendor_overdue');
  assert.match(m.subject, /the link has stopped working$/);
  assert.match(m.body_text, /What you saved is kept/);
  assert.equal(await messages.reminders(db, { now: new Date(lexp + 2 * DAY) }), 0, 'once');
});

test('4. follow-ups: saved while reviewing, sent together in one email with a new link; a later one goes with the same link; the answer goes to the consultant', async () => {
  const c = await tprmClient('Msg Clarification Client');
  const ctx = await linked(c, 'Clarified Hosting');
  await answerAndSubmit(ctx);
  let res = await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-01', body: 'Please send the approval minutes.' });
  assert.match(toast(res), /saved, not sent yet\. 1 waiting/);
  res = await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-02', body: 'Who reviews it?' });
  assert.match(toast(res), /2 waiting/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS n FROM tp_clarifications WHERE assessment_id=?').get(ctx.a)).n, 0, 'the third party sees nothing yet');
  const before = (await mails(c.id, 'tp_vendor_request')).length;
  res = await consultant.session.post(`${qBase(ctx)}/clarifications/send`, {});
  assert.match(toast(res), /2 follow-ups sent to Priya Vendor in one email, with a new link/);
  const links = (await mails(c.id, 'tp_vendor_request')).slice(before);
  assert.equal(links.length, 1, 'one email');
  let m = links[0];
  assert.match(m.subject, /^2 questions about your answers for Msg Clarification Client$/);
  assert.match(m.body_text, /GOV-01: Please send the approval minutes\.[\s\S]*GOV-02: Who reviews it\?/);
  assert.match(m.body_text, /\[link removed\]/);
  const token = [...fs.readFileSync(process.env.EMAIL_DEV_OUTBOX, 'utf8').matchAll(/\/vendor\/q\/([A-Za-z0-9_-]{20,})/g)].at(-1)[1];
  await tokenNowhere(c.id, token);
  assert.equal((await mails(c.id, 'tprm:vendor_clarification')).length, 0);

  res = await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'AIS-01', body: 'Is the register reviewed monthly?' });
  assert.match(toast(res), /saved, not sent yet/, toast(res));
  res = await consultant.session.post(`${qBase(ctx)}/clarifications/send`, {});
  assert.match(toast(res), /1 follow-up sent to the third party in one email/);
  [m] = await mails(c.id, 'tprm:vendor_clarification');
  assert.equal(m.to_email, VENDOR);
  assert.match(m.subject, /^A question about your answers for /);
  assert.match(m.body_text, /about AIS-01:\s+Is the register reviewed monthly\?/);
  assert.match(m.body_text, /Answer it with the button below/);
  assert.ok(fs.readFileSync(process.env.EMAIL_DEV_OUTBOX, 'utf8').includes(`/vendor/q/${token}`), 'the same link');
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/clarifications/send`, {})), /no follow-ups waiting/);

  const cl = await db.prepare("SELECT id FROM tp_clarifications WHERE assessment_id=? AND question_id='GOV-01'").get(ctx.a);
  const answered = await vpost('/vendor/q/', token, `/clarifications/${cl.id}`, [['response', 'Minutes attached.']]);
  assert.equal(answered.status, 303);
  [m] = await mails(c.id, 'tprm:consultant_clarification_answered');
  assert.equal(m.to_email, consultant.email);
  assert.match(m.subject, /Clarified Hosting answered a clarification$/);
  assert.match(m.body_text, /answered your question on GOV-01:\s+Minutes attached\./);
  assert.match(m.body_html, /step=review&amp;answers=all#answer-\d+/);
});

test('4b. a follow-up not sent yet can be removed, and unsent follow-ups stop the review closing', async () => {
  const c = await tprmClient('Msg Draft Follow-up Client');
  const ctx = await linked(c, 'Drafty Hosting');
  await answerAndSubmit(ctx);
  await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-01', body: 'Draft only.' });
  const page = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=review&answers=all`);
  assert.match(page.text, /data-tprm-followups-waiting="1"/);
  assert.match(page.text, /Follow-up, not sent yet/);
  const did = Number((page.text.match(/data-tprm-followup-draft="(\d+)"/) || [])[1]);
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/close`, { row_version: String((await qRow(ctx.a)).row_version) })), /written but not sent/);
  assert.match(toast(await consultant.session.post(`${qBase(ctx)}/clarifications/drafts/${did}/remove`, {})), /removed/);
  assert.doesNotMatch((await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=review&answers=all`)).text, /data-tprm-followups-waiting/);
});

async function issued(c, name) {
  const tp = await addThirdParty(c.id, name, 'proposed');
  const started = await consultant.session.post(`/tprm/clients/${c.id}/third-parties/${tp}/assessments`, {});
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(c.id, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(c.id, tp, a)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(c.id, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(`${aBase(c.id, tp, a)}/details`, {
    client_decision_owner_id: String(c.owner.id), due_date: '', row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(rBase(c.id, tp, a), { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  const rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=? ORDER BY version DESC').get(a)).id);
  assert.equal((await consultant.session.post(`${rBase(c.id, tp, a)}/${rid}`, {
    outcome: 'approve_with_conditions', residual_rating: 'medium', rationale: 'Adequate with two fixes.', valid_until: '2099-12-31',
    'conditions[0][description]': 'Enforce MFA for all admin accounts', 'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': '2099-06-30',
    'conditions[1][description]': 'Sign the data processing agreement', 'conditions[1][owner]': 'client', 'conditions[1][due_date]': '2099-03-31',
    intent: 'submit', row_version: String((await recRow(rid)).row_version) })).status, 302);
  assert.equal((await senior.session.post(`${rBase(c.id, tp, a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version) })).status, 302);
  assert.equal((await recRow(rid)).status, 'issued');
  const conds = await db.prepare('SELECT * FROM tp_conditions WHERE recommendation_id=? ORDER BY position').all(rid);
  return { ws: c.id, tp, a, rid, c, vendorCond: Number(conds[0].id), clientCond: Number(conds[1].id) };
}

test('5. the decision: needed and reminded once to the decision owner; the decision, the conditions link and the proof', async () => {
  const c = await tprmClient('Msg Decision Client');
  const ctx = await issued(c, 'Decided Print');
  let [m] = await mails(c.id, 'tprm:client_decision_needed');
  assert.equal(m.to_email, c.owner.email);
  assert.match(m.subject, /^Decision needed: Decided Print$/);
  assert.match(m.body_text, /issued the recommendation on Decided Print: Onboard with conditions/);
  assert.match(m.body_html, new RegExp(`/workspaces/${c.id}/client-portal/third-party-risk/recommendations/${ctx.rid}`));

  const issuedAt = new Date((await recRow(ctx.rid)).issued_at).getTime();
  assert.equal(await messages.reminders(db, { now: new Date(issuedAt + 3 * DAY) }), 0, 'not before 7 days');
  assert.equal(await messages.reminders(db, { now: new Date(issuedAt + 8 * DAY) }), 1);
  [m] = await mails(c.id, 'tprm:client_decision_reminder');
  assert.match(m.subject, /^Reminder: decision needed on Decided Print$/);
  assert.equal(await messages.reminders(db, { now: new Date(issuedAt + 9 * DAY) }), 0, 'once');

  const owner = await sessionFor(c.owner);
  await owner.get(recPage(c.id, ctx.rid));
  assert.equal((await owner.post(`${recPage(c.id, ctx.rid)}/decision`, { outcome: 'approve_with_conditions' })).status, 302);
  [m] = await mails(c.id, 'tprm:consultant_client_decided');
  assert.equal(m.to_email, consultant.email);
  assert.match(m.subject, /^\[Msg Decision Client\] Decision on Decided Print: Onboard with conditions$/);
  assert.match(m.body_text, /Owner of Msg Decision Client recorded the decision Onboard with conditions on version 1/);

  await consultant.session.get(aBase(ctx.ws, ctx.tp, ctx.a));
  const res = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/conditions-link`, {
    recipient_name: 'Priya Vendor', recipient_email: VENDOR, expires_in_days: '30', send_email: '1' });
  assert.match(res.text, /data-tprm-condition-link-emailed="sent">Emailed to priya@thirdparty\.example\.net/);
  const token = (res.text.match(/\/vendor\/c\/([A-Za-z0-9_-]+)/) || [])[1];
  assert.ok(token);
  [m] = await mails(c.id, 'tprm:conditions_link');
  assert.equal(m.to_email, VENDOR);
  assert.match(m.subject, /^Conditions agreed for Msg Decision Client: please send your proof$/);
  assert.match(m.body_text, /Enforce MFA for all admin accounts \(by 30 Jun 2099\)/);
  assert.doesNotMatch(m.body_text, /Sign the data processing agreement/, 'only the third party\'s conditions');
  assert.match(m.body_text, /\[link removed\]/);
  await tokenNowhere(c.id, token);

  const proof = await vpost('/vendor/c/', token, `/conditions/${ctx.vendorCond}/proof`, [['note', 'MFA enforced for every admin.']],
    [{ field: 'files', filename: 'mfa.txt', content: 'mfa report' }]);
  assert.equal(proof.status, 303);
  [m] = await mails(c.id, 'tprm:consultant_proof_uploaded');
  assert.equal(m.to_email, consultant.email);
  assert.match(m.subject, /Decided Print sent proof for condition 1$/);
  assert.match(m.body_text, /\(1 file\)/);
  assert.match(m.body_text, /Their note: MFA enforced for every admin\./);

  assert.equal(await messages.reminders(db, { now: new Date('2099-03-20T09:00:00Z') }), 0, 'not yet');
  assert.equal(await messages.reminders(db, { now: new Date('2099-03-27T09:00:00Z') }), 1);
  [m] = await mails(c.id, 'tprm:client_condition_due');
  assert.equal(m.to_email, c.owner.email);
  assert.match(m.subject, /^Condition due 31 Mar 2099: Decided Print$/);
  assert.match(m.body_text, /Sign the data processing agreement/);
  assert.equal(await messages.reminders(db, { now: new Date('2099-03-28T09:00:00Z') }), 0, 'once');

  await db.prepare("UPDATE users SET email_notify='off' WHERE id=?").run(c.owner.id);
  const ctx2 = await issued(c, 'Muted Print');
  assert.equal((await mails(c.id, 'tprm:client_decision_needed')).filter(x => /Muted Print/.test(x.subject)).length, 0);
  assert.ok((await sent(c.id, ctx2.a)).every(e => e.after_state.to !== 'client'));

  process.env.EMAIL_DELIVERY_DISABLED = '1';
  try {
    const before = (await sent(c.id, ctx.a)).length;
    assert.equal(await messages.reminders(db, { now: new Date('2099-03-27T09:00:00Z') }), 0);
    const res = await messages.deliver(db, { ws: { id: c.id, firm_id: firmId }, a: { id: ctx.a, third_party_id: ctx.tp, third_party_name: 'X' }, firmName: '', clientName: 'Y' },
      { kind: 'vendor_receipt', key: 'disabled-check', role: 'third_party', to: { name: 'P', email: VENDOR }, data: {} });
    assert.equal(res.skipped, 'disabled');
    assert.equal((await sent(c.id, ctx.a)).length, before);
  } finally { process.env.EMAIL_DELIVERY_DISABLED = '0'; }
});

test('6. the firm hears about a client\'s request to add a supplier, once', async () => {
  const was = process.env.EMAIL_DELIVERY_DISABLED;
  process.env.EMAIL_DELIVERY_DISABLED = '0';
  try {
    const c = await tprmClient('Message Request Client');
    await db.prepare('UPDATE workspaces SET lead_consultant_id = ? WHERE id = ?').run(consultant.id, c.id);
    const rid = Number((await db.prepare(`INSERT INTO tp_client_requests (workspace_id, name, service_description, requested_by) VALUES (?, 'Orbit Backup', 'Nightly backups', ?) RETURNING id`)
      .get(c.id, c.owner.id)).id);
    await messages.clientRequested(db, { workspaceId: c.id, requestId: rid });
    await messages.clientRequested(db, { workspaceId: c.id, requestId: rid });
    const rows = await mails(c.id, 'tprm:consultant_client_request');
    assert.equal(rows.length, 1, 'one email to the lead, not two');
    assert.match(`${rows[0].subject}`, /Request to add Orbit Backup/);
  } finally {
    process.env.EMAIL_DELIVERY_DISABLED = was;
  }
});

test('7. a manager rewords an email; sent emails and the preview use it; going back to the standard removes it', async () => {
  const was = process.env.EMAIL_DELIVERY_DISABLED;
  process.env.EMAIL_DELIVERY_DISABLED = '0';
  try {
    await client.get('/tprm/settings/emails');
    const saved = await client.post('/tprm/settings/emails/vendor_invitation', { subject: 'Questionnaire for {client} from our team', headline: '', opening: 'SENTINEL-OPENING for {supplier}.', closing: '' });
    assert.equal(saved.status, 302, toast(saved));
    assert.equal((await consultant.session.post('/tprm/settings/emails/vendor_invitation', { subject: 'x' })).status, 403, 'only a manager rewords emails');
    const preview = await client.get('/tprm/settings/emails/vendor_invitation/preview');
    assert.equal(preview.status, 200);
    assert.match(preview.text, /SENTINEL-OPENING for Lumen Print &amp; Mail\./);
    const c = await tprmClient('Reworded Email Client');
    const ctx = await linked(c, 'Reworded Supplier', { send_email: '1' });
    const rows = await db.prepare(`SELECT subject, body_html AS html FROM email_outbox WHERE workspace_id=? AND related_type='tp_vendor_request' ORDER BY id`).all(c.id);
    assert.ok(rows.length >= 1, 'the invitation was sent');
    assert.equal(rows[rows.length - 1].subject, 'Questionnaire for Reworded Email Client from our team');
    assert.match(rows[rows.length - 1].html || '', /SENTINEL-OPENING for Reworded Supplier\./);
    assert.ok(ctx.token);
    const reset = await client.post('/tprm/settings/emails/vendor_invitation', { reset: '1' });
    assert.match(toast(reset), /standard/);
    assert.doesNotMatch((await client.get('/tprm/settings/emails/vendor_invitation/preview')).text, /SENTINEL-OPENING/);
  } finally {
    process.env.EMAIL_DELIVERY_DISABLED = was;
  }
});

test('8. a firm\'s own words keep their paragraphs', () => {
  const m = email.renderTprmEmail('vendor_reminder_7', { toName: 'Priya', firmName: 'Firm', clientName: 'Acme', until: '1 Dec', sentDay: '1 Nov', url: 'https://app.example/x' },
    { opening: 'First paragraph for {client}.\n\nSecond paragraph.' });
  const text = email.stripHtml(m.html);
  assert.match(m.html, /First paragraph for Acme\.<\/p>[\s\S]*?<p[^>]*>Second paragraph\.<\/p>/);
  assert.ok(text.includes('Second paragraph.'));
});

test('9. each step of a review is emailed to the named reviewer or the lead, never to the person who took it', async () => {
  const c = await tprmClient('Stage Mail Client');
  const tp = await addThirdParty(c.id, 'Stage Mail Supplier', 'proposed');
  assert.equal((await client.post(`/tprm/clients/${c.id}/third-parties/${tp}/team`, { team_owner_id: String(consultant.id), team_reviewer_id: String(senior.id) })).status, 302);
  const started = await consultant.session.post(`/tprm/clients/${c.id}/third-parties/${tp}/assessments`, {});
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(c.id, tp)).map(r => String(r.id));
  const propose = async () => {
    const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
    for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
    assert.equal((await consultant.session.post(`${aBase(c.id, tp, a)}/scope`, body)).status, 302);
  };
  const to = async kind => (await mails(c.id, `tprm:${kind}`)).map(m => m.to_email);

  await propose();
  assert.deepEqual(await to('consultant_tier_to_confirm'), [senior.email]);
  assert.match((await mails(c.id, 'tprm:consultant_tier_to_confirm'))[0].subject, /Tier to confirm: Stage Mail Supplier/);
  assert.doesNotMatch((await mails(c.id, 'tprm:consultant_tier_to_confirm'))[0].body_html, /No reviewer is named/);
  assert.match((await mails(c.id, 'tprm:consultant_tier_to_confirm'))[0].body_html, /You are the reviewer named for this third party/);
  assert.equal((await senior.session.post(`${aBase(c.id, tp, a)}/return`, { comment: 'Recheck the data the service handles.', row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.deepEqual(await to('consultant_tier_returned'), [consultant.email]);
  await propose();
  assert.deepEqual(await to('consultant_tier_to_confirm'), [senior.email, senior.email], 'a second proposal is a second email');
  assert.equal((await senior.session.post(`${aBase(c.id, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.deepEqual(await to('consultant_tier_confirmed'), [consultant.email]);

  assert.equal((await consultant.session.post(`${aBase(c.id, tp, a)}/details`, {
    client_decision_owner_id: String(c.owner.id), due_date: '', row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(rBase(c.id, tp, a), { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  const rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=? ORDER BY version DESC').get(a)).id);
  const submit = async () => assert.equal((await consultant.session.post(`${rBase(c.id, tp, a)}/${rid}`, {
    outcome: 'approve', residual_rating: 'low', rationale: 'Adequate.', valid_until: '2099-12-31', intent: 'submit',
    row_version: String((await recRow(rid)).row_version) })).status, 302);
  await submit();
  assert.deepEqual(await to('consultant_recommendation_to_review'), [senior.email]);
  assert.equal((await senior.session.post(`${rBase(c.id, tp, a)}/${rid}/request-changes`, { comment: 'Name the contract clause.', row_version: String((await recRow(rid)).row_version) })).status, 302);
  assert.deepEqual(await to('consultant_recommendation_returned'), [consultant.email]);
  assert.match((await mails(c.id, 'tprm:consultant_recommendation_returned'))[0].body_html || '', /Name the contract clause\./);
  await submit();
  assert.equal((await to('consultant_recommendation_to_review')).length, 2);
  assert.equal((await senior.session.post(`${rBase(c.id, tp, a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version) })).status, 302);
  assert.deepEqual(await to('consultant_recommendation_issued'), [consultant.email], 'the author, who is also the lead, gets one email');
  for (const kind of Object.values(messages.STAGE_EVENTS).map(s => s.kind)) {
    for (const m of await mails(c.id, `tprm:${kind}`)) assert.notEqual(m.to_email, null);
  }
});

test('10. no reviewer named: everyone who can confirm the tier is told it waits, never the proposer', async () => {
  const c = await tprmClient('Stage Mail Quiet Client');
  const tp = await addThirdParty(c.id, 'Quiet Supplier', 'proposed');
  await startAssessment(c.id, tp);
  const told = (await mails(c.id, 'tprm:consultant_tier_to_confirm')).map(m => m.to_email);
  assert.ok(told.includes(senior.email), 'the senior on the client is told');
  assert.ok(!told.includes(consultant.email), 'not the proposer');
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(c.id);
  const expected = (await require('../lib/tprm/team').reviewerCandidates(db, ws)).filter(u => Number(u.id) !== consultant.id).map(u => u.email);
  assert.deepEqual([...told].sort(), [...expected].sort(), 'exactly the people who may confirm it');
  assert.equal((await mails(c.id, 'tprm:consultant_tier_confirmed')).length, 1, 'the lead hears the tier is confirmed');
  for (const m of await mails(c.id, 'tprm:consultant_tier_to_confirm')) {
    assert.doesNotMatch(m.body_html, /You are the reviewer named/, 'nobody is told they are the named reviewer when none is named');
    assert.match(m.body_text || m.body_html, /confirm it or send it back/);
    assert.match(m.body_html, /No reviewer is named for this third party, so everyone who can confirm tiers for this client was told/);
  }
});

test('10b. the tier-to-confirm email gives the real reason it came to this person', () => {
  const base = { toName: 'Meera', clientName: 'Acme', thirdPartyName: 'Varma', byName: 'Kavya', tierLabel: 'High', url: 'https://app.example/a' };
  const named = email.renderTprmEmail('consultant_tier_to_confirm', { ...base, reviewerNamed: true }).text;
  const none = email.renderTprmEmail('consultant_tier_to_confirm', { ...base, reviewerNamed: false }).text;
  const unknown = email.renderTprmEmail('consultant_tier_to_confirm', base).text;
  assert.match(named, /You are the reviewer named for this third party/);
  assert.match(none, /No reviewer is named for this third party, so everyone who can confirm tiers for this client was told/);
  assert.doesNotMatch(none, /You are the reviewer named/);
  assert.doesNotMatch(unknown, /reviewer named|No reviewer/);
  assert.match(unknown, /You can confirm tiers for this client/);
});

test('11. questionnaires out: listed until submitted; remind, reopen with a new link, and cancel as not returned', async () => {
  const tracker = require('../lib/tprm/questionnaire-tracker');
  const c = await tprmClient('Out List Client');
  const ctx = await linked(c, 'Out List Supplier');
  const page = await consultant.session.get('/tprm/questionnaires');
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-tprm-out-row="${ctx.a}" data-tprm-out-state="not_opened"`));
  assert.match(page.text, /data-tprm-out-link/);

  const act = `/tprm/clients/${c.id}/questionnaires-out/${ctx.a}`;
  const reminded = await consultant.session.post(`${act}/remind`, { show: 'all' });
  assert.equal(reminded.status, 302);
  assert.match(toast(reminded), /Reminder sent to Priya Vendor/);

  const before = (await vlinks(ctx.a)).length;
  const reopened = await consultant.session.post(`${act}/reopen`, {});
  assert.equal(reopened.status, 302);
  assert.match(toast(reopened), /new link was emailed to Priya Vendor/);
  const links = await vlinks(ctx.a);
  assert.equal(links.length, before + 1);
  assert.deepEqual(links.slice(0, -1).map(l => l.status), links.slice(0, -1).map(() => 'revoked'), 'the old link stops working');
  assert.equal(links[links.length - 1].recipient_email, VENDOR);

  const noReason = await consultant.session.post(`${act}/cancel`, { reason: '' });
  assert.match(toast(noReason), /Say why/);
  const cancelled = await consultant.session.post(`${act}/cancel`, { reason: 'The supplier stopped replying.' });
  assert.match(toast(cancelled), /closed as not returned/);
  const q = await qRow(ctx.a);
  assert.deepEqual([q.status, q.not_returned], ['closed', true]);
  assert.doesNotMatch((await consultant.session.get('/tprm/questionnaires')).text, new RegExp(`data-tprm-out-row="${ctx.a}"`));

  const now = new Date('2027-01-10T12:00:00Z');
  const row = (over) => ({ link_status: 'active', expires_at: '2027-02-28T00:00:00Z', last_opened_at: '2027-01-05T00:00:00Z', ...over });
  assert.equal(tracker.stateOf(row({}), now), 'in_progress');
  assert.equal(tracker.stateOf(row({ last_opened_at: null }), now), 'not_opened');
  assert.equal(tracker.stateOf(row({ expires_at: '2027-01-15T00:00:00Z' }), now), 'due_soon');
  assert.equal(tracker.stateOf(row({ expires_at: '2027-01-09T00:00:00Z' }), now), 'overdue');
  assert.equal(tracker.stateOf(row({ link_status: 'revoked' }), now), 'overdue');
});

test('12. a reminder that goes is confirmed and recorded with who sent it; one that fails says so and can be tried again the same day', async () => {
  const c = await tprmClient('Remind Trace Client');
  const ctx = await linked(c, 'Remind Trace Supplier');
  const act = `/tprm/clients/${c.id}/questionnaires-out/${ctx.a}`;
  const email = require('../lib/email');
  const real = email.sendEmail;
  email.sendEmail = async () => ({ ok: false, error: 'mailbox unavailable' });
  let failed;
  try {
    failed = await consultant.session.post(`${act}/remind`, {});
  } finally { email.sendEmail = real; }
  assert.match(toast(failed), /No reminder sent: the email to priya@thirdparty\.example\.net could not be sent \(mailbox unavailable\)/);
  const retried = await consultant.session.post(`${act}/remind`, {});
  assert.match(toast(retried), /Reminder sent to Priya Vendor at priya@thirdparty\.example\.net, and recorded in the assessment history/,
    'a failed send does not count as the reminder for today');
  const again = await consultant.session.post(`${act}/remind`, {});
  assert.match(toast(again), /No reminder sent: a reminder already went today/);
  const history = await consultant.session.get(`${aBase(c.id, ctx.tp, ctx.a)}?step=history`);
  assert.match(history.text, new RegExp(`${consultant.name || 'Consultant'}[^<]* sent a reminder to the third party \\(Priya Vendor\\) by email|sent a reminder to the third party \\(Priya Vendor\\) by email`));
  assert.match(history.text, /Email to the third party \(Priya Vendor\) not sent/);
  assert.match(history.text, /tried to send a reminder to the third party \(Priya Vendor\) by email/, 'the failed try is not shown as sent');

  const a = await db.prepare('SELECT a.*, t.name AS third_party_name FROM tp_assessments a JOIN tp_third_parties t ON t.id = a.third_party_id WHERE a.id = ?').get(ctx.a);
  const b = { a, ws: await db.prepare('SELECT * FROM workspaces WHERE id=?').get(c.id), firmName: '', clientName: 'Remind Trace Client', f: require('../lib/tprm/format').forZone('UTC') };
  const send = () => messages.deliver(db, b, { kind: 'vendor_reminder_7', key: `scheduled-check:${ctx.a}`, role: 'third_party',
    to: { name: 'Priya Vendor', email: VENDOR }, data: { url: null, sentDay: '', until: '', total: 1, answered: 0, contact: null } });
  email.sendEmail = async () => ({ ok: false, error: 'mailbox unavailable' });
  try {
    assert.equal((await send()).ok, false);
    assert.deepEqual(await send(), { skipped: 'already_sent' }, 'a scheduled email that failed is not sent again on the next run');
  } finally { email.sendEmail = real; }
});

test('12b. nothing is emailed to an exited third party, and the reminder button says why', async () => {
  const c = await tprmClient('Exited Mail Client');
  const ctx = await linked(c, 'Exited Mail Supplier');
  await db.prepare("UPDATE tp_third_parties SET status = 'exited' WHERE id = ?").run(ctx.tp);
  const before = (await db.prepare('SELECT COUNT(*)::int AS n FROM email_outbox WHERE workspace_id=?').get(c.id)).n;
  const act = `/tprm/clients/${c.id}/questionnaires-out/${ctx.a}`;
  const reminded = await consultant.session.post(`${act}/remind`, {});
  assert.match(toast(reminded), /No reminder sent: the third party has exited, so its links no longer open and nothing is emailed to it/);
  const r = await messages.manualReminder(db, { workspaceId: c.id, assessmentId: ctx.a });
  assert.deepEqual(r, { sent: false, reason: 'the third party has exited, so its links no longer open and nothing is emailed to it' });
  const a = await db.prepare('SELECT a.*, t.name AS third_party_name FROM tp_assessments a JOIN tp_third_parties t ON t.id = a.third_party_id WHERE a.id = ?').get(ctx.a);
  const b = { a, ws: await db.prepare('SELECT * FROM workspaces WHERE id=?').get(c.id), firmName: '', clientName: 'Exited Mail Client', f: require('../lib/tprm/format').forZone('UTC') };
  assert.deepEqual(await messages.deliver(db, b, { kind: 'vendor_clarification', key: `exited-check:${ctx.a}`, role: 'third_party',
    to: { name: 'Priya Vendor', email: VENDOR }, data: { url: null, sentDay: '', until: '', contact: null } }), { skipped: 'exited' });
  const link = (await vlinks(ctx.a))[0];
  await messages.reminders(db, { now: new Date(new Date(link.expires_at).getTime() - 12 * 3600 * 1000) });
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS n FROM email_outbox WHERE workspace_id=?').get(c.id)).n, before, 'no reminder, clarification or issue email went');
});

test('12c. when the complete-enough count cannot be worked out, the reminder still goes and the error is logged', async () => {
  const c = await tprmClient('Count Error Client');
  const ctx = await linked(c, 'Count Error Supplier');
  const vendorAnswers = require('../lib/tprm/vendor-answers');
  const real = vendorAnswers.progressCounts;
  const realError = console.error;
  const logged = [];
  vendorAnswers.progressCounts = async () => { throw new Error('bank unreadable'); };
  console.error = (...args) => { logged.push(args.join(' ')); };
  let r;
  try {
    r = await messages.manualReminder(db, { workspaceId: c.id, assessmentId: ctx.a });
  } finally {
    vendorAnswers.progressCounts = real;
    console.error = realError;
  }
  assert.equal(r.sent, true);
  assert.ok(logged.some(l => /answeredCount/.test(l) && /bank unreadable/.test(l)), logged.join('\n'));
});

test('5b. a client who turns off third-party risk emails is not emailed about a decision, and other emails stay on', async () => {
  const c = await tprmClient('Tprm Muted Client');
  await db.prepare("UPDATE users SET tprm_email_notify='off' WHERE id=?").run(c.owner.id);
  await issued(c, 'Quiet Owner Print');
  assert.equal((await mails(c.id, 'tprm:client_decision_needed')).length, 0);
  assert.notEqual((await db.prepare('SELECT email_notify FROM users WHERE id=?').get(c.owner.id)).email_notify, 'off');
});
