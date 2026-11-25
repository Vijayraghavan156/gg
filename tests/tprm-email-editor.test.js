'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-editor-outbox-')), 'outbox.log');

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');
const markup = require('../lib/tprm/email-markup');
const email = require('../lib/email');

const PASSWORD = 'tprm-email-editor-password-1234';
const KIND = 'vendor_reminder_7';
const BASE = `/tprm/settings/emails/${KIND}`;

let env;
let db;
let firmId;
let manager;
let consultant;
const sessions = [];

test.before(async () => {
  env = await bootClient();
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  manager = await makeUser('editor-manager@test.local', 'manager', 'Mina Manager');
  consultant = await makeUser('editor-consultant@test.local', 'consultant', 'Cyrus Consultant');
});

test.after(async () => {
  for (const s of sessions) await s.close();
  if (env && env.client) await env.client.close();
});

async function makeUser(address, role, name) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,?,1)`).run(address, bcrypt.hashSync(PASSWORD, 4), name, firmId, role)).lastInsertRowid);
  return { id, email: address, firm_role: role, name };
}

async function sessionFor(user) {
  if (user.session) return user.session;
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email: user.email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${user.email} signs in`);
  await session.get('/dashboard');
  sessions.push(session);
  user.session = session;
  return session;
}

const toastOf = res => decodeURIComponent((String(res.location || '').match(/[?&]toast=([^&#]*)/) || [])[1] || '').replace(/\+/g, ' ');

test('markup: bold, italic, lists, links and details render safely; text keeps link addresses and list marks', () => {
  const src = 'Hello **{name}**, see *the guide* at [our page](https://firm.example/guide).\nSecond line <script>x</script>\n\n- First\n- Ask {contact}';
  const d = { toName: 'Priya', contact: { name: 'Kabir', email: 'kabir@firm.example' } };
  const html = markup.toHtmlBlocks(src, d).join('');
  assert.match(html, /<strong>Priya<\/strong>/);
  assert.match(html, /<em>the guide<\/em>/);
  assert.match(html, /<a href="https:\/\/firm\.example\/guide" style="[^"]*">our page<\/a>/);
  assert.match(html, /<br>Second line &lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /<ul[^>]*><li[^>]*>First<\/li><li[^>]*>Ask Kabir at <a href="mailto:kabir@firm\.example"/);
  assert.doesNotMatch(html, /<script>/);
  const text = markup.toText(src, d);
  assert.match(text, /our page \(https:\/\/firm\.example\/guide\)/);
  assert.match(text, /^- First$/m);
  assert.match(text, /^- Ask Kabir at kabir@firm\.example$/m);
  assert.match(markup.toHtmlBlocks('*a **b** c*', {}).join(''), /<em>a <strong>b<\/strong> c<\/em>/);
});

test('markup: unsafe links and details the email cannot fill are refused with a plain reason', () => {
  const allowed = ['name', 'client'];
  const errs = markup.problems('[click](javascript:alert(1)) and [mail](mailto:nobody) and {due} and {client}', allowed, 'Opening words');
  assert.equal(errs.length, 3);
  assert.match(errs.join(' '), /"javascript:alert\(1" must start with https:\/\/ or be mailto:/);
  assert.match(errs.join(' '), /"mailto:nobody" must start with https:\/\//);
  assert.match(errs.join(' '), /Opening words: \{due\} is not something this email can fill in\. Use \{name\}, \{client\}\./);
  assert.deepEqual(markup.problems('[ok](https://a.example) {name}', allowed, 'x'), []);
  const html = markup.toHtmlBlocks('[click](javascript:alert(1))', {}).join('');
  assert.doesNotMatch(html, /href/);
});

test('markup: plain wording saved before the editor keeps its asterisks and dashes as written', () => {
  const plain = 'Use *.pdf files [max 5].\n- not a list';
  const src = markup.fromPlain(plain);
  assert.equal(markup.toText(src, {}), plain);
  assert.doesNotMatch(markup.toHtmlBlocks(src, {}).join(''), /<em>|<ul/);
  assert.match(markup.editorHtml(src), /Use \*\.pdf files \[max 5\]\./);
});

test('wording saved in the simple form renders exactly as before', () => {
  const d = { toName: 'Priya', firmName: 'Firm', clientName: 'Bank', thirdPartyName: 'Lumen', until: '22 Dec 2026', sentDay: '1 Dec 2026', url: 'https://app.example/x' };
  const plain = email.renderTprmEmail(KIND, d, { subject: 'Hi {client}', opening: 'Keep **this** literal.\n\nSecond.' });
  assert.match(plain.html, /Keep \*\*this\*\* literal\./);
  assert.match(plain.text, /Keep \*\*this\*\* literal\.\n\nSecond\./);
  assert.equal((plain.text.match(/Your security questionnaire for Bank/g) || []).length, 1, 'the heading appears once in the plain text');
  assert.equal(plain.subject, 'Hi Bank');
  const rich = email.renderTprmEmail(KIND, d, { subject: 'Hi {client}', opening: 'Keep **this** bold.', format: 'rich' });
  assert.match(rich.html, /Keep <strong>this<\/strong> bold\./);
  assert.match(rich.text, /Keep this bold\./);
  assert.match(rich.text, /https:\/\/app\.example\/x/);
});

test('the editor page: one page per supplier or client email; team emails keep the simple form', async () => {
  const m = await sessionFor(manager);
  const page = await m.get(`${BASE}/edit`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-email-editor-page="vendor_reminder_7"/);
  const pick = (page.text.match(/<select[^>]*data-tprm-email-field[\s\S]*?<\/select>/) || [''])[0];
  assert.match(pick, /value="due"/);
  assert.match(pick, /value="contact"[^>]*>The reviewer to write to/);
  assert.equal((await m.get('/tprm/settings/emails/consultant_submitted/edit')).status, 404);
  const list = await m.get('/tprm/settings/emails');
  assert.match(list.text, /href="\/tprm\/settings\/emails\/vendor_reminder_7\/edit"/);
  assert.doesNotMatch(list.text, /data-tprm-email-form="vendor_reminder_7"/);
  assert.match(list.text, /data-tprm-email-form="consultant_submitted"/);
  const c = await sessionFor(consultant);
  const ro = await c.get(`${BASE}/edit`);
  assert.equal(ro.status, 200);
  assert.doesNotMatch(ro.text, /name="intent" value="save"/);
  assert.equal((await c.post(`${BASE}/edit`, { intent: 'save', opening: 'x' })).status, 403);
});

test('save, earlier versions, put back and going back to the standard', async () => {
  const m = await sessionFor(manager);
  const first = await m.post(`${BASE}/edit`, { intent: 'save', subject: 'First {client}', headline: '', opening: 'Hello **{name}**.', closing: '' });
  assert.equal(first.status, 302, toastOf(first));
  assert.match(toastOf(first), /Email saved/);
  let shown = await m.get(`${BASE}/preview`);
  assert.match(shown.text, /Hello <strong>Priya Shah<\/strong>\./);
  assert.match(String(shown.headers['content-security-policy']), /sandbox/);
  const row = async () => db.prepare('SELECT subject, opening, format, row_version FROM tp_email_templates WHERE firm_id = ? AND kind = ?').get(firmId, KIND);
  const second = await m.post(`${BASE}/edit`, { intent: 'save', subject: 'Second', opening: '- one\n- two', closing: '', row_version: String((await row()).row_version) });
  assert.equal(second.status, 302, toastOf(second));
  assert.equal((await row()).format, 'rich');
  const versions = await db.prepare('SELECT id, subject, is_standard FROM tp_email_template_versions WHERE firm_id = ? AND kind = ? ORDER BY id').all(firmId, KIND);
  assert.deepEqual(versions.map(v => v.subject), ['First {client}', 'Second']);
  const page = await m.get(`${BASE}/edit`);
  assert.match(page.text, new RegExp(`data-tprm-email-version="${versions[0].id}"[\\s\\S]*?Put this back`));
  assert.match((await m.get(`${BASE}/preview?v=${versions[0].id}`)).text, /Hello <strong>/);
  const back = await m.post(`${BASE}/versions/${versions[0].id}/restore`, { row_version: String((await row()).row_version) });
  assert.match(toastOf(back), /Earlier version put back/);
  assert.equal((await row()).subject, 'First {client}');
  const reset = await m.post(`${BASE}/edit`, { intent: 'reset', row_version: String((await row()).row_version) });
  assert.match(toastOf(reset), /standard wording/);
  assert.ok(!(await row()));
  const last = await db.prepare('SELECT is_standard FROM tp_email_template_versions WHERE firm_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(firmId, KIND);
  assert.equal(last.is_standard, true);
  const again = await m.post(`${BASE}/versions/${versions[1].id}/restore`, {});
  assert.match(toastOf(again), /put back/);
  assert.equal((await row()).subject, 'Second');
  shown = await m.get(`${BASE}/preview?as=text`);
  assert.match(shown.text, /^- one$/m);
});

test('a bad link keeps the wording on the page and says what to fix', async () => {
  const m = await sessionFor(manager);
  const res = await m.post(`${BASE}/edit`, { intent: 'save', subject: '', opening: 'Read [this](http://plain.example) {nonsense}', closing: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /data-tprm-email-errors[\s\S]*?must start with https:\/\//);
  assert.match(res.text, /\{nonsense\} is not something this email can fill in/);
  assert.match(res.text, /<textarea[^>]*name="opening"[^>]*>Read \[this\]\(http:\/\/plain\.example\) \{nonsense\}<\/textarea>/);
  const preview = await m.post(`${BASE}/preview`, { opening: '[x](javascript:alert(1))' });
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Fix these before the preview can show/);
  assert.doesNotMatch(preview.text, /href="javascript/);
});

test('the live preview shows unsaved wording as the email or as plain text', async () => {
  const m = await sessionFor(manager);
  const html = await m.post(`${BASE}/preview`, { subject: 'Draft for {client}', opening: 'Write to {contact}.\n\n- Item A', closing: '' });
  assert.equal(html.status, 200);
  assert.match(String(html.headers['content-security-policy']), /sandbox/);
  assert.match(html.text, /Write to Kabir Mehta at <a href="mailto:kabir@firm\.example"/);
  const text = await m.post(`${BASE}/preview`, { subject: 'Draft for {client}', opening: 'See [the guide](https://firm.example/g).\n\n- Item A', closing: '', as: 'text' });
  assert.match(text.text, /Subject: Draft for Konkan Coastal Bank/);
  assert.match(text.text, /See the guide \(https:\/\/firm\.example\/g\)\./);
  assert.match(text.text, /^- Item A$/m);
  const c = await sessionFor(consultant);
  assert.equal((await c.post(`${BASE}/preview`, { opening: 'x' })).status, 200, 'anyone who can see the emails can preview');
});

test('send me a test email: goes only to the manager, with sample details, and keeps the unsaved wording', async () => {
  const m = await sessionFor(manager);
  const before = (await db.prepare('SELECT COUNT(*)::int AS n FROM tp_events').get()).n;
  const res = await m.post(`${BASE}/edit`, { intent: 'test', subject: 'Test me {client}', opening: 'Unsaved **words** with [a link](https://firm.example/t).', closing: '' });
  assert.equal(res.status, 200);
  assert.match(res.text, /data-tprm-email-notice[^>]*>Test email sent to editor-manager@test\.local/);
  assert.match(res.text, /name="subject" maxlength="200" value="Test me \{client\}"/);
  const sent = await db.prepare(`SELECT to_email, subject, body_html, body_text FROM email_outbox WHERE related_type = ? ORDER BY id DESC LIMIT 1`).get(`tprm_test:${KIND}`);
  assert.equal(sent.to_email, manager.email);
  assert.equal(sent.subject, 'Test: Test me Konkan Coastal Bank');
  assert.match(sent.body_html, /Unsaved <strong>words<\/strong>/);
  assert.match(sent.body_text, /a link \(https:\/\/firm\.example\/t\)/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS n FROM tp_events').get()).n, before, 'no assessment history is written');
  const saved = await db.prepare('SELECT subject FROM tp_email_templates WHERE firm_id = ? AND kind = ?').get(firmId, KIND);
  assert.notEqual(saved && saved.subject, 'Test me {client}', 'a test does not save');
});

test('the invitation uses the formatted wording, with {due} and {contact}', async () => {
  const tpl = require('../lib/tprm/email-templates');
  assert.deepEqual(await tpl.fieldsFor('vendor_invitation'), ['name', 'client', 'supplier', 'firm', 'due', 'contact']);
  const m = await tpl.preview('vendor_invitation', { format: 'rich', opening: 'Please reply by **{due}** to {contact}.', closing: '- Bring your SOC 2 report' }, 'Acme Advisory');
  assert.match(m.html, /Please reply by <strong>22 Dec 2026<\/strong> to Kabir Mehta at <a href="mailto:kabir@firm\.example"/);
  assert.match(m.html, /<li[^>]*>Bring your SOC 2 report<\/li>/);
  assert.match(m.text, /^- Bring your SOC 2 report$/m);
});

test('{contact} falls back to the firm name when no reviewer can be named', () => {
  const d = { toName: 'Priya', firmName: 'Firm LLP', clientName: 'Bank', thirdPartyName: 'Lumen', until: '22 Dec 2026', sentDay: '1 Dec 2026', url: 'https://app.example/x', contact: null };
  const m = email.renderTprmEmail(KIND, d, { format: 'rich', opening: 'Questions? Write to {contact}.' });
  assert.match(m.html, /Questions\? Write to Firm LLP\./);
  assert.match(m.text, /Questions\? Write to Firm LLP\./);
  assert.match(markup.toText('Write to {contact}.', {}), /Write to us\./);
});

test('wording saved before the editor existed becomes the first version, so it can be put back', async () => {
  const kind = 'vendor_receipt';
  await db.prepare(`INSERT INTO tp_email_templates (firm_id, kind, subject, opening, updated_by) VALUES (?, ?, ?, ?, ?)`).run(firmId, kind, 'Old subject', 'Old *plain* words', manager.id);
  const m = await sessionFor(manager);
  const page = await m.get(`/tprm/settings/emails/${kind}/edit`);
  assert.match(page.text, /<textarea[^>]*name="opening"[^>]*>Old \\\*plain\\\* words<\/textarea>/, 'old asterisks stay literal in the editor');
  const rv = (await db.prepare('SELECT row_version FROM tp_email_templates WHERE firm_id = ? AND kind = ?').get(firmId, kind)).row_version;
  assert.equal((await m.post(`/tprm/settings/emails/${kind}/edit`, { intent: 'save', subject: 'New subject', opening: 'New', row_version: String(rv) })).status, 302);
  const versions = await db.prepare('SELECT id, subject, format FROM tp_email_template_versions WHERE firm_id = ? AND kind = ? ORDER BY id').all(firmId, kind);
  assert.deepEqual(versions.map(v => [v.subject, v.format]), [['Old subject', 'plain'], ['New subject', 'rich']]);
  const back = await m.post(`/tprm/settings/emails/${kind}/versions/${versions[0].id}/restore`, {});
  assert.match(toastOf(back), /put back/);
  const row = await db.prepare('SELECT subject, opening, format FROM tp_email_templates WHERE firm_id = ? AND kind = ?').get(firmId, kind);
  assert.deepEqual([row.subject, row.opening, row.format], ['Old subject', 'Old *plain* words', 'plain']);
  assert.match((await m.get(`/tprm/settings/emails/${kind}/preview`)).text, /Old \*plain\* words/);
});

test('the migration copies wording saved earlier into the versions list', async () => {
  const kind = 'vendor_overdue';
  await db.prepare(`INSERT INTO tp_email_templates (firm_id, kind, subject, updated_by) VALUES (?, ?, ?, ?)`).run(firmId, kind, 'Before the editor', manager.id);
  await db.prepare(`INSERT INTO tp_email_templates (firm_id, kind, subject, updated_by) VALUES (?, ?, ?, ?)`).run(firmId, 'consultant_submitted', 'Team only', manager.id);
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations', '146_tprm_email_editor.sql'), 'utf8');
  await db.exec(sql.slice(sql.indexOf('INSERT INTO tp_email_template_versions')));
  await db.exec(sql.slice(sql.indexOf('INSERT INTO tp_email_template_versions')));
  const rows = await db.prepare('SELECT kind, subject FROM tp_email_template_versions WHERE firm_id = ? AND kind IN (?, ?)').all(firmId, kind, 'consultant_submitted');
  assert.deepEqual(rows.map(r => [r.kind, r.subject]), [[kind, 'Before the editor']], 'once, and not for team emails');
});
