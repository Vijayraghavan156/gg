'use strict';

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
const good = id => completeAnswer(BANK_BY_ID.get(id), id, { ref: `Policy for ${id}`, date: '2026-01-15' });
const PASSWORD = 'after-completion-tests-password-1234';
const LOW = {
  data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily',
  delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no',
};
const FIX = 'Pilot on 10 terminals in December.';
const FIX_DAY = '2099-01-31';

let env;
let client;
let db;
let firmId;
let consultant;
let senior;
let vendorRoute;
const sessions = [];
const createdPaths = new Set();

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  vendorRoute = require('../routes/tprm-vendor');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('ac-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('ac-senior@test.local', { role: 'senior_consultant' });
  for (const u of [consultant, senior]) u.session = await signIn(u.email);
});

test.beforeEach(() => {
  for (const l of [vendorRoute.limiter, vendorRoute.postLimiter, vendorRoute.conditionsLimiter, vendorRoute.conditionsPostLimiter]) if (l) l.reset();
});

test.after(async () => {
  for (const p of await db.prepare('SELECT stored_path FROM tp_evidence UNION SELECT stored_path FROM tp_condition_proof_files').all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  for (const s of sessions) await s.close();
  for (const u of [consultant, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

async function makeUser(email, { type = 'firm', role = 'consultant', workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firmId : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email, firm_role: role };
}

async function signIn(email) {
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${email} signs in`);
  await session.get('/dashboard');
  return session;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = ctx => `/tprm/clients/${ctx.ws}/third-parties/${ctx.tp}/assessments/${ctx.a}`;
const recPage = ctx => `/workspaces/${ctx.ws}/client-portal/third-party-risk/recommendations/${ctx.rid}`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const issueRow = async a => db.prepare('SELECT * FROM tp_issues WHERE assessment_id=? ORDER BY id').get(a);
const findingRow = async id => db.prepare('SELECT * FROM tp_findings WHERE id=?').get(id);
const condRow = async id => db.prepare('SELECT * FROM tp_conditions WHERE id=?').get(id);
const mails = async (ws, kind) => db.prepare('SELECT * FROM email_outbox WHERE workspace_id=? AND related_type=? ORDER BY id').all(ws, `tprm:${kind}`);
const aftOf = text => (String(text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];

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
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), location: res.headers.location || null, headers: res.headers });
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body != null) req.write(body);
      req.end();
    });
  });
}

function multipart(fields) {
  const boundary = '----tprmac' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of fields) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function vform(urlPath, fields, aft) {
  const body = new URLSearchParams([['_aft', aft], ...fields]).toString();
  return await request('POST', urlPath, { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
}

const issuesPage = ctx => request('GET', `/vendor/q/${ctx.token}/issues`);

async function setup(name) {
  const ws = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, `${name} Client`)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(ws);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(ws, u.id, u.firm_role);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`ac-owner-${slug}@test.local`, { type: 'client', workspaceId: ws, memberRole: 'client_owner' });
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosted service' })).status, 302);
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  const a = idIn(started.location, /assessments\/(\d+)/);
  const ctx = { ws, tp, a, owner };
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const scope = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) scope[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ctx)}/scope`, scope)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ctx)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(`${aBase(ctx)}/details`, {
    client_decision_owner_id: String(owner.id), due_date: '', row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(`${aBase(ctx)}/questionnaire`, {})).status, 302);
  const q = await db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(a);
  const link = await consultant.session.post(`${aBase(ctx)}/questionnaire/links`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(q.row_version) });
  ctx.token = ((link.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || '').split('/vendor/q/')[1];
  assert.ok(ctx.token, 'a questionnaire link was made');
  const answers = {};
  for (const id of q.sections.flatMap(s => s.ids)) answers[id] = good(id);
  answers['AIS-01'] = { r: 'no', d: 'No AI is used to provide the service.' };
  const first = await request('GET', `/vendor/q/${ctx.token}`);
  const form = multipart([['_aft', aftOf(first.text)], ...answerFormFields(answers, BANK_BY_ID), ['intent', 'save']]);
  assert.equal((await request('POST', `/vendor/q/${ctx.token}/save`, { body: form.body, headers: form.headers })).status, 303);
  const page = await request('GET', `/vendor/q/${ctx.token}`);
  assert.equal((await vform(`/vendor/q/${ctx.token}/submit`, [], aftOf(page.text))).status, 303);
  return ctx;
}

async function addFinding(ctx, title) {
  const res = await consultant.session.post(`${aBase(ctx)}/findings`, { control_ref: 'A.8.9', severity: 'medium', title, description: `${title} in detail.` });
  assert.equal(res.status, 302, toast(res));
  return Number((await db.prepare('SELECT id FROM tp_findings WHERE assessment_id=? AND title=?').get(ctx.a, title)).id);
}

async function agreedIssue(ctx, findingId) {
  assert.equal((await consultant.session.post(`${aBase(ctx)}/findings/${findingId}/share`, { title: 'Card terminals', body: 'How will the terminals be patched?' })).status, 302);
  const issue = await issueRow(ctx.a);
  const aft = aftOf((await issuesPage(ctx)).text);
  assert.equal((await vform(`/vendor/q/${ctx.token}/issues/${issue.id}`, [['proposed_fix', FIX], ['proposed_date', FIX_DAY]], aft)).status, 303);
  const proposed = await issueRow(ctx.a);
  assert.equal((await consultant.session.post(`${aBase(ctx)}/issues/${issue.id}/agree`, { row_version: String(proposed.row_version) })).status, 302);
  assert.equal((await issueRow(ctx.a)).status, 'agreed');
  return Number(issue.id);
}

async function completeWith(ctx, conditions) {
  await db.prepare(`UPDATE tp_answers SET review_conclusion = 'satisfactory', reviewed_by = ?, reviewed_at = now() WHERE assessment_id = ?`).run(consultant.id, ctx.a);
  await db.prepare(`UPDATE tp_questionnaires SET status = 'closed', closed_at = now(), closed_reason = 'Reviewed', closed_by = ?, row_version = row_version + 1
    WHERE assessment_id = ?`).run(consultant.id, ctx.a);
  assert.equal((await consultant.session.post(`${aBase(ctx)}/recommendations`, { row_version: String((await assessmentRow(ctx.a)).row_version) })).status, 302);
  ctx.rid = Number((await db.prepare("SELECT id FROM tp_recommendations WHERE assessment_id=? AND status='draft'").get(ctx.a)).id);
  const body = { outcome: conditions.length ? 'approve_with_conditions' : 'approve', residual_rating: 'medium', rationale: 'Adequate with the agreed fix.',
    valid_until: '2099-12-31', intent: 'submit' };
  conditions.forEach((c, i) => {
    body[`conditions[${i}][description]`] = c.description;
    body[`conditions[${i}][owner]`] = c.owner || 'vendor';
    body[`conditions[${i}][due_date]`] = c.due || FIX_DAY;
    if (c.finding) body[`conditions[${i}][finding_id]`] = String(c.finding);
  });
  body.row_version = String((await db.prepare('SELECT row_version FROM tp_recommendations WHERE id=?').get(ctx.rid)).row_version);
  const saved = await consultant.session.post(`${aBase(ctx)}/recommendations/${ctx.rid}`, body);
  assert.equal(saved.status, 302, String(saved.text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600));
  const issued = await senior.session.post(`${aBase(ctx)}/recommendations/${ctx.rid}/issue`, {
    row_version: String((await db.prepare('SELECT row_version FROM tp_recommendations WHERE id=?').get(ctx.rid)).row_version) });
  assert.equal(issued.status, 302, toast(issued));
  const owner = await signIn(ctx.owner.email);
  sessions.push(owner);
  await owner.get(recPage(ctx));
  const decided = await owner.post(`${recPage(ctx)}/decision`, { outcome: body.outcome });
  assert.equal(decided.status, 302, toast(decided));
  assert.equal((await assessmentRow(ctx.a)).status, 'completed');
}

let flowCtx = null;
async function flow() {
  if (flowCtx) return flowCtx;
  const ctx = await setup('Terminal Co');
  ctx.findingId = await addFinding(ctx, 'Unpatched card terminals');
  ctx.issueId = await agreedIssue(ctx, ctx.findingId);
  const otherFinding = await addFinding(ctx, 'Shared admin accounts');
  assert.equal((await consultant.session.post(`${aBase(ctx)}/findings/${otherFinding}/share`, { title: 'Admin accounts', body: 'Who uses the admin account?' })).status, 302);
  ctx.otherIssue = Number((await db.prepare('SELECT id FROM tp_issues WHERE finding_id=?').get(otherFinding)).id);
  await completeWith(ctx, [{ description: FIX, finding: ctx.findingId }]);
  ctx.cid = Number((await db.prepare('SELECT id FROM tp_conditions WHERE recommendation_id=? AND finding_id=?').get(ctx.rid, ctx.findingId)).id);
  flowCtx = ctx;
  return ctx;
}

test('the supplier issue thread writes the fix date in brackets after the fix', async () => {
  const ctx = await flow();
  const page = await issuesPage(ctx);
  assert.match(page.text, /Proposed fix: Pilot on 10 terminals in December\. \(by 31 Jan 2099\)/);
  assert.doesNotMatch(page.text, /December\., by/);
});

test('the firm\'s issue panel writes the agreed fix with its date in brackets, as one sentence', async () => {
  const ctx = await flow();
  const firm = (await consultant.session.get(`${aBase(ctx)}?step=evidence`)).text;
  assert.match(firm, /data-tprm-issue-agreed>Agreed fix: Pilot on 10 terminals in December \(by 31 Jan 2099\)<\/p>/);
  assert.doesNotMatch(firm, /December\., by/);
});

test('after completion the supplier can still answer the firm on an open issue and is emailed, but cannot propose a new fix', async () => {
  const ctx = await flow();
  const page = await issuesPage(ctx);
  assert.match(page.text, new RegExp(`data-vendor-issue-form="${ctx.issueId}"`), 'the supplier can still reply after completion');
  assert.match(page.text, new RegExp(`data-vendor-issue-form="${ctx.otherIssue}"`));
  assert.doesNotMatch(page.text, /name="proposed_fix"/, 'but cannot propose a new fix');
  const before = (await mails(ctx.ws, 'vendor_issue_update')).length;
  const asked = await consultant.session.post(`${aBase(ctx)}/issues/${ctx.issueId}/reply`, { body: 'Which terminal models are in the pilot?' });
  assert.match(toast(asked), /Reply sent/);
  assert.equal((await mails(ctx.ws, 'vendor_issue_update')).length, before + 1, 'the supplier is emailed the question');
  const aft = aftOf(page.text);
  const late = await vform(`/vendor/q/${ctx.token}/issues/${ctx.otherIssue}`, [['proposed_fix', 'Another fix'], ['proposed_date', FIX_DAY]], aft);
  assert.equal(late.status, 409);
  assert.match(late.text, /The review is completed, so a new fix can no longer be agreed here/);
  const replied = await vform(`/vendor/q/${ctx.token}/issues/${ctx.issueId}`, [['body', 'Model T200 only.']], aft);
  assert.equal(replied.status, 303, replied.text.slice(0, 300));
  assert.match((await issuesPage(ctx)).text, /Model T200 only\./);
});

test('the supplier issue shows where the proof is, and verifying the linked condition closes the finding and the issue', async () => {
  const ctx = await flow();
  let page = await issuesPage(ctx);
  assert.match(page.text, /data-vendor-issue-stage="proof_due"/);
  assert.match(page.text, /Send proof that it is done with the conditions link you were emailed\./);
  await consultant.session.get(aBase(ctx));
  const made = await consultant.session.post(`${aBase(ctx)}/conditions-link`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', expires_in_days: '30' });
  ctx.ctoken = ((made.text.match(/value="([^"]*\/vendor\/c\/[A-Za-z0-9_-]+)"/) || [])[1] || '').split('/vendor/c/')[1];
  assert.ok(ctx.ctoken, 'a conditions link was made');
  const cpage = await request('GET', `/vendor/c/${ctx.ctoken}`);
  const proof = multipart([['_aft', aftOf(cpage.text)], ['note', 'Pilot done on all 10 terminals.']]);
  assert.equal((await request('POST', `/vendor/c/${ctx.ctoken}/conditions/${ctx.cid}/proof`, { body: proof.body, headers: proof.headers })).status, 303);
  page = await issuesPage(ctx);
  assert.match(page.text, /data-vendor-issue-stage="proof_sent"/);
  assert.doesNotMatch(page.text, /You will be asked for proof when it is done/);

  await consultant.session.get(aBase(ctx));
  const verified = await consultant.session.post(`${aBase(ctx)}/conditions/${ctx.cid}/verify`, { row_version: String((await condRow(ctx.cid)).row_version) });
  assert.equal(verified.status, 302, toast(verified));
  assert.equal((await condRow(ctx.cid)).status, 'verified');
  const finding = await findingRow(ctx.findingId);
  assert.equal(finding.status, 'closed', 'verifying the linked condition closes the finding');
  assert.match(finding.close_reason, /Condition 1 was verified/);
  assert.equal(Number(finding.closed_by), consultant.id);

  page = await issuesPage(ctx);
  assert.match(page.text, /data-vendor-issue-stage="closed"/);
  assert.match(page.text, /data-vendor-issue-label>Closed</);
  assert.match(page.text, /Nothing more is needed: this issue is closed\./);
  assert.doesNotMatch(page.text, new RegExp(`data-vendor-issue-form="${ctx.issueId}"`), 'a closed issue takes no more replies');
  assert.equal((await vform(`/vendor/q/${ctx.token}/issues/${ctx.issueId}`, [['body', 'Anything else?']], aftOf(page.text))).status, 409);
  assert.match(toast(await consultant.session.post(`${aBase(ctx)}/issues/${ctx.issueId}/reply`, { body: 'Late' })), /This finding is closed/);
  const firm = (await consultant.session.get(`${aBase(ctx)}?step=evidence`)).text;
  assert.match(firm, /Closed: the finding is closed/);
});

test('a conditions link closed because every condition is met says the proof was accepted, and the supplier is emailed', async () => {
  const ctx = await flow();
  assert.ok(ctx.ctoken, 'the previous test made the link');
  const done = await request('GET', `/vendor/c/${ctx.ctoken}`);
  assert.equal(done.status, 200, 'the closed conditions link explains itself');
  assert.match(done.text, /data-vendor-conditions-done/);
  assert.match(done.text, /Your proof was accepted\. Every condition for you is met, so nothing more is needed\./);
  assert.doesNotMatch(done.text, /This link is not valid/);
  const accepted = await mails(ctx.ws, 'vendor_proof_accepted');
  assert.equal(accepted.length, 1, 'the supplier is emailed that the proof was accepted');
  assert.equal(accepted[0].to_email, 'priya@thirdparty.example.net');
  assert.match(accepted[0].subject, /^Proof accepted: condition 1 for Terminal Co Client$/);
  assert.match(accepted[0].body_html, /nothing more is needed/);
  assert.equal((await request('GET', '/vendor/c/not-a-real-token')).status, 404, 'an unknown link is still not valid');
});

test('the client portal writes the date an issue closed in the client\'s own zone', async () => {
  const ctx = await flow();
  assert.equal((await findingRow(ctx.findingId)).status, 'closed');
  const at = await db.prepare("SELECT to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS t FROM tp_findings WHERE id = ?").get(ctx.findingId);
  const utcHour = Number(at.t.slice(11, 13));
  const zone = utcHour < 12 ? 'Pacific/Honolulu' : 'Pacific/Kiritimati';
  await db.prepare('UPDATE workspaces SET timezone = ? WHERE id = ?').run(zone, ctx.ws);
  try {
    const expected = require('../lib/tprm/format').forZone(zone).day(new Date(`${at.t}Z`));
    assert.notEqual(expected, require('../lib/tprm/format').forZone('UTC').day(new Date(`${at.t}Z`)), 'the zone chosen moves the date');
    const owner = await signIn(ctx.owner.email);
    sessions.push(owner);
    const page = (await owner.get(`/workspaces/${ctx.ws}/client-portal/third-party-risk/third-parties/${ctx.tp}?tab=issues`)).text;
    assert.match(page, new RegExp(`data-tprm-cv-issue-closed><b>Closed on ${expected}\\.</b>`));
  } finally {
    await db.prepare('UPDATE workspaces SET timezone = NULL WHERE id = ?').run(ctx.ws);
  }
});

test('a signed-in supplier who opens conditions after every one is met sees that the proof was accepted, not the home page', async () => {
  const ctx = await flow();
  assert.ok(ctx.ctoken, 'the earlier test made and closed the conditions link');
  const page = await issuesPage(ctx);
  const started = await vform(`/vendor/q/${ctx.token}/home`, [], aftOf(page.text));
  assert.equal(started.status, 303, started.text.slice(0, 300));
  const cookie = (started.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('tpv_sid='));
  assert.ok(cookie, 'a portal session started');
  const done = await request('GET', `/vendor/p/a/${ctx.a}/c`, { headers: { cookie } });
  assert.equal(done.status, 200, done.location || '');
  assert.match(done.text, /data-vendor-conditions-done/);
  assert.match(done.text, /Your proof was accepted\. Every condition for you is met, so nothing more is needed\./);
});

test('the client portal shows an issue whose finding was closed as closed, not as a fix still agreed', async () => {
  const ctx = await flow();
  assert.equal((await findingRow(ctx.findingId)).status, 'closed', 'the earlier test closed the finding');
  const owner = await signIn(ctx.owner.email);
  sessions.push(owner);
  const page = (await owner.get(`/workspaces/${ctx.ws}/client-portal/third-party-risk/third-parties/${ctx.tp}?tab=issues`)).text;
  const card = page.slice(page.indexOf(`data-tprm-cv-issue="${ctx.findingId}"`), page.indexOf('</section>', page.indexOf(`data-tprm-cv-issue="${ctx.findingId}"`)));
  assert.match(card, /data-tprm-cv-issue-closed><b>Closed on \d{1,2} [A-Z][a-z]{2} \d{4}\.<\/b> The fix agreed with the supplier was: Pilot on 10 terminals in December \(by 31 Jan 2099\)/);
  assert.doesNotMatch(card, /<b>Fix agreed with the supplier:<\/b>/);
});

test('after completion a finding can be closed with a reason, and only closing gets past the freeze', async () => {
  const ctx = await setup('Closing Co');
  const findingId = await addFinding(ctx, 'Old backup policy');
  await completeWith(ctx, []);
  const firm = (await consultant.session.get(`${aBase(ctx)}?step=evidence`)).text;
  assert.match(firm, new RegExp(`data-tprm-finding-close-after="${findingId}"`));
  const row = await findingRow(findingId);
  const noReason = await consultant.session.post(`${aBase(ctx)}/findings/${findingId}/close`, { close_reason: '', row_version: String(row.row_version) });
  assert.match(toast(noReason), /Say why the finding is closed/);
  assert.equal((await findingRow(findingId)).status, 'open');
  const res = await consultant.session.post(`${aBase(ctx)}/findings/${findingId}/close`, { close_reason: 'New policy approved in March.', row_version: String(row.row_version) });
  assert.match(toast(res), /Finding closed: Old backup policy/);
  const closed = await findingRow(findingId);
  assert.deepEqual([closed.status, closed.close_reason, Number(closed.closed_by)], ['closed', 'New policy approved in March.', consultant.id]);
  const ev = (await db.prepare(`SELECT after_state FROM tp_events WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? AND action='finding.updated'`).all(ctx.ws, ctx.a)).at(-1);
  assert.deepEqual([ev.after_state.status, ev.after_state.close_reason], ['closed', 'New policy approved in March.']);
  const page = (await consultant.session.get(`${aBase(ctx)}?step=evidence`)).text;
  assert.match(page, /data-tprm-finding-closure/);
  assert.doesNotMatch(page, new RegExp(`data-tprm-finding-close-after="${findingId}"`));
  await assert.rejects(db.prepare("UPDATE tp_findings SET title = 'Changed' WHERE id = ?").run(findingId), /frozen/);
  await assert.rejects(db.prepare("UPDATE tp_findings SET status = 'open', close_reason = NULL WHERE id = ?").run(findingId), /frozen/);
});

test('the client Assurance box shows the certificate that runs longest, not the latest uploaded', async () => {
  const ctx = await flow();
  const clientView = require('../lib/tprm/client-view');
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(ctx.ws);
  let seen = false;
  const uploadedNewestFirst = new Proxy(db, { get: (target, prop) => (prop !== 'prepare' ? target[prop] : sql => {
    const stmt = target.prepare(sql);
    if (!/FROM tp_assurance_reports r/.test(sql)) return stmt;
    seen = true;
    return { ...stmt, all: async () => [
      { kind: 'iso27001', expires_on: '2028-06-09', period_end: null, check_status: 'accepted' },
      { kind: 'iso27001', expires_on: '2028-06-14', period_end: null, check_status: 'accepted' },
    ] };
  }) });
  const party = await clientView.thirdParty(uploadedNewestFirst, ws, ctx.tp);
  assert.ok(seen, 'the client page read the reports');
  const iso = party.assurance.find(r => r.kind === 'iso27001');
  assert.equal(iso.expires_on, '2028-06-14', 'the report that runs to 14 Jun 2028 is shown');
});

test('the supplier portal home labels and counts an issue by its finding once the finding is closed', async () => {
  const ctx = await flow();
  const other = await db.prepare('SELECT i.id, i.status, f.id AS finding_id, f.row_version FROM tp_issues i JOIN tp_findings f ON f.id = i.finding_id WHERE i.id = ?').get(ctx.otherIssue);
  assert.equal(other.status, 'open');
  const page = await issuesPage(ctx);
  const started = await vform(`/vendor/q/${ctx.token}/home`, [], aftOf(page.text));
  const cookie = (started.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('tpv_sid='));
  assert.ok(cookie);
  const homeOf = async () => (await request('GET', '/vendor/p/home', { headers: { cookie } })).text;
  assert.match(await homeOf(), /Reply to the issue &#34;Admin accounts&#34;|Reply to the issue "Admin accounts"/);
  const closed = await consultant.session.post(`${aBase(ctx)}/findings/${other.finding_id}/close`, { close_reason: 'Accounts were split in November.', row_version: String(other.row_version) });
  assert.match(toast(closed), /Finding closed/);
  const home = await homeOf();
  const row = home.slice(home.indexOf(`data-vendor-home-issue="${ctx.otherIssue}"`), home.indexOf('</tr>', home.indexOf(`data-vendor-home-issue="${ctx.otherIssue}"`)));
  assert.match(row, /<td>Closed<\/td>/);
  const findingRowFor = home.slice(home.indexOf(`data-vendor-home-issue="${ctx.issueId}"`), home.indexOf('</tr>', home.indexOf(`data-vendor-home-issue="${ctx.issueId}"`)));
  assert.match(findingRowFor, /<td>Closed<\/td>/, 'the agreed issue whose finding was verified closed reads Closed too');
  assert.doesNotMatch(home, /Reply to the issue &#34;Admin accounts&#34;|Reply to the issue "Admin accounts"/);
});

async function proveAndVerify(ctx, cid) {
  if (!ctx.ctoken) {
    await consultant.session.get(aBase(ctx));
    const made = await consultant.session.post(`${aBase(ctx)}/conditions-link`, {
      recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', expires_in_days: '30' });
    ctx.ctoken = ((made.text.match(/value="([^"]*\/vendor\/c\/[A-Za-z0-9_-]+)"/) || [])[1] || '').split('/vendor/c/')[1];
    assert.ok(ctx.ctoken, 'a conditions link was made');
  }
  const cpage = await request('GET', `/vendor/c/${ctx.ctoken}`);
  const proof = multipart([['_aft', aftOf(cpage.text)], ['note', 'Done.']]);
  assert.equal((await request('POST', `/vendor/c/${ctx.ctoken}/conditions/${cid}/proof`, { body: proof.body, headers: proof.headers })).status, 303);
  const verified = await consultant.session.post(`${aBase(ctx)}/conditions/${cid}/verify`, { row_version: String((await condRow(cid)).row_version) });
  assert.match(toast(verified), /Condition verified/);
}

const waiveIt = async (ctx, cid, until = '') => client.post(`${aBase(ctx)}/conditions/${cid}/waive`, {
  reason: 'Accepted by the client for now.', waive_until: until, row_version: String((await condRow(cid)).row_version) });

test('a finding cannot be closed by hand while a condition linked to it still needs proof', async () => {
  const ctx = await setup('Pending Close Co');
  const findingId = await addFinding(ctx, 'Weak passwords');
  await completeWith(ctx, [{ description: 'Enforce 14 character passwords.', finding: findingId }]);
  const row = await findingRow(findingId);
  const res = await consultant.session.post(`${aBase(ctx)}/findings/${findingId}/close`, { close_reason: 'Policy changed.', row_version: String(row.row_version) });
  assert.match(toast(res), /Condition 1 is linked to this finding and is not met for good yet/);
  assert.equal((await findingRow(findingId)).status, 'open', 'the supplier is not told nothing more is needed while proof is still asked for');
});

test('a waiver with an end date does not close the finding, and waiving the last linked condition for good closes it', async () => {
  const ctx = await setup('Waiver Close Co');
  const findingId = await addFinding(ctx, 'No MFA on admin');
  await completeWith(ctx, [{ description: 'Turn on MFA for admins.', finding: findingId }, { description: 'Turn on MFA for support.', finding: findingId }]);
  const [c1, c2] = (await db.prepare('SELECT id FROM tp_conditions WHERE recommendation_id=? ORDER BY position').all(ctx.rid)).map(r => Number(r.id));
  assert.match(toast(await waiveIt(ctx, c2, '2099-01-31')), /Condition waived/);
  await proveAndVerify(ctx, c1);
  assert.equal((await findingRow(findingId)).status, 'open', 'a waiver that will lapse is not met for good');

  const other = await setup('Waiver Last Co');
  const second = await addFinding(other, 'Shared admin password');
  await completeWith(other, [{ description: 'Give each admin an account.', finding: second }]);
  const only = Number((await db.prepare('SELECT id FROM tp_conditions WHERE recommendation_id=?').get(other.rid)).id);
  assert.match(toast(await waiveIt(other, only)), /Condition waived/);
  const closed = await findingRow(second);
  assert.equal(closed.status, 'closed', 'waiving the last linked condition for good closes the finding');
  assert.match(closed.close_reason, /Condition 1 was waived/);
});

test('when the firm uploads the proof, the accepted email goes to the main contact, not to a revoked link, and does not say the supplier sent it', async () => {
  const ctx = await setup('Firm Proof Co');
  await completeWith(ctx, [{ description: 'Send the new pen test report.' }]);
  const cid = Number((await db.prepare('SELECT id FROM tp_conditions WHERE recommendation_id=?').get(ctx.rid)).id);
  await consultant.session.get(aBase(ctx));
  await consultant.session.post(`${aBase(ctx)}/conditions-link`, { recipient_name: 'Wrong Person', recipient_email: 'wrong@elsewhere.example', expires_in_days: '30' });
  const link = await db.prepare("SELECT id, row_version FROM tp_condition_links WHERE assessment_id=? AND status='active'").get(ctx.a);
  const revoked = await consultant.session.post(`${aBase(ctx)}/conditions-link/${link.id}/revoke`, { row_version: String(link.row_version) });
  assert.match(toast(revoked), /Conditions link revoked/);
  let main = await db.prepare("SELECT name, email FROM tp_vendor_people WHERE third_party_id=? AND status='active' AND role='main'").get(ctx.tp);
  if (!main) {
    await db.prepare("INSERT INTO tp_vendor_people (workspace_id, third_party_id, email, name, role) VALUES (?, ?, 'maya@thirdparty.example.net', 'Maya Main', 'main')").run(ctx.ws, ctx.tp);
    main = { name: 'Maya Main', email: 'maya@thirdparty.example.net' };
  }
  await consultant.session.get(`${aBase(ctx)}?step=decision`);
  const fields = [['_csrf', consultant.session.getCsrfToken()], ['note', 'Report received by email on 2 Dec.'], ['row_version', String((await condRow(cid)).row_version)]];
  const form = multipart(fields);
  const up = await consultant.session.post(`${aBase(ctx)}/conditions/${cid}/proofs`, form.body, { headers: form.headers });
  assert.match(toast(up), /Proof uploaded/);
  await senior.session.get(`${aBase(ctx)}?step=decision`);
  const verified = await senior.session.post(`${aBase(ctx)}/conditions/${cid}/verify`, { row_version: String((await condRow(cid)).row_version) });
  assert.match(toast(verified), /Condition verified/);
  const sent = await mails(ctx.ws, 'vendor_proof_accepted');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to_email, main.email, 'the main contact, not the address of the revoked link');
  assert.match(sent[0].body_html, /accepted the proof they received for condition 1/);
  assert.doesNotMatch(sent[0].body_html, /accepted your proof|Your proof/);
});
