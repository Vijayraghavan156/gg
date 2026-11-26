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
let events;
let placement;
let rbac;
let dates;
let consultant;
let senior;
const createdPaths = new Set();
const sessions = [];

const PASSWORD = 'client-decision-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };
const VALID_UNTIL = '2099-12-31';
const DUE = '2099-06-30';

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  D = require('../lib/tprm/decisions');
  rec = require('../lib/tprm/recommendations');
  events = require('../lib/tprm/events');
  placement = require('../lib/tprm/placement');
  rbac = require('../lib/rbac');
  dates = require('../lib/dates');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  managerId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
  consultant = await makeUser('dec-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('dec-senior@test.local', { role: 'senior_consultant' });
  for (const u of [consultant, senior]) u.session = await signIn(u.email, u.password);
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

async function tprmClient(name, { firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firm, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (firm === firmId) {
    for (const u of [consultant, senior]) {
      await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
    }
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`dec-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
  const other = await makeUser(`dec-coord-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'isms_manager' });
  const contributor = await makeUser(`dec-contrib-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'contributor' });
  return { id, owner, other, contributor };
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
const portal = ws => `/workspaces/${ws}/client-portal/third-party-risk`;
const recPage = (ws, rid) => `${portal(ws)}/recommendations/${rid}`;
const assessmentRow = async id => db.prepare('SELECT *, due_date::text AS due_date FROM tp_assessments WHERE id=?').get(id);
const recRow = async id => db.prepare('SELECT *, valid_until::text AS valid_until FROM tp_recommendations WHERE id=?').get(id);
const recsOf = async a => db.prepare('SELECT * FROM tp_recommendations WHERE assessment_id=? ORDER BY version').all(a);
const tpRow = async id => db.prepare(`SELECT *, next_due_date::text AS next_due_date, last_assessment_date::text AS last_assessment_date
  FROM tp_third_parties WHERE id=?`).get(id);
const decisionsOf = async a => db.prepare('SELECT *, risk_acceptance_until::text AS risk_acceptance_until FROM tp_client_decisions WHERE assessment_id=? ORDER BY id').all(a);
const chain = async (ws, type, id) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type=? AND chain_id=? ORDER BY chain_seq`).all(ws, type, id);
const wsRow = async id => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const today = async ws => dates.todayFor(await wsRow(ws));

function multipart(token, files) {
  const boundary = '----tprmdec' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (token) parts.push(`--${boundary}`, 'Content-Disposition: form-data; name="_csrf"', '', token);
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="files"; filename="${f.filename}"`,
      `Content-Type: ${f.type || 'text/plain'}`, '', f.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function uploadOne(ctx, filename, content, session = consultant.session) {
  const form = multipart(session.getCsrfToken(), [{ filename, content }]);
  const res = await session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence`, form.body, { headers: form.headers });
  assert.equal(res.status, 302, `upload redirects (got ${res.status})`);
  const row = await db.prepare('SELECT * FROM tp_evidence WHERE workspace_id=? AND assessment_id=? AND original_name=?').get(ctx.ws, ctx.a, filename);
  assert.ok(row, `${filename} stored`);
  createdPaths.add(row.stored_path);
  return row;
}

async function release(ctx, ev, session = consultant.session) {
  const res = await session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/evidence/${ev.id}/release`, { row_version: String(ev.row_version) });
  assert.equal(res.status, 302);
}

async function addFinding(ctx, fields) {
  const res = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings`, { status: 'open', ...fields });
  assert.equal(res.status, 302, `finding added (${res.status})`);
}

async function addThirdParty(ws, name, status) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosting' })).status, 302);
  return tp;
}

async function nameOwner(ctx, ownerId) {
  const res = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/details`, {
    client_decision_owner_id: ownerId == null ? '' : String(ownerId), due_date: '', row_version: String((await assessmentRow(ctx.a)).row_version),
  });
  assert.equal(res.status, 302, `details saved (${toast(res)})`);
}

async function confirmed(c, name, { status = 'in_use', owner = true } = {}) {
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
  assert.equal((await assessmentRow(a)).status, 'tier_confirmed');
  const ctx = { ws, tp, a, c };
  if (owner) await nameOwner(ctx, c.owner.id);
  return ctx;
}

function draftBody(outcome, extra = {}) {
  const body = { outcome, residual_rating: 'medium', rationale: 'Controls are adequate.', valid_until: VALID_UNTIL, ...extra };
  if (outcome === 'approve_with_conditions') {
    Object.assign(body, { 'conditions[0][description]': 'Enforce MFA for all admin accounts', 'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': DUE });
  }
  return body;
}

async function issued(ctx, outcome, { rid = null, extra = {}, issueExtra = {} } = {}) {
  let id = rid;
  if (!id) {
    const res = await consultant.session.post(rBase(ctx.ws, ctx.tp, ctx.a), { row_version: String((await assessmentRow(ctx.a)).row_version) });
    assert.equal(res.status, 302, `draft created (${toast(res)})`);
    const rows = await recsOf(ctx.a);
    id = Number(rows[rows.length - 1].id);
  }
  const saved = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${id}`, {
    ...draftBody(outcome, extra), intent: 'submit', row_version: String((await recRow(id)).row_version) });
  assert.equal(saved.status, 302);
  assert.equal((await recRow(id)).status, 'in_review', `submitted (${toast(saved)})`);
  const res = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${id}/issue`, { row_version: String((await recRow(id)).row_version), ...issueExtra });
  assert.equal(res.status, 302);
  assert.equal((await recRow(id)).status, 'issued', `issued (${toast(res)})`);
  return id;
}

async function decide(session, ws, rid, body, { csrf } = {}) {
  await session.get(recPage(ws, rid));
  return await session.post(`${recPage(ws, rid)}/decision`, { ...body }, csrf === false ? { csrf: false } : undefined);
}

async function actorFor(user, ws) {
  const role = rbac.normalizeRole(user.firm_role);
  const perms = role === 'manager' ? new Set(rbac.rolePermissions('manager').concat(['*'])) : new Set(rbac.rolePermissions(role));
  return { user: { id: user.id, user_type: 'firm', firm_id: user.firm_id, firm_role: user.firm_role }, perms, ws: await wsRow(ws) };
}
async function clientActor(user, ws, memberRole) {
  return { user: { id: user.id, user_type: 'client' }, perms: new Set(rbac.rolePermissions(memberRole)), ws: await wsRow(ws) };
}

let main;

test('divergence has one definition: the outcome differs from the recommendation; more information never diverges', () => {
  const recOutcomes = ['approve', 'approve_with_conditions', 'reject'];
  for (const r of recOutcomes) {
    assert.equal(D.diverges('request_more_information', r), false, `more information on ${r}`);
    for (const d of recOutcomes) assert.equal(D.diverges(d, r), d !== r, `${d} on ${r}`);
  }
  assert.throws(() => D.diverges('maybe', 'approve'), TypeError);

  const onApprove = { outcome: 'approve', valid_until: VALID_UNTIL };
  const t = '2030-01-15';
  let v = D.validate({ outcome: 'approve' }, { recommendation: onApprove, today: t });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.values, { outcome: 'approve', rationale: null, diverges: false, risk_acceptance_until: null });
  v = D.validate({ outcome: 'approve', risk_acceptance_until: '2031-01-01' }, { recommendation: onApprove, today: t });
  assert.equal(v.values.risk_acceptance_until, null, 'no risk acceptance on a decision that follows the advice');
  v = D.validate({ outcome: 'reject' }, { recommendation: onApprove, today: t });
  assert.equal(v.errors.length, 2, 'a diverging decision needs a rationale and a risk-acceptance expiry');
  v = D.validate({ outcome: 'reject', rationale: 'Budget', risk_acceptance_until: t }, { recommendation: onApprove, today: t });
  assert.match(v.errors.join(' '), /after today/);
  v = D.validate({ outcome: 'approve_with_conditions', rationale: 'We add our own', risk_acceptance_until: '2030-06-30' }, { recommendation: onApprove, today: t });
  assert.deepEqual(v.errors, []);
  assert.equal(v.values.diverges, true);
  v = D.validate({ outcome: 'request_more_information' }, { recommendation: onApprove, today: t });
  assert.match(v.errors.join(' '), /what more information/);
  v = D.validate({ outcome: 'request_more_information', rationale: 'SOC 2 report please' }, { recommendation: onApprove, today: t });
  assert.equal(v.values.diverges, false);
  v = D.validate({ outcome: '' }, { recommendation: onApprove, today: t });
  assert.match(v.errors.join(' '), /Choose your decision/);
  v = D.validate({ outcome: 'approve' }, { recommendation: { outcome: 'approve', valid_until: '2030-01-14' }, today: t });
  assert.match(v.errors.join(' '), /can no longer be approved/, 'an expired recommendation is not approved');
});

test('approval: only an unexpired positive decision counts; in use with no decision is not yet assessed, not blocked', () => {
  const t = '2030-01-15';
  const inUse = { status: 'in_use' };
  let s = D.approvalState({ thirdParty: inUse, today: t });
  assert.equal(s.state, 'not_yet_assessed');
  assert.equal(s.approved, false);
  assert.equal(s.label, 'Not assessed yet');
  assert.equal(D.approvalState({ thirdParty: { status: 'proposed' }, today: t }).state, 'awaiting_approval');
  s = D.approvalState({ thirdParty: inUse, finalDecision: { outcome: 'approve', diverges: false, valid_until: '2030-12-31' }, today: t });
  assert.deepEqual([s.state, s.approved, s.until, s.label], ['approved', true, '2030-12-31', 'Approved until 31 Dec 2030']);
  s = D.approvalState({ thirdParty: inUse, finalDecision: { outcome: 'approve_with_conditions', diverges: false, valid_until: '2030-12-31' }, today: '2030-12-31' });
  assert.equal(s.approved, true, 'valid through the valid-until day');
  s = D.approvalState({ thirdParty: inUse, finalDecision: { outcome: 'approve', diverges: false, valid_until: '2030-12-31' }, today: '2031-01-01' });
  assert.deepEqual([s.state, s.approved, s.label], ['expired', false, 'Approval expired on 31 Dec 2030']);
  s = D.approvalState({ thirdParty: inUse, finalDecision: { outcome: 'approve', diverges: true, valid_until: '2030-12-31', risk_acceptance_until: '2030-06-30' }, today: t });
  assert.deepEqual([s.state, s.until], ['approved', '2030-06-30']);
  s = D.approvalState({ thirdParty: inUse, finalDecision: { outcome: 'approve', diverges: true, valid_until: '2030-12-31', risk_acceptance_until: '2030-06-30' }, today: '2030-07-01' });
  assert.equal(s.state, 'expired', 'the risk acceptance expired first');
  s = D.approvalState({ thirdParty: { status: 'proposed' }, finalDecision: { outcome: 'reject', diverges: false, valid_until: '2030-12-31' }, today: t });
  assert.deepEqual([s.state, s.approved, s.label], ['not_approved', false, 'Not approved']);
  assert.equal(D.approvalState({ thirdParty: { status: 'exited' }, finalDecision: { outcome: 'approve', valid_until: '2030-12-31' }, today: t }).state, 'exited');
  assert.equal(D.approvalState({ thirdParty: inUse, openAssessment: { status: 'recommendation_issued' }, today: t }).pendingLabel, 'Waiting for your decision');
  assert.equal(D.approvalState({ thirdParty: inUse, openAssessment: { status: 'information_requested' }, today: t }).pending, 'information_requested');
  assert.equal(D.approvalState({ thirdParty: inUse, openAssessment: { status: 'scoping' }, today: t }).pending, 'in_progress');
});

test('a recommendation is not issued until a client decision owner is named; it can be named at issue', async () => {
  main = await tprmClient('Decision Main Client');
  const ctx = await confirmed(main, 'Ownerless Co', { owner: false });
  const res0 = await consultant.session.post(rBase(ctx.ws, ctx.tp, ctx.a), { row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(res0.status, 302);
  const rid = Number((await recsOf(ctx.a))[0].id);
  let page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-owner-needed/, 'the consultant is prompted to name one');
  const submit = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}`, { ...draftBody('approve'), intent: 'submit', row_version: String((await recRow(rid)).row_version) });
  assert.equal(submit.status, 302);
  page = await allSteps(senior.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-issue-owner/, 'the issue form asks for the owner');
  let res = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 302);
  assert.match(toast(res), /Name the client decision owner/);
  assert.equal((await recRow(rid)).status, 'in_review', 'not issued');
  await assert.rejects(rec.issue(db, await actorFor(senior, ctx.ws), ctx.tp, ctx.a, rid, { row_version: (await recRow(rid)).row_version }),
    err => err.status === 400 && /client decision owner/.test(err.message), 'the domain refuses too');
  res = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version), client_decision_owner_id: String(main.contributor.id) });
  assert.match(toast(res), /client owner or ISMS manager/, 'a contributor cannot be named');
  res = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version), client_decision_owner_id: String(main.owner.id) });
  assert.equal((await recRow(rid)).status, 'issued');
  assert.equal(Number((await assessmentRow(ctx.a)).client_decision_owner_id), main.owner.id);
  const issuedEvent = (await chain(ctx.ws, 'assessment', ctx.a)).find(e => e.action === 'recommendation.issued');
  assert.equal(issuedEvent.after_state.client_decision_owner_id, main.owner.id);
  assert.deepEqual(issuedEvent.after_state.findings, { count: 0, ids: [] });

  await nameOwner(ctx, null);
  const ownerPage = await (await sessionFor(main.owner)).get(recPage(ctx.ws, rid));
  assert.match(ownerPage.text, /Waiting for your firm to name a decision owner/);
  assert.doesNotMatch(ownerPage.text, /data-tprm-decision-form/);
  await nameOwner(ctx, main.owner.id);
});

test('only the named client decision owner decides: firm users (manager included) 403, other client users 403', async () => {
  const ctx = await confirmed(main, 'Gatekeeper Co', { status: 'proposed' });
  const rid = await issued(ctx, 'approve');
  const body = { outcome: 'approve' };

  for (const [who, session] of [['manager', client], ['senior consultant', senior.session], ['consultant', consultant.session]]) {
    const res = await decide(session, ctx.ws, rid, body);
    assert.equal(res.status, 403, `${who} cannot record a client decision`);
    assert.match(res.text, /Firm users, managers included, cannot record a client decision/);
  }
  assert.equal((await client.get(recPage(ctx.ws, rid))).status, 404, 'the portal page is for client users');
  for (const firmUser of [{ id: managerId, firm_id: firmId, firm_role: 'manager' }, senior, consultant]) {
    await assert.rejects(D.recordDecision(db, await actorFor(firmUser, ctx.ws), rid, body),
      err => err.status === 403 && /Firm users/.test(err.message), `the domain refuses ${firmUser.firm_role}`);
  }
  assert.equal(rbac.hasPermission(new Set(['*']), 'tp.client_decide'), false, 'no firm wildcard grants the client decision');

  for (const [user, role] of [[main.other, 'isms_manager'], [main.contributor, 'contributor']]) {
    const session = await sessionFor(user);
    const page = await session.get(recPage(ctx.ws, rid));
    assert.equal(page.status, 200, `${role} can view the recommendation`);
    assert.doesNotMatch(page.text, /data-tprm-decision-form/, `${role} gets no decision form`);
    assert.match(page.text, /data-tprm-portal-waiting/);
    assert.equal((await decide(session, ctx.ws, rid, body)).status, 403, `${role} cannot decide`);
  }
  await assert.rejects(D.recordDecision(db, await clientActor(main.other, ctx.ws, 'isms_manager'), rid, body),
    err => err.status === 403 && /named on this assessment/.test(err.message));

  for (const by of [managerId, main.other.id]) {
    await assert.rejects(db.prepare(`INSERT INTO tp_client_decisions (workspace_id, assessment_id, recommendation_id, outcome, diverges, decided_by)
      VALUES (?,?,?,'approve',false,?)`).run(ctx.ws, ctx.a, rid, by), /only the assessment's named client decision owner/);
  }
  assert.equal((await decisionsOf(ctx.a)).length, 0);

  const ownerSession = await sessionFor(main.owner);
  const page = await ownerSession.get(recPage(ctx.ws, rid));
  assert.match(page.text, /data-tprm-decision-form/, 'the named owner gets the form');
  assert.equal((await decide(ownerSession, ctx.ws, rid, body)).status, 302);
  assert.equal((await decisionsOf(ctx.a)).length, 1);
});

test('onboarding "Onboard with conditions": in use, last assessed today, next due from the tier interval with the client override', async () => {
  await db.prepare('UPDATE tp_client_settings SET interval_months_low = 6 WHERE workspace_id=?').run(main.id);
  const ctx = await confirmed(main, 'Onboard Co', { status: 'proposed' });
  const rid = await issued(ctx, 'approve_with_conditions');
  assert.equal((await tpRow(ctx.tp)).status, 'proposed');
  let approval = await D.currentApproval(db, await wsRow(ctx.ws), ctx.tp);
  assert.deepEqual([approval.state, approval.approved, approval.pending], ['awaiting_approval', false, 'decision_needed']);

  const ownerSession = await sessionFor(main.owner);
  const list = await ownerSession.get(portal(ctx.ws));
  assert.match(list.text, new RegExp(`data-tprm-portal-row="${ctx.tp}" data-tprm-approval="awaiting_approval"`));
  assert.match(list.text, /data-tprm-pending="decision_needed">Waiting for your decision</, 'the client reads the pending decision as its own');
  assert.match(list.text, new RegExp(`data-tprm-portal-open="${rid}"`));

  const res = await decide(ownerSession, ctx.ws, rid, { outcome: 'approve_with_conditions' });
  assert.equal(res.status, 302);
  assert.match(toast(res), /Your decision has been recorded/);
  const [d] = await decisionsOf(ctx.a);
  assert.equal(d.outcome, 'approve_with_conditions');
  assert.equal(d.diverges, false);
  assert.equal(Number(d.decided_by), main.owner.id);
  const day = await today(ctx.ws);
  const t = await tpRow(ctx.tp);
  assert.equal(t.status, 'in_use');
  assert.equal(t.last_assessment_date, day);
  assert.equal(t.next_due_date, placement.addMonths(day, 6), 'Low tier, client override 6 months');
  assert.equal(t.current_tier, 'low');
  assert.equal((await assessmentRow(ctx.a)).status, 'completed');
  approval = await D.currentApproval(db, await wsRow(ctx.ws), ctx.tp);
  assert.deepEqual([approval.state, approval.approved, approval.until], ['approved', true, VALID_UNTIL]);
  assert.equal((await D.currentApproval(db, await wsRow(ctx.ws), ctx.tp, { today: '2100-01-01' })).state, 'expired', 'expires after valid until');

  const aEvents = await chain(ctx.ws, 'assessment', ctx.a);
  const recorded = aEvents.find(e => e.action === 'client_decision.recorded');
  assert.equal(Number(recorded.actor_user_id), main.owner.id);
  assert.equal(recorded.after_state.assessment_status, 'completed');
  assert.equal(recorded.after_state.outcome_label, 'Onboard with conditions');
  const tEvents = await chain(ctx.ws, 'third_party', ctx.tp);
  const tpEvent = tEvents.find(e => e.action === 'third_party.client_decision');
  assert.equal(tpEvent.before_state.status, 'proposed');
  assert.equal(tpEvent.after_state.status, 'in_use');
  assert.equal(tpEvent.after_state.next_due_date, placement.addMonths(day, 6));
  assert.equal(tpEvent.after_state.interval_months, 6);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);

  const register = await consultant.session.get(`/tprm/clients/${ctx.ws}`);
  assert.match(register.text, new RegExp(`data-tprm-row="${ctx.tp}"[\\s\\S]*?data-tprm-approval="approved"[\\s\\S]*?Approved until 31 Dec 2099`));
  const tpPage = await consultant.session.get(`/tprm/clients/${ctx.ws}/third-parties/${ctx.tp}`);
  assert.match(tpPage.text, /data-tprm-approval="approved"/);
  const aPage = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(aPage.text, /data-tprm-client-decision-outcome="approve_with_conditions"/);
  assert.doesNotMatch(aPage.text, /data-tprm-decision-form/);

  assert.equal((await decide(ownerSession, ctx.ws, rid, { outcome: 'approve' })).status, 409);
  await assert.rejects(db.prepare(`INSERT INTO tp_client_decisions (workspace_id, assessment_id, recommendation_id, outcome, diverges, decided_by)
    VALUES (?,?,?,'approve',false,?)`).run(ctx.ws, ctx.a, rid, main.owner.id), /waits for it|one_per_version/);
  await assert.rejects(db.prepare("UPDATE tp_client_decisions SET rationale='changed' WHERE id=?").run(d.id), /insert-only/);
  await assert.rejects(db.prepare('DELETE FROM tp_client_decisions WHERE id=?').run(d.id), /insert-only/);
  await db.prepare('UPDATE tp_client_settings SET interval_months_low = NULL WHERE workspace_id=?').run(main.id);
});

async function questionnaireOut(ctx) {
  const qb = `${aBase(ctx.ws, ctx.tp, ctx.a)}/questionnaire`;
  assert.equal((await consultant.session.post(qb, { delivery_model: 'vendor_hosted' })).status, 302);
  const q = await db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(ctx.a);
  const res = await consultant.session.post(`${qb}/links`, {
    recipient_name: 'Priya Vendor', recipient_email: 'priya@thirdparty.example.net', row_version: String(q.row_version) });
  assert.equal(res.status, 200, 'the link is shown');
  const [link] = await db.prepare(`SELECT * FROM tp_vendor_requests WHERE assessment_id=? AND status='active'`).all(ctx.a);
  assert.ok(link);
  return { qb, link, token: (res.text.match(/\/vendor\/q\/([A-Za-z0-9_-]{43})/) || [])[1] };
}

test('completing the assessment revokes an active questionnaire link in the decision\'s transaction, with an event', async () => {
  const ctx = await confirmed(main, 'Completed Link Co', { status: 'proposed' });
  const { link, token } = await questionnaireOut(ctx);
  const res = await consultant.session.post(rBase(ctx.ws, ctx.tp, ctx.a), { row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(res.status, 302);
  const rid = Number((await recsOf(ctx.a))[0].id);
  assert.equal((await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}`, {
    ...draftBody('approve'), intent: 'save', row_version: String((await recRow(rid)).row_version) })).status, 302);
  await db.transaction(async () => {
    await db.exec('ALTER TABLE tp_assessments DISABLE TRIGGER tp_assessments_review_questionnaire');
    await db.prepare(`UPDATE tp_recommendations SET status='in_review', submitted_at=now(), row_version=row_version+1 WHERE id=?`).run(rid);
    await db.prepare(`UPDATE tp_assessments SET status='recommendation_in_review', row_version=row_version+1 WHERE id=?`).run(ctx.a);
    await db.exec('ALTER TABLE tp_assessments ENABLE TRIGGER tp_assessments_review_questionnaire');
  })();
  const issue = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version) });
  assert.equal(issue.status, 302);
  assert.equal((await recRow(rid)).status, 'issued');
  assert.equal((await db.prepare('SELECT status FROM tp_vendor_requests WHERE id=?').get(link.id)).status, 'active');

  const ownerSession = await sessionFor(main.owner);
  const decided = await decide(ownerSession, ctx.ws, rid, { outcome: 'approve' });
  assert.equal(decided.status, 302, toast(decided));
  assert.equal((await assessmentRow(ctx.a)).status, 'completed');
  const after = await db.prepare('SELECT * FROM tp_vendor_requests WHERE id=?').get(link.id);
  assert.equal(after.status, 'revoked');
  assert.equal(after.revoke_reason, 'Assessment completed');
  assert.equal(Number(after.revoked_by), main.owner.id);
  const aEvents = await chain(ctx.ws, 'assessment', ctx.a);
  const revoked = aEvents.find(e => e.action === 'vendor_link.revoked');
  assert.equal(Number(revoked.actor_user_id), main.owner.id);
  assert.equal(revoked.after_state.reason, 'Assessment completed');
  const recorded = aEvents.find(e => e.action === 'client_decision.recorded');
  assert.deepEqual(recorded.after_state.revoked_request_ids, [Number(link.id)]);
  assert.ok(aEvents.indexOf(revoked) < aEvents.indexOf(recorded), 'revoked in the same transaction, before the assessment moves');
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
  const vendorPage = await makeClient(env.app).get(`/vendor/q/${token}`);
  assert.equal(vendorPage.status, 404, 'the link no longer opens');

  const other = await confirmed(main, 'More Info Link Co', { status: 'proposed' });
  const out = await questionnaireOut(other);
  const closed = await consultant.session.post(`${out.qb}/not-returned`, { reason: 'No reply.', row_version: String((await db.prepare('SELECT row_version FROM tp_questionnaires WHERE assessment_id=?').get(other.a)).row_version) });
  assert.match(toast(closed), /not returned/);
  const rid2 = await issued(other, 'approve');
  assert.equal((await decide(ownerSession, other.ws, rid2, { outcome: 'request_more_information', rationale: 'Need the SOC 2 report.' })).status, 302);
  assert.equal((await assessmentRow(other.a)).status, 'information_requested');
  assert.ok(!(await chain(other.ws, 'assessment', other.a)).some(e => e.action === 'vendor_link.revoked' && e.after_state.reason === 'Assessment completed'));
});

test('the database refuses completing an assessment while a questionnaire link is active', async () => {
  const ctx = await confirmed(main, 'Raw Complete Co', { status: 'proposed' });
  await questionnaireOut(ctx);
  await assert.rejects(db.prepare(`UPDATE tp_assessments SET status='completed' WHERE id=?`).run(ctx.a),
    /revoke the third party's questionnaire link before completing the assessment/);
});

test('a questionnaire closed as not returned shows on the client\'s decision page, without the firm\'s reason', async () => {
  const ctx = await confirmed(main, 'Portal Not Returned Co', { status: 'proposed' });
  const out = await questionnaireOut(ctx);
  const q = await db.prepare('SELECT row_version FROM tp_questionnaires WHERE assessment_id=?').get(ctx.a);
  assert.match(toast(await consultant.session.post(`${out.qb}/not-returned`, { reason: 'Internal note: their CISO left.', row_version: String(q.row_version) })),
    /not returned/);
  const rid = await issued(ctx, 'approve');
  const ownerSession = await sessionFor(main.owner);
  const page = await ownerSession.get(recPage(ctx.ws, rid));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-portal-not-returned>Questionnaire not returned by the third party\.</);
  assert.doesNotMatch(page.text, /their CISO left/);
  const firm = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(firm.text, /Questionnaire not returned: Internal note: their CISO left\./);
  const plain = await confirmed(main, 'Portal Plain Co', { status: 'proposed' });
  const rid2 = await issued(plain, 'approve');
  assert.doesNotMatch((await ownerSession.get(recPage(plain.ws, rid2))).text, /data-tprm-portal-not-returned/);
});

test('the database holds one decision per version, the divergence rule and the risk acceptance', async () => {
  const ctx = await confirmed(main, 'Db Rules Co', { status: 'proposed' });
  const rid = await issued(ctx, 'approve');
  const ins = (outcome, diverges, until = null, rationale = null) => db.prepare(`INSERT INTO tp_client_decisions
    (workspace_id, assessment_id, recommendation_id, outcome, diverges, risk_acceptance_until, rationale, decided_by)
    VALUES (?,?,?,?,?,?::date,?,?)`).run(ctx.ws, ctx.a, rid, outcome, diverges, until, rationale, main.owner.id);
  await assert.rejects(ins('reject', false), /diverges must say/, 'a diverging decision cannot be stored as not diverging');
  await assert.rejects(ins('approve', true, '2099-01-01', 'x'), /diverges must say/);
  await assert.rejects(ins('reject', true), /divergence_accepted/, 'rationale and expiry required when diverging');
  await assert.rejects(ins('request_more_information', true, '2099-01-01', 'x'), /never_diverges|diverges must say/);
  await assert.rejects(ins('approve', false, '2099-01-01'), /risk_acceptance_only_when_diverging/);
  assert.equal((await decisionsOf(ctx.a)).length, 0);
  await ins('reject', true, '2099-01-01', 'Our own reasons');
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_issued');
  await assert.rejects(ins('approve', false), /one_per_version/, 'one decision per recommendation version');
});

test('a diverging decision shows a warning and needs a rationale and a risk-acceptance expiry; "Do not onboard" leaves it proposed', async () => {
  const ctx = await confirmed(main, 'Diverge Co', { status: 'proposed' });
  const rid = await issued(ctx, 'approve');
  const ownerSession = await sessionFor(main.owner);
  const page = await ownerSession.get(recPage(ctx.ws, rid));
  assert.match(page.text, /data-tprm-divergence-warning hidden/, 'the warning is there, shown when a different outcome is picked');
  assert.match(page.text, /<span>Onboard<\/span>\s*<span class="meta text-xs">\(recommended\)<\/span>/);
  for (const label of ['Onboard with conditions', 'Do not onboard', 'Need more information']) assert.match(page.text, new RegExp(`<span>${label}</span>`));

  let res = await decide(ownerSession, ctx.ws, rid, { outcome: 'reject' });
  assert.equal(res.status, 400);
  assert.match(res.text, /give your rationale/);
  assert.match(res.text, /risk acceptance expires/);
  assert.match(res.text, /data-tprm-divergence-warning\s*>/, 'the warning is shown on the refused form');
  res = await decide(ownerSession, ctx.ws, rid, { outcome: 'reject', rationale: 'We do not need it any more' });
  assert.equal(res.status, 400);
  assert.equal((await decisionsOf(ctx.a)).length, 0, 'nothing recorded');
  res = await decide(ownerSession, ctx.ws, rid, { outcome: 'reject', rationale: 'We do not need it any more', risk_acceptance_until: '2099-03-31' });
  assert.equal(res.status, 302);
  const [d] = await decisionsOf(ctx.a);
  assert.deepEqual([d.outcome, d.diverges, d.risk_acceptance_until], ['reject', true, '2099-03-31']);
  assert.equal((await assessmentRow(ctx.a)).status, 'completed');
  const t = await tpRow(ctx.tp);
  assert.equal(t.status, 'proposed', 'an onboarding reject leaves the third party proposed');
  assert.equal(t.next_due_date, null);
  const approval = await D.currentApproval(db, await wsRow(ctx.ws), ctx.tp);
  assert.deepEqual([approval.state, approval.approved], ['not_approved', false]);
  const aPage = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(aPage.text, /data-tprm-decision-diverges/);
});

test('a diverging approval lasts until its risk acceptance expires', async () => {
  const ctx = await confirmed(main, 'Against Advice Co', { status: 'proposed' });
  const rid = await issued(ctx, 'reject');
  const res = await decide(await sessionFor(main.owner), ctx.ws, rid, { outcome: 'approve', rationale: 'Business need', risk_acceptance_until: '2098-06-30' });
  assert.equal(res.status, 302);
  const ws = await wsRow(ctx.ws);
  const approval = await D.currentApproval(db, ws, ctx.tp);
  assert.deepEqual([approval.state, approval.until], ['approved', '2098-06-30'], 'the earlier of valid-until and the risk acceptance');
  assert.equal((await D.currentApproval(db, ws, ctx.tp, { today: '2098-07-01' })).state, 'expired');
  assert.equal((await tpRow(ctx.tp)).status, 'in_use');
});

test('reassessment: "Exit" exits the third party; "Continue" sets the next due date from the model interval', async () => {
  const exit = await confirmed(main, 'Exit Co', { status: 'in_use' });
  assert.equal((await D.currentApproval(db, await wsRow(exit.ws), exit.tp)).state, 'not_yet_assessed');
  const rid = await issued(exit, 'reject');
  assert.equal((await decide(await sessionFor(main.owner), exit.ws, rid, { outcome: 'reject' })).status, 302);
  let t = await tpRow(exit.tp);
  assert.equal(t.status, 'exited');
  assert.equal(t.next_due_date, null);
  assert.equal((await D.currentApproval(db, await wsRow(exit.ws), exit.tp)).state, 'exited');
  const exitEvent = (await chain(exit.ws, 'third_party', exit.tp)).find(e => e.action === 'third_party.client_decision');
  assert.deepEqual([exitEvent.before_state.status, exitEvent.after_state.status], ['in_use', 'exited']);

  const cont = await confirmed(main, 'Continue Co', { status: 'in_use' });
  const rid2 = await issued(cont, 'approve');
  assert.equal((await decide(await sessionFor(main.owner), cont.ws, rid2, { outcome: 'approve' })).status, 302);
  const day = await today(cont.ws);
  const model = await require('../lib/tprm/criticality').firmIntervals(db, firmId);
  t = await tpRow(cont.tp);
  assert.equal(t.next_due_date, placement.addMonths(day, model.intervals.low), 'the model interval for Low, no override');
  assert.equal(t.last_assessment_date, day);
  assert.equal(t.status, 'in_use');
});

test('"Need more information": back to the firm, revised version started by a consultant, issued, then decided', async () => {
  const ctx = await confirmed(main, 'More Info Co', { status: 'in_use' });
  const v1 = await issued(ctx, 'approve');
  const ownerSession = await sessionFor(main.owner);
  let res = await decide(ownerSession, ctx.ws, v1, { outcome: 'request_more_information' });
  assert.equal(res.status, 400, 'say what is needed');
  res = await decide(ownerSession, ctx.ws, v1, { outcome: 'request_more_information', rationale: 'Please share the SOC 2 report.' });
  assert.equal(res.status, 302);
  assert.match(toast(res), /request for more information has been sent/);
  assert.equal((await assessmentRow(ctx.a)).status, 'information_requested');
  const before = await tpRow(ctx.tp);
  assert.equal(before.next_due_date, (await tpRow(ctx.tp)).next_due_date);
  let approval = await D.currentApproval(db, await wsRow(ctx.ws), ctx.tp);
  assert.deepEqual([approval.state, approval.pending], ['not_yet_assessed', 'information_requested'], 'a request for more information is not a decision on authority');

  let aPage = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(aPage.text, /Client requested more information/);
  assert.match(aPage.text, /Please share the SOC 2 report\./);
  assert.match(aPage.text, /data-tprm-start-revision-form/);
  const queue = await senior.session.get('/tprm/review');
  assert.match(queue.text, new RegExp(`data-tprm-review-information-row="${ctx.a}"`));
  assert.equal((await consultant.session.post(rBase(ctx.ws, ctx.tp, ctx.a), { row_version: String((await assessmentRow(ctx.a)).row_version) })).status, 409,
    'not a fresh first draft');
  assert.equal((await decide(ownerSession, ctx.ws, v1, { outcome: 'approve' })).status, 409, 'version 1 is decided');

  assert.equal((await ownerSession.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/new-version`, { reason: 'x' })).status, 404, 'the firm area is not reachable by a client user');
  res = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/new-version`, { reason: 'The client asked for more information.' });
  assert.equal(res.status, 302);
  let rows = await recsOf(ctx.a);
  assert.deepEqual(rows.map(r => [r.version, r.status]), [[1, 'issued'], [2, 'draft']]);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_draft');
  let p1 = await ownerSession.get(recPage(ctx.ws, v1));
  assert.match(p1.text, /data-tprm-portal-decided="request_more_information"/);
  assert.equal((await ownerSession.get(recPage(ctx.ws, rows[1].id))).status, 404, 'a draft never reaches the portal');

  const v2 = Number(rows[1].id);
  res = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${v2}/withdraw`, { reason: 'Started too early', row_version: String((await recRow(v2)).row_version) });
  assert.equal(res.status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'information_requested');
  res = await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/new-version`, { reason: 'SOC 2 report reviewed' });
  rows = await recsOf(ctx.a);
  const v3 = Number(rows[2].id);
  await issued(ctx, 'approve_with_conditions', { rid: v3, extra: { rationale: 'SOC 2 report reviewed: MFA gap remains.' } });
  rows = await recsOf(ctx.a);
  assert.deepEqual(rows.map(r => [r.version, r.status]), [[1, 'withdrawn'], [2, 'withdrawn'], [3, 'issued']]);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_issued');

  p1 = await ownerSession.get(recPage(ctx.ws, v1));
  assert.match(p1.text, /Replaced by version 3/);
  const p3 = await ownerSession.get(recPage(ctx.ws, v3));
  assert.match(p3.text, /data-tprm-decision-form/);
  assert.match(p3.text, /SOC 2 report reviewed: MFA gap remains\./);
  res = await decide(ownerSession, ctx.ws, v3, { outcome: 'approve_with_conditions' });
  assert.equal(res.status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'completed');
  const decided = await decisionsOf(ctx.a);
  assert.deepEqual(decided.map(d => [Number(d.recommendation_id), d.outcome]), [[v1, 'request_more_information'], [v3, 'approve_with_conditions']]);
  approval = await D.currentApproval(db, await wsRow(ctx.ws), ctx.tp);
  assert.equal(approval.state, 'approved');
  aPage = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.doesNotMatch(aPage.text, /data-tprm-start-revision-form/);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
  const actions = (await chain(ctx.ws, 'assessment', ctx.a)).map(e => e.action).filter(x => /client_decision|new_version|issued$/.test(x));
  assert.deepEqual(actions, ['recommendation.issued', 'client_decision.recorded', 'recommendation.new_version_started',
    'recommendation.new_version_started', 'recommendation.issued', 'client_decision.recorded']);
});

test('the portal shows released files only, findings with their client-facing description, and no review comments or drafts', async () => {
  const ctx = await confirmed(main, 'Portal Content Co', { status: 'proposed' });
  const shared = await uploadOne(ctx, 'shared-soc2.txt', 'released bytes');
  await uploadOne(ctx, 'internal-workpaper.txt', 'internal bytes');
  await release(ctx, shared);
  await addFinding(ctx, { severity: 'high', title: 'No MFA on admin accounts', control_ref: 'A.5.17', description: 'CLIENT-FACING-DESCRIPTION', impact: 'CLIENT-FACING-IMPACT' });
  const rid = await issued(ctx, 'approve_with_conditions', { issueExtra: { comment: 'INTERNAL-REVIEW-COMMENT' } });
  const issuedEvent = (await chain(ctx.ws, 'assessment', ctx.a)).find(e => e.action === 'recommendation.issued');
  assert.equal(issuedEvent.after_state.findings.count, 1, 'the issued event lists the findings');
  const firmPage = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(firmPage.text, /data-tprm-rec-findings[\s\S]*No MFA on admin accounts/);

  const ownerSession = await sessionFor(main.owner);
  const page = await ownerSession.get(recPage(ctx.ws, rid));
  assert.equal(page.status, 200);
  assert.match(page.text, /shared-soc2\.txt/);
  assert.doesNotMatch(page.text, /internal-workpaper/);
  assert.match(page.text, /No MFA on admin accounts/);
  assert.match(page.text, /A\.5\.17/);
  assert.match(page.text, /CLIENT-FACING-DESCRIPTION[\s\S]*Why it matters:<\/span> CLIENT-FACING-IMPACT/);
  assert.doesNotMatch(page.text, /INTERNAL-REVIEW-COMMENT/);
  assert.doesNotMatch(page.text, new RegExp(shared.stored_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no storage path');
  assert.match(page.text, /Enforce MFA for all admin accounts/, 'conditions with owner and due date');
  assert.match(page.text, /Third party/);
  assert.match(page.text, /Low because/, 'the final tier and its reason');

  const unreleased = await db.prepare("SELECT id FROM tp_evidence WHERE assessment_id=? AND original_name='internal-workpaper.txt'").get(ctx.a);
  const dl = await ownerSession.get(`${recPage(ctx.ws, rid)}/evidence/${shared.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.text, 'released bytes');
  assert.equal((await ownerSession.get(`${recPage(ctx.ws, rid)}/evidence/${unreleased.id}/download`)).status, 404, 'unreleased: 404');
  const contributorSession = await sessionFor(main.contributor);
  assert.equal((await contributorSession.get(`${recPage(ctx.ws, rid)}/evidence/${shared.id}/download`)).status, 200, 'client users of the workspace');
  assert.equal((await client.get(`${recPage(ctx.ws, rid)}/evidence/${shared.id}/download`)).status, 404, 'not through the portal for firm users');

  const other = await confirmed(main, 'Portal Other Co', { status: 'proposed' });
  const otherFile = await uploadOne(other, 'other-shared.txt', 'other bytes');
  await release(other, otherFile);
  assert.equal((await ownerSession.get(`${recPage(ctx.ws, rid)}/evidence/${otherFile.id}/download`)).status, 404);
});

test('isolation: another client or firm\'s records are 404; another client\'s portal is outside the user\'s portal', async () => {
  const ctx = await confirmed(main, 'Isolated Co', { status: 'proposed' });
  const ev = await uploadOne(ctx, 'isolated.txt', 'iso bytes');
  const rid = await issued(ctx, 'approve');
  await release(ctx, (await db.prepare('SELECT * FROM tp_evidence WHERE id=?').get(ev.id)));
  const second = await tprmClient('Decision Second Client');
  const secondSession = await sessionFor(second.owner);
  assert.equal((await secondSession.get(recPage(second.id, rid))).status, 404, 'another client\'s recommendation id');
  assert.equal((await decide(secondSession, second.id, rid, { outcome: 'approve' })).status, 404);
  assert.equal((await secondSession.get(`${recPage(second.id, rid)}/evidence/${ev.id}/download`)).status, 404);
  assert.equal((await secondSession.get(recPage(ctx.ws, rid))).status, 403, 'another client\'s portal');
  await assert.rejects(D.recordDecision(db, await clientActor(second.owner, second.id, 'client_owner'), rid, { outcome: 'approve' }),
    err => err.status === 404);

  const otherFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Decision Other Firm')").run()).lastInsertRowid);
  const foreign = await tprmClient('Decision Foreign Client', { firm: otherFirm });
  const foreignSession = await sessionFor(foreign.owner);
  assert.equal((await foreignSession.get(recPage(foreign.id, rid))).status, 404);
  assert.equal((await D.portalRecommendation(db, await wsRow(foreign.id), rid)), null);
  assert.equal(await D.currentApproval(db, await wsRow(foreign.id), ctx.tp), null);
  assert.equal((await decisionsOf(ctx.a)).length, 0);

  await db.prepare('UPDATE tp_client_settings SET enabled=false WHERE workspace_id=?').run(second.id);
  assert.equal((await secondSession.get(portal(second.id))).status, 404);
  await db.prepare('UPDATE tp_client_settings SET enabled=true WHERE workspace_id=?').run(second.id);
});

test('the decision form is CSRF-protected', async () => {
  const ctx = await confirmed(main, 'Csrf Co', { status: 'proposed' });
  const rid = await issued(ctx, 'approve');
  const ownerSession = await sessionFor(main.owner);
  assert.equal((await decide(ownerSession, ctx.ws, rid, { outcome: 'approve' }, { csrf: false })).status, 403);
  assert.equal((await decide(ownerSession, ctx.ws, rid, { outcome: 'approve', _csrf: 'f'.repeat(64) })).status, 403);
  assert.equal((await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/new-version`, { reason: 'x' }, { csrf: false })).status, 403);
  assert.equal((await decisionsOf(ctx.a)).length, 0);
});

test('the portal list shows tier and decision status, "Not assessed yet" for in-use third parties with no decision', async () => {
  const c = await tprmClient('Decision List Client');
  const plain = await addThirdParty(c.id, 'Legacy Co', 'in_use');
  const session = await sessionFor(c.contributor);
  const list = await session.get(portal(c.id));
  assert.equal(list.status, 200);
  assert.match(list.text, new RegExp(`data-tprm-portal-row="${plain}" data-tprm-approval="not_yet_assessed"`));
  assert.match(list.text, /Not assessed yet/);
  const register = await client.get(`/tprm/clients/${c.id}`);
  assert.match(register.text, /data-tprm-approval="not_yet_assessed"/);
  assert.deepEqual(await events.verifyChains(db), []);
});

test('deleting a client removes its decisions; restore verification counts them', async () => {
  const c = await tprmClient('Decision Doomed Client');
  const ctx = await confirmed(c, 'Doomed Co', { status: 'proposed' });
  const rid = await issued(ctx, 'approve');
  assert.equal((await decide(await sessionFor(c.owner), ctx.ws, rid, { outcome: 'approve' })).status, 302);
  await require('../lib/workspace-deletion').deleteWorkspace(db, ctx.ws);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_client_decisions WHERE workspace_id=?').get(ctx.ws)).c, 0);
  const restoreCheck = fs.readFileSync(path.join(ROOT, 'lib', 'restore-check.js'), 'utf8');
  assert.match(restoreCheck.slice(restoreCheck.indexOf('SNAPSHOT_COUNT_TABLES'), restoreCheck.indexOf('LIVE_COUNT_MIN_RATIO')), /'tp_client_decisions'/);
});

test('client view: the third-party page shows only what was issued or released, and only to that client', async () => {
  const c = await tprmClient('Client View Pages');
  const ctx = await confirmed(c, 'Shown Party Co');
  const kept = await uploadOne(ctx, 'released-cv.txt', 'released');
  await release(ctx, kept);
  await uploadOne(ctx, 'unreleased-cv.txt', 'not released');
  await addFinding(ctx, { severity: 'high', title: 'CV finding title', description: 'Seen by the client', control_ref: 'A.5.1' });
  const rid = await issued(ctx, 'approve_with_conditions');

  const hidden = await confirmed(c, 'Hidden Draft Co');
  const made = await consultant.session.post(rBase(hidden.ws, hidden.tp, hidden.a), { row_version: String((await assessmentRow(hidden.a)).row_version) });
  assert.equal(made.status, 302);
  const draft = (await recsOf(hidden.a)).pop();
  assert.equal((await consultant.session.post(`${rBase(hidden.ws, hidden.tp, hidden.a)}/${draft.id}`, {
    ...draftBody('approve', { rationale: 'SENTINEL-CV-DRAFT rationale' }), intent: 'save', row_version: String((await recRow(draft.id)).row_version) })).status, 302);

  const owner = await sessionFor(c.owner);
  const home = await owner.get(portal(c.id));
  assert.equal(home.status, 200);
  assert.match(home.text, /data-tprm-client-view/);
  assert.match(home.text, new RegExp(`href="${portal(c.id)}/third-parties/${ctx.tp}" data-tprm-cv-party="${ctx.tp}"`));
  assert.match(home.text, /data-tprm-cv-tile="stages"/);
  assert.doesNotMatch(home.text, /SENTINEL-CV-DRAFT/);

  const page = await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-tprm-cv-party-head="${ctx.tp}"`));
  const docs = await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=documents`);
  assert.match(docs.text, /released-cv\.txt/);
  assert.doesNotMatch(docs.text, /unreleased-cv\.txt/, 'a file not released stays with the consultants');
  assert.match(docs.text, new RegExp(`/recommendations/${rid}/evidence/${kept.id}/download`));
  const issues = await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=issues`);
  assert.match(issues.text, /CV finding title/);
  const conds = await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=conditions`);
  assert.match(conds.text, /Enforce MFA for all admin accounts/);

  const draftPage = await owner.get(`${portal(c.id)}/third-parties/${hidden.tp}?tab=reviews`);
  assert.equal(draftPage.status, 200);
  assert.doesNotMatch(draftPage.text, /SENTINEL-CV-DRAFT/, 'a draft recommendation is not shown');
  assert.match(draftPage.text, /No recommendation issued yet/);

  assert.equal((await owner.get(`${portal(c.id)}/third-parties/999999`)).status, 404);
  const other = await tprmClient('Client View Other');
  const otherCtx = await confirmed(other, 'Other Client Party');
  assert.equal((await owner.get(`${portal(c.id)}/third-parties/${otherCtx.tp}`)).status, 404, 'another client\'s third party is not found');
  assert.notEqual((await (await sessionFor(other.owner)).get(`${portal(c.id)}/third-parties/${ctx.tp}`)).status, 200, 'another client cannot open it');
  assert.equal((await consultant.session.get(`${portal(c.id)}/third-parties/${ctx.tp}`)).status, 404, 'the portal page is for client users');
});

test('client view: tabs, filters and pages are plain links and forms', async () => {
  const c = await tprmClient('Client View Lists');
  await confirmed(c, 'Alpha Listed Co');
  const owner = await sessionFor(c.owner);
  for (const tab of ['waiting', 'renewals', 'ended']) {
    const res = await owner.get(`${portal(c.id)}?tab=${tab}`);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`data-tprm-cv-tab="${tab}"[^>]*>`));
    assert.match(res.text, new RegExp(`class="is-on" aria-current="page" data-tprm-cv-tab="${tab}"`));
  }
  const found = await owner.get(`${portal(c.id)}?q=alpha`);
  assert.match(found.text, /Alpha Listed Co/);
  const none = await owner.get(`${portal(c.id)}?q=zzz-not-there`);
  assert.match(none.text, /No third party matches these filters/);
  assert.equal((await owner.get(`${portal(c.id)}?page=99&tier=bogus&stage=x`)).status, 200);
  assert.match(found.text, /<form method="GET" action="[^"]+" class="cv-filters"/);
});

test('issue comments: the client sees and joins the conversation; internal notes and earlier comments stay hidden', async () => {
  const issuesLib = require('../lib/tprm/issues');
  const c = await tprmClient('Client View Comments');
  const ctx = await confirmed(c, 'Comment Party Co');
  await addFinding(ctx, { severity: 'medium', title: 'Comment finding', description: 'A gap', control_ref: 'A.8.1' });
  const fid = Number((await db.prepare('SELECT id FROM tp_findings WHERE workspace_id=? AND assessment_id=? AND title=?').get(ctx.ws, ctx.a, 'Comment finding')).id);
  assert.equal((await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${fid}/share`, { title: 'Shared comment issue', body: 'Please fix' })).status, 302);
  const iid = Number((await db.prepare('SELECT id FROM tp_issues WHERE workspace_id=? AND finding_id=?').get(ctx.ws, fid)).id);
  await db.prepare(`INSERT INTO tp_issue_messages (workspace_id, issue_id, author_kind, author_user_id, author_name, body, client_visible)
    VALUES (?, ?, 'firm', ?, 'Earlier', 'SENTINEL-EARLIER-COMMENT', false)`).run(ctx.ws, iid, consultant.id);
  assert.equal((await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/issues/${iid}/reply`, { body: 'SENTINEL-INTERNAL-NOTE', internal: '1' })).status, 302);
  assert.equal((await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/issues/${iid}/reply`, { body: 'Shared reply for everyone' })).status, 302);
  const firmPage = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=evidence`);
  assert.match(firmPage.text, /data-tprm-issue-internal-switch/);
  const rid = await issued(ctx, 'approve');

  const owner = await sessionFor(c.owner);
  const page = await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=issues`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Shared reply for everyone/);
  assert.doesNotMatch(page.text, /SENTINEL-INTERNAL-NOTE/, 'an internal note is not shown to the client');
  assert.doesNotMatch(page.text, /SENTINEL-EARLIER-COMMENT/, 'comments written before clients could read them stay hidden');
  assert.match(page.text, /data-tprm-cv-comment-form/);

  const posted = await owner.post(`${portal(c.id)}/issues/${iid}/comments`, { body: 'Client question here', third_party_id: String(ctx.tp) });
  assert.equal(posted.status, 302);
  assert.match(toast(posted), /Comment added/);
  const row = await db.prepare("SELECT author_kind, author_user_id, internal, client_visible FROM tp_issue_messages WHERE workspace_id=? AND issue_id=? AND body='Client question here'").get(ctx.ws, iid);
  assert.deepEqual([row.author_kind, Number(row.author_user_id), row.internal, row.client_visible], ['client', c.owner.id, false, true]);

  const vendorView = await issuesLib.vendorList(db, { workspaceId: ctx.ws, assessmentId: ctx.a });
  const vendorBodies = vendorView[0].messages.map(m => m.body);
  assert.ok(vendorBodies.includes('Client question here'), 'the supplier sees the client comment');
  assert.ok(!vendorBodies.includes('SENTINEL-INTERNAL-NOTE'), 'the supplier does not see an internal note');
  const firmView = await issuesLib.forAssessment(db, ctx.ws, ctx.a);
  assert.ok(firmView[0].messages.some(m => m.body === 'SENTINEL-INTERNAL-NOTE' && m.internal), 'the firm sees its internal note');

  const other = await tprmClient('Client View Comments Other');
  const otherSession = await sessionFor(other.owner);
  await otherSession.get(portal(other.id));
  assert.equal((await otherSession.post(`${portal(other.id)}/issues/${iid}/comments`, { body: 'Not mine' })).status, 404, 'another client cannot comment on it');
  assert.notEqual((await consultant.session.post(`${portal(c.id)}/issues/${iid}/comments`, { body: 'Firm via portal' })).status, 302);
  assert.equal((await owner.post(`${portal(c.id)}/issues/${iid}/comments`, { body: '   ', third_party_id: String(ctx.tp) })).status, 302);

  assert.equal((await decide(owner, ctx.ws, rid, { outcome: 'approve' })).status, 302);
  const closed = await owner.post(`${portal(c.id)}/issues/${iid}/comments`, { body: 'Too late', third_party_id: String(ctx.tp) });
  assert.match(toast(closed), /closed/);
  assert.match((await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=issues`)).text, /data-tprm-cv-thread-closed/);
});

test('client details: an owner at the client, business unit and volume, set by the firm or by the client', async () => {
  const c = await tprmClient('Client View Details');
  const tp = await addThirdParty(c.id, 'Details Party Co', 'in_use');
  const row = async () => await db.prepare('SELECT client_owner_user_id, business_unit, service_volume, row_version FROM tp_third_parties WHERE workspace_id=? AND id=?').get(c.id, tp);
  const other = await tprmClient('Client View Details Other');
  const firmSave = async owner => await client.post(`/tprm/clients/${c.id}/third-parties/${tp}`, {
    name: 'Details Party Co', status: 'in_use', client_owner_user_id: String(owner), business_unit: 'Retail operations', service_volume: 'About 10,000 a month',
    row_version: String((await row()).row_version) });
  const refused = await firmSave(other.owner.id);
  assert.equal(refused.status, 400, 'a person from another client cannot own it');
  assert.equal((await row()).client_owner_user_id, null);
  assert.equal((await firmSave(c.other.id)).status, 302);
  assert.deepEqual([Number((await row()).client_owner_user_id), (await row()).business_unit], [c.other.id, 'Retail operations']);
  const firmPage = await client.get(`/tprm/clients/${c.id}/third-parties/${tp}`);
  assert.match(firmPage.text, /data-tprm-client-owner-fact><dt>Owner at the client<\/dt><dd>[^<]*dec-coord/);

  const owner = await sessionFor(c.owner);
  const page = await owner.get(`${portal(c.id)}/third-parties/${tp}`);
  assert.match(page.text, /data-tprm-cv-owner>[^<]*dec-coord/);
  assert.match(page.text, /data-tprm-cv-edit-details/);
  assert.match(page.text, /Not asked at this tier/);
  const home = await owner.get(portal(c.id));
  assert.match(home.text, /dec-coord-client-view-details@test\.local<\/td>/);
  assert.doesNotMatch((await owner.get(`${portal(c.id)}?owner=me`)).text, new RegExp(`data-tprm-cv-party="${tp}"`), 'owned by someone else');

  const saved = await owner.post(`${portal(c.id)}/third-parties/${tp}/details`, { client_owner_user_id: String(c.owner.id), business_unit: 'Cards', service_volume: '', row_version: String((await row()).row_version) });
  assert.equal(saved.status, 302);
  assert.match(toast(saved), /Details saved/);
  assert.deepEqual([Number((await row()).client_owner_user_id), (await row()).business_unit, (await row()).service_volume], [c.owner.id, 'Cards', null]);
  assert.match((await owner.get(`${portal(c.id)}?owner=me`)).text, new RegExp(`data-tprm-cv-party="${tp}"`));
  const stale = await owner.post(`${portal(c.id)}/third-parties/${tp}/details`, { client_owner_user_id: '', row_version: '1' });
  assert.match(toast(stale), /changed|reload/i);
  const bad = await owner.post(`${portal(c.id)}/third-parties/${tp}/details`, { client_owner_user_id: String(other.owner.id), row_version: String((await row()).row_version) });
  assert.match(toast(bad), /people at the client/);

  const contributor = await sessionFor(c.contributor);
  assert.doesNotMatch((await contributor.get(`${portal(c.id)}/third-parties/${tp}`)).text, /data-tprm-cv-edit-details/);
  const blocked = await contributor.post(`${portal(c.id)}/third-parties/${tp}/details`, { client_owner_user_id: '', row_version: String((await row()).row_version) });
  assert.match(toast(blocked), /does not allow/);
  assert.equal(Number((await row()).client_owner_user_id), c.owner.id);
});

test('client view: the Scoping tab shows how the tier was set once the tier is confirmed, as the header does', async () => {
  const c = await tprmClient('Client View Scoping');
  const ws = c.id;
  const tp = await addThirdParty(ws, 'Scoping Party Co', 'in_use');
  const a = idIn((await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {})).location, /assessments\/(\d+)/);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ws, tp, a)}/scope`, body)).status, 302);
  const ctx = { ws, tp, a, c };
  await nameOwner(ctx, c.owner.id);
  const owner = await sessionFor(c.owner);
  const scopingTab = () => owner.get(`${portal(ws)}/third-parties/${tp}?tab=scoping`);

  const proposed = await scopingTab();
  assert.equal(proposed.status, 200);
  assert.match(proposed.text, /once your consultants confirm the tier/);
  assert.doesNotMatch(proposed.text, /data-tprm-cv-scoping=/, 'a proposed tier is not shown');

  assert.equal((await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  const confirmedTier = await scopingTab();
  assert.match(confirmedTier.text, new RegExp(`data-tprm-cv-scoping="${a}"`));
  assert.match(confirmedTier.text, /data-tprm-cv-deciding/);
  assert.match(confirmedTier.text, /Low tier/);
  assert.match(confirmedTier.text, /data-tprm-cv-not-sent/, 'before the questionnaire goes out, the page says so instead of showing no questions');
  assert.doesNotMatch(confirmedTier.text, /Extra question packs/);

  await issued(ctx, 'approve');
  const after = await scopingTab();
  assert.match(after.text, new RegExp(`data-tprm-cv-scoping="${a}"`));
  assert.match(after.text, /Low tier/);
});

test('client requests: the client asks for a new third party, the firm adds it and the scoping starts from the client\'s answers', async () => {
  const c = await tprmClient('Client View Requests');
  const owner = await sessionFor(c.owner);
  const form = await owner.get(`${portal(c.id)}/requests/new`);
  assert.equal(form.status, 200);
  assert.match(form.text, /data-tprm-cv-request-form/);
  const body = { name: 'Requested Supplier Co', service_description: 'Nightly backups', business_unit: 'IT', service_volume: 'Four servers',
    owner_user_id: String(c.owner.id), contact_email: 'ops@requested.example' };
  const missing = await owner.post(`${portal(c.id)}/requests`, body);
  assert.equal(missing.status, 400, 'every question that sets the tier must be answered');
  assert.match(missing.text, /How much it matters/);
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  const sent = await owner.post(`${portal(c.id)}/requests`, body);
  assert.equal(sent.status, 302);
  assert.match(toast(sent), /sent to your consultants/);
  const reqRow = await db.prepare("SELECT * FROM tp_client_requests WHERE workspace_id=? AND name='Requested Supplier Co'").get(c.id);
  assert.equal(reqRow.status, 'submitted');
  const tab = await owner.get(`${portal(c.id)}?tab=requests`);
  assert.match(tab.text, new RegExp(`data-tprm-cv-request="${reqRow.id}" data-tprm-cv-request-status="submitted"`));

  const contributor = await sessionFor(c.contributor);
  await contributor.get(portal(c.id));
  const blocked = await contributor.post(`${portal(c.id)}/requests`, { ...body, name: 'Contributor Supplier Co' });
  assert.ok(blocked.status === 403 || /does not allow/.test(toast(blocked)), `a contributor cannot request (${blocked.status})`);
  assert.equal((await db.prepare("SELECT COUNT(*)::int n FROM tp_client_requests WHERE name='Contributor Supplier Co'").get()).n, 0);

  const firmHome = await consultant.session.get(`/tprm/clients/${c.id}`);
  assert.match(firmHome.text, new RegExp(`data-tprm-client-request="${reqRow.id}"`));
  const page = await consultant.session.get(`/tprm/clients/${c.id}/requests/${reqRow.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-client-request-answers/);
  const other = await tprmClient('Client View Requests Other');
  assert.equal((await consultant.session.get(`/tprm/clients/${other.id}/requests/${reqRow.id}`)).status, 404);

  const accepted = await consultant.session.post(`/tprm/clients/${c.id}/requests/${reqRow.id}/accept`, { row_version: String(reqRow.row_version) });
  assert.equal(accepted.status, 302);
  const tp = idIn(accepted.location, /third-parties\/(\d+)/);
  const tpr = await db.prepare('SELECT name, status, business_unit, client_owner_user_id FROM tp_third_parties WHERE workspace_id=? AND id=?').get(c.id, tp);
  assert.deepEqual([tpr.name, tpr.status, tpr.business_unit, Number(tpr.client_owner_user_id)], ['Requested Supplier Co', 'proposed', 'IT', c.owner.id]);
  assert.equal((await db.prepare('SELECT status FROM tp_client_requests WHERE id=?').get(reqRow.id)).status, 'accepted');
  const started = await consultant.session.post(`/tprm/clients/${c.id}/third-parties/${tp}/assessments`, {});
  const a = idIn(started.location, /assessments\/(\d+)/);
  const answers = (await assessmentRow(a)).answers;
  for (const [q, x] of Object.entries(LOW)) assert.equal(answers[q], x, `${q} carried over from the request`);
  assert.match((await owner.get(`${portal(c.id)}?tab=requests`)).text, new RegExp(`href="${portal(c.id)}/third-parties/${tp}"`));

  const second = await owner.post(`${portal(c.id)}/requests`, { ...body, name: 'Declined Supplier Co' });
  assert.equal(second.status, 302);
  const r2 = await db.prepare("SELECT * FROM tp_client_requests WHERE workspace_id=? AND name='Declined Supplier Co'").get(c.id);
  assert.equal((await consultant.session.post(`/tprm/clients/${c.id}/requests/${r2.id}/decline`, { reason: '', row_version: String(r2.row_version) })).status, 400);
  assert.equal((await consultant.session.post(`/tprm/clients/${c.id}/requests/${r2.id}/decline`, { reason: 'Already covered by Quill', row_version: String(r2.row_version) })).status, 302);
  assert.match((await owner.get(`${portal(c.id)}?tab=requests`)).text, /Already covered by Quill/);

  const third = await owner.post(`${portal(c.id)}/requests`, { ...body, name: 'Withdrawn Supplier Co' });
  assert.equal(third.status, 302);
  const r3 = await db.prepare("SELECT * FROM tp_client_requests WHERE workspace_id=? AND name='Withdrawn Supplier Co'").get(c.id);
  assert.match(toast(await owner.post(`${portal(c.id)}/requests/${r3.id}/withdraw`, { row_version: String(r3.row_version) })), /withdrawn/);
  assert.equal((await db.prepare('SELECT status FROM tp_client_requests WHERE id=?').get(r3.id)).status, 'withdrawn');
});

test('firm home: tiles and My work, counting only clients the person can reach', async () => {
  const c = await tprmClient('Firm Home Reach');
  const owner = await sessionFor(c.owner);
  await owner.get(portal(c.id));
  const body = { name: 'Hub Request Co', service_description: 'Statement printing' };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await owner.post(`${portal(c.id)}/requests`, body)).status, 302);
  const hidden = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, 'Firm Home Unreachable')).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(hidden);
  const outsider = await makeUser('hub-outsider-owner@test.local', { type: 'client', workspaceId: hidden, memberRole: 'client_owner' });
  await db.prepare(`INSERT INTO tp_client_requests (workspace_id, name, service_description, requested_by) VALUES (?, 'SENTINEL-UNREACHABLE-REQUEST', 'x', ?)`).run(hidden, outsider.id);

  const home = await consultant.session.get('/tprm');
  assert.equal(home.status, 200);
  assert.match(home.text, /data-tprm-hub/);
  assert.match(home.text, /data-tprm-my-work/);
  assert.match(home.text, /data-tprm-work-item="request"[\s\S]*?Hub Request Co/);
  assert.doesNotMatch(home.text, /SENTINEL-UNREACHABLE-REQUEST/, 'a client the consultant is not on stays out of My work');
  assert.match(home.text, /data-tprm-pipeline[\s\S]*data-tprm-client-list/, 'the pipeline still comes before the client list');
});

test('register: tiles, extra columns, and starting assessments for several ticked third parties at once', async () => {
  const c = await tprmClient('Register Bulk Client');
  const a1 = await addThirdParty(c.id, 'Bulk One Co', 'proposed');
  const a2 = await addThirdParty(c.id, 'Bulk Two Co', 'in_use');
  const page = await consultant.session.get(`/tprm/clients/${c.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-register-tiles/);
  assert.match(page.text, /data-tprm-bulk/);
  assert.match(page.text, new RegExp(`name="ids" value="${a1}" form="tp-bulk"`));
  const started = await consultant.session.post(`/tprm/clients/${c.id}/third-parties/bulk-start`, { ids: [String(a1), String(a2)], _tp_confirmed: '1' });
  assert.equal(started.status, 302);
  assert.match(toast(started), /2 assessments started/);
  const types = (await db.prepare('SELECT type FROM tp_assessments WHERE workspace_id=? ORDER BY third_party_id').all(c.id)).map(r => r.type);
  assert.deepEqual(types.sort(), ['onboarding', 'reassessment']);
  const again = await consultant.session.post(`/tprm/clients/${c.id}/third-parties/bulk-start`, { ids: String(a1), _tp_confirmed: '1' });
  assert.match(toast(again), /0 assessments started\. 1 not started: This third party already has an open assessment/);
  const other = await tprmClient('Register Bulk Other');
  const foreign = await addThirdParty(other.id, 'Foreign Bulk Co', 'proposed');
  const cross = await consultant.session.post(`/tprm/clients/${c.id}/third-parties/bulk-start`, { ids: String(foreign), _tp_confirmed: '1' });
  assert.match(toast(cross), /0 assessments started/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int n FROM tp_assessments WHERE workspace_id=?').get(other.id)).n, 0, 'another client\'s third party is never started');
});

test('firm third-party page: summary cards and the Issues, Conditions, Documents and Contracts tabs', async () => {
  const c = await tprmClient('Firm Party Page');
  const ctx = await confirmed(c, 'Firm Page Co');
  const kept = await uploadOne(ctx, 'firm-released.txt', 'released');
  await release(ctx, kept);
  await uploadOne(ctx, 'firm-unreleased.txt', 'not released');
  await addFinding(ctx, { severity: 'high', title: 'Firm page finding', description: 'Seen by the firm', control_ref: 'A.5.1' });
  await issued(ctx, 'approve_with_conditions');
  const base = `/tprm/clients/${c.id}/third-parties/${ctx.tp}`;
  const page = await consultant.session.get(base);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-party-cards/);
  for (const t of ['issues', 'conditions', 'documents', 'contracts']) assert.match(page.text, new RegExp(`data-tprm-tab="${t}"`));
  const docs = await consultant.session.get(`${base}?tab=documents`);
  assert.match(docs.text, /firm-released\.txt[\s\S]*?Released|Released[\s\S]*?firm-released\.txt/);
  assert.match(docs.text, /firm-unreleased\.txt/, 'the firm sees files it has not released');
  assert.match((await consultant.session.get(`${base}?tab=issues`)).text, /Firm page finding/);
  assert.match((await consultant.session.get(`${base}?tab=conditions`)).text, /Enforce MFA for all admin accounts/);
});

test('finding conversations: the client and the firm talk about a finding that was not shared with the third party', async () => {
  const c = await tprmClient('Finding Talk Client');
  const ctx = await confirmed(c, 'Finding Talk Co');
  await addFinding(ctx, { severity: 'medium', title: 'Unshared talk finding', description: 'A gap', control_ref: 'A.8.2' });
  const fid = Number((await db.prepare('SELECT id FROM tp_findings WHERE workspace_id=? AND assessment_id=? AND title=?').get(ctx.ws, ctx.a, 'Unshared talk finding')).id);
  const rid = await issued(ctx, 'approve');
  const owner = await sessionFor(c.owner);
  const page = await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=issues`);
  assert.match(page.text, new RegExp(`data-tprm-cv-finding-thread="${fid}"`));
  const posted = await owner.post(`${portal(c.id)}/findings/${fid}/comments`, { body: 'Why is this medium?', third_party_id: String(ctx.tp) });
  assert.equal(posted.status, 302);
  assert.match(toast(posted), /Comment added/);
  const firm = await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=evidence`);
  assert.match(firm.text, new RegExp(`data-tprm-finding-notes="${fid}"[\\s\\S]*?Why is this medium\\?`));
  const reply = await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${fid}/client-reply`, { body: 'Because the gap touches customer data.' });
  assert.match(toast(reply), /Reply sent to the client/);
  assert.match((await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=issues`)).text, /Because the gap touches customer data\./);
  const other = await tprmClient('Finding Talk Other');
  const os = await sessionFor(other.owner);
  await os.get(portal(other.id));
  assert.equal((await os.post(`${portal(other.id)}/findings/${fid}/comments`, { body: 'Not mine' })).status, 404);
  assert.equal((await decide(owner, ctx.ws, rid, { outcome: 'approve' })).status, 302);
  assert.match(toast(await owner.post(`${portal(c.id)}/findings/${fid}/comments`, { body: 'Late', third_party_id: String(ctx.tp) })), /closed/);
});

test('automatic reassessments: started before they are due, by the last lead or the client lead, once, and only where switched on', async () => {
  const auto = require('../lib/tprm/auto-reassess');
  const c = await tprmClient('Auto Reassess Client');
  await db.prepare('UPDATE workspaces SET lead_consultant_id = ? WHERE id = ?').run(consultant.id, c.id);
  const soon = await addThirdParty(c.id, 'Due Soon Co', 'in_use');
  const later = await addThirdParty(c.id, 'Due Later Co', 'in_use');
  const today = dates.todayFor(await wsRow(c.id));
  const plus = n => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  await db.prepare('UPDATE tp_third_parties SET next_due_date = ? WHERE id = ?').run(plus(10), soon);
  await db.prepare('UPDATE tp_third_parties SET next_due_date = ? WHERE id = ?').run(plus(90), later);
  const permissionsFor = async u => new Set(rbac.rolePermissions(rbac.normalizeRole(u.firm_role)));
  const count = async tp => (await db.prepare('SELECT COUNT(*)::int n FROM tp_assessments WHERE workspace_id=? AND third_party_id=?').get(c.id, tp)).n;
  await auto.run(db, { permissionsFor });
  assert.equal(await count(soon), 0, 'off until a manager switches it on');
  const settingsPage = await client.get(`/tprm/clients/${c.id}/settings`);
  assert.match(settingsPage.text, /data-tprm-auto-reassess/);
  await db.prepare('UPDATE tp_client_settings SET auto_reassess_days = 30 WHERE workspace_id = ?').run(c.id);
  await auto.run(db, { permissionsFor });
  await auto.run(db, { permissionsFor });
  assert.equal(await count(soon), 1, 'started once');
  assert.equal(await count(later), 0, 'not yet within 30 days');
  const a = await db.prepare('SELECT type, status, lead_consultant_id FROM tp_assessments WHERE workspace_id=? AND third_party_id=?').get(c.id, soon);
  assert.deepEqual([a.type, a.status, Number(a.lead_consultant_id)], ['reassessment', 'scoping', consultant.id]);
});

test('document checks: old evidence, the wrong kind of file and the same file given for many answers are flagged', async () => {
  const checks = require('../lib/tprm/document-checks');
  assert.match(checks.kindCheck('Approved policy document showing version, approver and review date', 'policy.png').text, /this is an image/);
  assert.match(checks.kindCheck('Certificate of insurance or policy schedule', 'insurance.xlsx').text, /this is a spreadsheet/);
  assert.equal(checks.kindCheck('Asset register extract', 'assets.xlsx'), null, 'a register can be a spreadsheet');
  assert.equal(checks.kindCheck('Architecture or data-flow diagram for the service', 'flow.png'), null, 'a diagram can be an image');
  const c = await tprmClient('Document Check Client');
  const ctx = await confirmed(c, 'Document Check Co');
  const img = await uploadOne(ctx, 'policy-list.csv', 'a,b\n1,2');
  const doc = await uploadOne(ctx, 'old-policy.txt', 'policy text');
  const bankById = new Map([['GOV-01', { evidence: 'Approved policy document showing version, approver and review date' }], ['GOV-02', { evidence: 'Organisation chart' }]]);
  const rows = [
    { question_id: 'GOV-01', evidence_date: '2024-01-15', files: [{ id: img.id }, { id: doc.id }] },
    { question_id: 'GOV-02', files: [{ id: doc.id }] }, { question_id: 'GOV-03', files: [{ id: doc.id }] }, { question_id: 'GOV-04', files: [{ id: doc.id }] },
  ];
  const map = await checks.forRows(db, ctx.ws, rows, { bankById, reports: [{ evidence_id: doc.id, certificate_expires_on: '2025-01-01' }], today: '2026-11-24' });
  const keys = id => (map.get(Number(id)) || []).map(x => x.key).sort();
  assert.deepEqual(keys(img.id), ['kind', 'old']);
  assert.deepEqual(keys(doc.id), ['expired', 'old', 'reused']);
});

test('a client account with third-party risk and no ISO programme opens on Third-party risk, with no Home, actions, progress or Updates', async () => {
  const only = await tprmClient('Portal Only Tprm');
  await db.prepare(`UPDATE workspaces SET frameworks='[]' WHERE id=?`).run(only.id);
  const both = await tprmClient('Portal Both Services');
  const portal = ws => `/workspaces/${ws}/client-portal`;
  const onlySession = await sessionFor(only.owner);
  const landing = await onlySession.get('/dashboard');
  assert.equal(landing.status, 302);
  assert.equal(landing.location, portal(only.id));
  for (const route of [portal(only.id), `${portal(only.id)}?view=actions`, `${portal(only.id)}/updates`]) {
    const res = await onlySession.get(route);
    assert.equal(res.status, 302, `${route} redirects`);
    assert.equal(res.location, `${portal(only.id)}/third-party-risk`);
  }
  const page = await onlySession.get(`${portal(only.id)}/third-party-risk`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`href="${portal(only.id)}/third-party-risk"`));
  assert.doesNotMatch(page.text, new RegExp(`href="${portal(only.id)}\\?view=|href="${portal(only.id)}/updates"`));
  assert.doesNotMatch(page.text, /data-tprm-cv-nav="portal"/, 'no Portal item that would only lead back here');
  const bothSession = await sessionFor(both.owner);
  const home = await bothSession.get(portal(both.id));
  assert.equal(home.status, 200);
  assert.match(home.text, new RegExp(`href="${portal(both.id)}/updates"`));
  assert.match(home.text, new RegExp(`href="${portal(both.id)}/third-party-risk"`));
  const bothTprm = await bothSession.get(`${portal(both.id)}/third-party-risk`);
  assert.match(bothTprm.text, /data-tprm-cv-nav="portal"/, 'a client with both services keeps the way back to the portal');
});
