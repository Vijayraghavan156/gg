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
let D;
let rec;
let ev;
let fd;
let at;
let events;
let rbac;
let dates;
let consultant;
let consultant2;
let outsider;
let senior;
let main;
const createdPaths = new Set();
const sessions = [];

const PASSWORD = 'decisions-followup-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };
const VALID_UNTIL = '2099-12-31';
const DUE = '2099-06-30';

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  D = require('../lib/tprm/decisions');
  rec = require('../lib/tprm/recommendations');
  ev = require('../lib/tprm/evidence');
  fd = require('../lib/tprm/findings');
  at = require('../lib/tprm/assessments');
  events = require('../lib/tprm/events');
  rbac = require('../lib/rbac');
  dates = require('../lib/dates');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
  consultant = await makeUser('fu-consultant@test.local', { role: 'consultant' });
  consultant2 = await makeUser('fu-consultant2@test.local', { role: 'consultant' });
  outsider = await makeUser('fu-outsider@test.local', { role: 'consultant' });
  senior = await makeUser('fu-senior@test.local', { role: 'senior_consultant' });
  for (const u of [consultant, consultant2, senior]) u.session = await signIn(u.email, u.password);
  main = await tprmClient('Followup Main Client');
});

test.after(async () => {
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

async function makeUser(email, { type = 'firm', role = 'consultant', workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firmId : null,
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

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, consultant2, senior]) {
    await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`fu-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
  return { id, owner };
}

async function sessionFor(user) {
  if (!user.session) {
    user.session = await signIn(user.email, user.password);
    sessions.push(user.session);
  }
  return user.session;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const rBase = (ws, tp, a) => `${aBase(ws, tp, a)}/recommendations`;
const recPage = (ws, rid) => `/workspaces/${ws}/client-portal/third-party-risk/recommendations/${rid}`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const recRow = async id => db.prepare('SELECT *, valid_until::text AS valid_until FROM tp_recommendations WHERE id=?').get(id);
const recsOf = async a => db.prepare('SELECT * FROM tp_recommendations WHERE assessment_id=? ORDER BY version').all(a);
const evRow = async id => db.prepare('SELECT * FROM tp_evidence WHERE id=?').get(id);
const findingRow = async id => db.prepare('SELECT * FROM tp_findings WHERE id=?').get(id);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);
const wsRow = async id => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);

async function actorFor(user, ws) {
  const role = rbac.normalizeRole(user.firm_role);
  const perms = role === 'manager' ? new Set(rbac.rolePermissions('manager').concat(['*'])) : new Set(rbac.rolePermissions(role));
  return { user: { id: user.id, user_type: 'firm', firm_id: user.firm_id, firm_role: user.firm_role }, perms, ws: await wsRow(ws) };
}
const managerUser = () => ({ id: managerId, firm_id: firmId, firm_role: 'manager', user_type: 'firm' });

const lookup = () => ({
  db,
  getWorkspace: async (id, user) => {
    const ws = await wsRow(id);
    if (!ws || Number(ws.firm_id) !== Number(user.firm_id)) return null;
    if (rbac.isManager(rbac.normalizeRole(user.firm_role))) return ws;
    const m = await db.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(id, user.id);
    return m ? { ...ws, _userRole: rbac.normalizeRole(m.role) } : null;
  },
  permissionsFor: async (user, ws) => (rbac.isManager(rbac.normalizeRole(user.firm_role))
    ? new Set(rbac.rolePermissions('manager').concat(['*'])) : new Set(rbac.rolePermissions(ws._userRole || 'consultant'))),
});

function multipart(token, files) {
  const boundary = '----tprmfu' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (token) parts.push(`--${boundary}`, 'Content-Disposition: form-data; name="_csrf"', '', token);
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="files"; filename="${f.filename}"`,
      'Content-Type: text/plain', '', f.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(ctx, filename, content = filename + ' bytes', session = consultant.session) {
  const form = multipart(session.getCsrfToken(), [{ filename, content }]);
  return await session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence`, form.body, { headers: form.headers });
}

async function uploadOne(ctx, filename) {
  const res = await upload(ctx, filename);
  assert.equal(res.status, 302, `upload redirects (got ${res.status})`);
  const row = await db.prepare('SELECT * FROM tp_evidence WHERE workspace_id=? AND assessment_id=? AND original_name=?').get(ctx.ws, ctx.a, filename);
  createdPaths.add(row.stored_path);
  return row;
}

async function addThirdParty(ws, name, status) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosting' })).status, 302);
  return tp;
}

async function confirmed(name, { status = 'proposed' } = {}) {
  const ws = main.id;
  const tp = await addThirdParty(ws, name, status);
  const started = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(started.status, 302);
  const a = idIn(started.location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  const res = await consultant.session.post(`${aBase(ws, tp, a)}/details`, {
    client_decision_owner_id: String(main.owner.id), due_date: '', row_version: String((await assessmentRow(a)).row_version) });
  assert.equal(res.status, 302);
  return { ws, tp, a };
}

function draftBody(outcome, extra = {}) {
  const body = { outcome, residual_rating: 'medium', rationale: 'Controls are adequate.', valid_until: VALID_UNTIL, ...extra };
  if (outcome === 'approve_with_conditions') {
    Object.assign(body, { 'conditions[0][description]': 'Enforce MFA', 'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': DUE });
  }
  return body;
}

async function createDraft(ctx, session = consultant.session) {
  const res = await session.post(rBase(ctx.ws, ctx.tp, ctx.a), { row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(res.status, 302, `draft created (${toast(res)})`);
  const rows = await recsOf(ctx.a);
  return Number(rows[rows.length - 1].id);
}

async function submit(ctx, rid, outcome = 'approve', { session = consultant.session, extra = {} } = {}) {
  const res = await session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}`, {
    ...draftBody(outcome, extra), intent: 'submit', row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 302);
  return res;
}

async function issue(ctx, rid, session = senior.session) {
  return await session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version) });
}

async function decide(ws, rid, body) {
  const s = await sessionFor(main.owner);
  await s.get(recPage(ws, rid));
  return await s.post(`${recPage(ws, rid)}/decision`, { ...body });
}

async function addFinding(ctx, fields = {}, session = consultant.session) {
  return await session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings`, { status: 'open', severity: 'medium', title: 'Finding', ...fields });
}

async function assertFrozen(ctx, { file, finding, label }) {
  const a = await assessmentRow(ctx.a);
  const res = await upload(ctx, `frozen-${crypto.randomBytes(3).toString('hex')}.txt`);
  assert.equal(res.status, 409, `${label}: upload refused`);
  assert.match(res.text, /frozen|can no longer change/, `${label}: the refusal says why`);
  const f = await evRow(file.id);
  assert.equal((await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${file.id}/delete`, { row_version: String(f.row_version) })).status, 409,
    `${label}: deleting an unreleased file refused`);
  assert.ok(await evRow(file.id), `${label}: the file is still there`);
  assert.equal((await addFinding(ctx, { title: 'Late finding' })).status, 409, `${label}: adding a finding refused`);
  assert.equal((await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/new`)).status, 409, `${label}: the add form refused`);
  assert.equal((await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${finding.id}/edit`)).status, 409, `${label}: the edit form refused`);
  const fr = await findingRow(finding.id);
  assert.equal((await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${finding.id}`, {
    severity: 'high', title: 'Changed', status: 'open', row_version: String(fr.row_version) })).status, 409, `${label}: editing a finding refused`);
  assert.equal((await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${finding.id}/remove`, { row_version: String(fr.row_version) })).status, 409,
    `${label}: removing a finding refused`);
  assert.equal((await findingRow(finding.id)).title, fr.title);
  const actor = await actorFor(consultant, ctx.ws);
  await assert.rejects(fd.addFinding(db, actor, ctx.tp, ctx.a, { severity: 'low', title: 'Domain' }), e => e.status === 409, `${label}: domain refuses findings`);
  await assert.rejects(ev.deleteEvidence(db, actor, ctx.tp, ctx.a, file.id, { row_version: f.row_version }), e => e.status === 409, `${label}: domain refuses deletes`);
  await assert.rejects(ev.assertCanUpload(db, actor, ctx.tp, ctx.a), e => e.status === 409, `${label}: domain refuses uploads`);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.doesNotMatch(page.text, /data-tprm-upload-form/, `${label}: no upload form`);
  assert.doesNotMatch(page.text, /data-tprm-add-finding/, `${label}: no add finding`);
  assert.doesNotMatch(page.text, /data-tprm-edit-finding/, `${label}: no edit finding`);
  assert.doesNotMatch(page.text, /data-tprm-delete-form/, `${label}: no delete`);
  assert.equal(a.status, (await assessmentRow(ctx.a)).status);
}

async function assertUnfrozen(ctx, label) {
  const name = `unfrozen-${crypto.randomBytes(3).toString('hex')}.txt`;
  const res = await upload(ctx, name);
  assert.equal(res.status, 302, `${label}: upload allowed again`);
  const row = await db.prepare('SELECT * FROM tp_evidence WHERE assessment_id=? AND original_name=?').get(ctx.a, name);
  createdPaths.add(row.stored_path);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-upload-form/, `${label}: the upload form is back`);
  assert.doesNotMatch(page.text, /data-tprm-evidence-frozen/);
  return row;
}

test('item 9: evidence and findings freeze from submission; recall, changes requested and a revised version unfreeze them; release stays allowed', async () => {
  const ctx = await confirmed('Freeze Co');
  const file = await uploadOne(ctx, 'freeze-a.txt');
  const toRelease = await uploadOne(ctx, 'freeze-b.txt');
  assert.equal((await addFinding(ctx, { title: 'MFA gap', evidence: String(file.id) })).status, 302);
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=?').get(ctx.a);
  const rid = await createDraft(ctx);
  await assertUnfrozen(ctx, 'draft');

  await submit(ctx, rid);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_in_review');
  await assertFrozen(ctx, { file, finding, label: 'in review' });
  let page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-evidence-frozen/);
  assert.match(page.text, /data-tprm-release-form/, 'release is still offered');
  let r = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${toRelease.id}/release`, { row_version: String(toRelease.row_version) });
  assert.equal(r.status, 302, 'released while frozen');
  assert.equal((await evRow(toRelease.id)).released_to_client, true);

  await assert.rejects(db.prepare(`INSERT INTO tp_findings (workspace_id, assessment_id, severity, title) VALUES (?, ?, 'low', 'sql')`).run(ctx.ws, ctx.a),
    /frozen/);
  await assert.rejects(db.prepare('UPDATE tp_findings SET title = ? WHERE id = ?').run('sql', finding.id), /frozen/);
  await assert.rejects(db.prepare('DELETE FROM tp_finding_evidence WHERE finding_id = ?').run(finding.id), /frozen/);
  await assert.rejects(db.prepare('DELETE FROM tp_evidence WHERE id = ?').run(file.id), /frozen/);
  await assert.rejects(db.prepare(`INSERT INTO tp_evidence (workspace_id, assessment_id, original_name, stored_path, size_bytes, sha256)
    VALUES (?, ?, 'x.txt', ?, 1, ?)`).run(ctx.ws, ctx.a, 'fu-sql-' + crypto.randomBytes(4).toString('hex'), 'a'.repeat(64)), /frozen/);

  r = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/recall`, { row_version: String((await recRow(rid)).row_version) });
  assert.equal(r.status, 302);
  await assertUnfrozen(ctx, 'recalled');
  await submit(ctx, rid);
  await assertFrozen(ctx, { file, finding, label: 'resubmitted' });

  r = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/request-changes`, { comment: 'Add the SOC 2 report.', row_version: String((await recRow(rid)).row_version) });
  assert.equal(r.status, 302);
  await assertUnfrozen(ctx, 'changes requested');

  await submit(ctx, rid);
  assert.equal((await issue(ctx, rid)).status, 302);
  assert.equal((await recRow(rid)).status, 'issued');
  await assertFrozen(ctx, { file, finding, label: 'issued' });
  assert.equal((await decide(ctx.ws, rid, { outcome: 'request_more_information', rationale: 'Pen test report please.' })).status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'information_requested');
  await assertFrozen(ctx, { file, finding, label: 'information requested' });
  page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /Start the revised recommendation first/);
  r = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/new-version`, { reason: 'Client asked for the pen test.' });
  assert.equal(r.status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_draft');
  const late = await assertUnfrozen(ctx, 'revised version');
  assert.equal((await addFinding(ctx, { title: 'Pen test finding' })).status, 302, 'findings change with the revised version');

  const v2 = Number((await recsOf(ctx.a))[1].id);
  await submit(ctx, v2);
  assert.equal((await issue(ctx, v2)).status, 302);
  assert.equal((await decide(ctx.ws, v2, { outcome: 'approve' })).status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'completed');
  await assertFrozen(ctx, { file, finding, label: 'completed' });
  r = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${late.id}/release`, { row_version: String(late.row_version) });
  assert.equal(r.status, 302, 'released on a completed assessment');
  assert.equal((await evRow(late.id)).released_to_client, true);
  const owner = await sessionFor(main.owner);
  assert.equal((await owner.get(`${recPage(ctx.ws, v2)}/evidence/${late.id}/download`)).status, 200, 'the client downloads it');
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('item 9: withdrawing an unissued first version unfreezes; withdrawing a revised draft freezes again', async () => {
  const ctx = await confirmed('Withdraw Freeze Co');
  await uploadOne(ctx, 'withdraw-a.txt');
  const rid = await createDraft(ctx);
  await submit(ctx, rid);
  assert.equal((await upload(ctx, 'withdraw-frozen.txt')).status, 409);
  let res = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/withdraw`, { reason: 'Rethink', row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'tier_confirmed');
  await assertUnfrozen(ctx, 'withdrawn before issue');
  const r2 = await createDraft(ctx);
  await submit(ctx, r2);
  assert.equal((await issue(ctx, r2)).status, 302);
  assert.equal((await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/new-version`, { reason: 'Refresh' })).status, 302);
  await assertUnfrozen(ctx, 'revised draft');
  const v3 = Number((await recsOf(ctx.a)).pop().id);
  res = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${v3}/withdraw`, { reason: 'Not needed', row_version: String((await recRow(v3)).row_version) });
  assert.equal(res.status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_issued');
  assert.equal((await upload(ctx, 'withdraw-refrozen.txt')).status, 409, 'frozen again with the issued version');
});

test('the recall and hand-over forms are CSRF-protected', async () => {
  const ctx = await confirmed('Csrf Followup Co');
  const rid = await createDraft(ctx);
  await submit(ctx, rid);
  const rv = String((await recRow(rid)).row_version);
  assert.equal((await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/recall`, { row_version: rv }, { csrf: false })).status, 403);
  assert.equal((await client.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/reassign`, { author_id: String(consultant2.id), row_version: rv }, { csrf: false })).status, 403);
  const row = await recRow(rid);
  assert.deepEqual([row.status, Number(row.author_id)], ['in_review', consultant.id]);
});

test('item 9: a cancelled assessment refuses release too (route, domain, database)', async () => {
  const ctx = await confirmed('Cancelled Release Co');
  const file = await uploadOne(ctx, 'cancelled.txt');
  const r = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/cancel`, { reason: 'Not needed', row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(r.status, 302);
  const res = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${file.id}/release`, { row_version: String(file.row_version) });
  assert.equal(res.status, 409);
  assert.match(res.text, /cancelled/);
  await assert.rejects(ev.releaseEvidence(db, await actorFor(consultant, ctx.ws), ctx.tp, ctx.a, file.id, { row_version: file.row_version }),
    e => e.status === 409);
  await assert.rejects(db.prepare(`UPDATE tp_evidence SET released_to_client = true, released_by = ?, released_at = now() WHERE id = ?`).run(consultant.id, file.id),
    /cancelled/);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.doesNotMatch(page.text, /data-tprm-release-form/);
  assert.equal((await evRow(file.id)).released_to_client, false);
});

test('item 10: a manager hands a recommendation to another consultant; maker-checker holds', async () => {
  const ctx = await confirmed('Handover Co');
  const rid = await createDraft(ctx);
  const actorM = { ...(await actorFor(managerUser(), ctx.ws)) };

  let page = await allSteps(client, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-reassign/);
  assert.match(page.text, new RegExp(`<option value="${consultant2.id}">`), 'an assigned consultant is offered');
  assert.doesNotMatch(page.text, new RegExp(`<option value="${outsider.id}">`), 'an unassigned consultant is not');
  assert.doesNotMatch((await allSteps(senior.session, aBase(ctx.ws, ctx.tp, ctx.a))).text, /data-tprm-rec-reassign/);
  let res = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/reassign`, { author_id: String(consultant2.id), row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 403, 'a senior consultant is not a manager');
  await assert.rejects(rec.reassign(db, await actorFor(senior, ctx.ws), ctx.tp, ctx.a, rid, { author_id: consultant2.id, row_version: (await recRow(rid)).row_version }, { lookup: lookup() }),
    e => e.status === 403);
  res = await client.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/reassign`, { author_id: String(outsider.id), row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 302);
  assert.match(toast(res), /tp\.manage/, 'a consultant without access to the client is refused');
  assert.equal(Number((await recRow(rid)).author_id), consultant.id);
  res = await client.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/reassign`, { author_id: String(consultant2.id), row_version: '999' });
  assert.equal(res.status, 409, 'stale row_version');

  res = await client.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/reassign`, { author_id: String(consultant2.id), reason: 'Leave', row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 302);
  assert.equal(Number((await recRow(rid)).author_id), consultant2.id);
  assert.equal((await recRow(rid)).status, 'draft');
  let ev1 = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'recommendation.reassigned').pop();
  assert.equal(ev1.actor_user_id, managerId);
  assert.deepEqual([ev1.before_state.author_id, ev1.after_state.author_id, ev1.after_state.reason], [consultant.id, consultant2.id, 'Leave']);
  res = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}`, { ...draftBody('approve'), row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 403, 'the previous author no longer edits it');

  await submit(ctx, rid, 'approve', { session: consultant2.session });
  res = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/request-changes`, { comment: 'Tighten the rationale.', row_version: String((await recRow(rid)).row_version) });
  assert.equal((await recRow(rid)).status, 'changes_requested');
  res = await client.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/reassign`, { author_id: String(senior.id), row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 302);
  let row = await recRow(rid);
  assert.deepEqual([Number(row.author_id), row.status, row.reviewer_id, row.review_comment], [senior.id, 'draft', null, null]);
  ev1 = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'recommendation.reassigned').pop();
  assert.equal(ev1.after_state.review_reset, true);
  assert.equal(ev1.before_state.review_comment, 'Tighten the rationale.', 'the reset review is kept in the event');
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_draft');
  await submit(ctx, rid, 'approve', { session: senior.session });
  assert.equal((await issue(ctx, rid, senior.session)).status, 403, 'the new author never reviews');

  res = await client.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/reassign`, { author_id: String(consultant.id), row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 302);
  row = await recRow(rid);
  assert.deepEqual([Number(row.author_id), row.status], [consultant.id, 'in_review']);
  assert.equal((await issue(ctx, rid, senior.session)).status, 302, 'the former author may now review it');
  assert.equal((await recRow(rid)).status, 'issued');

  res = await client.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/reassign`, { author_id: String(consultant2.id), row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 409);
  await assert.rejects(rec.reassign(db, actorM, ctx.tp, ctx.a, rid, { author_id: consultant2.id, row_version: (await recRow(rid)).row_version }, { lookup: lookup() }),
    e => e.status === 409);
  await assert.rejects(db.prepare('UPDATE tp_recommendations SET author_id = ? WHERE id = ?').run(consultant2.id, rid), /author changes only before issue/);
  const ctx2 = await confirmed('Handover Check Co');
  const r2 = await createDraft(ctx2);
  await submit(ctx2, r2);
  await senior.session.post(`${rBase(ctx2.ws, ctx2.tp, ctx2.a)}/${r2}/request-changes`, { comment: 'More', row_version: String((await recRow(r2)).row_version) });
  await assert.rejects(db.prepare('UPDATE tp_recommendations SET author_id = ? WHERE id = ?').run(senior.id, r2), /maker_checker/);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('item 11: the author recalls an in-review recommendation to draft before any review action', async () => {
  const ctx = await confirmed('Recall Co');
  const rid = await createDraft(ctx);
  let res = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/recall`, { row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 409, 'a draft is not in review');
  await submit(ctx, rid);
  const staleIssue = String((await recRow(rid)).row_version);
  let queue = await senior.session.get('/tprm/review');
  assert.match(queue.text, new RegExp(`data-tprm-review-recommendation="${rid}"`));
  let page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-recall-form/);
  assert.doesNotMatch((await allSteps(consultant2.session, aBase(ctx.ws, ctx.tp, ctx.a))).text, /data-tprm-rec-recall-form/);
  res = await consultant2.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/recall`, { row_version: staleIssue });
  assert.equal(res.status, 403, 'only the author recalls');

  res = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/recall`, { row_version: staleIssue });
  assert.equal(res.status, 302);
  assert.match(toast(res), /recalled to draft/);
  const rows = await recsOf(ctx.a);
  assert.deepEqual(rows.map(r => [Number(r.id), r.version, r.status]), [[rid, 1, 'draft']], 'same row and version, no new one');
  assert.equal(rows[0].submitted_at, null);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_draft');
  const recalled = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'recommendation.recalled');
  assert.equal(recalled.actor_user_id, consultant.id);
  assert.equal(recalled.after_state.status, 'draft');
  queue = await senior.session.get('/tprm/review');
  assert.doesNotMatch(queue.text, new RegExp(`data-tprm-review-recommendation="${rid}"`), 'the queue no longer lists it');
  assert.equal((await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: staleIssue })).status, 409,
    'the reviewer\'s stale issue form is refused');
  await submit(ctx, rid, 'approve', { extra: { rationale: 'Revised before review.' } });
  await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/request-changes`, { comment: 'One more thing.', row_version: String((await recRow(rid)).row_version) });
  await assert.rejects(rec.recall(db, await actorFor(consultant, ctx.ws), ctx.tp, ctx.a, rid, { row_version: (await recRow(rid)).row_version }),
    e => e.status === 409, 'changes requested is not in review');
  await submit(ctx, rid);
  assert.equal((await issue(ctx, rid)).status, 302);
  await assert.rejects(rec.recall(db, await actorFor(consultant, ctx.ws), ctx.tp, ctx.a, rid, { row_version: (await recRow(rid)).row_version }),
    e => e.status === 409, 'an issued recommendation is not recalled');
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status = 'draft' WHERE id = ?`).run(rid), /immutable/);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('item 12: cancelling withdraws an unissued recommendation, and is refused once one has been issued', async () => {
  const c1 = await confirmed('Cancel Draft Co');
  const r1 = await createDraft(c1);
  let res = await consultant.session.post(`${aBase(c1.ws, c1.tp, c1.a)}/cancel`, { reason: 'Client changed its mind', row_version: String((await assessmentRow(c1.a)).row_version) });
  assert.equal(res.status, 302);
  assert.equal((await assessmentRow(c1.a)).status, 'cancelled');
  let row = await recRow(r1);
  assert.deepEqual([row.status, row.withdraw_reason, Number(row.withdrawn_by)], ['withdrawn', 'Assessment cancelled', consultant.id]);
  const actions = (await chain(c1.ws, c1.a)).map(e => e.action);
  assert.deepEqual(actions.slice(-2), ['recommendation.withdrawn', 'assessment.cancelled']);

  const c2 = await confirmed('Cancel Review Co');
  const r2 = await createDraft(c2);
  await submit(c2, r2);
  res = await client.post(`${aBase(c2.ws, c2.tp, c2.a)}/cancel`, { reason: 'Duplicate', row_version: String((await assessmentRow(c2.a)).row_version) });
  assert.equal(res.status, 302);
  row = await recRow(r2);
  assert.deepEqual([row.status, row.withdraw_reason, Number(row.withdrawn_by)], ['withdrawn', 'Assessment cancelled', managerId]);
  assert.doesNotMatch((await senior.session.get('/tprm/review')).text, new RegExp(`data-tprm-review-recommendation="${r2}"`));

  const c3 = await confirmed('Cancel Issued Co');
  const r3 = await createDraft(c3);
  await submit(c3, r3);
  let page = await allSteps(consultant.session, aBase(c3.ws, c3.tp, c3.a));
  assert.match(page.text, /data-tprm-cancel>/, 'cancel is offered before issue');
  assert.match(page.text, /withdrawn with it/);
  assert.equal((await issue(c3, r3)).status, 302);
  const refuse = async label => {
    const r = await consultant.session.post(`${aBase(c3.ws, c3.tp, c3.a)}/cancel`, { reason: 'Too late', row_version: String((await assessmentRow(c3.a)).row_version) });
    assert.equal(r.status, 409, `${label}: route`);
    assert.match(r.text, /can no longer be cancelled/);
    await assert.rejects(at.cancel(db, await actorFor(consultant, c3.ws), c3.tp, c3.a, { reason: 'x', row_version: (await assessmentRow(c3.a)).row_version }),
      e => e.status === 409, `${label}: domain`);
    const p = await allSteps(consultant.session, aBase(c3.ws, c3.tp, c3.a));
    assert.doesNotMatch(p.text, /data-tprm-cancel>/, `${label}: no cancel form`);
    assert.match(p.text, /data-tprm-cancel-blocked/);
    assert.notEqual((await assessmentRow(c3.a)).status, 'cancelled');
  };
  await refuse('recommendation issued');
  await assert.rejects(db.prepare(`UPDATE tp_assessments SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'sql' WHERE id = ?`).run(c3.a),
    /cannot be cancelled/);
  assert.equal((await decide(c3.ws, r3, { outcome: 'request_more_information', rationale: 'More please.' })).status, 302);
  await refuse('information requested');
  assert.equal((await consultant.session.post(`${rBase(c3.ws, c3.tp, c3.a)}/new-version`, { reason: 'Revising' })).status, 302);
  assert.equal((await assessmentRow(c3.a)).status, 'recommendation_draft');
  await refuse('revised version in progress');
  const v2 = Number((await recsOf(c3.a))[1].id);
  await submit(c3, v2);
  assert.equal((await issue(c3, v2)).status, 302);
  assert.equal((await decide(c3.ws, v2, { outcome: 'approve' })).status, 302);
  assert.equal((await assessmentRow(c3.a)).status, 'completed');
  page = await allSteps(consultant.session, aBase(c3.ws, c3.tp, c3.a));
  assert.doesNotMatch(page.text, /data-tprm-cancel/, 'a completed assessment offers nothing');

  const c4 = await confirmed('Cancel Sql Co');
  await createDraft(c4);
  await assert.rejects(db.prepare(`UPDATE tp_assessments SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'sql' WHERE id = ?`).run(c4.a),
    /withdraw the recommendation/);
  assert.deepEqual(await events.verifyChains(db, main.id), []);
});

test('item 13: "valid until" is required for approve and approve with conditions only', async () => {
  const today = '2030-01-15';
  const base = { residual_rating: 'low', rationale: 'r', conditions: [] };
  assert.match(rec.submitProblems({ ...base, outcome: 'approve' }, today).join(' '), /valid until/);
  assert.match(rec.submitProblems({ ...base, outcome: 'approve_with_conditions', conditions: [{ description: 'c', owner: 'vendor', due_date: '2030-02-01' }] }, today).join(' '),
    /valid until/);
  assert.deepEqual(rec.submitProblems({ ...base, outcome: 'reject' }, today), [], 'optional for reject');
  assert.match(rec.submitProblems({ ...base, outcome: 'reject', valid_until: today }, today).join(' '), /after today/, 'when set, still in the future');

  const ctx = await confirmed('No Date Co');
  const rid = await createDraft(ctx);
  let page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-valid-until-hint/);
  assert.match(page.text, /optional for &#34;Do not onboard&#34;|optional for "Do not onboard"/);
  let res = await submit(ctx, rid, 'approve', { extra: { valid_until: '' } });
  assert.match(toast(res), /valid until/, 'approve needs it');
  assert.equal((await recRow(rid)).status, 'draft');
  await submit(ctx, rid, 'reject', { extra: { valid_until: '' } });
  assert.equal((await recRow(rid)).status, 'in_review');
  assert.equal((await issue(ctx, rid)).status, 302);
  let row = await recRow(rid);
  assert.deepEqual([row.status, row.valid_until], ['issued', null]);
  const owner = await sessionFor(main.owner);
  page = await owner.get(recPage(ctx.ws, rid));
  assert.match(page.text, /data-tprm-portal-rec-valid-until="not_needed">no expiry \(not needed for Do not onboard\)/);
  res = await decide(ctx.ws, rid, { outcome: 'reject' });
  assert.equal(res.status, 302);
  let approval = await D.currentApproval(db, await wsRow(ctx.ws), ctx.tp);
  assert.equal(approval.state, 'not_approved', 'a reject decision needs no valid-until');
  assert.equal((await db.prepare('SELECT status FROM tp_third_parties WHERE id=?').get(ctx.tp)).status, 'proposed', 'Do not onboard keeps it proposed');

  const ctx2 = await confirmed('Diverge No Date Co');
  const r2 = await createDraft(ctx2);
  await submit(ctx2, r2, 'reject', { extra: { valid_until: '' } });
  assert.equal((await issue(ctx2, r2)).status, 302);
  res = await decide(ctx2.ws, r2, { outcome: 'approve', rationale: 'Business need', risk_acceptance_until: '2098-03-31' });
  assert.equal(res.status, 302);
  approval = await D.currentApproval(db, await wsRow(ctx2.ws), ctx2.tp);
  assert.deepEqual([approval.state, approval.until], ['approved', '2098-03-31']);
  const s = D.approvalState({ thirdParty: { status: 'in_use' }, finalDecision: { outcome: 'approve', diverges: true, valid_until: null, risk_acceptance_until: '2030-06-30' }, today: '2030-07-01' });
  assert.equal(s.state, 'expired');

  const ctx3 = await confirmed('Db Date Co');
  const r3 = await createDraft(ctx3);
  await db.prepare(`UPDATE tp_recommendations SET outcome = 'approve', residual_rating = 'low', rationale = 'r' WHERE id = ?`).run(r3);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status = 'in_review', submitted_at = now() WHERE id = ?`).run(r3),
    /tp_recommendations_complete/);
  await db.prepare(`UPDATE tp_recommendations SET outcome = 'reject' WHERE id = ?`).run(r3);
  await db.prepare(`UPDATE tp_recommendations SET status = 'in_review', submitted_at = now() WHERE id = ?`).run(r3);
  assert.equal((await recRow(r3)).status, 'in_review');
});

test('items 14 and 15 (unchanged): an expired recommendation cannot be approved; the client asks for more information', async () => {
  const v = D.validate({ outcome: 'approve' }, { recommendation: { outcome: 'approve', valid_until: '2030-01-14' }, today: '2030-01-15' });
  assert.match(v.errors.join(' '), /Need more information/);
  const ok = D.validate({ outcome: 'request_more_information', rationale: 'Please refresh it' }, { recommendation: { outcome: 'approve', valid_until: '2030-01-14' }, today: '2030-01-15' });
  assert.deepEqual(ok.errors, []);
  assert.equal(D.approvalState({ thirdParty: { status: 'proposed' }, finalDecision: { outcome: 'reject', diverges: false, valid_until: null }, today: '2030-01-15' }).label,
    'Not approved');
});
