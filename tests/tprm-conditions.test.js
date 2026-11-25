'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient, allSteps } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
let env;
let client;
let db;
let firmId;
let managerId;
let C;
let D;
let events;
let rbac;
let consultant;
let consultant2;
let senior;
const sessions = [];
const createdPaths = new Set();

const PASSWORD = 'conditions-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };
const VALID_UNTIL = '2099-12-31';
const DUE_VENDOR = '2099-06-30';
const DUE_CLIENT = '2099-03-31';

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  C = require('../lib/tprm/conditions');
  D = require('../lib/tprm/decisions');
  events = require('../lib/tprm/events');
  rbac = require('../lib/rbac');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
  consultant = await makeUser('cond-consultant@test.local', { role: 'consultant' });
  consultant2 = await makeUser('cond-consultant2@test.local', { role: 'consultant' });
  senior = await makeUser('cond-senior@test.local', { role: 'senior_consultant' });
  for (const u of [consultant, consultant2, senior]) u.session = await signIn(u.email, u.password);
});

test.after(async () => {
  for (const p of await db.prepare('SELECT stored_path FROM tp_condition_proof_files').all()) createdPaths.add(p.stored_path);
  for (const p of await db.prepare('SELECT stored_path FROM tp_evidence').all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  for (const s of sessions) await s.close();
  for (const u of [consultant, consultant2, senior]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId, workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firm : null,
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
    for (const u of [consultant, consultant2, senior]) {
      await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
    }
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`cond-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
  const other = await makeUser(`cond-coord-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'isms_manager' });
  const contributor = await makeUser(`cond-contrib-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'contributor' });
  return { id, owner, other, contributor };
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const rBase = (ws, tp, a) => `${aBase(ws, tp, a)}/recommendations`;
const cBase = (ctx, cid) => `${aBase(ctx.ws, ctx.tp, ctx.a)}/conditions/${cid}`;
const portal = ws => `/workspaces/${ws}/client-portal/third-party-risk`;
const recPage = (ws, rid) => `${portal(ws)}/recommendations/${rid}`;
const assessmentRow = async id => db.prepare('SELECT *, due_date::text AS due_date FROM tp_assessments WHERE id=?').get(id);
const recRow = async id => db.prepare('SELECT * FROM tp_recommendations WHERE id=?').get(id);
const recsOf = async a => db.prepare('SELECT * FROM tp_recommendations WHERE assessment_id=? ORDER BY version').all(a);
const condRow = async id => db.prepare('SELECT *, due_date::text AS due_date, waive_until::text AS waive_until FROM tp_conditions WHERE id=?').get(id);
const proofsOf = async cid => db.prepare('SELECT * FROM tp_condition_proofs WHERE condition_id=? ORDER BY id').all(cid);
const filesOf = async cid => db.prepare('SELECT * FROM tp_condition_proof_files WHERE condition_id=? ORDER BY id').all(cid);
const chain = async (ws, type, id) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type=? AND chain_id=? ORDER BY chain_seq`).all(ws, type, id);
const wsRow = async id => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const unique = prefix => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
const DIRECT_STATUS = 403;
const FIRM_PORTAL_STATUS = 404;
const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';

function multipart(token, files, fields = {}) {
  const boundary = '----tprmcond' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (token) parts.push(`--${boundary}`, 'Content-Disposition: form-data; name="_csrf"', '', token);
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="files"; filename="${f.filename}"`,
      `Content-Type: ${f.type || 'text/plain'}`, '', f.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function stagedFor(name) {
  const dir = path.join(ROOT, 'uploads', `firm_${firmId}`);
  if (!fs.existsSync(dir)) return [];
  const dirs = [dir, ...fs.readdirSync(dir).filter(d => /^client_\d+$/.test(d)).map(d => path.join(dir, d))];
  return dirs.flatMap(d => fs.readdirSync(d)).filter(f => f.endsWith(name.replace(/[^\w.-]/g, '_')));
}

async function track(cid) {
  for (const f of await filesOf(cid)) createdPaths.add(f.stored_path);
}

async function firmProof(session, ctx, cid, files, { note = '', token, rowVersion } = {}) {
  await allSteps(session, aBase(ctx.ws, ctx.tp, ctx.a));
  const rv = rowVersion != null ? rowVersion : (await condRow(cid)).row_version;
  const form = multipart(token === undefined ? session.getCsrfToken() : token, files, { note, row_version: rv });
  const res = await session.post(`${cBase(ctx, cid)}/proofs`, form.body, { headers: form.headers });
  await track(cid);
  return res;
}

async function portalProof(session, ctx, cid, files, { note = '', token, rowVersion } = {}) {
  await session.get(recPage(ctx.ws, ctx.rid));
  const rv = rowVersion != null ? rowVersion : (await condRow(cid)).row_version;
  const form = multipart(token === undefined ? session.getCsrfToken() : token, files, { note, row_version: rv });
  const res = await session.post(`${portal(ctx.ws)}/conditions/${cid}/proofs`, form.body, { headers: form.headers });
  await track(cid);
  return res;
}

async function firmAction(session, ctx, cid, action, body = {}) {
  await allSteps(session, aBase(ctx.ws, ctx.tp, ctx.a));
  return await session.post(`${cBase(ctx, cid)}/${action}`, { row_version: String((await condRow(cid)).row_version), ...body });
}

async function addThirdParty(ws, name, status) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosting' })).status, 302);
  return tp;
}

async function withConditions(c, name, { decide = 'approve_with_conditions', status = 'proposed' } = {}) {
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
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/details`, {
    client_decision_owner_id: String(c.owner.id), due_date: '', row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(rBase(ws, tp, a), { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  const rid = Number((await recsOf(a)).pop().id);
  const saved = await consultant.session.post(`${rBase(ws, tp, a)}/${rid}`, {
    outcome: 'approve_with_conditions', residual_rating: 'medium', rationale: 'Adequate with two fixes.', valid_until: VALID_UNTIL,
    'conditions[0][description]': 'Enforce MFA for all admin accounts', 'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': DUE_VENDOR,
    'conditions[1][description]': 'Sign the data processing agreement', 'conditions[1][owner]': 'client', 'conditions[1][due_date]': DUE_CLIENT,
    intent: 'submit', row_version: String((await recRow(rid)).row_version) });
  assert.equal(saved.status, 302);
  assert.equal((await senior.session.post(`${rBase(ws, tp, a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version) })).status, 302);
  assert.equal((await recRow(rid)).status, 'issued');
  const conds = await db.prepare('SELECT * FROM tp_conditions WHERE recommendation_id=? ORDER BY position').all(rid);
  const ctx = { ws, tp, a, rid, c, vendorId: Number(conds[0].id), clientId: Number(conds[1].id) };
  if (decide) {
    const owner = await sessionFor(c.owner);
    await owner.get(recPage(ws, rid));
    const extra = decide === 'approve_with_conditions' ? {} : { rationale: 'We accept the risk.', risk_acceptance_until: '2099-01-31' };
    const res = await owner.post(`${recPage(ws, rid)}/decision`, { outcome: decide, ...extra });
    assert.equal(res.status, 302, `decision recorded (${toast(res)})`);
  }
  return ctx;
}

async function clientActor(user, ws, memberRole) {
  return { user: { id: user.id, user_type: 'client' }, perms: new Set(rbac.rolePermissions(memberRole)), ws: await wsRow(ws) };
}
async function firmActor(user, ws) {
  const role = rbac.normalizeRole(user.firm_role);
  const perms = role === 'manager' ? new Set(rbac.rolePermissions('manager').concat(['*'])) : new Set(rbac.rolePermissions(role));
  return { user: { id: user.id, user_type: 'firm', firm_id: user.firm_id, firm_role: user.firm_role }, perms, ws: await wsRow(ws) };
}
const managerUser = () => ({ id: managerId, firm_id: firmId, firm_role: 'manager' });

let main;

test('overdue and condition states are computed from the due date and the client\'s day', () => {
  const today = '2030-05-10';
  const open = { status: 'open', due_date: '2030-05-09' };
  let s = C.stateOf(open, today);
  assert.deepEqual([s.met, s.overdue, s.canSubmit, s.canWaive, s.label], [false, true, true, true, 'Open']);
  s = C.stateOf({ status: 'open', due_date: today }, today);
  assert.deepEqual([s.overdue, s.dueSoon], [false, true], 'due today is not overdue yet');
  assert.equal(C.stateOf({ status: 'open', due_date: '2030-06-09' }, today).dueSoon, true, '30 days ahead is due soon');
  assert.equal(C.stateOf({ status: 'open', due_date: '2030-06-10' }, today).dueSoon, false);
  s = C.stateOf({ status: 'proof_submitted', due_date: '2030-05-01' }, today);
  assert.deepEqual([s.overdue, s.awaitingVerification, s.canSubmit, s.canWaive], [true, true, false, false],
    'proof waiting for verification is still overdue');
  s = C.stateOf({ status: 'verified', due_date: '2030-01-01' }, today);
  assert.deepEqual([s.met, s.overdue], [true, false]);
  s = C.stateOf({ status: 'waived', due_date: '2030-01-01', waive_until: null }, today);
  assert.deepEqual([s.met, s.overdue, s.canSubmit], [true, false, false], 'a waiver without expiry is final');
  s = C.stateOf({ status: 'waived', due_date: '2030-01-01', waive_until: '2030-05-10' }, today);
  assert.equal(s.met, true, 'a waiver counts through its expiry day');
  s = C.stateOf({ status: 'waived', due_date: '2030-01-01', waive_until: '2030-05-09' }, today);
  assert.deepEqual([s.met, s.overdue, s.waiverExpired, s.canSubmit, s.label], [false, true, true, true, 'Waiver expired']);
  s = C.stateOf({ status: 'changes_requested', due_date: '2031-01-01' }, today);
  assert.deepEqual([s.overdue, s.canSubmit], [false, true]);

  assert.equal(C.summarize([], today), null);
  let sum = C.summarize([{ status: 'verified', due_date: '2030-01-01' }, { status: 'waived', due_date: '2030-01-01' }], today);
  assert.deepEqual([sum.state, sum.label], ['met', 'Conditions met']);
  sum = C.summarize([{ status: 'verified', due_date: '2030-01-01' }, { status: 'open', due_date: '2030-01-01' }], today);
  assert.deepEqual([sum.state, sum.label, sum.overdue], ['overdue', 'Conditions overdue', 1]);
  sum = C.summarize([{ status: 'verified', due_date: '2030-01-01' }, { status: 'open', due_date: '2031-01-01' }], today);
  assert.deepEqual([sum.state, sum.label], ['open', 'Conditions open: 1 of 2 met']);
});

test('conditions are tracked only once the client decided with conditions (domain, page and database)', async () => {
  const c = await tprmClient('Cond Untracked Client');
  const ctx = await withConditions(c, 'Waiting Co', { decide: null });
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-conditions-tracked="no"/);
  assert.match(page.text, /followed up here once the client decides/);
  assert.doesNotMatch(page.text, /data-tprm-condition-upload/);
  const res = await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'early.txt', content: 'early' }]);
  assert.equal(res.status, 409, 'no proof before the decision');
  assert.match(res.text, /followed up only once the client has decided/);
  await assert.rejects(db.prepare(`UPDATE tp_conditions SET status='waived', waived_by=?, waived_at=now(), waive_reason='x' WHERE id=?`)
    .run(managerId, ctx.vendorId), /tracked only after the client decided/);
  await assert.rejects(db.prepare(`INSERT INTO tp_condition_proofs (workspace_id, recommendation_id, condition_id, submitted_by_kind, submitted_by)
    VALUES (?,?,?,'consultant',?)`).run(ctx.ws, ctx.rid, ctx.vendorId, consultant.id), /only on a condition the client decided with/);
  const portalPage = await (await sessionFor(c.owner)).get(recPage(ctx.ws, ctx.rid));
  assert.doesNotMatch(portalPage.text, /data-tprm-portal-conditions-tracking/);

  const ctx2 = await withConditions(c, 'Plain Onboard Co', { decide: 'approve' });
  const page2 = await allSteps(consultant.session, aBase(ctx2.ws, ctx2.tp, ctx2.a));
  assert.match(page2.text, /data-tprm-conditions-tracked="no"/);
  assert.match(page2.text, /so these conditions are not followed up/);
  assert.equal((await firmProof(consultant.session, ctx2, ctx2.vendorId, [{ filename: 'late.txt', content: 'late' }])).status, 409);
  assert.equal((await condRow(ctx2.vendorId)).status, 'open');
  await assert.rejects(db.prepare(`UPDATE tp_conditions SET description='Softer' WHERE id=?`).run(ctx2.vendorId), /conditions change only while/);
});

test('the client submits proof in the portal for a client-owned condition; a consultant verifies it', async () => {
  main = await tprmClient('Cond Main Client');
  const ctx = await withConditions(main, 'Acme Hosting');
  main.ctx = ctx;
  assert.equal((await assessmentRow(ctx.a)).status, 'completed', 'the assessment is completed: conditions are post-decision work');
  const owner = await sessionFor(main.owner);
  let page = await owner.get(recPage(ctx.ws, ctx.rid));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-portal-conditions-tracking/);
  assert.match(page.text, /data-tprm-portal-proof-form/, 'the owner gets the form on the client-owned condition');
  assert.equal((page.text.match(/data-tprm-portal-proof-form/g) || []).length, 1, 'only on the client-owned condition');

  const content = `DPA signed ${unique('d')}`;
  const res = await portalProof(owner, ctx, ctx.clientId, [{ filename: 'signed-dpa.pdf', content: `${PDF}% ${content}\n`, type: 'application/pdf' }],
    { note: 'Signed by our CFO.' });
  assert.equal(res.status, 302, (res.text || '').slice(0, 300));
  assert.match(toast(res), /sent to your consultants/);
  assert.match(res.location, new RegExp(`recommendations/${ctx.rid}`));
  let cond = await condRow(ctx.clientId);
  assert.equal(cond.status, 'proof_submitted');
  const [proof] = await proofsOf(ctx.clientId);
  assert.deepEqual([proof.submitted_by_kind, Number(proof.submitted_by), proof.note, proof.review_status],
    ['client', main.owner.id, 'Signed by our CFO.', 'pending']);
  const [file] = await filesOf(ctx.clientId);
  assert.equal(file.original_name, 'signed-dpa.pdf');
  assert.equal(file.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'uploads', `firm_${firmId}`, `client_${ctx.ws}`, file.stored_path))).digest('hex'));

  page = await owner.get(recPage(ctx.ws, ctx.rid));
  assert.match(page.text, /signed-dpa\.pdf/);
  assert.match(page.text, /Waiting for your consultants to verify it/);
  assert.ok(!page.text.includes(file.stored_path));
  const download = await owner.get(`${portal(ctx.ws)}/conditions/files/${file.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.text, new RegExp(content));

  const firmPage = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(firmPage.text, new RegExp(`data-tprm-condition="${ctx.clientId}" data-tprm-condition-status="proof_submitted"`));
  assert.match(firmPage.text, /data-tprm-condition-verify/);
  assert.ok(!firmPage.text.includes(file.stored_path));
  const firmDownload = await consultant.session.get(`${cBase(ctx, ctx.clientId)}/files/${file.id}/download`);
  assert.equal(firmDownload.status, 200);
  assert.match(firmDownload.headers['content-disposition'], /^attachment/);
  assert.match(firmPage.text, new RegExp(`data-tp-preview="[^"]*/files/${file.id}/download\\?inline=1"[^>]*data-tprm-proof-preview`));
  const inline = await consultant.session.get(`${cBase(ctx, ctx.clientId)}/files/${file.id}/download?inline=1`);
  assert.equal(inline.status, 200);
  assert.match(inline.headers['content-type'], /^application\/pdf/);
  assert.match(inline.headers['content-disposition'], /^inline;/);
  assert.equal(inline.headers['x-content-type-options'], 'nosniff');
  const verified = await firmAction(consultant.session, ctx, ctx.clientId, 'verify', { comment: 'Checked against the signed copy.' });
  assert.equal(verified.status, 302);
  assert.match(toast(verified), /Condition verified/);
  cond = await condRow(ctx.clientId);
  assert.deepEqual([cond.status, Number(cond.verified_by)], ['verified', consultant.id]);
  const reviewed = (await proofsOf(ctx.clientId))[0];
  assert.deepEqual([reviewed.review_status, Number(reviewed.reviewed_by)], ['verified', consultant.id]);
  page = await owner.get(recPage(ctx.ws, ctx.rid));
  assert.match(page.text, /data-tprm-portal-proof-review="verified"/);
  assert.doesNotMatch(page.text, /Checked against the signed copy/, 'the verification note is firm-internal');
  assert.doesNotMatch(page.text, /data-tprm-portal-proof-form/, 'nothing left to submit for the client');
  const again = await portalProof(owner, ctx, ctx.clientId, [{ filename: 'again.txt', content: 'again' }]);
  assert.equal(again.status, 409, 'refused before any file is accepted');
  assert.match(again.text, /&#34;Verified&#34;|"Verified"/);
  assert.equal((await proofsOf(ctx.clientId)).length, 1);
});

test('portal proof: only client owners and ISMS managers of this workspace, only client-owned conditions', async () => {
  const c = await tprmClient('Cond Portal Rules Client');
  const ctx = await withConditions(c, 'Rules Co');
  const contributor = await sessionFor(c.contributor);
  const page = await contributor.get(recPage(ctx.ws, ctx.rid));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-portal-conditions-tracking/);
  assert.doesNotMatch(page.text, /data-tprm-portal-proof-form/);
  assert.equal((await portalProof(contributor, ctx, ctx.clientId, [{ filename: 'c.txt', content: 'c' }])).status, 403);
  const owner = await sessionFor(c.owner);
  const vendorRes = await portalProof(owner, ctx, ctx.vendorId, [{ filename: 'v.txt', content: 'v' }]);
  assert.equal(vendorRes.status, 403);
  assert.match(vendorRes.text, /collect its proof from the third party/);
  const otherClient = await tprmClient('Cond Portal Other Client');
  const outsider = await sessionFor(otherClient.owner);
  await outsider.get(portal(otherClient.id));
  const form = multipart(outsider.getCsrfToken(), [{ filename: 'x.txt', content: 'x' }], { row_version: 1 });
  assert.equal((await outsider.post(`${portal(otherClient.id)}/conditions/${ctx.clientId}/proofs`, form.body, { headers: form.headers })).status, 404);
  assert.equal((await outsider.get(`${portal(otherClient.id)}/conditions/files/1/download`)).status, 404);
  const direct = await outsider.post(`${portal(ctx.ws)}/conditions/${ctx.clientId}/proofs`, form.body, { headers: form.headers });
  assert.equal(direct.status, DIRECT_STATUS, `another client's user is refused (${direct.status})`);
  const firmPortal = await client.post(`${portal(ctx.ws)}/conditions/${ctx.clientId}/proofs`, form.body, { headers: form.headers });
  assert.equal(firmPortal.status, FIRM_PORTAL_STATUS, `a firm user is refused (${firmPortal.status})`);
  await assert.rejects(C.submitProof(db, await clientActor(c.contributor, ctx.ws, 'contributor'), { via: 'portal', conditionId: ctx.clientId }, [], { note: 'x', row_version: 1 }),
    err => err.status === 403);
  await assert.rejects(db.prepare(`INSERT INTO tp_condition_proofs (workspace_id, recommendation_id, condition_id, submitted_by_kind, submitted_by)
    VALUES (?,?,?,'client',?)`).run(ctx.ws, ctx.rid, ctx.vendorId, c.owner.id), /client-owned condition/);
  await assert.rejects(db.prepare(`INSERT INTO tp_condition_proofs (workspace_id, recommendation_id, condition_id, submitted_by_kind, submitted_by)
    VALUES (?,?,?,'consultant',?)`).run(ctx.ws, ctx.rid, ctx.clientId, consultant.id), /condition the third party owns/);
  await assert.rejects(db.prepare(`INSERT INTO tp_condition_proofs (workspace_id, recommendation_id, condition_id, submitted_by_kind)
    VALUES (?,?,?,'vendor')`).run(ctx.ws, ctx.rid, ctx.vendorId), /through an active link/);
  const coord = await sessionFor(c.other);
  const ok = await portalProof(coord, ctx, ctx.clientId, [{ filename: 'coord.txt', content: `coord ${unique('c')}` }]);
  assert.equal(ok.status, 302, toast(ok));
  assert.equal((await condRow(ctx.clientId)).status, 'proof_submitted');
});

test('third-party-owned: the consultant uploads, cannot verify their own proof; changes requested, resubmitted, verified', async () => {
  const ctx = main.ctx;
  const res = await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'mfa-screenshot.txt', content: `MFA ${unique('m')}` }],
    { note: 'Screenshot from the third party.' });
  assert.equal(res.status, 302, toast(res));
  let cond = await condRow(ctx.vendorId);
  assert.equal(cond.status, 'proof_submitted');
  const [first] = await proofsOf(ctx.vendorId);
  assert.deepEqual([first.submitted_by_kind, Number(first.submitted_by)], ['consultant', consultant.id]);

  let page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-condition-own-proof/);
  const own = await firmAction(consultant.session, ctx, ctx.vendorId, 'verify');
  assert.equal(own.status, 403);
  assert.match(own.text, /someone else verifies it/);
  assert.equal((await firmAction(consultant.session, ctx, ctx.vendorId, 'request-changes', { comment: 'x' })).status, 403);
  await assert.rejects(C.verify(db, await firmActor(consultant, ctx.ws), ctx.tp, ctx.a, ctx.vendorId, { row_version: cond.row_version }),
    err => err.status === 403);
  await assert.rejects(db.prepare(`UPDATE tp_condition_proofs SET review_status='verified', reviewed_by=?, reviewed_at=now() WHERE id=?`)
    .run(consultant.id, first.id), /maker_checker/);

  const noComment = await firmAction(senior.session, ctx, ctx.vendorId, 'request-changes', { comment: '' });
  assert.equal(noComment.status, 302);
  assert.match(toast(noComment), /Say what needs to change/);
  assert.equal((await condRow(ctx.vendorId)).status, 'proof_submitted');
  const changes = await firmAction(senior.session, ctx, ctx.vendorId, 'request-changes', { comment: 'The screenshot does not show the admin accounts.' });
  assert.equal(changes.status, 302);
  cond = await condRow(ctx.vendorId);
  assert.equal(cond.status, 'changes_requested');
  assert.equal((await proofsOf(ctx.vendorId))[0].review_status, 'changes_requested');

  assert.equal((await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'mfa-report.txt', content: `MFA report ${unique('m')}` }])).status, 302);
  assert.equal((await condRow(ctx.vendorId)).status, 'proof_submitted');
  assert.equal((await proofsOf(ctx.vendorId)).length, 2, 'history of submissions kept');
  page = await allSteps(senior.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /The screenshot does not show the admin accounts/, 'the firm page shows the history');
  const verified = await firmAction(senior.session, ctx, ctx.vendorId, 'verify');
  assert.equal(verified.status, 302);
  cond = await condRow(ctx.vendorId);
  assert.deepEqual([cond.status, Number(cond.verified_by)], ['verified', senior.id]);

  const tpChain = await chain(ctx.ws, 'third_party', ctx.tp);
  assert.equal(tpChain[tpChain.length - 1].action, 'third_party.conditions_met');
  assert.deepEqual([tpChain[tpChain.length - 1].after_state.verified, tpChain[tpChain.length - 1].after_state.conditions], [2, 2]);
  const approval = await D.currentApproval(db, await wsRow(ctx.ws), ctx.tp);
  assert.equal(approval.state, 'approved');
  assert.deepEqual([approval.conditions.state, approval.conditions.label], ['met', 'Conditions met']);
  const register = await client.get(`/tprm/clients/${ctx.ws}`);
  assert.match(register.text, /data-tprm-conditions-state="met"[^>]*>Conditions met/);
  const tpPage = await client.get(`/tprm/clients/${ctx.ws}/third-parties/${ctx.tp}`);
  assert.match(tpPage.text, /data-tprm-conditions-state="met"[^>]*>Conditions met/);
  assert.match(tpPage.text, /All conditions met/);
  page = await allSteps(senior.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-condition-status="verified">Verified/);
});

test('the database holds the lifecycle and maker-checker', async () => {
  const c = await tprmClient('Cond Database Client');
  const ctx = await withConditions(c, 'Db Co');
  await assert.rejects(db.prepare(`UPDATE tp_conditions SET status='proof_submitted' WHERE id=?`).run(ctx.vendorId), /needs a submitted proof/);
  await assert.rejects(db.prepare(`UPDATE tp_conditions SET status='verified', verified_by=?, verified_at=now() WHERE id=?`)
    .run(senior.id, ctx.vendorId), /open cannot become verified/);
  assert.equal((await firmProof(consultant.session, ctx, ctx.vendorId, [], { note: 'Confirmed on a call; minutes to follow.' })).status, 302,
    'a note alone is a submission');
  const [proof] = await proofsOf(ctx.vendorId);
  await assert.rejects(db.prepare(`UPDATE tp_condition_proofs SET note='edited' WHERE id=?`).run(proof.id), /never changes/);
  await assert.rejects(db.prepare(`DELETE FROM tp_condition_proofs WHERE id=?`).run(proof.id), /never deleted/);
  await assert.rejects(db.prepare(`UPDATE tp_conditions SET status='waived', waived_by=?, waived_at=now(), waive_reason='x' WHERE id=?`)
    .run(managerId, ctx.vendorId), /proof_submitted cannot become waived/);
  const outsiderFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Cond Outsider Firm')").run()).lastInsertRowid);
  const outsider = await makeUser('cond-outsider-firm-user@test.local', { role: 'manager', firm: outsiderFirm });
  await assert.rejects(db.prepare(`UPDATE tp_condition_proofs SET review_status='verified', reviewed_by=?, reviewed_at=now() WHERE id=?`)
    .run(outsider.id, proof.id), /firm user of this client's firm/);
  await C.verify(db, await firmActor(senior, ctx.ws), ctx.tp, ctx.a, ctx.vendorId, { row_version: (await condRow(ctx.vendorId)).row_version });
  await assert.rejects(db.prepare(`UPDATE tp_conditions SET status='open', verified_by=NULL, verified_at=NULL WHERE id=?`).run(ctx.vendorId),
    /verified cannot become open/);
  await assert.rejects(db.prepare(`INSERT INTO tp_condition_proof_files (workspace_id, condition_id, proof_id, original_name, stored_path, size_bytes, sha256)
    VALUES (?,?,?,'late.txt','late-file.txt',1,?)`).run(ctx.ws, ctx.vendorId, proof.id, 'a'.repeat(64)), /before it is reviewed/);
  assert.equal((await portalProof(await sessionFor(c.owner), ctx, ctx.clientId, [{ filename: 's.txt', content: 's' }], { rowVersion: 99 })).status, 302);
  assert.equal((await condRow(ctx.clientId)).status, 'open', 'a stale row_version stores nothing');
  assert.equal((await filesOf(ctx.clientId)).length, 0);
});

test('waiving: managers only, with a reason and an optional expiry', async () => {
  const c = await tprmClient('Cond Waive Client');
  const ctx = await withConditions(c, 'Waive Co');
  for (const s of [consultant.session, senior.session]) {
    const res = await firmAction(s, ctx, ctx.vendorId, 'waive', { reason: 'Compensating control' });
    assert.equal(res.status, 403, 'only a manager waives');
  }
  await assert.rejects(C.waive(db, await firmActor(senior, ctx.ws), ctx.tp, ctx.a, ctx.vendorId, { reason: 'x', row_version: 1 }), err => err.status === 403);
  await assert.rejects(db.prepare(`UPDATE tp_conditions SET status='waived', waived_by=?, waived_at=now(), waive_reason='x' WHERE id=?`)
    .run(senior.id, ctx.vendorId), /only a manager of the firm waives/);
  let res = await firmAction(client, ctx, ctx.vendorId, 'waive', { reason: '' });
  assert.match(toast(res), /Give the reason/);
  res = await firmAction(client, ctx, ctx.vendorId, 'waive', { reason: 'x', waive_until: '2001-01-01' });
  assert.match(toast(res), /after today/);
  assert.equal((await condRow(ctx.vendorId)).status, 'open');
  const page = await allSteps(client, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-condition-waive/, 'the manager sees the waive form');
  assert.doesNotMatch((await allSteps(senior.session, aBase(ctx.ws, ctx.tp, ctx.a))).text, /data-tprm-condition-waive/);
  res = await firmAction(client, ctx, ctx.vendorId, 'waive', { reason: 'Compensating control: VPN with hardware keys.', waive_until: '2099-09-30' });
  assert.equal(res.status, 302);
  assert.match(toast(res), /Condition waived/);
  const cond = await condRow(ctx.vendorId);
  assert.deepEqual([cond.status, Number(cond.waived_by), cond.waive_reason, cond.waive_until],
    ['waived', managerId, 'Compensating control: VPN with hardware keys.', '2099-09-30']);
  assert.equal((await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'w.txt', content: 'w' }])).status, 409);
  const proof = await db.prepare(`INSERT INTO tp_condition_proofs (workspace_id, recommendation_id, condition_id, submitted_by_kind, submitted_by)
    VALUES (?,?,?,'consultant',?) RETURNING id`).get(ctx.ws, ctx.rid, ctx.vendorId, consultant.id);
  assert.ok(proof.id, 'a waiver with an expiry date can be followed by proof');
  const portalPage = await (await sessionFor(c.owner)).get(recPage(ctx.ws, ctx.rid));
  assert.match(portalPage.text, /Waived until 30 Sep 2099/);
  assert.doesNotMatch(portalPage.text, /Compensating control/);
});

test('overdue conditions: "Conditions overdue" beside the approval, and the conditions due list', async () => {
  const c = await tprmClient('Cond Due Client');
  const ctx = await withConditions(c, 'Due Co');
  const ws = await wsRow(ctx.ws);
  let approvals = await D.approvals(db, ws, [ctx.tp], { today: '2099-01-15' });
  assert.equal(approvals.get(ctx.tp).conditions.state, 'open');
  assert.equal(approvals.get(ctx.tp).state, 'approved', 'the approval itself is unchanged');
  approvals = await D.approvals(db, ws, [ctx.tp], { today: '2099-04-01' });
  assert.deepEqual([approvals.get(ctx.tp).conditions.state, approvals.get(ctx.tp).conditions.label], ['overdue', 'Conditions overdue']);
  assert.equal(approvals.get(ctx.tp).state, 'approved');

  const user = { id: managerId, user_type: 'firm', firm_id: firmId, firm_role: 'manager' };
  const deps = depsFor();
  let due = await C.conditionsDue(deps, user, { today: '2099-04-01' });
  const mine = list => list.filter(r => Number(r.workspace_id) === ctx.ws).map(r => Number(r.id));
  assert.deepEqual(mine(due.overdue), [ctx.clientId], 'the client condition is overdue');
  assert.deepEqual(mine(due.dueSoon), [], 'the third party condition (2099-06-30) is not due within 30 days');
  due = await C.conditionsDue(deps, user, { today: '2099-06-05' });
  assert.deepEqual(mine(due.overdue), [ctx.clientId]);
  assert.deepEqual(mine(due.dueSoon), [ctx.vendorId]);
  assert.equal((await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'due.txt', content: `due ${unique('d')}` }])).status, 302);
  due = await C.conditionsDue(deps, user, { today: '2099-01-15' });
  assert.deepEqual(mine(due.awaiting), [ctx.vendorId]);
  assert.deepEqual(mine(due.dueSoon), []);
  const page = await client.get('/tprm/conditions');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-conditions-due/);
  assert.match(page.text, new RegExp(`data-tprm-conditions-list="awaiting"[\\s\\S]*data-tprm-conditions-row="${ctx.vendorId}"`));
  assert.match((await client.get('/tprm')).text, /href="\/tprm\/conditions"/);
  const stranger = await makeUser('cond-stranger@test.local', { role: 'consultant' });
  const strangerDue = await C.conditionsDue(deps, { ...stranger, user_type: 'firm' }, { today: '2099-04-01' });
  assert.deepEqual(mine(strangerDue.overdue), []);
  assert.notEqual((await (await sessionFor(c.owner)).get('/tprm/conditions')).status, 200);
});

function depsFor() {
  const reach = async user => (rbac.normalizeRole(user.firm_role) === 'consultant'
    ? await db.prepare('SELECT w.* FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ? WHERE w.firm_id = ?').all(user.id, user.firm_id)
    : await db.prepare('SELECT * FROM workspaces WHERE firm_id = ?').all(user.firm_id));
  return {
    db,
    listWorkspaces: reach,
    getWorkspace: async (id, user) => (await reach(user)).find(w => Number(w.id) === Number(id)) || null,
    permissionsFor: async user => {
      const role = rbac.normalizeRole(user.firm_role);
      return new Set(role === 'manager' ? rbac.rolePermissions('manager').concat(['*']) : rbac.rolePermissions(role));
    },
  };
}

test('the review queue lists proof to verify, never the user\'s own upload', async () => {
  const c = await tprmClient('Cond Queue Client');
  const ctx = await withConditions(c, 'Queue Co');
  assert.equal((await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'q.txt', content: `q ${unique('q')}` }])).status, 302);
  assert.equal((await portalProof(await sessionFor(c.owner), ctx, ctx.clientId, [{ filename: 'qc.txt', content: `qc ${unique('q')}` }])).status, 302);
  const seniorQueue = await senior.session.get('/tprm/review');
  assert.equal(seniorQueue.status, 200);
  assert.match(seniorQueue.text, /data-tprm-review-proofs/);
  assert.match(seniorQueue.text, new RegExp(`data-tprm-review-proof="${ctx.vendorId}"`));
  assert.match(seniorQueue.text, new RegExp(`data-tprm-review-proof="${ctx.clientId}"`));
  const consultantQueue = await consultant.session.get('/tprm/review');
  assert.equal(consultantQueue.status, 200);
  assert.doesNotMatch(consultantQueue.text, new RegExp(`data-tprm-review-proof="${ctx.vendorId}"`), 'not their own upload');
  assert.match(consultantQueue.text, new RegExp(`data-tprm-review-proof="${ctx.clientId}"`), 'the client\'s proof is theirs to verify');
  const list = await C.proofQueue(depsFor(), { id: consultant2.id, user_type: 'firm', firm_id: firmId, firm_role: 'consultant' });
  assert.ok(list.some(r => Number(r.id) === ctx.vendorId), 'another consultant verifies the upload');
});

test('the portal shows statuses and the client\'s own submissions, never internal comments or the firm\'s uploads', async () => {
  const c = await tprmClient('Cond Hidden Client');
  const ctx = await withConditions(c, 'Hidden Co');
  const owner = await sessionFor(c.owner);
  assert.equal((await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'firm-internal-upload.txt', content: `fi ${unique('f')}` }],
    { note: 'Internal note about the third party.' })).status, 302);
  assert.equal((await firmAction(senior.session, ctx, ctx.vendorId, 'request-changes', { comment: 'Internal: ask their CISO again.' })).status, 302);
  assert.equal((await portalProof(owner, ctx, ctx.clientId, [{ filename: 'our-dpa.txt', content: `dpa ${unique('p')}` }])).status, 302);
  assert.equal((await firmAction(consultant.session, ctx, ctx.clientId, 'request-changes', { comment: 'Please send the countersigned page.' })).status, 302);
  const page = await owner.get(recPage(ctx.ws, ctx.rid));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-condition-status="changes_requested"/);
  assert.match(page.text, /Please send the countersigned page\./, 'the request for changes on the client\'s own proof is shown');
  for (const hidden of ['Internal note about the third party', 'Internal: ask their CISO again', 'firm-internal-upload.txt', 'uploads/firm_']) {
    assert.ok(!page.text.includes(hidden), `the portal never shows ${hidden}`);
  }
  for (const f of await filesOf(ctx.clientId)) assert.ok(!page.text.includes(f.stored_path));
  const [firmFile] = await filesOf(ctx.vendorId);
  assert.equal((await owner.get(`${portal(ctx.ws)}/conditions/files/${firmFile.id}/download`)).status, 404);
  assert.match(page.text, /data-tprm-portal-proof-form/);
  assert.equal((await portalProof(owner, ctx, ctx.clientId, [{ filename: 'our-dpa-2.txt', content: `dpa2 ${unique('p')}` }])).status, 302);
  assert.equal((await condRow(ctx.clientId)).status, 'proof_submitted');
});

test('upload validation uses the app\'s upload pipeline; nothing is staged on refusal; no storage paths', async () => {
  const c = await tprmClient('Cond Upload Client');
  const ctx = await withConditions(c, 'Upload Co');
  const exe = `${unique('payload')}.exe`;
  let res = await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: exe, content: 'MZ\u0000binary' }]);
  assert.equal(res.status, 400);
  assert.match(res.text, /This file type is not allowed/);
  assert.deepEqual(stagedFor(exe), []);
  const owner = await sessionFor(c.owner);
  const exe2 = `${unique('payload')}.exe`;
  res = await portalProof(owner, ctx, ctx.clientId, [{ filename: exe2, content: 'MZ\u0000binary' }]);
  assert.equal(res.status, 400);
  assert.deepEqual(stagedFor(exe2), []);
  res = await firmProof(consultant.session, ctx, ctx.vendorId, [], { note: '' });
  assert.match(toast(res), /Attach at least one file or write a note/);
  assert.equal((await condRow(ctx.vendorId)).status, 'open');
  const many = Array.from({ length: 11 }, (_, i) => ({ filename: `many-${i}-${unique('m')}.txt`, content: `m${i}` }));
  res = await firmProof(consultant.session, ctx, ctx.vendorId, many);
  assert.equal(res.status, 400);
  assert.match(res.text, /at most 10 files/);
  for (const f of many) assert.deepEqual(stagedFor(f.filename), []);
  res = await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'ok.txt', content: `ok ${unique('o')}` }]);
  assert.equal(res.status, 302);
  const ev = (await chain(ctx.ws, 'assessment', ctx.a)).find(e => e.action === 'condition.proof_submitted');
  assert.equal(ev.after_state.files[0].name, 'ok.txt');
  assert.match(ev.after_state.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(ev.after_state), /stored_path|uploads\//);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  for (const f of await filesOf(ctx.vendorId)) assert.ok(!page.text.includes(f.stored_path));
  assert.doesNotMatch(page.text, /uploads\/firm_/);
});

test('isolation: another client, another firm and unassigned users get 404', async () => {
  const ctx = main.ctx;
  const other = await tprmClient('Cond Isolation Client');
  const otherCtx = await withConditions(other, 'Isolated Co');
  const wrong = { ...ctx, ws: ctx.ws, tp: ctx.tp, a: ctx.a };
  assert.equal((await firmAction(client, wrong, otherCtx.vendorId, 'waive', { reason: 'x' })).status, 404);
  assert.equal((await firmProof(consultant.session, wrong, otherCtx.vendorId, [{ filename: 'i.txt', content: 'i' }])).status, 404);
  const [file] = await filesOf(ctx.clientId);
  assert.equal((await client.get(`${cBase(otherCtx, otherCtx.vendorId)}/files/${file.id}/download`)).status, 404);
  const firm2 = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Cond Other Firm')").run()).lastInsertRowid);
  const foreign = await makeUser('cond-foreign-manager@test.local', { role: 'manager', firm: firm2 });
  const foreignSession = await sessionFor(foreign);
  assert.equal((await allSteps(foreignSession, aBase(ctx.ws, ctx.tp, ctx.a))).status, 404);
  assert.equal((await foreignSession.get(`${cBase(ctx, ctx.clientId)}/files/${file.id}/download`)).status, 404);
  const due = await C.conditionsDue(depsFor(), { ...foreign, user_type: 'firm' }, { today: '2099-12-31' });
  assert.equal([...due.overdue, ...due.dueSoon, ...due.awaiting].filter(r => Number(r.workspace_id) === ctx.ws).length, 0);
  const unassigned = await makeUser('cond-unassigned@test.local', { role: 'consultant' });
  assert.equal((await (await sessionFor(unassigned)).get(`${cBase(ctx, ctx.clientId)}/files/${file.id}/download`)).status, 404);
  assert.equal((await (await sessionFor(other.owner)).get(`${portal(other.id)}/conditions/files/${file.id}/download`)).status, 404);
});

test('CSRF is required on every condition form, multipart included', async () => {
  const c = await tprmClient('Cond CSRF Client');
  const ctx = await withConditions(c, 'Csrf Co');
  for (const token of [null, 'f'.repeat(64)]) {
    const name = `${unique('csrf')}.txt`;
    const res = await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: name, content: 'forged' }], { token });
    assert.equal(res.status, 403, `firm multipart with ${token ? 'a forged' : 'no'} token`);
    assert.deepEqual(stagedFor(name), []);
    const name2 = `${unique('csrf')}.txt`;
    const res2 = await portalProof(await sessionFor(c.owner), ctx, ctx.clientId, [{ filename: name2, content: 'forged' }], { token });
    assert.equal(res2.status, 403, `portal multipart with ${token ? 'a forged' : 'no'} token`);
    assert.deepEqual(stagedFor(name2), []);
  }
  for (const action of ['verify', 'request-changes', 'waive']) {
    const p = `${cBase(ctx, ctx.vendorId)}/${action}`;
    assert.equal((await client.post(p, { row_version: '1', comment: 'x', reason: 'x' }, { csrf: false })).status, 403, `${action} without a token`);
    assert.equal((await client.post(p, { row_version: '1', comment: 'x', reason: 'x', _csrf: 'f'.repeat(64) }, { csrf: false })).status, 403, `${action} forged`);
  }
  assert.equal((await condRow(ctx.vendorId)).status, 'open');
  assert.equal((await condRow(ctx.clientId)).status, 'open');
  assert.equal((await proofsOf(ctx.vendorId)).length + (await proofsOf(ctx.clientId)).length, 0);
});

test('every change writes an event in the assessment chain and the chains verify', async () => {
  const ctx = main.ctx;
  const actions = (await chain(ctx.ws, 'assessment', ctx.a)).map(e => e.action).filter(x => !x.startsWith('message.'));
  const tail = actions.slice(actions.indexOf('client_decision.recorded') + 1);
  assert.deepEqual(tail, ['condition.proof_submitted', 'condition.verified', 'condition.proof_submitted', 'condition.changes_requested',
    'condition.proof_submitted', 'condition.verified']);
  const ev = (await chain(ctx.ws, 'assessment', ctx.a)).filter(e => e.action.startsWith('condition.'));
  assert.equal(Number(ev[0].actor_user_id), main.owner.id, 'the client user is the actor of the client\'s submission');
  assert.equal(ev[0].after_state.submitted_by_kind, 'client');
  assert.equal(ev[3].after_state.comment, 'The screenshot does not show the admin accounts.');
  const waived = await tprmClient('Cond Events Waive Client');
  const wctx = await withConditions(waived, 'Events Waive Co');
  await firmAction(client, wctx, wctx.vendorId, 'waive', { reason: 'Accepted for now.' });
  const wEvent = (await chain(wctx.ws, 'assessment', wctx.a)).pop();
  assert.deepEqual([wEvent.action, wEvent.after_state.reason, Number(wEvent.actor_user_id)], ['condition.waived', 'Accepted for now.', managerId]);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
  assert.deepEqual(await events.verifyChains(db, wctx.ws), []);
  const page = await allSteps(client, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-history-action="condition.verified"/, 'history shows the condition events');
});

test('deleting a workspace removes its proofs, their files and the stored files', async () => {
  const c = await tprmClient('Cond Deleted Client');
  const ctx = await withConditions(c, 'Deleted Co');
  assert.equal((await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'gone.txt', content: `gone ${unique('g')}` }])).status, 302);
  assert.equal((await portalProof(await sessionFor(c.owner), ctx, ctx.clientId, [{ filename: 'gone-client.txt', content: `gc ${unique('g')}` }])).status, 302);
  const stored = (await db.prepare('SELECT stored_path FROM tp_condition_proof_files WHERE workspace_id=?').all(ctx.ws)).map(r => r.stored_path);
  assert.equal(stored.length, 2);
  for (const s of stored) assert.ok(fs.existsSync(path.join(ROOT, 'uploads', `firm_${firmId}`, `client_${ctx.ws}`, s)));
  const deleted = await client.post(`/workspaces/${ctx.ws}/delete`, { confirm_name: 'Cond Deleted Client' });
  assert.equal(deleted.status, 302);
  for (const table of ['tp_condition_proofs', 'tp_condition_proof_files', 'tp_conditions', 'tp_events']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ctx.ws)).c, 0, table);
  }
  for (const s of stored) assert.equal(fs.existsSync(path.join(ROOT, 'uploads', `firm_${firmId}`, `client_${ctx.ws}`, s)), false, 'stored file removed');

  const c2 = await tprmClient('Cond Cascade Client');
  const ctx2 = await withConditions(c2, 'Cascade Co');
  assert.equal((await firmProof(consultant.session, ctx2, ctx2.vendorId, [{ filename: 'cascade.txt', content: `cascade ${unique('c')}` }])).status, 302);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(ctx2.ws);
  for (const table of ['tp_condition_proofs', 'tp_condition_proof_files']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ctx2.ws)).c, 0, table);
  }
  const restoreCheck = fs.readFileSync(path.join(ROOT, 'lib', 'restore-check.js'), 'utf8');
  const counted = restoreCheck.slice(restoreCheck.indexOf('SNAPSHOT_COUNT_TABLES'), restoreCheck.indexOf('LIVE_COUNT_MIN_RATIO'));
  assert.match(counted, /'tp_condition_proofs', 'tp_condition_proof_files'/);
  assert.match(restoreCheck, /table: 'tp_condition_proof_files', column: 'stored_path'/);
});

async function backdate(cid, set) {
  await db.exec('ALTER TABLE tp_conditions DISABLE TRIGGER tp_conditions_guard');
  try {
    await db.prepare(`UPDATE tp_conditions SET ${set} WHERE id=?`).run(cid);
  } finally {
    await db.exec('ALTER TABLE tp_conditions ENABLE TRIGGER tp_conditions_guard');
  }
}

test('an overdue condition is flagged on every page that shows it, and listed first', async () => {
  const c = await tprmClient('Cond Overdue Pages Client');
  const ctx = await withConditions(c, 'Overdue Pages Co');
  await backdate(ctx.clientId, "due_date = DATE '2020-01-31'");
  const page = await allSteps(client, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-conditions-summary="overdue"/);
  assert.match(page.text, new RegExp(`data-tprm-condition="${ctx.clientId}"[^>]*>[\\s\\S]*?data-tprm-condition-overdue`));
  const register = await client.get(`/tprm/clients/${ctx.ws}`);
  assert.match(register.text, /data-tprm-conditions-state="overdue"[^>]*>Conditions overdue/);
  const tpPage = await client.get(`/tprm/clients/${ctx.ws}/third-parties/${ctx.tp}`);
  assert.match(tpPage.text, /data-tprm-conditions-state="overdue"[^>]*>Conditions overdue/);
  assert.match(tpPage.text, /data-tprm-approval="approved"/, 'the approval itself is unchanged');
  const portalPage = await (await sessionFor(c.owner)).get(recPage(ctx.ws, ctx.rid));
  assert.match(portalPage.text, /data-tprm-portal-condition-overdue/);
  assert.match(portalPage.text, /data-tprm-portal-conditions-summary="overdue"/);
  const due = await client.get('/tprm/conditions');
  assert.match(due.text, new RegExp(`data-tprm-conditions-list="overdue"[\\s\\S]*?data-tprm-conditions-row="${ctx.clientId}"[\\s\\S]*?data-tprm-conditions-list="due-soon"`));
  assert.equal((await portalProof(await sessionFor(c.owner), ctx, ctx.clientId, [{ filename: 'late.txt', content: `late ${unique('l')}` }])).status, 302);
  const queue = await senior.session.get('/tprm/review');
  assert.match(queue.text, new RegExp(`data-tprm-review-proof="${ctx.clientId}"[\\s\\S]*?Overdue`));
});

test('an expired waiver: "Waiver expired", proof accepted again (waiver cleared) or a new waiver', async () => {
  const c = await tprmClient('Cond Expired Waiver Client');
  const ctx = await withConditions(c, 'Expired Waiver Co');
  for (const cid of [ctx.vendorId, ctx.clientId]) {
    assert.equal((await firmAction(client, ctx, cid, 'waive', { reason: `Temporary ${cid}`, waive_until: '2099-01-31' })).status, 302);
    await backdate(cid, "waive_until = DATE '2020-01-31', due_date = DATE '2020-01-15'");
  }
  let page = await allSteps(client, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, new RegExp(`data-tprm-condition="${ctx.clientId}" data-tprm-condition-status="waiver_expired"`));
  assert.match(page.text, /Waiver expired/);
  assert.match(page.text, /data-tprm-conditions-summary="overdue"/);
  const owner = await sessionFor(c.owner);
  assert.match((await owner.get(recPage(ctx.ws, ctx.rid))).text, /data-tprm-portal-proof-form/);
  const res = await portalProof(owner, ctx, ctx.clientId, [{ filename: 'after-waiver.txt', content: `aw ${unique('a')}` }]);
  assert.equal(res.status, 302, toast(res));
  let cond = await condRow(ctx.clientId);
  assert.deepEqual([cond.status, cond.waived_by, cond.waive_reason, cond.waive_until], ['proof_submitted', null, null, null]);
  const again = await firmAction(client, ctx, ctx.vendorId, 'waive', { reason: 'Extended once more.' });
  assert.equal(again.status, 302, toast(again));
  cond = await condRow(ctx.vendorId);
  assert.deepEqual([cond.status, cond.waive_reason, cond.waive_until], ['waived', 'Extended once more.', null]);
  assert.equal((await firmProof(consultant.session, ctx, ctx.vendorId, [{ filename: 'final.txt', content: 'final' }])).status, 409);
  const actions = (await chain(ctx.ws, 'assessment', ctx.a)).map(e => e.action).filter(a => a.startsWith('condition.'));
  assert.deepEqual(actions, ['condition.waived', 'condition.waived', 'condition.proof_submitted', 'condition.waived']);
});

test('the cross-client lists show nothing of a client the user cannot reach (real sessions)', async () => {
  const ctx = main.ctx;
  const c = await tprmClient('Cond Lists Isolation Client');
  const lctx = await withConditions(c, 'Lists Isolation Co');
  await backdate(lctx.clientId, "due_date = DATE '2020-01-31'");
  assert.equal((await firmProof(consultant.session, lctx, lctx.vendorId, [{ filename: 'iso.txt', content: `iso ${unique('i')}` }])).status, 302);
  assert.match((await consultant2.session.get('/tprm/conditions')).text, new RegExp(`data-tprm-conditions-row="${lctx.clientId}"`));
  assert.match((await consultant2.session.get('/tprm/review')).text, new RegExp(`data-tprm-review-proof="${lctx.vendorId}"`));
  const unassigned = await makeUser('cond-lists-unassigned@test.local', { role: 'consultant' });
  const firm2 = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Cond Lists Other Firm')").run()).lastInsertRowid);
  const foreign = await makeUser('cond-lists-foreign@test.local', { role: 'manager', firm: firm2 });
  for (const u of [unassigned, foreign]) {
    const s = await sessionFor(u);
    const due = await s.get('/tprm/conditions');
    assert.equal(due.status, 200);
    for (const id of [lctx.clientId, lctx.vendorId, ctx.clientId, ctx.vendorId]) {
      assert.doesNotMatch(due.text, new RegExp(`data-tprm-conditions-row="${id}"`), `${u.email} does not see condition ${id}`);
    }
    const queue = await s.get('/tprm/review');
    assert.doesNotMatch(queue.text, new RegExp(`data-tprm-review-proof="${lctx.vendorId}"`));
  }
});
