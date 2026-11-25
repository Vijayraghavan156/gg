'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'phase5-followup-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };
const VALID_UNTIL = '2099-12-31';
const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';

let env;
let client;
let db;
let firmId;
let D;
let L;
let report;
let events;
let vendorRoute;
let consultant;
let consultant2;
let senior;
let main;
const sessions = [];
const rendered = [];
const createdPaths = new Set();

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  D = require('../lib/tprm/decisions');
  L = require('../lib/tprm/condition-links');
  report = require('../lib/tprm/report');
  events = require('../lib/tprm/events');
  vendorRoute = require('../routes/tprm-vendor');
  report.configure({
    renderPdf: async (html, opts) => {
      rendered.push({ html, opts });
      return Buffer.from(`%PDF-1.4 stub ${crypto.createHash('sha256').update(html).digest('hex')}`);
    },
  });
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  consultant = await makeUser('p5f-consultant@test.local', { role: 'consultant', name: 'Casey Consultant' });
  consultant2 = await makeUser('p5f-consultant2@test.local', { role: 'consultant', name: 'Cory Consultant' });
  senior = await makeUser('p5f-senior@test.local', { role: 'senior_consultant', name: 'Sam Senior' });
  for (const u of [consultant, consultant2, senior]) u.session = await signIn(u.email, u.password);
  main = await tprmClient('P5F Main Client');
});

test.beforeEach(() => {
  for (const l of [vendorRoute.conditionsLimiter, vendorRoute.conditionsPostLimiter]) l.reset();
});

test.after(async () => {
  for (const p of await db.prepare('SELECT stored_path FROM tp_condition_proof_files').all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  for (const s of sessions) await s.close();
  for (const u of [consultant, consultant2, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

async function makeUser(email, { type = 'firm', role = 'consultant', workspaceId = null, memberRole = null, name = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), name || email, type, type === 'firm' ? firmId : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
  return { id, email, password: PASSWORD, firm_id: type === 'firm' ? firmId : null, firm_role: type === 'firm' ? role : null, user_type: type };
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

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, consultant2, senior]) {
    await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`p5f-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner', name: `Owner of ${name}` });
  const contributor = await makeUser(`p5f-contrib-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'contributor' });
  return { id, owner, contributor };
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const rBase = (ws, tp, a) => `${aBase(ws, tp, a)}/recommendations`;
const portal = ws => `/workspaces/${ws}/client-portal/third-party-risk`;
const recPage = (ws, rid) => `${portal(ws)}/recommendations/${rid}`;
const firmReport = ctx => `${rBase(ctx.ws, ctx.tp, ctx.a)}/${ctx.rid}/report.pdf`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const recRow = async id => db.prepare('SELECT * FROM tp_recommendations WHERE id=?').get(id);
const condRow = async id => db.prepare('SELECT *, due_date::text AS due_date FROM tp_conditions WHERE id=?').get(id);
const proofsOf = async cid => db.prepare('SELECT * FROM tp_condition_proofs WHERE condition_id=? ORDER BY id').all(cid);
const linksOf = async a => db.prepare('SELECT * FROM tp_condition_links WHERE assessment_id=? ORDER BY id').all(a);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);
const eventCount = async () => Number((await db.prepare('SELECT COUNT(*)::integer AS c FROM tp_events').get()).c);
const lastHtml = () => rendered.at(-1).html;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function withDisabled(table, trigger, fn) {
  await db.exec(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try { return await fn(); } finally { await db.exec(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); }
}

async function addThirdParty(ws, name, status, service = { description: 'Hosting' }) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  if (service) assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, service)).status, 302);
  return tp;
}

async function withConditions(c, name, { decide = 'approve_with_conditions', finding = false } = {}) {
  const ws = c.id;
  const tp = await addThirdParty(ws, name, 'proposed');
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302);
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/details`, {
    client_decision_owner_id: String(c.owner.id), due_date: '', row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  if (finding) {
    const f = await consultant.session.post(`${aBase(ws, tp, a)}/findings`, {
      status: 'open', severity: 'high', control_ref: 'A.8.5', title: 'Admin MFA gaps', description: 'internal analysis' });
    assert.equal(f.status, 302);
  }
  assert.equal((await consultant.session.post(rBase(ws, tp, a), { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  const rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=? ORDER BY version DESC').get(a)).id);
  const saved = await consultant.session.post(`${rBase(ws, tp, a)}/${rid}`, {
    outcome: 'approve_with_conditions', residual_rating: 'medium', rationale: 'Adequate with two fixes.', valid_until: VALID_UNTIL,
    'conditions[0][description]': 'Enforce MFA for all admin accounts', 'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': '2099-06-30',
    'conditions[1][description]': 'Sign the data processing agreement', 'conditions[1][owner]': 'client', 'conditions[1][due_date]': '2099-03-31',
    intent: 'submit', row_version: String((await recRow(rid)).row_version) });
  assert.equal(saved.status, 302);
  assert.equal((await senior.session.post(`${rBase(ws, tp, a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version) })).status, 302);
  assert.equal((await recRow(rid)).status, 'issued');
  const conds = await db.prepare('SELECT * FROM tp_conditions WHERE recommendation_id=? ORDER BY position').all(rid);
  const ctx = { ws, tp, a, rid, c, vendorId: Number(conds[0].id), clientId: Number(conds[1].id) };
  if (decide) await decideOn(ctx, decide);
  return ctx;
}

async function decideOn(ctx, outcome) {
  const owner = await sessionFor(ctx.c.owner);
  await owner.get(recPage(ctx.ws, ctx.rid));
  const extra = outcome === 'approve_with_conditions' ? {} : { rationale: 'We accept the risk.', risk_acceptance_until: '2099-01-31' };
  const res = await owner.post(`${recPage(ctx.ws, ctx.rid)}/decision`, { outcome, ...extra });
  assert.equal(res.status, 302, `decision recorded (${toast(res)})`);
}

async function createLink(session, ctx, extra = {}) {
  await session.get(aBase(ctx.ws, ctx.tp, ctx.a));
  const res = await session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/conditions-link`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', expires_in_days: '30', ...extra });
  const url = (res.text && res.text.match(/value="([^"]*\/vendor\/c\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
  return { res, token: url ? url.split('/vendor/c/')[1] : null };
}

async function firmAction(session, ctx, cid, action, body = {}) {
  await session.get(aBase(ctx.ws, ctx.tp, ctx.a));
  return await session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/conditions/${cid}/${action}`, { row_version: String((await condRow(cid)).row_version), ...body });
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

const vget = token => request('GET', `/vendor/c/${token}`);
const aftOf = text => (String(text).replace(/<form[^>]*data-vendor-sign-out[\s\S]*?<\/form>/g, '').match(/name="_aft" value="([^"]+)"/) || [])[1];

function multipart(fields, files = []) {
  const boundary = '----tprmp5f' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of fields) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${f.field || 'files'}"; filename="${f.filename}"`,
      `Content-Type: ${f.type || 'application/octet-stream'}`, '', f.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function vendorProof(token, cid, { note = 'Proof attached.', files = [], aft, headers = {} } = {}) {
  const value = aft === undefined ? aftOf((await vget(token)).text) : aft;
  const form = multipart([...(value == null ? [] : [['_aft', value]]), ['note', note]], files);
  const res = await request('POST', `/vendor/c/${token}/conditions/${cid}/proof`, { body: form.body, headers: { ...form.headers, ...headers } });
  for (const r of await db.prepare('SELECT stored_path FROM tp_condition_proof_files').all()) createdPaths.add(r.stored_path);
  return res;
}

function stagedFor(name) {
  const dir = path.join(ROOT, 'uploads', `firm_${firmId}`);
  if (!fs.existsSync(dir)) return [];
  const dirs = [dir, ...fs.readdirSync(dir).filter(d => /^client_\d+$/.test(d)).map(d => path.join(dir, d))];
  return dirs.flatMap(d => fs.readdirSync(d)).filter(f => f.endsWith(name.replace(/[^\w.-]/g, '_')));
}

test('1. overdue conditions never suspend approval: flagged on the register, the third-party page, the portal and the report', async () => {
  const ctx = await withConditions(main, 'Overdue Hosting');
  await withDisabled('tp_conditions', 'tp_conditions_guard', () =>
    db.prepare("UPDATE tp_conditions SET due_date = '2020-01-31' WHERE id = ?").run(ctx.vendorId));
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(ctx.ws);
  const approval = await D.currentApproval(db, ws, ctx.tp);
  assert.equal(approval.state, 'approved', 'an overdue condition does not suspend the approval');
  assert.equal(approval.label, 'Approved until 31 Dec 2099');
  assert.deepEqual([approval.conditions.state, approval.conditions.label], ['overdue', 'Conditions overdue']);

  const register = await consultant.session.get(`/tprm/clients/${ctx.ws}`);
  assert.match(register.text, /data-tprm-conditions-state="overdue">Conditions overdue</);
  const tpPage = await consultant.session.get(`/tprm/clients/${ctx.ws}/third-parties/${ctx.tp}`);
  assert.match(tpPage.text, /data-tprm-conditions-state="overdue"/);

  const owner = await sessionFor(main.owner);
  const home = await owner.get(portal(ctx.ws));
  assert.equal(home.status, 200);
  const row = home.text.slice(home.text.indexOf(`data-tprm-portal-row="${ctx.tp}"`));
  assert.match(row.slice(0, 2000), /data-tprm-approval="approved"/);
  assert.match(row.slice(0, 2000), /data-tprm-portal-conditions-state="overdue">Conditions overdue</);
  const rec = await owner.get(recPage(ctx.ws, ctx.rid));
  assert.match(rec.text, /data-tprm-portal-conditions-summary="overdue"/);

  assert.equal((await consultant.session.get(firmReport(ctx))).status, 200);
  const html = lastHtml();
  assert.match(html, /data-report-status-section data-report-as-of="\d{1,2} [A-Z][a-z]+ \d{4}"/);
  assert.match(html, /data-report-status-approval="Approved until 31 Dec 2099"/);
  assert.match(html, /data-report-status-conditions="Conditions overdue"/);
  assert.match(html, /data-report-now="Open, overdue"[^>]*>(?:(?!<\/tr>)[^])*data-report-status-condition-text>Enforce MFA for all admin accounts</);
  assert.match(html, /data-report-now="Open"[^>]*>(?:(?!<\/tr>)[^])*data-report-status-condition-text>Sign the data processing agreement</);
});

test('2. conditions link: created from the Conditions step, shown once, token hash only, read-only page scoped to open third-party-owned conditions', async () => {
  const waiting = await withConditions(main, 'Waiting Link Co', { decide: null });
  const early = await createLink(consultant.session, waiting);
  assert.equal(early.res.status, 302);
  assert.match(toast(early.res), /once the client has decided on the recommendation with conditions/);
  assert.equal((await linksOf(waiting.a)).length, 0);
  const plain = await withConditions(main, 'Plain Approve Co', { decide: 'approve' });
  assert.match(toast((await createLink(consultant.session, plain)).res), /once the client has decided/);

  const ctx = await withConditions(main, 'Link Hosting');
  main.linkCtx = ctx;
  let page = await consultant.session.get(aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-condition-link-create/);
  const { res, token } = await createLink(consultant.session, ctx);
  assert.equal(res.status, 200);
  assert.match(res.text, /data-tprm-new-condition-link/);
  assert.match(res.headers['cache-control'] || '', /no-store/);
  assert.ok(token, 'the link is in the response');
  main.linkToken = token;
  const [link] = await linksOf(ctx.a);
  assert.equal(link.token_hash, sha(token), 'only the sha256 of the token is stored');
  assert.equal(link.status, 'active');
  assert.equal(Number(link.recommendation_id), ctx.rid);
  const leaked = await db.prepare(`SELECT COUNT(*)::integer AS c FROM tp_events WHERE after_state::text LIKE ? OR before_state::text LIKE ?`)
    .get(`%${token}%`, `%${token}%`);
  assert.equal(leaked.c, 0, 'the token is in no event');
  const created = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'condition_link.created');
  assert.deepEqual(created.after_state.condition_ids, [ctx.vendorId], 'scope: the third-party-owned condition only');
  assert.equal(Number(created.actor_user_id), consultant.id);
  page = await consultant.session.get(aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, new RegExp(`data-tprm-condition-link-active="${link.id}"`));
  assert.equal(page.text.includes(token), false, 'the assessment page never shows the link again');

  const before = await eventCount();
  const linkRows = JSON.stringify(await linksOf(ctx.a));
  const open = await vget(token);
  assert.equal(open.status, 200);
  assert.equal(open.headers['set-cookie'], undefined, 'no session is created');
  assert.match(open.headers['cache-control'], /no-store/);
  assert.match(open.headers['x-robots-tag'], /noindex/);
  assert.match(open.text, /Conditions for P5F Main Client/);
  assert.match(open.text, /Enforce MFA for all admin accounts/);
  assert.match(open.text, new RegExp(`data-vendor-condition-form="${ctx.vendorId}"`));
  assert.doesNotMatch(open.text, /Sign the data processing agreement/, 'the client-owned condition is not shown');
  for (const needle of ['Casey Consultant', 'Sam Senior', 'Link Hosting', 'Adequate with two fixes', 'priya@']) {
    assert.equal(open.text.includes(needle), false, `${needle} is not on the third party's page`);
  }
  assert.equal(await eventCount(), before, 'opening the link writes no event');
  assert.equal(JSON.stringify(await linksOf(ctx.a)), linkRows, 'opening the link changes no row');
});

test('3. conditions link security: one invalid page; POST needs same origin and this link\'s anti-forgery value; other conditions are refused; files checked', async () => {
  const ctx = main.linkCtx;
  const token = main.linkToken;
  const other = await withConditions(main, 'Other Link Co');
  const otherLink = await createLink(consultant2.session, other);
  assert.ok(otherLink.token);

  const unknown = await vget(crypto.randomBytes(32).toString('base64url'));
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /This link is not valid/);
  const malformed = await vget('not-a-token');
  assert.equal(malformed.status, 404);
  assert.equal(malformed.text, unknown.text, 'the same page for every invalid link');
  assert.equal((await request('GET', `/vendor/c/${token}/anything`)).text, unknown.text);

  const file = [{ filename: 'mfa-policy.pdf', content: PDF, type: 'application/pdf' }];
  assert.equal((await vendorProof(token, ctx.vendorId, { aft: null, files: file })).status, 403);
  const foreignAft = aftOf((await vget(otherLink.token)).text);
  assert.equal((await vendorProof(token, ctx.vendorId, { aft: foreignAft, files: file })).status, 403, 'a form of another link is refused');
  assert.equal((await vendorProof(token, ctx.vendorId, { files: file, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await vendorProof(token, ctx.vendorId, { files: file, headers: { origin: 'https://evil.example' } })).status, 403);
  const json = await request('POST', `/vendor/c/${token}/conditions/${ctx.vendorId}/proof`, { body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(json.status, 415);
  const huge = await request('POST', `/vendor/c/${token}/conditions/${ctx.vendorId}/proof`, { body: 'x',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(vendorRoute.BODY_LIMITS.multipartBytes + 1) } });
  assert.equal(huge.status, 413);
  let res = await vendorProof(token, ctx.clientId, { files: file });
  assert.equal(res.status, 400);
  assert.match(res.text, /does not belong to this link/);
  res = await vendorProof(token, other.vendorId, { files: file });
  assert.equal(res.status, 400, 'another assessment\'s condition id is refused');
  res = await vendorProof(token, 'abc', { files: file });
  assert.equal(res.status, 400);
  res = await vendorProof(token, ctx.vendorId, { files: [{ filename: 'tool.exe', content: 'MZ binary', type: 'application/octet-stream' }] });
  assert.equal(res.status, 400);
  assert.deepEqual(stagedFor('tool.exe'), [], 'the refused file is removed');
  for (const cid of [ctx.vendorId, ctx.clientId, other.vendorId]) assert.equal((await proofsOf(cid)).length, 0, 'nothing stored');
  for (const cid of [ctx.vendorId, other.vendorId]) assert.equal((await condRow(cid)).status, 'open');

  const second = await createLink(consultant.session, other);
  assert.equal((await vget(otherLink.token)).text, unknown.text, 'the replaced link no longer opens');
  assert.equal((await vget(otherLink.token)).status, 404);
  const otherLinks = await linksOf(other.a);
  assert.deepEqual(otherLinks.map(l => [l.status, l.revoke_reason]), [['revoked', 'Replaced by a new link'], ['active', null]]);
  const active = otherLinks[1];
  await consultant.session.get(aBase(other.ws, other.tp, other.a));
  const revoked = await consultant.session.post(`${aBase(other.ws, other.tp, other.a)}/conditions-link/${active.id}/revoke`, { row_version: String(active.row_version) });
  assert.equal(revoked.status, 302);
  assert.match(toast(revoked), /revoked/);
  assert.equal((await vget(second.token)).status, 404);
  assert.equal((await vendorProof(second.token, other.vendorId, { aft: aftOf(unknown.text) || 'x', files: file })).status, 404);
  const third = await createLink(consultant.session, other);
  const [, , l3] = await linksOf(other.a);
  await withDisabled('tp_condition_links', 'tp_condition_links_guard', () =>
    db.prepare("UPDATE tp_condition_links SET created_at = now() - interval '40 days', expires_at = now() - interval '1 day' WHERE id = ?").run(l3.id));
  assert.equal((await vget(third.token)).text, unknown.text, 'an expired link gets the invalid page');

  await assert.rejects(db.prepare("UPDATE tp_condition_links SET token_hash = repeat('a', 64) WHERE id = ?").run(l3.id), /never change/);
  await assert.rejects(db.prepare('DELETE FROM tp_condition_links WHERE id = ?').run(l3.id), /never deleted/);
  await assert.rejects(db.prepare(`INSERT INTO tp_condition_proofs (workspace_id, recommendation_id, condition_id, submitted_by_kind, submitted_by, condition_link_id)
    VALUES (?, ?, ?, 'vendor', NULL, ?)`).run(other.ws, other.rid, other.vendorId, l3.id), /through an active link/);
  await assert.rejects(db.prepare(`INSERT INTO tp_condition_proofs (workspace_id, recommendation_id, condition_id, submitted_by_kind, submitted_by)
    VALUES (?, ?, ?, 'vendor', NULL)`).run(other.ws, other.rid, other.vendorId), /through an active link|tp_condition_proofs_vendor_link/);
  await assert.rejects(db.prepare(`INSERT INTO tp_condition_proofs (workspace_id, recommendation_id, condition_id, submitted_by_kind, submitted_by, condition_link_id)
    VALUES (?, ?, ?, 'consultant', ?, ?)`).run(other.ws, other.rid, other.vendorId, consultant.id, l3.id), /tp_condition_proofs_vendor_link/,
    'only a vendor submission names a link');
  const waiting = await withConditions(main, 'Untracked Link Co', { decide: null });
  await assert.rejects(db.prepare(`INSERT INTO tp_condition_links (workspace_id, assessment_id, recommendation_id, token_hash, recipient_name,
    recipient_email, expires_at, created_by) VALUES (?, ?, ?, repeat('b', 64), 'X', 'x@y.z', now() + interval '1 day', ?)`)
    .run(waiting.ws, waiting.a, waiting.rid, consultant.id), /once the client decided on it with conditions/);
});

test('4. the third party sends proof through the link; any firm user with tp.manage verifies it; the link ends when its conditions are met', async () => {
  const ctx = main.linkCtx;
  const token = main.linkToken;
  const [link] = await linksOf(ctx.a);
  const content = `MFA policy ${crypto.randomBytes(4).toString('hex')}`;
  const aft = aftOf((await vget(token)).text);
  let res = await vendorProof(token, ctx.vendorId, { note: 'MFA is enforced since May.', files: [{ filename: 'mfa-policy.pdf', content: `${PDF}% ${content}\n`, type: 'application/pdf' }] });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  assert.equal(res.location, `/vendor/c/${token}?notice=sent`);
  let [proof] = await proofsOf(ctx.vendorId);
  assert.deepEqual([proof.submitted_by_kind, proof.submitted_by, Number(proof.condition_link_id), proof.note, proof.review_status],
    ['vendor', null, Number(link.id), 'MFA is enforced since May.', 'pending']);
  const [file] = await db.prepare('SELECT * FROM tp_condition_proof_files WHERE proof_id = ?').all(proof.id);
  assert.equal(file.original_name, 'mfa-policy.pdf');
  assert.equal((await condRow(ctx.vendorId)).status, 'proof_submitted');
  const ev = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'condition.proof_submitted').at(-1);
  assert.equal(ev.actor_user_id, null, 'no firm or client actor');
  assert.deepEqual([ev.after_state.by, ev.after_state.submitted_by_kind, ev.after_state.condition_link_id], ['third_party', 'vendor', Number(link.id)]);
  assert.equal(ev.after_state.files[0].sha256, file.sha256);

  let open = await request('GET', res.location);
  assert.match(open.text, /Thank you: your proof has been sent/);
  assert.match(open.text, /Proof sent: waiting for verification/);
  assert.doesNotMatch(open.text, new RegExp(`data-vendor-condition-form="${ctx.vendorId}"`));
  assert.doesNotMatch(open.text, new RegExp(file.stored_path), 'no storage path');
  res = await vendorProof(token, ctx.vendorId, { aft, files: [{ filename: 'again.txt', content: 'again', type: 'text/plain' }] });
  assert.equal(res.status, 409, 'nothing more while it waits for verification');
  assert.equal((await proofsOf(ctx.vendorId)).length, 1);

  let page = await consultant.session.get(aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /The third party, through its conditions link/);
  assert.match(page.text, /data-tprm-condition-verify/, 'any firm user with tp.manage may verify it');
  assert.match(page.text, /\(shown to the third party on its conditions link\)/);
  const queue = await consultant.session.get('/tprm/review');
  assert.match(queue.text, new RegExp(`data-tprm-review-proof="${ctx.vendorId}"`), 'in the review queue for any firm user with tp.manage');
  const ownerPage = await (await sessionFor(main.owner)).get(recPage(ctx.ws, ctx.rid));
  assert.doesNotMatch(ownerPage.text, /mfa-policy\.pdf|MFA is enforced since May/);

  res = await firmAction(consultant.session, ctx, ctx.vendorId, 'request-changes', { comment: 'Add the admin MFA report too.' });
  assert.equal(res.status, 302, toast(res));
  open = await vget(token);
  assert.match(open.text, /data-vendor-changes-comment>(?:(?!<\/p>|<\/div>)[^])*Add the admin MFA report too\./);
  assert.match(open.text, new RegExp(`data-vendor-condition-form="${ctx.vendorId}"`));
  res = await vendorProof(token, ctx.vendorId, { note: 'Report attached.', files: [{ filename: 'mfa-report.txt', content: 'all admins enrolled', type: 'text/plain' }] });
  assert.equal(res.status, 303);
  res = await firmAction(consultant.session, ctx, ctx.vendorId, 'verify', { comment: 'Checked.' });
  assert.equal(res.status, 302, toast(res));
  const cond = await condRow(ctx.vendorId);
  assert.deepEqual([cond.status, Number(cond.verified_by)], ['verified', consultant.id]);
  proof = (await proofsOf(ctx.vendorId)).at(-1);
  assert.deepEqual([proof.review_status, Number(proof.reviewed_by)], ['verified', consultant.id]);
  const [after] = await linksOf(ctx.a);
  assert.deepEqual([after.status, after.revoke_reason, Number(after.revoked_by)], ['revoked', L.REVOKE_REASONS.met, consultant.id]);
  assert.equal((await vget(token)).status, 404);
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  assert.deepEqual(actions.slice(-2), ['condition.verified', 'condition_link.revoked']);
  page = await consultant.session.get(aBase(ctx.ws, ctx.tp, ctx.a));
  assert.doesNotMatch(page.text, /data-tprm-condition-link-create/, 'nothing left for a link');
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('5. the report is frozen at issue: findings, rationale and names changed later leave it unchanged; the status section follows the decision', async () => {
  const ctx = await withConditions(main, 'Frozen Hosting', { decide: null, finding: true });
  const snap = await db.prepare('SELECT * FROM tp_recommendation_snapshots WHERE recommendation_id = ?').get(ctx.rid);
  assert.ok(snap, 'the snapshot is taken in the issue transaction');
  assert.equal(snap.taken_after_issue, false);
  assert.equal(snap.content_sha256, sha(snap.content));
  const issued = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'recommendation.issued');
  assert.deepEqual(issued.after_state.report_snapshot, { id: Number(snap.id), sha256: snap.content_sha256 });
  assert.match(snap.content, /Admin MFA gaps/);

  assert.equal((await consultant.session.get(firmReport(ctx))).status, 200);
  const first = lastHtml();
  const frozenPart = html => html.slice(0, html.indexOf('data-report-status-section'));
  assert.match(first, /data-report-finding="1" data-report-severity="High" data-report-control="A\.8\.5" data-report-finding-status="Open"[^>]*>(?:(?!<\/tr>|<\/section>)[^])*data-report-finding-title>1\. Admin MFA gaps</);
  assert.match(first, /The client has not recorded its decision on this version yet\./);

  await withDisabled('tp_findings', 'tp_findings_freeze', () =>
    db.prepare("UPDATE tp_findings SET title = 'Renamed finding', status = 'closed' WHERE assessment_id = ?").run(ctx.a));
  await db.exec('ALTER TABLE tp_recommendations DISABLE TRIGGER USER');
  try {
    await db.prepare("UPDATE tp_recommendations SET rationale = 'Rewritten after issue.' WHERE id = ?").run(ctx.rid);
  } finally {
    await db.exec('ALTER TABLE tp_recommendations ENABLE TRIGGER USER');
  }
  await db.prepare("UPDATE tp_third_parties SET name = 'Renamed Hosting' WHERE id = ?").run(ctx.tp);
  assert.equal((await consultant.session.get(firmReport(ctx))).status, 200);
  const second = lastHtml();
  assert.equal(frozenPart(second), frozenPart(first), 'the recommendation sections are unchanged');
  assert.doesNotMatch(second, /Renamed finding|Rewritten after issue|Renamed Hosting/);

  await decideOn(ctx, 'approve_with_conditions');
  const owner = await sessionFor(main.owner);
  assert.equal((await owner.get(`${recPage(ctx.ws, ctx.rid)}/report.pdf`)).status, 200);
  const third = lastHtml();
  assert.equal(frozenPart(third), frozenPart(first));
  assert.match(third, /data-report-status-decision="Onboard with conditions"/);
  assert.match(third, /data-report-status-approval="Approved until 31 Dec 2099"/);
  assert.match(third, /data-report-status-conditions="Conditions open: 0 of 2 met"/);
  assert.match(third, /data-report-now="Open"[^>]*>(?:(?!<\/tr>)[^])*data-report-status-condition-text>Enforce MFA for all admin accounts</);
  assert.doesNotMatch(third, /data-report-after-issue/, 'taken at issue: no "after issue" note');
  const ev = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'recommendation.report_generated').at(-1);
  assert.deepEqual([ev.after_state.snapshot_id, ev.after_state.snapshot_sha256, ev.after_state.snapshot_taken_after_issue],
    [Number(snap.id), snap.content_sha256, false]);
  assert.match(ev.after_state.status_as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await db.prepare('SELECT COUNT(*)::integer AS c FROM tp_recommendation_snapshots WHERE recommendation_id = ?').get(ctx.rid)).c, 1);

  await assert.rejects(db.prepare("UPDATE tp_recommendation_snapshots SET taken_after_issue = true WHERE id = ?").run(snap.id), /never change/);
  await assert.rejects(db.prepare('DELETE FROM tp_recommendation_snapshots WHERE id = ?').run(snap.id), /never deleted/);
});

test('6. a version issued before snapshots existed gets one on its first report, marked "after issue"', async () => {
  const ctx = await withConditions(main, 'Legacy Hosting', { decide: null });
  await withDisabled('tp_recommendation_snapshots', 'tp_recommendation_snapshots_guard', () =>
    db.prepare('DELETE FROM tp_recommendation_snapshots WHERE recommendation_id = ?').run(ctx.rid));
  assert.equal((await consultant.session.get(firmReport(ctx))).status, 200);
  const snap = await db.prepare('SELECT * FROM tp_recommendation_snapshots WHERE recommendation_id = ?').get(ctx.rid);
  assert.ok(snap);
  assert.equal(snap.taken_after_issue, true);
  assert.equal(Number(snap.taken_by), consultant.id);
  const html = lastHtml();
  assert.match(html, /data-report-after-issue>This report was compiled on \d{1,2} [A-Z][a-z]{2} \d{4} from the records as they stood then, after version 1 was issued\.</);
  let ev = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'recommendation.report_generated').at(-1);
  assert.deepEqual([ev.after_state.snapshot_id, ev.after_state.snapshot_taken_after_issue], [Number(snap.id), true]);
  await withDisabled('tp_findings', 'tp_findings_freeze', async () => {
    const f = await db.prepare(`INSERT INTO tp_findings (workspace_id, assessment_id, control_ref, severity, title, status, description)
      VALUES (?, ?, 'A.5.19', 'low', 'Added later', 'open', 'x') RETURNING id`).get(ctx.ws, ctx.a);
    assert.ok(f);
  });
  assert.equal((await consultant.session.get(firmReport(ctx))).status, 200);
  assert.doesNotMatch(lastHtml(), /Added later/);
  ev = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'recommendation.report_generated').at(-1);
  assert.equal(ev.after_state.snapshot_id, Number(snap.id));
  assert.equal((await db.prepare('SELECT COUNT(*)::integer AS c FROM tp_recommendation_snapshots WHERE recommendation_id = ?').get(ctx.rid)).c, 1);
  await assert.rejects(db.prepare(`INSERT INTO tp_recommendation_snapshots (workspace_id, assessment_id, recommendation_id, content, content_sha256, taken_after_issue)
    VALUES (?, ?, ?, '{}', repeat('0', 64), true)`).run(ctx.ws, ctx.a, ctx.rid), /tp_recommendation_snapshots_sha|one_per_recommendation/);
});

test('7. PDF header and footer use the app\'s font; other renderers keep their options', () => {
  const pack = require('../lib/audit-pack');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const appFont = (css.match(/--font-sans:\s*([^;]+);/) || [])[1];
  assert.ok(appFont);
  assert.equal(pack.APP_FONT_STACK.replace(/'/g, '"'), appFont.trim(), 'the stack is public/app.css --font-sans');
  const t = pack.headerFooterTemplates({ headerLeft: 'Client <A>', headerRight: 'Right', footerLeft: 'Foot' });
  for (const tpl of [t.headerTemplate, t.footerTemplate]) {
    assert.ok(tpl.includes(`font-family:${pack.APP_FONT_STACK};`));
    assert.doesNotMatch(tpl, /font-family:[^;]*"/, 'no double quote inside the style attribute');
  }
  assert.match(t.headerTemplate, /Client &lt;A&gt;/);
  assert.match(t.footerTemplate, /<span class="pageNumber"><\/span> of <span class="totalPages"><\/span>/);
  assert.match(pack.headerFooterTemplates().headerTemplate, /<span style="float:left"><\/span>/, 'no options: empty header');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'tprm', 'report.js'), 'utf8');
  assert.doesNotMatch(src, /Helvetica, Arial/, 'the report body uses the app font too');
});

test('8. portal concentration: the client\'s own third parties in use only, read-only, no firm-only data', async () => {
  const c = await tprmClient('P5F Concentration Client');
  const otherClient = await tprmClient('P5F Other Client');
  const inUse = await addThirdParty(c.id, 'Cloudy Hosting', 'in_use',
    { description: 'Core banking hosting', hosting_countries: 'India, Singapore', data_access: 'SECRET-DATA-ACCESS', annual_spend: '987654', sole_source: '1' });
  await addThirdParty(c.id, 'Second Hosting', 'in_use', { description: 'Backup hosting', hosting_countries: 'India' });
  await addThirdParty(c.id, 'Proposed Payroll', 'proposed', { description: 'Payroll service' });
  await addThirdParty(otherClient.id, 'Other Client Vendor', 'in_use', { description: 'Other client service' });
  const owner = await sessionFor(c.owner);
  const home = await owner.get(portal(c.id));
  assert.match(home.text, new RegExp(`href="${portal(c.id)}/concentration" data-tprm-portal-concentration-link`));
  const res = await owner.get(`${portal(c.id)}/concentration`);
  assert.equal(res.status, 200);
  assert.match(res.text, /data-tprm-portal-concentration/);
  assert.match(res.text, /Cloudy Hosting: Core banking hosting/);
  assert.match(res.text, /data-tprm-group-row="country:india" data-tprm-group-count="2"/);
  assert.match(res.text, /data-tprm-concentration-singles="country"[^>]*>And 1 group with one service each/, 'Singapore, counted in one line');
  assert.match(res.text, /data-tprm-headline="sole_source"/);
  for (const needle of ['Proposed Payroll', 'Payroll service', 'Other Client Vendor', 'SECRET-DATA-ACCESS', '987654', 'href="/tprm/',
    `third_party:id:${inUse}`, 'Concentration across clients']) {
    assert.equal(res.text.includes(needle), false, `${needle} is not on the portal page`);
  }
  assert.equal((await (await sessionFor(c.contributor)).get(`${portal(c.id)}/concentration`)).status, 200);
  assert.equal((await consultant.session.get(`${portal(c.id)}/concentration`)).status, 404);
  const stranger = await sessionFor(otherClient.owner);
  assert.equal((await stranger.get(`${portal(c.id)}/concentration`)).status, 403);
  const own = await stranger.get(`${portal(otherClient.id)}/concentration`);
  assert.match(own.text, /Other Client Vendor/);
  assert.doesNotMatch(own.text, /Cloudy Hosting/);
  const ws = await db.prepare('SELECT * FROM workspaces WHERE id=?').get(c.id);
  assert.equal(await require('../lib/tprm/concentration').forPortal(db, { user: { id: consultant.id, user_type: 'firm' }, perms: new Set(['tp.view']), ws }), null);
});

test('9. rate limits on the conditions link, and deleting a client removes its links, vendor proofs and snapshots', async () => {
  for (let i = 0; i < vendorRoute.RATE_LIMIT.max; i += 1) await vget('not-a-token');
  const limited = await vget(crypto.randomBytes(32).toString('base64url'));
  assert.equal(limited.status, 429);
  assert.ok(limited.headers['retry-after']);
  vendorRoute.conditionsLimiter.reset();
  assert.equal((await vget('not-a-token')).status, 404, 'served again once the window resets');

  const purge = async (name, viaRoute) => {
    const c = await tprmClient(name);
    const ctx = await withConditions(c, `${name} Vendor`);
    const { token } = await createLink(consultant.session, ctx);
    assert.equal((await vendorProof(token, ctx.vendorId, { files: [{ filename: 'purge.txt', content: `purge ${name}`, type: 'text/plain' }] })).status, 303);
    const stored = (await db.prepare('SELECT stored_path FROM tp_condition_proof_files WHERE workspace_id=?').all(ctx.ws)).map(r => r.stored_path);
    assert.equal(stored.length, 1);
    if (viaRoute) {
      const res = await client.post(`/workspaces/${ctx.ws}/delete`, { confirm_name: name });
      assert.equal(res.status, 302);
      for (const s of stored) assert.equal(fs.existsSync(path.join(ROOT, 'uploads', `firm_${firmId}`, `client_${ctx.ws}`, s)), false, 'stored file removed');
    } else {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(ctx.ws);
      for (const s of stored) createdPaths.add(s);
    }
    for (const table of ['tp_condition_links', 'tp_condition_proofs', 'tp_condition_proof_files', 'tp_recommendation_snapshots']) {
      assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ctx.ws)).c, 0, `${table} (${viaRoute ? 'route' : 'cascade'})`);
    }
  };
  await purge('P5F Deleted Client', true);
  await purge('P5F Cascade Client', false);
  const restoreCheck = fs.readFileSync(path.join(ROOT, 'lib', 'restore-check.js'), 'utf8');
  assert.match(restoreCheck, /'tp_condition_links', 'tp_recommendation_snapshots'/);
});

test('signed in to the portal, a person sends proof for a condition under their own name', async () => {
  const ctx = await withConditions(main, 'Portal Proof Co');
  const { token } = await createLink(consultant.session, ctx);
  assert.ok(token);
  const added = await consultant.session.post(`/tprm/clients/${ctx.ws}/third-parties/${ctx.tp}/people`, { name: 'Ivy Chen', email: 'ivy@portalproof.example' });
  assert.equal(added.status, 302);
  const person = await db.prepare(`SELECT * FROM tp_vendor_people WHERE workspace_id=? AND third_party_id=? AND email='ivy@portalproof.example'`).get(ctx.ws, ctx.tp);
  const firm = await db.prepare('SELECT firm_id FROM workspaces WHERE id=?').get(ctx.ws);
  const sid = await require('../lib/tprm/vendor-session').createSession(db, { firmId: Number(firm.firm_id), email: 'ivy@portalproof.example' });
  const cookie = `tpv_sid=${sid}`;
  const home = await request('GET', '/vendor/p/home', { headers: { cookie } });
  assert.match(home.text, new RegExp(`href="/vendor/p/a/${ctx.a}/c">Send proof`));
  const page = await request('GET', `/vendor/p/a/${ctx.a}/c`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`action="/vendor/p/a/${ctx.a}/c/conditions/${ctx.vendorId}/proof"`));
  const form = multipart([['_aft', aftOf(page.text)], ['note', 'MFA is on for every admin.']], [{ filename: 'mfa.txt', content: 'MFA enforced' }]);
  const sent = await request('POST', `/vendor/p/a/${ctx.a}/c/conditions/${ctx.vendorId}/proof`, { body: form.body, headers: { ...form.headers, cookie } });
  for (const r of await db.prepare('SELECT stored_path FROM tp_condition_proof_files').all()) createdPaths.add(r.stored_path);
  assert.equal(sent.status, 303, sent.text.slice(0, 300));
  assert.equal(sent.location, `/vendor/p/a/${ctx.a}/c?notice=sent`);
  const proof = (await proofsOf(ctx.vendorId)).pop();
  assert.equal(Number(proof.submitted_by_person_id), Number(person.id));
  const withLinkAft = multipart([['_aft', aftOf((await vget(token)).text)], ['note', 'x']], []);
  assert.equal((await request('POST', `/vendor/p/a/${ctx.a}/c/conditions/${ctx.vendorId}/proof`, { body: withLinkAft.body, headers: { ...withLinkAft.headers, cookie } })).status, 403);
});
