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
  assert.equal(res.status, 200, res.text.slice(0, 200));
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
  const events = await sent(c.id, ctx.a);
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

test('4. clarifications: the new link\'s email asks the question; a further one is emailed without a link; the answer goes to the consultant', async () => {
  const c = await tprmClient('Msg Clarification Client');
  const ctx = await linked(c, 'Clarified Hosting');
  await answerAndSubmit(ctx);
  let res = await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-01', body: 'Please send the approval minutes.' });
  assert.match(toast(res), /issue a new link/);
  assert.equal((await mails(c.id, 'tprm:vendor_clarification')).length, 0, 'no link to answer on yet: the link email carries it');
  const { token } = await createLink(ctx, { send_email: '1' });
  let [m] = (await mails(c.id, 'tp_vendor_request')).slice(-1);
  assert.match(m.subject, /^A question about your answers for Msg Clarification Client$/);
  assert.match(m.body_text, /has a question about GOV-01:\s+Please send the approval minutes\./);
  assert.match(m.body_text, /\[link removed\]/);
  await tokenNowhere(c.id, token);

  res = await consultant.session.post(`${qBase(ctx)}/clarifications`, { question_id: 'GOV-02', body: 'Who reviews it?' });
  assert.match(toast(res), /sees it on its link/);
  [m] = await mails(c.id, 'tprm:vendor_clarification');
  assert.equal(m.to_email, VENDOR);
  assert.match(m.body_text, /about GOV-02:\s+Who reviews it\?/);
  assert.match(m.body_text, /Answer it with the button below/);
  assert.match(m.body_text, /\[link removed\]/, 'the same link, kept out of the stored copy');
  assert.ok(fs.readFileSync(process.env.EMAIL_DEV_OUTBOX, 'utf8').includes(`/vendor/q/${token}`), 'the delivered email carries the link');
  await tokenNowhere(c.id, token);

  const cl = await db.prepare("SELECT id FROM tp_clarifications WHERE assessment_id=? AND question_id='GOV-01'").get(ctx.a);
  const answered = await vpost('/vendor/q/', token, `/clarifications/${cl.id}`, [['response', 'Minutes attached.']]);
  assert.equal(answered.status, 303);
  [m] = await mails(c.id, 'tprm:consultant_clarification_answered');
  assert.equal(m.to_email, consultant.email);
  assert.match(m.subject, /Clarified Hosting answered a clarification$/);
  assert.match(m.body_text, /answered your question on GOV-01:\s+Minutes attached\./);
  assert.match(m.body_html, /step=review&amp;answers=all#answer-\d+/);
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
