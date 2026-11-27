'use strict';

process.env.EMAIL_DELIVERY_DISABLED = '0';
for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
process.env.EMAIL_DEV_OUTBOX = require('node:path').join(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tprm-issues-outbox-')), 'outbox.log');

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
  consultant = await makeUser('is-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('is-senior@test.local', { role: 'senior_consultant' });
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
  assert.equal(res.status, 303, res.text.slice(0, 300));
  assert.equal((await qRow(ctx.a)).status, 'submitted');
  return ctx;
}

const firmPage = ctx => allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));


const issuesPage = token => request('GET', `/vendor/q/${token}/issues`);
const mails = async (ws, kind) => db.prepare('SELECT * FROM email_outbox WHERE workspace_id=? AND related_type=? ORDER BY id').all(ws, `tprm:${kind}`);
const issueRow = async a => db.prepare(`SELECT *, to_char(agreed_date, 'YYYY-MM-DD') AS agreed_day FROM tp_issues WHERE assessment_id=?`).get(a);

async function withFinding(name) {
  const ctx = await submitted(name);
  const base = aBase(ctx.ws, ctx.tp, ctx.a);
  const added = await consultant.session.post(`${base}/findings`, {
    control_ref: 'A.5.20', severity: 'high', title: 'No supplier access review',
    description: 'Access to the hosting console is not reviewed.', impact: 'The client cannot show its auditors who holds production access.',
  });
  assert.equal(added.status, 302, toast(added));
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=?').get(ctx.a);
  return { ...ctx, base, finding };
}

async function shared(name, fields = {}) {
  const ctx = await withFinding(name);
  const res = await consultant.session.post(`${ctx.base}/findings/${ctx.finding.id}/share`, {
    title: 'Access reviews', body: 'Please tell us how and how often access to the hosting console is reviewed.', ...fields,
  });
  assert.equal(res.status, 302, toast(res));
  return { ...ctx, issue: await issueRow(ctx.a) };
}

test('the consultant chooses what the third party sees, and the third party is emailed the link', async () => {
  const ctx = await withFinding('Share Co');
  const form = await consultant.session.get(`${ctx.base}/findings/${ctx.finding.id}/share`);
  assert.equal(form.status, 200);
  assert.match(form.text, /data-tprm-issue-share-form/);
  assert.match(form.text, /Access to the hosting console is not reviewed\./, 'the text starts from the finding');
  assert.doesNotMatch(form.text, /cannot show its auditors/, 'why it matters is not offered for sharing');

  const empty = await consultant.session.post(`${ctx.base}/findings/${ctx.finding.id}/share`, { title: '', body: '' });
  assert.equal(empty.status, 400);
  assert.match(empty.text, /Write the title the third party will see/);
  assert.equal(await issueRow(ctx.a), undefined);

  const res = await consultant.session.post(`${ctx.base}/findings/${ctx.finding.id}/share`, { title: 'Access reviews', body: 'How is console access reviewed?' });
  assert.equal(res.status, 302);
  assert.match(toast(res), /Shared with the third party/);
  const issue = await issueRow(ctx.a);
  assert.equal(issue.status, 'open');
  assert.equal(issue.title, 'Access reviews');

  const reopen = await consultant.session.get(`${ctx.base}/findings/${ctx.finding.id}/share`);
  assert.equal(reopen.status, 302);
  assert.match(reopen.location, new RegExp(`#issue-${issue.id}`));
  const again = await consultant.session.post(`${ctx.base}/findings/${ctx.finding.id}/share`, { title: 'Twice', body: 'Twice' });
  assert.equal(again.status, 302);
  assert.match(toast(again), /already shared/);

  const sent = await mails(ctx.ws, 'vendor_issue_shared');
  assert.equal(sent.length, 1);
  const box = fs.readFileSync(process.env.EMAIL_DEV_OUTBOX, 'utf8');
  assert.match(box, /An issue from your security review for Share Co Client/);
  assert.match(box, /Sign in with the button below to respond/, 'a submitted link is not repeated in email, so the third party signs in instead');
  assert.match(box, /\/vendor\/p\/sign-in/);
  assert.ok(!box.includes(ctx.token), 'the token is not in the email');

  const page = (await firmPage(ctx)).text;
  assert.match(page, /data-tprm-issues/);
  assert.match(page, new RegExp(`id="issue-${issue.id}"`));
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  assert.ok(actions.includes('issue.shared'));
});

test('the third party sees only what was shared, and can reply or propose a fix with JavaScript off', async () => {
  const ctx = await shared('Respond Co');
  const page = await issuesPage(ctx.token);
  assert.equal(page.status, 200);
  assert.match(page.text, /Access reviews/);
  assert.match(page.text, /how often access to the hosting console is reviewed/);
  assert.doesNotMatch(page.text, /cannot show its auditors/);
  assert.doesNotMatch(page.text, /No supplier access review/, 'the internal finding title stays with the firm');
  assert.doesNotMatch(page.text, /<script/);
  assert.match(page.text, /Response needed/);

  const aft = aftOf(page.text);
  const noDate = await postForm(ctx.token, `/issues/${ctx.issue.id}`, [['proposed_fix', 'Quarterly reviews from next month']], { aft });
  assert.equal(noDate.status, 400);
  assert.match(noDate.text, /Give the date by which the fix will be done/);
  assert.match(noDate.text, /Quarterly reviews from next month/, 'typed text is kept');

  const forged = await postForm(ctx.token, `/issues/${ctx.issue.id}`, [['body', 'Hello']], { aft: 'nope' });
  assert.equal(forged.status, 403);

  const reply = await postForm(ctx.token, `/issues/${ctx.issue.id}`, [['body', 'We review it every six months today.']], { aft });
  assert.equal(reply.status, 303);
  assert.match(reply.location, /\/issues\?notice=sent#issue-/);
  assert.equal((await issueRow(ctx.a)).status, 'open');

  const fix = await postForm(ctx.token, `/issues/${ctx.issue.id}`, [['proposed_fix', 'Quarterly reviews, signed off by the CISO'], ['proposed_date', '2027-03-31']], { aft });
  assert.equal(fix.status, 303);
  assert.equal((await issueRow(ctx.a)).status, 'proposed');
  const after = await issuesPage(ctx.token);
  assert.match(after.text, /Fix proposed/);
  assert.match(after.text, /We review it every six months today\./);

  assert.equal((await mails(ctx.ws, 'consultant_issue_reply')).length >= 2, true, 'the consultants hear about each response');
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  assert.ok(actions.includes('issue.vendor_replied'));
  assert.ok(actions.includes('issue.fix_proposed'));

  const done = await vget(ctx.token);
  assert.match(done.text, new RegExp(`/vendor/q/${ctx.token}/issues`), 'the submitted page links to the issues');
});

test('the consultant replies, agrees the fix, and the agreed fix becomes a condition of the draft', async () => {
  const ctx = await shared('Agree Co');
  const aft = aftOf((await issuesPage(ctx.token)).text);
  const early = await consultant.session.post(`${ctx.base}/issues/${ctx.issue.id}/agree`, { row_version: String(ctx.issue.row_version) });
  assert.equal(early.status, 302);
  assert.match(toast(early), /no proposed fix/);

  const reply = await consultant.session.post(`${ctx.base}/issues/${ctx.issue.id}/reply`, { body: 'Please include who signs the review off.' });
  assert.equal(reply.status, 302);
  assert.match(toast(reply), /Reply sent/);
  assert.equal((await mails(ctx.ws, 'vendor_issue_update')).length, 1);
  assert.match((await issuesPage(ctx.token)).text, /Please include who signs the review off\./);

  assert.equal((await postForm(ctx.token, `/issues/${ctx.issue.id}`, [['proposed_fix', 'Quarterly reviews signed off by the CISO'], ['proposed_date', '2027-03-31']], { aft })).status, 303);
  const proposed = await issueRow(ctx.a);
  const stale = await consultant.session.post(`${ctx.base}/issues/${ctx.issue.id}/agree`, { row_version: String(Number(proposed.row_version) - 1) });
  assert.match(toast(stale), /Someone else changed this issue/);
  const agreed = await consultant.session.post(`${ctx.base}/issues/${ctx.issue.id}/agree`, { row_version: String(proposed.row_version) });
  assert.equal(agreed.status, 302);
  const row = await issueRow(ctx.a);
  assert.equal(row.status, 'agreed');
  assert.equal(row.agreed_fix, 'Quarterly reviews signed off by the CISO');
  assert.equal(row.agreed_day, '2027-03-31');
  assert.equal((await mails(ctx.ws, 'vendor_issue_update')).length, 2, 'the third party hears the fix was agreed');
  assert.match((await issuesPage(ctx.token)).text, /Agreed fix/);

  const after = await consultant.session.post(`${ctx.base}/issues/${ctx.issue.id}/reply`, { body: 'Thank you, we will check the proof in March.' });
  assert.equal(after.status, 302);
  const updates = await mails(ctx.ws, 'vendor_issue_update');
  assert.equal(updates.length, 3);
  assert.match(updates[2].subject, /^A reply on an issue/, 'a reply after agreement is sent as a reply, not as another agreement');

  const fixes = await require('../lib/tprm/issues').agreedFixes(db, ctx.ws, ctx.a);
  assert.deepEqual(fixes.map(f => [f.description, f.owner, f.due_date]), [['Quarterly reviews signed off by the CISO', 'vendor', '2027-03-31']]);

  const removal = await consultant.session.post(`${ctx.base}/findings/${ctx.finding.id}/remove`, { row_version: String(ctx.finding.row_version || 1) });
  assert.equal(removal.status, 409);
  assert.ok(await db.prepare('SELECT 1 FROM tp_findings WHERE id=?').get(ctx.finding.id), 'a shared finding cannot be removed');
});

test('a withdrawn issue disappears for the third party and cannot be answered', async () => {
  const ctx = await shared('Withdraw Co');
  const aft = aftOf((await issuesPage(ctx.token)).text);
  const res = await consultant.session.post(`${ctx.base}/issues/${ctx.issue.id}/withdraw`, { row_version: String(ctx.issue.row_version) });
  assert.equal(res.status, 302);
  assert.match(toast(res), /Issue withdrawn/);
  const page = await issuesPage(ctx.token);
  assert.doesNotMatch(page.text, /Access reviews/);
  assert.match(page.text, /data-vendor-issues-empty/);
  const late = await postForm(ctx.token, `/issues/${ctx.issue.id}`, [['body', 'Too late']], { aft });
  assert.equal(late.status, 404);
  const done = await vget(ctx.token);
  assert.doesNotMatch(done.text, /\/issues"/);
});

test('issues are private to the link and the workspace', async () => {
  const one = await shared('Private One Co');
  const two = await submitted('Private Two Co');
  const page = await issuesPage(two.token);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Access reviews/);
  const aft = require('../lib/tprm/vendor-answers').formToken(require('../lib/tprm/questionnaires').hashToken(two.token));
  const cross = await postForm(two.token, `/issues/${one.issue.id}`, [['body', 'Not mine']], { aft });
  assert.equal(cross.status, 404);
  assert.equal((await issuesPage('not-a-real-token')).status, 404);
  const otherBase = aBase(two.ws, two.tp, two.a);
  const foreign = await consultant.session.post(`${otherBase}/issues/${one.issue.id}/withdraw`, {});
  assert.equal(foreign.status, 404);
  assert.equal((await issueRow(one.a)).status, 'open');
});

async function proposedFix(ctx, fix = 'Quarterly reviews signed off by the CISO', date = '2027-03-31') {
  const aft = aftOf((await issuesPage(ctx.token)).text);
  assert.equal((await postForm(ctx.token, `/issues/${ctx.issue.id}`, [['proposed_fix', fix], ['proposed_date', date]], { aft })).status, 303);
  return await issueRow(ctx.a);
}
const draftFor = async ctx => {
  const res = await consultant.session.post(`${ctx.base}/recommendations`, { row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(res.status, 302, toast(res));
  return db.prepare(`SELECT * FROM tp_recommendations WHERE assessment_id=? AND status='draft'`).get(ctx.a);
};
const conditionsOf = async rid => db.prepare(`SELECT description, owner, to_char(due_date, 'YYYY-MM-DD') AS due, finding_id FROM tp_conditions WHERE recommendation_id=? ORDER BY position`).all(rid);

test('agreeing a fix while a recommendation is drafted adds it to the draft as a condition owned by the third party', async () => {
  const ctx = await shared('Draft Open Co');
  const draft = await draftFor(ctx);
  const before = (await conditionsOf(draft.id)).length;
  const row = await proposedFix(ctx);
  const res = await consultant.session.post(`${ctx.base}/issues/${ctx.issue.id}/agree`, { row_version: String(row.row_version) });
  assert.equal(res.status, 302);
  assert.match(toast(res), /added as a condition of the draft recommendation/);
  const conds = await conditionsOf(draft.id);
  assert.equal(conds.length, before + 1);
  assert.deepEqual(conds[conds.length - 1], { description: 'Quarterly reviews signed off by the CISO', owner: 'vendor', due: '2027-03-31', finding_id: ctx.finding.id });
});

test('a fix agreed before the recommendation is drafted is in the new draft', async () => {
  const ctx = await shared('Draft Later Co');
  const row = await proposedFix(ctx, 'Encrypt the backups', '2027-02-28');
  const res = await consultant.session.post(`${ctx.base}/issues/${ctx.issue.id}/agree`, { row_version: String(row.row_version) });
  assert.match(toast(res), /toast=Fix agreed#/);
  const missing = await consultant.session.post(`${ctx.base}/issues/${ctx.issue.id}/withdraw`, {});
  assert.match(toast(missing), /Someone else changed this issue/, 'a change without the version it was made from is refused');
  const draft = await draftFor(ctx);
  const conds = await conditionsOf(draft.id);
  assert.ok(conds.some(c => c.description === 'Encrypt the backups' && c.owner === 'vendor' && c.due === '2027-02-28' && Number(c.finding_id) === Number(ctx.finding.id)), JSON.stringify(conds));
});

test('sharing when the third party has no working link says so', async () => {
  const ctx = await withFinding('No Link Co');
  await db.transaction(async () => {
    await db.exec('ALTER TABLE tp_vendor_requests DISABLE TRIGGER USER');
    await db.prepare(`UPDATE tp_vendor_requests SET status = 'revoked', revoked_at = now(), revoke_reason = 'replaced' WHERE assessment_id=?`).run(ctx.a);
    await db.exec('ALTER TABLE tp_vendor_requests ENABLE TRIGGER USER');
  })();
  const res = await consultant.session.post(`${ctx.base}/findings/${ctx.finding.id}/share`, { title: 'Access reviews', body: 'How is access reviewed?' });
  assert.equal(res.status, 302);
  assert.match(toast(res), /no main contact and no working link/);
  assert.equal((await mails(ctx.ws, 'vendor_issue_shared')).length, 0);
});
