'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient, allSteps } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'tprm-report-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };
const VALID_UNTIL = '2099-12-31';
const DUE = '2099-06-30';

let env;
let client;
let db;
let firmId;
let report;
let events;
let consultant;
let senior;
let main;
let otherClient;
const createdPaths = new Set();
const sessions = [];
const rendered = [];

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  report = require('../lib/tprm/report');
  events = require('../lib/tprm/events');
  report.configure({
    renderPdf: async (html, opts) => {
      rendered.push({ html, opts });
      return Buffer.from(`%PDF-1.4 stub ${crypto.createHash('sha256').update(html).digest('hex')}`);
    },
  });
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('rep-consultant@test.local', { role: 'consultant', name: 'Casey Consultant' });
  senior = await makeUser('rep-senior@test.local', { role: 'senior_consultant', name: 'Sam Senior' });
  for (const u of [consultant, senior]) u.session = await signIn(u.email, u.password);
  main = await tprmClient('Report Main Client');
  otherClient = await tprmClient('Report Other Client');
});

test.after(async () => {
  for (const p of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  for (const s of sessions) await s.close();
  for (const u of [consultant, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId, workspaceId = null, memberRole = null, name = email } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), name, type, type === 'firm' ? firm : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email, password: PASSWORD, firm_id: type === 'firm' ? firm : null, firm_role: type === 'firm' ? role : null, user_type: type };
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

async function sessionFor(user) {
  if (!user.session) {
    user.session = await signIn(user.email, user.password);
    sessions.push(user.session);
  }
  return user.session;
}

async function tprmClient(name, { firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firm, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (firm === firmId) {
    for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`rep-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner', name: `Owner of ${name}` });
  return { id, owner };
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const rBase = ctx => `${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations`;
const firmReport = (ctx, rid) => `${rBase(ctx)}/${rid}/report.pdf`;
const portal = ws => `/workspaces/${ws}/client-portal/third-party-risk`;
const portalReport = (ws, rid) => `${portal(ws)}/recommendations/${rid}/report.pdf`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const recRow = async id => db.prepare('SELECT * FROM tp_recommendations WHERE id=?').get(id);
const recsOf = async a => db.prepare('SELECT * FROM tp_recommendations WHERE assessment_id=? ORDER BY version').all(a);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);
const reportEvents = async ctx => (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'recommendation.report_generated');
const lastHtml = () => rendered.at(-1).html;

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

function multipart(fields, files = []) {
  const boundary = '----tprmrep' + crypto.randomBytes(8).toString('hex');
  const chunks = [];
  for (const [k, v] of fields) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field || 'files'}"; filename="${f.filename}"\r\nContent-Type: ${f.type || 'application/octet-stream'}\r\n\r\n`),
      Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(ctx, filename, content, description = '') {
  await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  const form = multipart([['_csrf', consultant.session.getCsrfToken()], ['description', description]], [{ filename, content, type: 'text/plain' }]);
  const res = await request('POST', `${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence`, { body: form.body, headers: { ...form.headers, cookie: consultant.session.getCookies() } });
  assert.equal(res.status, 302, `upload (${res.status})`);
  const row = await db.prepare('SELECT * FROM tp_evidence WHERE workspace_id=? AND assessment_id=? AND original_name=?').get(ctx.ws, ctx.a, filename);
  createdPaths.add(row.stored_path);
  return row;
}

async function addThirdParty(ws, name, status = 'in_use') {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosting' })).status, 302);
  return tp;
}

async function confirmed(c, name, { status = 'in_use' } = {}) {
  const ws = c.id;
  const tp = await addThirdParty(ws, name, status);
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302);
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  const ctx = { ws, tp, a, c };
  const res = await consultant.session.post(`${aBase(ws, tp, a)}/details`, {
    client_decision_owner_id: String(c.owner.id), due_date: '', row_version: String((await assessmentRow(a)).row_version),
  });
  assert.equal(res.status, 302);
  return ctx;
}

function draftBody(outcome) {
  const body = { outcome, residual_rating: 'medium', rationale: 'Controls are adequate.\n\nMFA is enforced for administrators.', valid_until: VALID_UNTIL };
  if (outcome === 'approve_with_conditions') {
    Object.assign(body, { 'conditions[0][description]': 'Enforce MFA for all admin accounts', 'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': DUE });
  }
  return body;
}

async function draft(ctx) {
  const res = await consultant.session.post(rBase(ctx), { row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(res.status, 302, toast(res));
  return Number((await recsOf(ctx.a)).at(-1).id);
}

async function submit(ctx, id, outcome) {
  const saved = await consultant.session.post(`${rBase(ctx)}/${id}`, { ...draftBody(outcome), intent: 'submit', row_version: String((await recRow(id)).row_version) });
  assert.equal(saved.status, 302);
  assert.equal((await recRow(id)).status, 'in_review', toast(saved));
}

async function issue(ctx, id) {
  const res = await senior.session.post(`${rBase(ctx)}/${id}/issue`, { row_version: String((await recRow(id)).row_version) });
  assert.equal(res.status, 302);
  assert.equal((await recRow(id)).status, 'issued', toast(res));
}

async function decide(session, ws, rid, body) {
  await session.get(`${portal(ws)}/recommendations/${rid}`);
  return await session.post(`${portal(ws)}/recommendations/${rid}/decision`, body);
}

let full;

test('a report only for the issued version: drafts and in-review versions are not found', async () => {
  const ctx = await confirmed(main, 'Acme Hosting <Ltd> & "Co"');
  full = ctx;
  const released = await upload(ctx, 'soc2-summary.txt', 'RELEASED-FILE-CONTENT', 'SECRET-EVIDENCE-DESCRIPTION internal');
  await upload(ctx, 'unreleased-secret.txt', 'UNRELEASED-CONTENT');
  const rel = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${released.id}/release`, { row_version: String(released.row_version) });
  assert.equal(rel.status, 302);
  const f = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings`, {
    status: 'open', severity: 'high', control_ref: 'A.8.5', title: 'Admin MFA gaps', description: 'SECRET-FINDING-DESCRIPTION internal analysis',
  });
  assert.equal(f.status, 302);
  const rid = await draft(ctx);
  assert.equal((await consultant.session.get(firmReport(ctx, rid))).status, 404, 'a draft has no report');
  await submit(ctx, rid, 'approve_with_conditions');
  const changes = await senior.session.post(`${rBase(ctx)}/${rid}/request-changes`, {
    comment: 'SECRET-REVIEW-COMMENT tighten the rationale', row_version: String((await recRow(rid)).row_version) });
  assert.equal(changes.status, 302);
  await submit(ctx, rid, 'approve_with_conditions');
  assert.equal((await consultant.session.get(firmReport(ctx, rid))).status, 404, 'in review has no report');
  const ownerSession = await sessionFor(main.owner);
  assert.equal((await ownerSession.get(portalReport(ctx.ws, rid))).status, 404, 'nor in the portal');
  assert.equal((await reportEvents(ctx)).length, 0, 'a refused download writes nothing');
  await issue(ctx, rid);
  ctx.rid = rid;

  const res = await consultant.session.get(firmReport(ctx, rid));
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /^attachment; filename="recommendation-acme-hosting-ltd-co-v1\.pdf"$/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(res.buffer.subarray(0, 5).toString() === '%PDF-');
  const [ev] = await reportEvents(ctx);
  assert.equal(ev.actor_user_id, consultant.id);
  assert.equal(ev.after_state.audience, 'firm');
  assert.equal(ev.after_state.version, 1);
  assert.equal(ev.after_state.recommendation_id, rid);
  assert.equal(ev.after_state.sha256, crypto.createHash('sha256').update(res.buffer).digest('hex'), 'the event holds the sha256 of the PDF sent');
  assert.equal(ev.after_state.size_bytes, res.buffer.length);
  assert.match(ev.after_state.html_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(ev.after_state).sort(), ['audience', 'html_sha256', 'letterhead_version', 'recommendation_id', 'sha256', 'size_bytes',
    'snapshot_id', 'snapshot_sha256', 'snapshot_taken_after_issue', 'status_as_of', 'version']);

  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, new RegExp(`data-tprm-report-download="${rid}"`));
  assert.match(page.text, /data-tprm-history-action="recommendation.report_generated"/, 'History shows the event');
});

test('report contents: the sections a client reads, and nothing internal', async () => {
  const ctx = full;
  const res = await consultant.session.get(firmReport(ctx, ctx.rid));
  assert.equal(res.status, 200);
  const html = lastHtml();
  const opts = rendered.at(-1).opts;
  const firm = (await db.prepare('SELECT name FROM firms WHERE id=?').get(firmId)).name;
  assert.match(html, new RegExp(`data-report-firm-name>${firm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`));
  assert.match(html, /data-report-fact="client">Report Main Client</);
  assert.match(html, /Acme Hosting &lt;Ltd&gt; &amp; &quot;Co&quot;/, 'values are escaped');
  assert.doesNotMatch(html, /Acme Hosting <Ltd>/);
  assert.match(html, /data-report-fact="assessment">Reassessment</);
  assert.match(html, /data-report-fact="issued">\d{1,2} [A-Z][a-z]{2} \d{4}, version 1</);
  assert.doesNotMatch(html.slice(html.indexOf('<body>'), html.indexOf('class="rest"')), /UTC/, 'page 1 prints no UTC time');
  assert.match(html, /data-report-outcome>Continue with conditions</);
  assert.match(html, /data-report-residual="Medium"/);
  assert.match(html, /data-report-valid-until="31 December 2099"/);
  assert.match(html, /<p>Controls are adequate\.<\/p><p>MFA is enforced for administrators\.<\/p>/);
  assert.match(html, /<strong>Low<\/strong> because: /);
  assert.match(html, /data-report-condition="1" data-report-owner="Third party" data-report-due="30 June? 2099" data-report-condition-status="Open"[^>]*>(?:(?!<\/tr>)[^])*data-report-condition-text>Enforce MFA for all admin accounts</);
  assert.match(html, /data-report-finding="1" data-report-severity="High" data-report-control="A\.8\.5" data-report-finding-status="Open"[^>]*>(?:(?!<\/tr>|<\/section>)[^])*data-report-finding-title>1\. Admin MFA gaps</);
  assert.match(html, /data-report-document="soc2-summary\.txt" data-report-released="\d{1,2} [A-Z][a-z]+ \d{4}"/);
  assert.match(html, /No questionnaire was sent to Acme Hosting &lt;Ltd&gt; &amp; &quot;Co&quot;\./);
  assert.match(html, /The client has not recorded its decision on this version yet\./);
  assert.equal(opts.footerLeft, `${firm} · Document reference ${(await db.prepare('SELECT content_sha256 FROM tp_recommendation_snapshots WHERE recommendation_id=?').get(ctx.rid)).content_sha256.slice(0, 8)}`);
  assert.doesNotMatch(html.slice(html.indexOf('<body>')), /snapshot/i);
  assert.match(opts.headerRight, /version 1/);
  assert.match(html, /data-report-finding-description><p>SECRET-FINDING-DESCRIPTION internal analysis<\/p>/);
  assert.match(html, /data-report-document="unreleased-secret\.txt" data-report-released=""/);
  assert.match(html, /data-report-signoff="prepared"><dt>Prepared by<\/dt><dd><div [^>]*data-report-signoff-name>Casey Consultant<\/div><div [^>]*data-report-signoff-role>Consultant<\/div><div [^>]*data-report-signoff-date>\d{1,2} [A-Z][a-z]{2} \d{4}</);
  assert.match(html, /data-report-signoff="issued"><dt>Reviewed and issued by<\/dt><dd><div [^>]*data-report-signoff-name>Sam Senior<\/div><div [^>]*data-report-signoff-role>Senior consultant</);
  const stored = await db.prepare('SELECT stored_path FROM tp_evidence WHERE assessment_id=?').all(ctx.a);
  for (const needle of ['SECRET-REVIEW-COMMENT', 'SECRET-EVIDENCE-DESCRIPTION',
    'RELEASED-FILE-CONTENT', 'UNRELEASED-CONTENT', ...stored.map(s => s.stored_path)]) {
    assert.equal(html.includes(needle), false, `${needle} is not in the report`);
  }
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"/);
  assert.match(html, /@font-face \{ font-family: "Report Inter";[^}]*src: url\("data:font\/woff2;base64,/, 'Inter, embedded: nothing fetched');
  await consultant.session.get(firmReport(ctx, ctx.rid));
  assert.equal(lastHtml(), html, 'deterministic');
  const evs = await reportEvents(ctx);
  assert.equal(evs.at(-1).after_state.html_sha256, evs.at(-2).after_state.html_sha256);
});

test('the report module reads no AI table and none of the internal columns', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'tprm', 'report.js'), 'utf8');
  for (const needle of [/tp_ai_/, /review_comment/, /withdraw_reason/, /stored_path/, /not_returned_reason/, /closed_reason/, /e\.description/,
    /self_issue_reason/, /close_note/, /revoke_reason/, /\.comment\b/, /c\.body/, /c\.response\b/]) {
    assert.doesNotMatch(src, needle, `report.js does not read ${needle}`);
  }
});

test('client access: the client downloads its own report; the decision appears once recorded; events name the client user', async () => {
  const ctx = full;
  const ownerSession = await sessionFor(main.owner);
  const page = await ownerSession.get(`${portal(ctx.ws)}/recommendations/${ctx.rid}`);
  assert.match(page.text, /data-tprm-portal-report/);
  let res = await ownerSession.get(portalReport(ctx.ws, ctx.rid));
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  let ev = (await reportEvents(ctx)).at(-1);
  assert.equal(ev.actor_user_id, main.owner.id);
  assert.equal(ev.after_state.audience, 'client');
  const audit = await db.prepare(`SELECT * FROM audit_log WHERE user_id=? AND action='tprm_client_download_recommendation_report' ORDER BY id DESC`).get(main.owner.id);
  assert.ok(audit, 'audit-logged like released-file downloads');

  const d = await decide(ownerSession, ctx.ws, ctx.rid, { outcome: 'approve', rationale: 'Our own <compensating> controls cover it.', risk_acceptance_until: '2099-01-31' });
  assert.equal(d.status, 302, toast(d));
  assert.equal((await assessmentRow(ctx.a)).status, 'completed');
  res = await ownerSession.get(portalReport(ctx.ws, ctx.rid));
  assert.equal(res.status, 200, 'still available once the assessment is completed');
  const html = lastHtml();
  assert.match(html, /data-report-status-decision="Continue"/);
  assert.match(html, /data-report-status-recorded="\d{1,2} [A-Z][a-z]+ \d{4} by Owner of Report Main Client"/);
  assert.match(html, /data-report-status-diverges="Yes, risk accepted until 31 Jan(?:uary)? 2099"/);
  assert.match(html, /Our own &lt;compensating&gt; controls cover it\./);
  ev = (await reportEvents(ctx)).at(-1);
  assert.equal(ev.actor_user_id, main.owner.id);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('isolation: another client, another firm, wrong ids, a client user on the firm route and a firm user on the portal route all get nothing', async () => {
  const ctx = full;
  const before = (await reportEvents(ctx)).length;
  const otherSession = await sessionFor(otherClient.owner);
  assert.equal((await otherSession.get(portalReport(otherClient.id, ctx.rid))).status, 404, 'another workspace\'s recommendation id');
  const cross = await otherSession.get(portalReport(ctx.ws, ctx.rid));
  assert.ok([403, 404].includes(cross.status), `not this client's member (${cross.status})`);
  const ownerSession = await sessionFor(main.owner);
  assert.equal((await ownerSession.get(firmReport(ctx, ctx.rid))).status, 404);
  assert.equal((await consultant.session.get(portalReport(ctx.ws, ctx.rid))).status, 404);
  assert.equal((await consultant.session.get(`${aBase(ctx.ws, ctx.tp + 1000, ctx.a)}/recommendations/${ctx.rid}/report.pdf`)).status, 404);
  assert.equal((await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a + 1000)}/recommendations/${ctx.rid}/report.pdf`)).status, 404);
  assert.equal((await consultant.session.get(`${aBase(otherClient.id, ctx.tp, ctx.a)}/recommendations/${ctx.rid}/report.pdf`)).status, 404);
  assert.equal((await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}/recommendations/abc/report.pdf`)).status, 404);
  const outsider = await makeUser('rep-outsider@test.local', { role: 'consultant' });
  const outsiderSession = await sessionFor(outsider);
  assert.equal((await outsiderSession.get(firmReport(ctx, ctx.rid))).status, 404);
  const otherFirm = Number((await db.prepare('INSERT INTO firms (name) VALUES (?)').run('Report Other Firm')).lastInsertRowid);
  const foreign = await makeUser('rep-foreign-manager@test.local', { role: 'manager', firm: otherFirm });
  const foreignSession = await sessionFor(foreign);
  assert.equal((await foreignSession.get(firmReport(ctx, ctx.rid))).status, 404);
  assert.equal((await reportEvents(ctx)).length, before, 'no event for a refused download');
});

test('a superseded version has no report; the revised issued version has', async () => {
  const ctx = await confirmed(main, 'Revised Report Co');
  const v1 = await draft(ctx);
  await submit(ctx, v1, 'approve');
  await issue(ctx, v1);
  const ownerSession = await sessionFor(main.owner);
  assert.equal((await decide(ownerSession, ctx.ws, v1, { outcome: 'request_more_information', rationale: 'Please share the SOC 2 report.' })).status, 302);
  assert.equal((await ownerSession.get(portalReport(ctx.ws, v1))).status, 200, 'still the live issued version while the revision is drafted');
  assert.match(lastHtml(), /data-report-status-decision="Need more information"/);
  assert.equal((await consultant.session.post(`${rBase(ctx)}/new-version`, { reason: 'The client asked for more information.' })).status, 302);
  const v2 = Number((await recsOf(ctx.a)).at(-1).id);
  await submit(ctx, v2, 'approve');
  await issue(ctx, v2);
  assert.equal((await recRow(v1)).status, 'withdrawn');
  assert.equal((await consultant.session.get(firmReport(ctx, v1))).status, 404, 'superseded');
  assert.equal((await ownerSession.get(portalReport(ctx.ws, v1))).status, 404);
  const res = await consultant.session.get(firmReport(ctx, v2));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /-v2\.pdf"$/);
  assert.match(lastHtml(), /data-report-fact="issued">\d{1,2} [A-Z][a-z]{2} \d{4}, version 2</);
});

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
function pngSized(width, height, padding = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'ascii'); ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(height, 12);
  ihdr.set([8, 2, 0, 0, 0], 16);
  return Buffer.concat([PNG_1X1.subarray(0, 8), ihdr, Buffer.alloc(padding, 0x41)]);
}
const LOGO_NAMES = /-(?:northwind\.png|logo\.png|logo\.gif|logo\.svg|big\.png|wide\.png)$/;
const firmUploads = () => {
  const dir = path.join(ROOT, 'uploads', `firm_${firmId}`);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => LOGO_NAMES.test(n)).length : 0;
};

async function postLetterhead(session, fields, file = null, { csrf = true } = {}) {
  await session.get('/tprm/settings/letterhead');
  const lh = await db.prepare('SELECT row_version FROM tp_letterheads WHERE firm_id=?').get(firmId);
  const all = [...(csrf ? [['_csrf', session.getCsrfToken() || '']] : []), ['row_version', String(lh ? lh.row_version : 0)], ...Object.entries(fields)];
  const form = multipart(all, file ? [{ field: 'logo', ...file }] : []);
  return await request('POST', '/tprm/settings/letterhead', { body: form.body, headers: { ...form.headers, cookie: session.getCookies() } });
}

test('letterhead: managers only; CSRF; the logo is a PNG or JPEG by its bytes, 1 MB and 4,000 pixels at most; staged files removed', async () => {
  assert.equal((await consultant.session.get('/tprm/settings/letterhead')).status, 403);
  assert.equal((await senior.session.get('/tprm/settings/letterhead')).status, 403);
  assert.equal(firmUploads(), 0);
  const bySenior = await postLetterhead(senior.session, { display_name: 'Hijack' }, { filename: 'logo.png', content: PNG_1X1, type: 'image/png' });
  assert.equal(bySenior.status, 403);
  assert.match(bySenior.text, /letterhead can be changed by managers only/);
  const ownerSession = await sessionFor(main.owner);
  assert.equal((await ownerSession.get('/tprm/settings/letterhead')).status, 403);
  assert.equal(await db.prepare('SELECT 1 FROM tp_letterheads WHERE firm_id=?').get(firmId), undefined);

  const page = await client.get('/tprm/settings/letterhead');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-letterhead-form/);
  assert.match((await client.get('/tprm')).text, /data-tprm-letterhead-link/);

  const noCsrf = await postLetterhead(client, { display_name: 'No token' }, null, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(await db.prepare('SELECT 1 FROM tp_letterheads WHERE firm_id=?').get(firmId), undefined);

  for (const [file, pattern] of [
    [{ filename: 'logo.gif', content: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), type: 'image/gif' }, /PNG or JPEG/],
    [{ filename: 'logo.png', content: Buffer.from('not really a png'), type: 'image/png' }, /do not match its extension/],
    [{ filename: 'logo.svg', content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), type: 'image/svg+xml' }, /not allowed/],
    [{ filename: 'big.png', content: pngSized(10, 10, 1024 * 1024 + 10), type: 'image/png' }, /1 MB or smaller/],
    [{ filename: 'wide.png', content: pngSized(4001, 10), type: 'image/png' }, /4,000 pixels/],
  ]) {
    const res = await postLetterhead(client, { display_name: 'Should not save' }, file);
    assert.equal(res.status, 400, `${file.filename}: ${res.status} ${res.text.replace(/\s+/g, ' ').slice(0, 2000)}`);
    assert.match(res.text, pattern, file.filename);
  }
  assert.equal(await db.prepare('SELECT 1 FROM tp_letterheads WHERE firm_id=?').get(firmId), undefined, 'nothing saved');
  const tooLong = await postLetterhead(client, { address_lines: '1\n2\n3\n4\n5\n6\n7' });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.text, /at most 6 lines/);

  const ok = await postLetterhead(client, {
    display_name: 'Northwind Assurance LLP', address_lines: '12 Example Street\r\nMumbai 400001\r\n\r\nIndia',
    contact_line: 'risk@northwind.example · +91 22 0000 0000', footer_text: 'Confidential: prepared for the named client only.',
  }, { filename: 'northwind.png', content: PNG_1X1, type: 'image/png' });
  assert.equal(ok.status, 302, ok.text.slice(0, 300));
  assert.match(toast(ok), /Letterhead saved/);
  const row = await db.prepare('SELECT * FROM tp_letterheads WHERE firm_id=?').get(firmId);
  assert.equal(row.display_name, 'Northwind Assurance LLP');
  assert.equal(row.address_lines, '12 Example Street\nMumbai 400001\nIndia');
  assert.equal(row.logo_mime, 'image/png');
  assert.equal(row.logo_sha256, crypto.createHash('sha256').update(PNG_1X1).digest('hex'));
  assert.ok(Buffer.from(row.logo).equals(PNG_1X1));
  assert.equal(firmUploads(), 0, 'every staged upload was removed (the logo lives in the database)');
  const audit = await db.prepare(`SELECT details FROM audit_log WHERE action='tprm_letterhead_changed' ORDER BY id DESC`).get();
  assert.match(audit.details, /logo/);

  await client.get('/tprm/settings/letterhead');
  const stale = multipart([['_csrf', client.getCsrfToken()], ['row_version', '0'], ['display_name', 'Stale']]);
  const staleRes = await request('POST', '/tprm/settings/letterhead', { body: stale.body, headers: { ...stale.headers, cookie: client.getCookies() } });
  assert.equal(staleRes.status, 409);
  assert.match(staleRes.text, /data-tprm-letterhead-errors[\s\S]*?Someone else changed the letterhead/);
  assert.match(staleRes.text, /name="display_name"[^>]*value="Stale"/);
  assert.equal((await db.prepare('SELECT display_name FROM tp_letterheads WHERE firm_id=?').get(firmId)).display_name, 'Northwind Assurance LLP', 'nothing saved');

  const light = multipart([['_csrf', client.getCsrfToken()], ['row_version', String(row.row_version)], ['display_name', 'Northwind Assurance LLP'],
    ['address_lines', row.address_lines], ['contact_line', row.contact_line || ''], ['footer_text', row.footer_text || ''], ['brand_colour', '#7dd3fc']]);
  const lightRes = await request('POST', '/tprm/settings/letterhead', { body: light.body, headers: { ...light.headers, cookie: client.getCookies() } });
  assert.equal(lightRes.status, 400);
  assert.match(lightRes.text, /too light for white text/);
  assert.match(lightRes.text, /name="brand_colour"[^>]*value="#7dd3fc"[^>]*aria-invalid="true"/);

  const res = await consultant.session.get(firmReport(full, full.rid));
  assert.equal(res.status, 200);
  const html = lastHtml();
  assert.match(html, /data-report-firm-name>Northwind Assurance LLP</);
  assert.match(html, /<div>12 Example Street<\/div>\s*<div>Mumbai 400001<\/div>\s*<div>India<\/div>/);
  assert.match(html, /risk@northwind\.example/);
  assert.ok(html.includes(`<img class="logo" src="data:image/png;base64,${PNG_1X1.toString('base64')}"`), 'the logo as a data: URI');
  assert.match(rendered.at(-1).opts.footerLeft, /^Confidential: prepared for the named client only\. · Document reference [0-9a-f]{8}$/);
  assert.equal((await reportEvents(full)).at(-1).after_state.letterhead_version, row.row_version);

  const removed = await postLetterhead(client, { display_name: 'Northwind Assurance LLP', address_lines: row.address_lines,
    contact_line: row.contact_line, footer_text: row.footer_text, remove_logo: '1' });
  assert.equal(removed.status, 302);
  assert.equal((await db.prepare('SELECT logo FROM tp_letterheads WHERE firm_id=?').get(firmId)).logo, null);
  await consultant.session.get(firmReport(full, full.rid));
  assert.doesNotMatch(lastHtml(), /<img/);
});

test('the real renderer: an A4 PDF from the report HTML (skipped when no browser can start)', async t => {
  const data = await report.reportData(db, await db.prepare('SELECT * FROM workspaces WHERE id=?').get(full.ws), full.rid);
  assert.ok(data);
  const lh = await require('../lib/tprm/letterhead').getLetterhead(db, firmId);
  const html = report.renderHtml(data, lh, null);
  let pdf;
  try {
    pdf = await require('../lib/audit-pack').renderPDF(html, { headerLeft: 'x', headerRight: 'y', footerLeft: lh.footerText });
  } catch (err) {
    t.skip(`no browser: ${err.message}`);
    return;
  }
  pdf = Buffer.from(pdf);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(/\/MediaBox \[0 0 59[45]\.9\d* 841\.9\d*\]/.test(pdf.toString('latin1')), 'A4');
});

const snapOf = async rid => db.prepare('SELECT * FROM tp_recommendation_snapshots WHERE recommendation_id=?').get(rid);
async function addFinding(ctx, fields) {
  const res = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings`, { status: 'open', control_ref: '', description: '', impact: '', ...fields });
  assert.equal(res.status, 302, toast(res));
  return Number((await db.prepare('SELECT id FROM tp_findings WHERE workspace_id=? AND assessment_id=? AND title=?').get(ctx.ws, ctx.a, fields.title)).id);
}
async function saveLinked(ctx, rid, findingId, { intent = 'submit' } = {}) {
  return await consultant.session.post(`${rBase(ctx)}/${rid}`, {
    ...draftBody('approve_with_conditions'), 'conditions[0][finding_id]': findingId == null ? '' : String(findingId),
    intent, row_version: String((await recRow(rid)).row_version),
  });
}

let linked;

test('layout 2: findings in detail with why they matter, the condition that addresses each, sign-off; frozen in the snapshot', async () => {
  const ctx = await confirmed(main, 'Layout Two Hosting');
  linked = ctx;
  const f1 = await addFinding(ctx, { severity: 'high', control_ref: 'A.8.13', title: 'Backups never restored',
    description: 'No restore test in the last 12 months.', impact: 'The client\'s payment ledger is hosted here; a failed restore stops <payments>.' });
  const f2 = await addFinding(ctx, { severity: 'low', title: 'Old TLS on the status page' });
  assert.equal((await db.prepare('SELECT impact FROM tp_findings WHERE id=?').get(f1)).impact, 'The client\'s payment ledger is hosted here; a failed restore stops <payments>.');
  const form = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${f1}/edit`);
  assert.match(form.text, /data-tprm-finding-impact/);
  assert.match(form.text, /data-tprm-finding-printed>[^<]*printed in the client(?:'|&#39;)s report/);
  const doc = await upload(ctx, 'restore-log.txt', 'LOG-CONTENT', 'INTERNAL-NOTE about the log');
  await withFrozenOff(() => db.prepare('INSERT INTO tp_finding_evidence (workspace_id, assessment_id, finding_id, evidence_id) VALUES (?,?,?,?)').run(ctx.ws, ctx.a, f1, doc.id));

  const rid = await draft(ctx);
  const saved = await saveLinked(ctx, rid, f1);
  assert.equal(saved.status, 302, toast(saved));
  assert.equal(Number((await db.prepare('SELECT finding_id FROM tp_conditions WHERE recommendation_id=?').get(rid)).finding_id), f1);
  await issue(ctx, rid);
  ctx.rid = rid;

  const content = JSON.parse((await snapOf(rid)).content);
  assert.equal(content.layoutVersion, 2);
  assert.deepEqual(content.conditionDetails.map(c => c.finding), [1]);
  assert.deepEqual(content.findingDetails.map(f => [f.n, f.title, f.conditions]), [[1, 'Backups never restored', [1]], [2, 'Old TLS on the status page', []]]);
  assert.deepEqual(content.documents.map(d => [d.name, d.from, d.released, d.findings]), [['restore-log.txt', 'firm', false, [1]]]);
  assert.equal(content.signoff.preparedBy, 'Casey Consultant');
  assert.equal(content.signoff.issuedBy, 'Sam Senior');
  assert.equal(content.questionnaireFacts, null);

  assert.equal((await consultant.session.get(firmReport(ctx, rid))).status, 200);
  const html = lastHtml();
  assert.match(html, /data-report-finding="1" data-report-severity="High" data-report-control="A\.8\.13" data-report-finding-status="Open">\s*<p [^>]*data-report-finding-title>1\. Backups never restored<\/p>\s*<p [^>]*data-report-finding-meta>High severity\. Control A\.8\.13\. Open when this recommendation was issued\.<\/p>/);
  assert.match(html, /data-report-finding-description><p>No restore test in the last 12 months\.<\/p>/);
  assert.match(html, /Why it matters to Report Main Client<\/p><div data-report-finding-impact><p>The client&#39;s payment ledger is hosted here; a failed restore stops &lt;payments&gt;\.<\/p>/);
  assert.match(html, /data-report-finding-conditions="1">Addressed by condition 1\.</);
  assert.match(html, /data-report-finding="2"[^>]*>(?:(?!data-report-finding=")[^])*data-report-finding-conditions="">No condition addresses this finding\.</);
  assert.doesNotMatch(html.slice(html.indexOf('data-report-finding="2"')), /^[^]*?data-report-finding-impact[^]*?data-report-conditions/, 'no "why it matters" when none was given');
  assert.match(html, /data-report-condition="1"[^>]*data-report-condition-finding="1">(?:(?!<\/tr>)[^])*<td [^>]*data-report-condition-finding-cell>Finding 1<\/td>/);
  assert.match(html, /No questionnaire was sent to Layout Two Hosting\./);
  assert.match(html, /data-report-document="restore-log\.txt" data-report-released=""><td [^>]*data-report-doc="name">restore-log\.txt<\/td><td [^>]*data-report-doc="from">[^<]+<\/td><td [^>]*data-report-doc="received">\d{1,2} [A-Z][a-z]{2} \d{4}<\/td><td [^>]*data-report-doc="used-for">finding 1<\/td><td [^>]*data-report-doc="shared">No<\/td>/);
  assert.match(html, /data-report-limits>This assessment is based on the documents listed above\. We did not test Layout Two Hosting&#39;s controls on site\. This report is our recommendation; the decision is Report Main Client&#39;s own\.</);
  assert.doesNotMatch(html, /data-report-results/, 'no questionnaire: no results by area');
  for (const needle of ['INTERNAL-NOTE', 'LOG-CONTENT']) assert.equal(html.includes(needle), false, needle);
  assert.match(html, /data-report-signoffs>Sign-off<\/h2>\s*<dl[^>]*><div data-report-signoff="prepared">/);
  const order = ['data-report-what-we-did', 'data-report-findings', 'data-report-conditions', 'data-report-signoffs', 'data-report-status-section'].map(h => html.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every(i => i > 0));
  assert.match(html, /data-report-status-section data-report-as-of="[^"]+">Appendix: status on \d{1,2} [A-Z][a-z]{2} \d{4}</);
  assert.doesNotMatch(html.slice(html.indexOf('<body>')), /\bUTC\b/);
  assert.doesNotMatch(html.slice(html.indexOf('<body>')), /snapshot/i);
});

async function withFrozenOff(fn) {
  await db.exec('ALTER TABLE tp_finding_evidence DISABLE TRIGGER tp_finding_evidence_freeze');
  try { return await fn(); } finally { await db.exec('ALTER TABLE tp_finding_evidence ENABLE TRIGGER tp_finding_evidence_freeze'); }
}

test('layout 2: a condition addresses a finding of its own assessment only; the link must be one of the list', async () => {
  const ctx = await confirmed(main, 'Linking Rules Co');
  const own = await addFinding(ctx, { severity: 'medium', title: 'Linking rules own finding' });
  const rid = await draft(ctx);
  const elsewhere = Number((await db.prepare('SELECT id FROM tp_findings WHERE assessment_id=? ORDER BY id LIMIT 1').get(linked.a)).id);
  const otherCtx = await confirmed(otherClient, 'Linking Rules Other Client Co');
  const foreign = await addFinding(otherCtx, { severity: 'low', title: 'Foreign client finding' });
  for (const bad of [elsewhere, foreign]) {
    const res = await saveLinked(ctx, rid, bad, { intent: 'save' });
    assert.equal(res.status, 302, `finding ${bad} of another assessment`);
    assert.match(toast(res), /Condition 1: choose the finding it addresses from this assessment's findings\./);
  }
  const junk = await saveLinked(ctx, rid, 'abc', { intent: 'save' });
  assert.equal(junk.status, 302);
  assert.match(toast(junk), /Condition 1: choose the finding it addresses from the list\./);
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS c FROM tp_conditions WHERE recommendation_id=? AND finding_id IS NOT NULL').get(rid)).c, 0);
  const cond = await db.prepare('SELECT id FROM tp_conditions WHERE recommendation_id=? LIMIT 1').get(rid);
  if (cond) await assert.rejects(db.prepare('UPDATE tp_conditions SET finding_id=? WHERE id=?').run(elsewhere, cond.id), /same assessment only|foreign key/);
  assert.equal((await saveLinked(ctx, rid, own, { intent: 'save' })).status, 302);
  const page = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=recommendation`);
  assert.match(page.text, new RegExp(`name="conditions\\[0\\]\\[finding_id\\]" data-tprm-rec-condition-finding[^>]*>(?:(?!</select>)[^])*<option value="${own}" selected>Finding 1: Linking rules own finding</option>`));
  assert.doesNotMatch(page.text, /Foreign client finding/);
  const row = await db.prepare('SELECT row_version FROM tp_findings WHERE id=?').get(own);
  const removed = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${own}/remove`, { row_version: String(row.row_version) });
  assert.equal(removed.status, 302, toast(removed));
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS c FROM tp_conditions WHERE recommendation_id=? AND finding_id IS NOT NULL').get(rid)).c, 0);
});

test('layout 2: a revised version keeps each condition\'s finding; a finding an issued version cited cannot be removed', async () => {
  const ctx = linked;
  const ownerSession = await sessionFor(main.owner);
  assert.equal((await decide(ownerSession, ctx.ws, ctx.rid, { outcome: 'request_more_information', rationale: 'Please show a restore test.' })).status, 302);
  assert.equal((await consultant.session.post(`${rBase(ctx)}/new-version`, { reason: 'The client asked for a restore test.' })).status, 302);
  const v2 = Number((await recsOf(ctx.a)).at(-1).id);
  const f1 = Number((await db.prepare("SELECT id FROM tp_findings WHERE assessment_id=? AND title='Backups never restored'").get(ctx.a)).id);
  assert.deepEqual((await db.prepare('SELECT finding_id FROM tp_conditions WHERE recommendation_id=?').all(v2)).map(c => Number(c.finding_id)), [f1]);
  const row = await db.prepare('SELECT row_version FROM tp_findings WHERE id=?').get(f1);
  const refused = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${f1}/remove`, { row_version: String(row.row_version) });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /This finding is addressed by condition 1 of recommendation version 1, so it cannot be removed\. Close it instead\./);
  assert.ok(await db.prepare('SELECT id FROM tp_findings WHERE id=?').get(f1), 'still there');
});

test('layout 1: a report issued with the first layout keeps its old layout and reads the scope live', async () => {
  const ctx = await confirmed(main, 'Old Layout Co');
  const rid = await draft(ctx);
  await submit(ctx, rid, 'approve_with_conditions');
  await issue(ctx, rid);
  const snap = await snapOf(rid);
  const old = JSON.parse(snap.content);
  for (const k of ['layoutVersion', 'zone', 'issuedAt', 'validUntilYmd', 'scopeFacts', 'questionnaireFacts', 'documents', 'results', 'contract',
    'rulebooks', 'findingDetails', 'conditionDetails', 'signoff']) delete old[k];
  const text = JSON.stringify(old);
  await db.exec('ALTER TABLE tp_recommendation_snapshots DISABLE TRIGGER USER');
  try {
    await db.prepare('UPDATE tp_recommendation_snapshots SET content=?, content_sha256=? WHERE id=?').run(text, crypto.createHash('sha256').update(text).digest('hex'), snap.id);
  } finally {
    await db.exec('ALTER TABLE tp_recommendation_snapshots ENABLE TRIGGER USER');
  }
  await db.prepare("UPDATE tp_services SET description='Hosting, described after issue' WHERE third_party_id=?").run(ctx.tp);
  assert.equal((await consultant.session.get(firmReport(ctx, rid))).status, 200);
  const html = lastHtml();
  assert.match(html, /data-report-fact="version">Version 1, issued \d{1,2} [A-Z][a-z]{2} \d{4} by Sam Senior</);
  assert.match(html, /<h2>Key findings<\/h2>/);
  assert.match(html, /<h2>Evidence shared with the client<\/h2>/);
  assert.match(html, /Status as of /);
  assert.match(html, /Hosting, described after issue/);
  assert.doesNotMatch(html, /data-report-signoffs|data-report-what-we-did/);
  assert.doesNotMatch(rendered.at(-1).opts.footerLeft, /Document reference/);
});

test('layout 2 rendering: what we did, results by area, contract, rulebooks, delivery model, documents and what they supported', () => {
  const data = {
    layoutVersion: 2, zone: 'Asia/Kolkata', clientName: 'Asterix Bank', thirdPartyName: 'Lumen Cloud', assessmentType: 'Onboarding',
    issuedAt: '2026-11-21T20:00:00.000Z', validUntilYmd: '2027-11-30',
    recommendation: { id: 1, version: 2, outcomeLabel: 'Onboard with conditions', residual: 'Medium', rationale: 'Adequate.', validUntil: '30 November 2027' },
    tier: { label: 'High', reason: '', override: null },
    scopeFacts: { services: [{ description: 'Payments hosting', data: 'Card data', hosting: 'India' }], answers: {}, decidingQuestionId: null, deliveryModel: 'vendor_hosted' },
    questionnaireFacts: { questions: 76, sentAt: '2026-11-02T05:00:00.000Z', submittedAt: '2026-11-09T05:00:00.000Z', notReturned: false, answeredBy: 'Priya Shah',
      clarificationsAsked: 3, clarificationsAnswered: 2 },
    documents: [
      { name: 'soc2.pdf', date: '2026-11-09T05:00:00.000Z', from: 'third_party', released: true, releasedOn: '2026-11-20T05:00:00.000Z', questions: ['AC-1'], areas: ['Access control', 'Logging'], findings: [] },
      { name: 'bcp.docx', date: '2026-11-09T05:00:00.000Z', from: 'third_party', released: false, releasedOn: null, questions: [], areas: [], findings: [1, 2] },
    ],
    results: [{ area: 'Access control', questions: 10, satisfactory: 7, gaps: 2, notApplicable: 1, notReviewed: 0 },
      { area: 'Logging', questions: 5, satisfactory: 4, gaps: 0, notApplicable: 0, notReviewed: 1 }],
    contract: { clauses: 14, satisfactory: 10, gaps: 2, missing: 1, not_required: 1, not_reviewed: 0 },
    rulebooks: ['EU - DORA', 'India baseline (CERT-In + DPDP)'],
    conditions: [], findings: [], findingDetails: [], conditionDetails: [], evidence: [],
    signoff: { preparedBy: 'Casey Consultant', preparedRole: 'Consultant', preparedAt: '2026-11-20T05:00:00.000Z', issuedBy: 'Sam Senior', issuedRole: 'Senior consultant', issuedAt: '2026-11-21T20:00:00.000Z' },
    snapshot: { id: 1, sha256: 'a'.repeat(64), takenAfterIssue: false, takenOn: '22 November 2026' },
    status: { asOf: '22 November 2026', asOfYmd: '2026-11-22', decision: null, tracked: false, conditions: [], approval: '', conditionsSummary: null },
  };
  const html = report.renderHtml(data, { displayName: 'Northwind', addressLines: [], contactLine: '' });
  assert.match(html, /data-report-fact="issued">22 Nov 2026, version 2</);
  assert.match(html, /Valid until <b>30 Nov 2027<\/b>/);
  assert.match(html, /The service is hosted or managed by Lumen Cloud\./);
  assert.match(html, /We sent Lumen Cloud a questionnaire of 76 questions on 2 Nov 2026\. Priya Shah answered it for Lumen Cloud on 9 Nov 2026\. We asked 3 follow-up questions; 2 were answered\. We reviewed the contract against 14 clauses: 10 satisfactory, 2 with gaps, 1 missing and 1 not required\. The questionnaire included the requirements of these regulatory rulebooks: EU - DORA; India baseline \(CERT-In \+ DPDP\)\./);
  const cells = (row, hook) => [...row.matchAll(new RegExp(`<td [^>]*${hook}="([a-z-]+)">([^<]*)</td>`, 'g'))].map(m => [m[1], m[2]]);
  const rowOf = re => (html.match(re) || [''])[0];
  assert.deepEqual(cells(rowOf(/<tr data-report-document="soc2\.pdf"[^]*?<\/tr>/), 'data-report-doc'),
    [['name', 'soc2.pdf'], ['from', 'Lumen Cloud'], ['received', '9 Nov 2026'], ['used-for', 'Access control, Logging'], ['shared', '20 Nov 2026']]);
  assert.match(rowOf(/<tr data-report-document="soc2\.pdf"[^]*?<\/tr>/), /data-report-released="20 Nov 2026"/);
  assert.deepEqual(cells(rowOf(/<tr data-report-document="bcp\.docx"[^]*?<\/tr>/), 'data-report-doc').slice(3), [['used-for', 'findings 1 and 2'], ['shared', 'No']]);
  assert.deepEqual([...html.matchAll(/<th [^>]*data-report-col="([a-z-]+)">([^<]*)<\/th>/g)].map(m => [m[1], m[2]]),
    [['area', 'Area'], ['questions', 'Questions'], ['satisfactory', 'Satisfactory'], ['gaps', 'Gaps'], ['not-applicable', 'Not applicable'], ['not-reviewed', 'Not reviewed']]);
  assert.deepEqual(cells(rowOf(/<tr data-report-area="Access control" data-report-gaps="2">[^]*?<\/tr>/), 'data-report-col').map(c => c[1]), ['Access control', '10', '7', '2', '1', '0']);
  assert.match(html, /data-report-limits>This assessment is based on Lumen Cloud&#39;s answers to the questionnaire and the documents listed above\./);
  assert.match(html, /data-report-signoff="prepared">(?:(?!<\/dd>)[^])*20 Nov 2026/);
  assert.match(html, /data-report-signoff="issued">(?:(?!<\/dd>)[^])*22 Nov 2026/);
  const nr = report.renderHtml({ ...data, questionnaireFacts: { ...data.questionnaireFacts, notReturned: true, submittedAt: null, clarificationsAsked: 0 },
    results: [], contract: null, rulebooks: [] }, { displayName: 'Northwind', addressLines: [], contactLine: '' });
  assert.match(nr, /questionnaire of 76 questions on 2 Nov 2026\. Lumen Cloud did not return it\.<\/p>/);
  assert.doesNotMatch(nr, /data-report-results|follow-up|contract against|rulebook/);
  const all = report.renderHtml({ ...data, results: [data.results[0]] }, { displayName: 'Northwind', addressLines: [], contactLine: '' });
  assert.doesNotMatch(all, /Not reviewed/);
  const untouched = report.renderHtml({ ...data, contract: { clauses: 14, satisfactory: 0, gaps: 0, missing: 0, not_required: 0, not_reviewed: 14 } },
    { displayName: 'Northwind', addressLines: [], contactLine: '' });
  assert.doesNotMatch(untouched, /contract against/);
  const partial = report.renderHtml({ ...data, contract: { clauses: 34, satisfactory: 2, gaps: 1, missing: 1, not_required: 1, not_reviewed: 29 } },
    { displayName: 'Northwind', addressLines: [], contactLine: '' });
  assert.match(partial, /We reviewed 5 of the 34 contract clauses on our checklist: 2 satisfactory, 1 with gaps, 1 missing and 1 not required\./);
});

test('a direct workspace delete cascades through an issued condition that addresses a finding', async () => {
  const c = await tprmClient('Cascade Linked Client');
  const ctx = await confirmed(c, 'Cascade Linked Co');
  const f = await addFinding(ctx, { severity: 'high', title: 'Cascade finding', impact: 'Matters.' });
  const rid = await draft(ctx);
  assert.equal((await saveLinked(ctx, rid, f)).status, 302);
  await issue(ctx, rid);
  assert.equal(Number((await db.prepare('SELECT finding_id FROM tp_conditions WHERE recommendation_id=?').get(rid)).finding_id), f);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(c.id);
  for (const table of ['tp_conditions', 'tp_findings', 'tp_recommendations']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(c.id)).c, 0, table);
  }
});
