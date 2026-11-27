'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient, allSteps } = require('./helpers');

let env;
let client;
let db;
let firmId;
let managerId;
let at;
let events;
let rbac;
let consultant;
let senior;
let senior2;

const PASSWORD = 'assessment-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };
const HIGH = { ...LOW, data_handled: 'confidential' };
const CRITICAL = { ...LOW, data_handled: 'special_financial' };

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  at = require('../lib/tprm/assessments');
  events = require('../lib/tprm/events');
  rbac = require('../lib/rbac');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  const me = await db.prepare('SELECT id, firm_role FROM users WHERE email=?').get(env.login.email);
  managerId = me.id;
  assert.equal(rbac.normalizeRole(me.firm_role), 'manager', 'the default test login is a manager');
  consultant = await makeUser('assess-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('assess-senior@test.local', { role: 'senior_consultant' });
  senior2 = await makeUser('assess-senior2@test.local', { role: 'senior_consultant' });
  for (const u of [consultant, senior, senior2]) u.session = await signIn(u.email, u.password);
});

test.after(async () => {
  for (const u of [consultant, senior, senior2]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId, workspaceId = null, memberRole = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), email, type, type === 'firm' ? firm : null,
    type === 'firm' ? role : null)).lastInsertRowid);
  if (workspaceId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(workspaceId, id, memberRole || role);
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

async function tprmClient(name, { firm = firmId, frameworks = ['iso27001'] } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,?,'certification_support')`).run(firm, name, JSON.stringify(frameworks))).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (firm === firmId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, consultant.id, 'consultant');
  return id;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);

async function addThirdParty(ws, body = {}) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'Acme', status: 'in_use', ...body });
  assert.equal(res.status, 302, `create redirects (got ${res.status})`);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  const svc = await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Payroll processing' });
  assert.equal(svc.status, 302);
  return tp;
}

const services = async (ws, tp) => (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=? ORDER BY id').all(ws, tp)).map(r => String(r.id));
const assessmentRow = async id => db.prepare('SELECT *, due_date::text AS due_date FROM tp_assessments WHERE id=?').get(id);
const tpRow = async id => db.prepare('SELECT *, next_due_date::text AS next_due_date FROM tp_third_parties WHERE id=?').get(id);
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;

async function start(ws, tp, session = client) {
  const res = await session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(res.status, 302, `start redirects (got ${res.status})`);
  const id = idIn(res.location, /assessments\/(\d+)/);
  assert.ok(id, `start opens the assessment (${res.location})`);
  return id;
}

function scopeBody(answers, extra = {}) {
  const body = { ...extra };
  for (const [q, a] of Object.entries(answers)) body[`answers[${q}]`] = a;
  return body;
}

async function postScope(ws, tp, a, answers, extra = {}, session = client) {
  const row = await assessmentRow(a);
  return await session.post(`${aBase(ws, tp, a)}/scope`, scopeBody(answers, {
    services: await services(ws, tp), intent: 'propose', row_version: String(row.row_version), ...extra,
  }));
}

async function propose(ws, tp, a, answers, extra = {}, session = client) {
  const res = await postScope(ws, tp, a, answers, extra, session);
  assert.equal(res.status, 302, `propose redirects (got ${res.status}: ${(res.text || '').match(/<li>[^<]*<\/li>/g) || ''})`);
  assert.equal((await assessmentRow(a)).status, 'tier_proposed');
}

async function confirm(ws, tp, a, session) {
  const row = await assessmentRow(a);
  return await session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String(row.row_version) });
}

async function wsRow(id) {
  return await db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
}

async function actorFor(user, ws) {
  const role = rbac.normalizeRole(user.firm_role);
  const perms = role === 'manager' ? new Set(rbac.rolePermissions('manager').concat(['*'])) : new Set(rbac.rolePermissions(role));
  return { user: { id: user.id, user_type: 'firm', firm_id: user.firm_id, firm_role: user.firm_role }, perms, ws: await wsRow(ws) };
}

const manager = () => ({ id: managerId, firm_id: firmId, firm_role: 'manager', user_type: 'firm' });

test('a proposed third party gets an onboarding assessment, one in use a reassessment, an exited one none', async () => {
  const ws = await tprmClient('Assessment Types Client');
  const proposed = await addThirdParty(ws, { name: 'Proposed Co', status: 'proposed' });
  const inUse = await addThirdParty(ws, { name: 'In Use Co', status: 'in_use' });
  const exited = await addThirdParty(ws, { name: 'Exited Co', status: 'exited' });

  const page = await client.get(`/tprm/clients/${ws}/third-parties/${proposed}`);
  assert.match(page.text, /Start onboarding assessment/);
  assert.match((await client.get(`/tprm/clients/${ws}/third-parties/${inUse}`)).text, /Start assessment</, 'never assessed: its first assessment is not called a reassessment');
  const assessedBefore = await addThirdParty(ws, { name: 'Assessed Before Co', status: 'in_use', last_assessment_date: '2025-06-01' });
  assert.match((await client.get(`/tprm/clients/${ws}/third-parties/${assessedBefore}`)).text, /Start reassessment/);
  const exitedPage = await client.get(`/tprm/clients/${ws}/third-parties/${exited}`);
  assert.doesNotMatch(exitedPage.text, /data-tprm-start-assessment/);
  assert.match(exitedPage.text, /Exited third parties are not assessed/);

  const onboarding = await start(ws, proposed, consultant.session);
  const reassessment = await start(ws, inUse);
  assert.equal((await assessmentRow(onboarding)).type, 'onboarding');
  assert.equal((await assessmentRow(reassessment)).type, 'reassessment');
  const firstPage = await client.get(aBase(ws, inUse, reassessment));
  assert.match(firstPage.text, /<title>Assessment · In Use Co/);
  assert.doesNotMatch(firstPage.text, /<title>Reassessment/);
  assert.match(firstPage.text, /<input type="checkbox" name="services" value="\d+" checked>/, 'the only service starts ticked');
  const again = await start(ws, assessedBefore);
  assert.match((await client.get(aBase(ws, assessedBefore, again))).text, /<title>Reassessment · Assessed Before Co/);
  assert.equal((await assessmentRow(onboarding)).status, 'scoping');
  assert.equal(Number((await assessmentRow(onboarding)).lead_consultant_id), consultant.id, 'the starter leads it');

  const refused = await client.post(`/tprm/clients/${ws}/third-parties/${exited}/assessments`, {});
  assert.equal(refused.status, 302);
  assert.match(decodeURIComponent(refused.location), /has exited, so it is not assessed/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_assessments WHERE third_party_id=?').get(exited)).c, 0);
  await assert.rejects(at.start(db, await actorFor(manager(), ws), exited), err => err.status === 409);
});

test('one open assessment per third party; a cancelled one makes room for the next', async () => {
  const ws = await tprmClient('One Open Client');
  const tp = await addThirdParty(ws);
  const first = await start(ws, tp);
  const again = await client.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(again.status, 302);
  assert.match(again.location, new RegExp(`assessments/${first}\\?`), 'the second start opens the open one');
  assert.match(decodeURIComponent(again.location), /already has an open assessment/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_assessments WHERE third_party_id=?').get(tp)).c, 1);

  const model = await db.prepare(`SELECT id, version FROM tp_criticality_models WHERE firm_id=? AND status='active'`).get(firmId);
  await assert.rejects(db.prepare(`INSERT INTO tp_assessments (workspace_id, firm_id, third_party_id, type, criticality_model_id, criticality_model_version)
    VALUES (?, ?, ?, 'reassessment', ?, ?)`).run(ws, firmId, tp, model.id, model.version), /tp_assessments_one_open|duplicate key/,
  'the database refuses a second open assessment');

  const noReason = await client.post(`${aBase(ws, tp, first)}/cancel`, { row_version: String((await assessmentRow(first)).row_version), reason: '' });
  assert.equal(noReason.status, 302);
  assert.match(decodeURIComponent(noReason.location), /Give a reason for cancelling/);
  assert.equal((await assessmentRow(first)).status, 'scoping');
  const cancelled = await client.post(`${aBase(ws, tp, first)}/cancel`, { row_version: String((await assessmentRow(first)).row_version), reason: 'Started by mistake' });
  assert.equal(cancelled.status, 302);
  assert.equal((await assessmentRow(first)).status, 'cancelled');
  const next = await start(ws, tp);
  assert.notEqual(next, first);
});

test('scoring uses the active model, records its version and explains the tier', async () => {
  const ws = await tprmClient('Scoring Client');
  const tp = await addThirdParty(ws);
  const a = await start(ws, tp);
  const active = await db.prepare(`SELECT id, version FROM tp_criticality_models WHERE firm_id=? AND status='active'`).get(firmId);
  let row = await assessmentRow(a);
  assert.equal(Number(row.criticality_model_id), Number(active.id));
  assert.equal(row.criticality_model_version, active.version);

  const page = await allSteps(client, aBase(ws, tp, a));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-scope-form/);
  assert.match(page.text, /What data will the third party handle\?/);
  assert.match(page.text, /How is the service delivered\?/, 'service-description questions are shown too');
  assert.match(page.text, /Not scored yet/);

  const partial = await postScope(ws, tp, a, { data_handled: 'personal' });
  assert.equal(partial.status, 400);
  assert.match(partial.text, /Answer every criticality question before proposing the tier \(4 unanswered\)/);
  assert.equal((await assessmentRow(a)).status, 'scoping');

  const unknown = await postScope(ws, tp, a, { ...LOW, data_handled: 'everything' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.text, /is not an answer to/);
  const other = await addThirdParty(ws, { name: 'Other Co' });
  const foreign = await postScope(ws, tp, a, LOW, { services: await services(ws, other) });
  assert.equal(foreign.status, 400);
  assert.match(foreign.text, /no longer recorded for this third party/);
  const none = await postScope(ws, tp, a, LOW, { services: [] });
  assert.equal(none.status, 400);
  assert.match(none.text, /Choose at least one service in scope/);

  const draft = await postScope(ws, tp, a, { data_handled: 'personal', delivery_model: 'vendor_hosted' }, { intent: 'save' });
  assert.equal(draft.status, 302);
  assert.match(decodeURIComponent(draft.location), /[?&]toast=Scope saved$/, 'the save says what was saved');
  row = await assessmentRow(a);
  assert.deepEqual(row.answers, { data_handled: 'personal', delivery_model: 'vendor_hosted' });
  assert.equal(row.scored_tier, null);

  await propose(ws, tp, a, { ...CRITICAL, delivery_model: 'vendor_hosted', payments_records: 'yes' });
  row = await assessmentRow(a);
  assert.equal(row.scored_tier, 'critical');
  assert.equal(row.final_tier, 'critical');
  assert.equal(row.deciding_question_id, 'data_handled');
  assert.equal(row.deciding_answer_id, 'special_financial');
  assert.equal(row.tier_explanation, 'Critical because: Special-category, financial or payment data');
  assert.equal(row.override_direction, 'none');
  assert.equal(Number(row.proposed_by), managerId);
  assert.ok(row.proposed_at);
  assert.equal(row.answers.payments_records, 'yes', 'service-description answers are kept');
  assert.deepEqual(row.services_in_scope.map(s => s.description), ['Payroll processing']);
  const shown = await allSteps(client, aBase(ws, tp, a));
  assert.match(shown.text, /Critical because: Special-category, financial or payment data/);

  const lowTp = await addThirdParty(ws, { name: 'Low Co' });
  const lowA = await start(ws, lowTp);
  await propose(ws, lowTp, lowA, { ...LOW, delivery_model: 'staff_onsite', sites_data: 'yes' });
  assert.equal((await assessmentRow(lowA)).scored_tier, 'low');
});

test('overrides: anyone raises with a reason; only a manager lowers, with a reason', async () => {
  const ws = await tprmClient('Override Client');
  const tp = await addThirdParty(ws);
  const a = await start(ws, tp, consultant.session);

  let res = await postScope(ws, tp, a, HIGH, { override_direction: 'raise', override_tier: 'critical', override_reason: '' }, consultant.session);
  assert.equal(res.status, 400);
  assert.match(res.text, /Give a reason for raising the tier/);
  res = await postScope(ws, tp, a, HIGH, { override_direction: 'raise', override_tier: 'medium', override_reason: 'Because' }, consultant.session);
  assert.equal(res.status, 400);
  assert.match(res.text, /Raising means a tier above the scored High/);

  res = await postScope(ws, tp, a, HIGH, { override_direction: 'lower', override_tier: 'low', override_reason: 'Small spend' }, consultant.session);
  assert.equal(res.status, 403);
  assert.match(res.text, /Only a manager can lower a tier/);
  res = await postScope(ws, tp, a, HIGH, { override_direction: 'lower', override_tier: 'low', override_reason: 'Small spend' }, senior.session);
  assert.equal(res.status, 403, 'a senior consultant cannot lower either');
  const row = await assessmentRow(a);
  for (const user of [consultant, senior]) {
    await assert.rejects(at.propose(db, await actorFor(user, ws), tp, a, {
      services: await services(ws, tp), answers: HIGH, override_direction: 'lower', override_tier: 'low',
      override_reason: 'Small spend', row_version: row.row_version,
    }), err => err.status === 403 && /Only a manager can lower/.test(err.message), `the domain refuses ${user.email}`);
  }
  assert.equal((await assessmentRow(a)).status, 'scoping');

  res = await postScope(ws, tp, a, HIGH, { override_direction: 'lower', override_tier: 'medium', override_reason: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Give a reason for lowering the tier/);
  await propose(ws, tp, a, HIGH, { override_direction: 'lower', override_tier: 'medium', override_reason: 'Only test data is shared' });
  let stored = await assessmentRow(a);
  assert.equal(stored.scored_tier, 'high');
  assert.equal(stored.final_tier, 'medium');
  assert.equal(stored.override_direction, 'lower');
  assert.equal(stored.override_reason, 'Only test data is shared');

  const tp2 = await addThirdParty(ws, { name: 'Raised Co', status: 'proposed' });
  const a2 = await start(ws, tp2, consultant.session);
  await propose(ws, tp2, a2, LOW, { override_direction: 'raise', override_tier: 'high', override_reason: 'Board asked for it' }, consultant.session);
  stored = await assessmentRow(a2);
  assert.equal(stored.final_tier, 'high');
  assert.equal(stored.override_direction, 'raise');
  assert.equal(stored.client_designation_used, false);

  const tp3 = await addThirdParty(ws, { name: 'Designated Co', status: 'proposed' });
  const a3 = await start(ws, tp3, consultant.session);
  const page = await allSteps(consultant.session, aBase(ws, tp3, a3));
  assert.match(page.text, /data-tprm-designation-reason[^>]*>Client designates as Critical/);
  await propose(ws, tp3, a3, HIGH, { override_preset: 'client_designation' }, consultant.session);
  stored = await assessmentRow(a3);
  assert.equal(stored.final_tier, 'critical');
  assert.equal(stored.override_direction, 'raise');
  assert.equal(stored.override_reason, 'Client designates as Critical');
  assert.equal(stored.client_designation_used, true);

  await assert.rejects(db.prepare(`UPDATE tp_assessments SET override_reason=NULL WHERE id=?`).run(a3), /tp_assessments_override_reason/);
});

test('the proposer cannot confirm without a self-approval reason; a second person with tp.review confirms and the third party takes the tier', async () => {
  const ws = await tprmClient('Confirmation Client');
  const tp = await addThirdParty(ws, { client_label: 'Gold', last_assessment_date: '2026-01-10' });
  const before = await tpRow(tp);
  const a = await start(ws, tp);
  await propose(ws, tp, a, HIGH);

  const page = await allSteps(client, aBase(ws, tp, a));
  assert.match(page.text, /You proposed this tier/);
  assert.doesNotMatch(page.text, /data-tprm-confirm-form/);
  assert.match(page.text, /data-tprm-self-confirm-form/);
  let res = await confirm(ws, tp, a, client);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(String(res.location).replace(/\+/g, ' ')), /Give the self-approval reason/);
  await assert.rejects(at.confirm(db, await actorFor(manager(), ws), tp, a, { row_version: (await assessmentRow(a)).row_version }),
    err => err.status === 400, 'the domain refuses the proposer without a reason too');
  res = await confirm(ws, tp, a, consultant.session);
  assert.equal(res.status, 403);
  await assert.rejects(at.confirm(db, await actorFor(consultant, ws), tp, a, { row_version: (await assessmentRow(a)).row_version }),
    err => err.status === 403);
  assert.equal((await assessmentRow(a)).status, 'tier_proposed');

  const reviewerPage = await allSteps(senior.session, aBase(ws, tp, a));
  assert.match(reviewerPage.text, /data-tprm-confirm-form/);
  res = await confirm(ws, tp, a, senior.session);
  assert.equal(res.status, 302);
  const row = await assessmentRow(a);
  assert.equal(row.status, 'tier_confirmed');
  assert.equal(Number(row.confirmed_by), senior.id);
  assert.ok(row.confirmed_at);
  const after = await tpRow(tp);
  assert.equal(after.current_tier, 'high');
  assert.equal(after.tier_source, 'assessed');
  assert.equal(after.next_due_date, before.next_due_date, 'the next due date waits for the client decision (slice 6)');
  assert.equal(after.row_version, before.row_version + 1);

  const register = await client.get(`/tprm/clients/${ws}`);
  assert.match(register.text, new RegExp(`data-tprm-row="${tp}"[\\s\\S]*?High[\\s\\S]*?</tr>`));
  const detail = await client.get(`/tprm/clients/${ws}/third-parties/${tp}`);
  assert.match(detail.text, /High <span class="meta text-xs">Assessed<\/span>/);
  assert.match(detail.text, /Assessed tier confirmed/);

  await assert.rejects(db.prepare('UPDATE tp_assessments SET confirmed_by=proposed_by WHERE id=?').run(a), /tp_assessments_maker_checker/);
});

const toastOf = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));

async function setTwoPerson(values, session = client) {
  const row = await db.prepare('SELECT row_version FROM tp_firm_settings WHERE firm_id=?').get(firmId);
  const body = { row_version: String(row ? row.row_version : 0) };
  if (values.tiers) body.self_approve_tiers = '1';
  if (values.recommendations) body.self_issue_recommendations = '1';
  return await session.post('/tprm/settings/two-person', body);
}

test('self-approval of a tier: a manager with a reason while the firm allows it; consultants and seniors never; off means two people', async () => {
  const settingsPage = await client.get('/tprm/settings/two-person');
  assert.equal(settingsPage.status, 200);
  assert.match(settingsPage.text, /name="self_approve_tiers" value="1" checked/);
  assert.match(settingsPage.text, /name="self_issue_recommendations" value="1"  data-tprm-self-issue-recommendations/, 'issuing your own is off by default');
  assert.equal((await senior.session.get('/tprm/settings/two-person')).status, 403);
  assert.equal((await consultant.session.post('/tprm/settings/two-person', { self_approve_tiers: '1', row_version: '0' })).status, 403);

  const ws = await tprmClient('Self Approval Client');
  const tp = await addThirdParty(ws, { name: 'Self Approved Co' });
  const a = await start(ws, tp);
  await propose(ws, tp, a, HIGH);
  const reason = 'Small engagement: no second reviewer on the team this week';
  const res = await client.post(`${aBase(ws, tp, a)}/confirm`, { self_approval_reason: reason, row_version: String((await assessmentRow(a)).row_version) });
  assert.equal(res.status, 302, toastOf(res));
  assert.match(toastOf(res), /self-approved/);
  const row = await assessmentRow(a);
  assert.deepEqual([row.status, Number(row.confirmed_by), Number(row.proposed_by), row.self_approval_reason], ['tier_confirmed', managerId, managerId, reason]);
  const ev = (await db.prepare(`SELECT after_state FROM tp_events WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? AND action='assessment.tier_confirmed'`).get(ws, a)).after_state;
  assert.deepEqual([ev.self_approved, ev.self_approval_reason, ev.setting], [true, reason, { managers_self_approve_tiers: true }]);
  const page = await allSteps(client, aBase(ws, tp, a));
  assert.match(page.text, /data-tprm-history-self-approved[^>]*>[^<]*Self-approved by [^:]+: Small engagement/);
  assert.match(page.text, /data-tprm-self-approved>Self-approved by/);
  const queue = await senior.session.get('/tprm/review');
  assert.match(queue.text, new RegExp(`data-tprm-review-self-approved-item="${a}"[\\s\\S]*?Self-approved by [^:]+: Small engagement`));
  await assert.rejects(db.prepare('UPDATE tp_assessments SET self_approval_reason = ? WHERE id = ?').run('later', a), /never changes/);

  const tp2 = await addThirdParty(ws, { name: 'Senior Own Co' });
  const a2 = await start(ws, tp2, senior.session);
  await propose(ws, tp2, a2, HIGH, {}, senior.session);
  const s2 = await senior.session.post(`${aBase(ws, tp2, a2)}/confirm`, { self_approval_reason: 'x', row_version: String((await assessmentRow(a2)).row_version) });
  assert.equal(s2.status, 403);
  assert.match(s2.text, /You proposed this tier, so a second person must confirm it/);
  assert.doesNotMatch((await allSteps(senior.session, aBase(ws, tp2, a2))).text, /data-tprm-self-confirm-form/);
  await assert.rejects(db.prepare(`UPDATE tp_assessments SET status = 'tier_confirmed', confirmed_by = proposed_by, confirmed_at = now(),
    self_approval_reason = 'x' WHERE id = ?`).run(a2), /only as a manager of the firm/, 'the database refuses a non-manager');
  const tp3 = await addThirdParty(ws, { name: 'Manager Own Co' });
  const a3 = await start(ws, tp3);
  await propose(ws, tp3, a3, HIGH);
  assert.match((await client.get('/tprm/review')).text, new RegExp(`data-tprm-review-item="${a3}"[\\s\\S]*?data-tprm-review-own`));

  const off = await setTwoPerson({ tiers: false });
  assert.equal(off.status, 302);
  assert.match(toastOf(off), /Two-person rules saved/);
  const audit = await db.prepare(`SELECT details FROM audit_log WHERE action='tprm_two_person_rules_changed' ORDER BY id DESC LIMIT 1`).get();
  assert.match(String(audit.details), /"managers_self_approve_tiers":false/);
  assert.equal((await client.post('/tprm/settings/two-person', { row_version: '1' }, { csrf: false })).status, 403, 'CSRF');
  const offPage = await allSteps(client, aBase(ws, tp3, a3));
  assert.doesNotMatch(offPage.text, /data-tprm-self-confirm-form/);
  assert.doesNotMatch((await client.get('/tprm/review')).text, new RegExp(`data-tprm-review-item="${a3}"`));
  const refused = await client.post(`${aBase(ws, tp3, a3)}/confirm`, { self_approval_reason: reason, row_version: String((await assessmentRow(a3)).row_version) });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /does not let managers self-approve tiers/);
  await assert.rejects(db.prepare(`UPDATE tp_assessments SET status = 'tier_confirmed', confirmed_by = proposed_by, confirmed_at = now(),
    self_approval_reason = 'x' WHERE id = ?`).run(a3), /when the firm allows managers to self-approve/);
  assert.equal((await assessmentRow(a3)).status, 'tier_proposed');
  await db.prepare('UPDATE tp_assessments SET updated_at = now() WHERE id = ?').run(a);
  assert.equal((await setTwoPerson({ tiers: true })).status, 302);
  assert.equal((await confirm(ws, tp3, a3, senior.session)).status, 302);
  assert.equal((await assessmentRow(a3)).self_approval_reason, null);
});

test('a reviewer sends a proposed tier back with a comment; the consultant changes it and proposes again', async () => {
  const ws = await tprmClient('Send Back Client');
  const tp = await addThirdParty(ws);
  const a = await start(ws, tp, consultant.session);
  await propose(ws, tp, a, LOW, {}, consultant.session);

  let res = await senior.session.post(`${aBase(ws, tp, a)}/return`, { row_version: String((await assessmentRow(a)).row_version), comment: ' ' });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.location), /Say what needs to change/);
  assert.equal((await assessmentRow(a)).status, 'tier_proposed');
  res = await consultant.session.post(`${aBase(ws, tp, a)}/return`, { row_version: String((await assessmentRow(a)).row_version), comment: 'x' });
  assert.equal(res.status, 403, 'a consultant cannot send back');
  res = await senior.session.post(`${aBase(ws, tp, a)}/return`, { row_version: String((await assessmentRow(a)).row_version), comment: 'Payroll data is personal data' });
  assert.equal(res.status, 302);
  let row = await assessmentRow(a);
  assert.equal(row.status, 'scoping');
  assert.equal(row.return_comment, 'Payroll data is personal data');
  assert.equal(row.proposed_by, null);
  const page = await allSteps(consultant.session, aBase(ws, tp, a));
  assert.match(page.text, /data-tprm-returned/);
  assert.match(page.text, /Payroll data is personal data/);

  await propose(ws, tp, a, { ...LOW, data_handled: 'personal' }, {}, consultant.session);
  res = await confirm(ws, tp, a, senior.session);
  assert.equal(res.status, 302);
  row = await assessmentRow(a);
  assert.equal(row.final_tier, 'high');
  assert.equal(row.status, 'tier_confirmed');
});

test('the client designation prompt: required on a reassessment that scores below the client\'s Critical, and recorded', async () => {
  const ws = await tprmClient('Designation Client');
  const flagged = await addThirdParty(ws, { name: 'Flagged Co', client_designated_critical: '1' });
  assert.equal((await tpRow(flagged)).current_tier, 'critical', 'provisionally Critical from the designation');
  const a = await start(ws, flagged);
  const page = await allSteps(client, aBase(ws, flagged, a));
  assert.match(page.text, /data-tprm-designation/);

  let res = await postScope(ws, flagged, a, HIGH);
  assert.equal(res.status, 400);
  assert.match(res.text, /The client designates this third party as Critical but the answers score High/);
  assert.equal((await assessmentRow(a)).status, 'scoping', 'never proposed without the choice');

  await propose(ws, flagged, a, HIGH, { designation_choice: 'keep_client_designation' });
  let row = await assessmentRow(a);
  assert.equal(row.client_designation_choice, 'keep_client_designation');
  assert.equal(row.scored_tier, 'high');
  assert.equal(row.final_tier, 'critical');
  assert.equal(row.override_direction, 'raise');
  assert.equal(row.override_reason, 'Client designates as Critical');
  assert.equal(row.client_designation_used, true);
  const proposedEvent = await db.prepare(`SELECT after_state FROM tp_events WHERE chain_type='assessment' AND chain_id=? AND action='assessment.tier_proposed'`).get(a);
  assert.equal(proposedEvent.after_state.client_designation_choice, 'keep_client_designation');

  await db.prepare(`UPDATE tp_client_settings SET label_tier_map='{"Tier 1":"critical"}'::jsonb WHERE workspace_id=?`).run(ws);
  const labelled = await addThirdParty(ws, { name: 'Labelled Co', client_label: 'tier 1' });
  const b = await start(ws, labelled);
  res = await postScope(ws, labelled, b, LOW);
  assert.equal(res.status, 400);
  assert.match(res.text, /Choose to keep the client(?:'|&#39;)s designation \(Critical\) or use the scored tier before proposing/);
  await propose(ws, labelled, b, LOW, { designation_choice: 'use_scored_tier' });
  row = await assessmentRow(b);
  assert.equal(row.client_designation_choice, 'use_scored_tier');
  assert.equal(row.final_tier, 'low');
  assert.equal(row.override_direction, 'none');
  assert.equal(row.client_designation_used, false);

  const both = await addThirdParty(ws, { name: 'Both Co', client_designated_critical: '1' });
  const c = await start(ws, both);
  res = await postScope(ws, both, c, LOW, { designation_choice: 'keep_client_designation', override_direction: 'raise', override_tier: 'high', override_reason: 'x' });
  assert.equal(res.status, 400);
  assert.match(res.text, /cannot be overridden as well/);

  const critical = await addThirdParty(ws, { name: 'Critical Co', client_designated_critical: '1' });
  const d = await start(ws, critical);
  await propose(ws, critical, d, CRITICAL);
  assert.equal((await assessmentRow(d)).client_designation_choice, null);
  const onboarding = await addThirdParty(ws, { name: 'New Co', status: 'proposed', client_designated_critical: '1' });
  const e = await start(ws, onboarding);
  await propose(ws, onboarding, e, LOW);
  assert.equal((await assessmentRow(e)).final_tier, 'low');
});

test('every state change writes an event in the assessment chain, and the vendor change in the third party chain', async () => {
  const ws = await tprmClient('Assessment Events Client');
  const tp = await addThirdParty(ws);
  const a = await start(ws, tp, consultant.session);
  const save = await postScope(ws, tp, a, { data_handled: 'internal' }, { intent: 'save' }, consultant.session);
  assert.equal(save.status, 302);
  await propose(ws, tp, a, HIGH, {}, consultant.session);
  await senior.session.post(`${aBase(ws, tp, a)}/return`, { row_version: String((await assessmentRow(a)).row_version), comment: 'Check access' });
  await propose(ws, tp, a, { ...HIGH, system_access: 'privileged' }, {}, consultant.session);
  assert.equal((await confirm(ws, tp, a, senior.session)).status, 302);
  const due = await client.post(`${aBase(ws, tp, a)}/details`, { row_version: String((await assessmentRow(a)).row_version), due_date: '2026-12-31' });
  assert.equal(due.status, 302);

  const chain = await db.prepare(`SELECT action, actor_user_id, third_party_id, after_state FROM tp_events
    WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? AND action NOT LIKE 'message.%' ORDER BY chain_seq`).all(ws, a);
  assert.deepEqual(chain.map(e => e.action), ['assessment.started', 'assessment.scope_saved', 'assessment.tier_proposed',
    'assessment.tier_returned', 'assessment.tier_proposed', 'assessment.tier_confirmed', 'assessment.details_updated']);
  assert.ok(chain.every(e => Number(e.third_party_id) === tp));
  assert.equal(Number(chain[5].actor_user_id), senior.id);
  assert.equal(chain[0].after_state.criticality_model_version, (await assessmentRow(a)).criticality_model_version);
  const vendor = await db.prepare(`SELECT action, before_state, after_state FROM tp_events
    WHERE workspace_id=? AND chain_type='third_party' AND chain_id=? ORDER BY chain_seq`).all(ws, tp);
  assert.deepEqual(vendor.map(e => e.action), ['third_party.created', 'service.added', 'third_party.tier_assessed']);
  assert.deepEqual(vendor[2].after_state, { current_tier: 'high', tier_source: 'assessed', assessment_id: a, assessment_type: 'reassessment' });
  assert.deepEqual(await events.verifyChains(db, ws), []);
  assert.equal((await assessmentRow(a)).due_date, '2026-12-31');
});

test('isolation: another client, another firm and client users never reach an assessment', async () => {
  const ws = await tprmClient('Isolation Client');
  const otherWs = await tprmClient('Isolation Other Client');
  const tp = await addThirdParty(ws, { name: 'Hidden Assessment Co' });
  const otherTp = await addThirdParty(otherWs, { name: 'Other Client Co' });
  const a = await start(ws, tp);

  for (const path of [`/tprm/clients/${otherWs}/third-parties/${tp}/assessments/${a}`, `/tprm/clients/${otherWs}/third-parties/${otherTp}/assessments/${a}`]) {
    assert.equal((await client.get(path)).status, 404, path);
  }
  assert.equal((await client.post(`/tprm/clients/${otherWs}/third-parties/${tp}/assessments`, {})).status, 404);
  await assert.rejects(at.getAssessment(db, await actorFor(manager(), otherWs), otherTp, a), err => err.status === 404);

  const otherFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Assessment Other Firm')").run()).lastInsertRowid);
  const outsider = await makeUser('assess-other-firm@test.local', { role: 'manager', firm: otherFirm });
  const outsiderSession = await signIn(outsider.email, outsider.password);
  try {
    assert.equal((await allSteps(outsiderSession, aBase(ws, tp, a))).status, 404);
    assert.equal((await outsiderSession.post(`${aBase(ws, tp, a)}/scope`, scopeBody(LOW, { intent: 'save', row_version: '1' }))).status, 404);
    const queue = await outsiderSession.get('/tprm/review');
    assert.doesNotMatch(queue.text, /Hidden Assessment Co/);
  } finally {
    await outsiderSession.close();
  }

  const owner = await makeUser('assess-client-owner@test.local', { type: 'client', workspaceId: ws, memberRole: 'client_owner' });
  const ownerSession = await signIn(owner.email, owner.password);
  try {
    assert.equal((await allSteps(ownerSession, aBase(ws, tp, a))).status, 404);
    assert.doesNotMatch((await allSteps(ownerSession, aBase(ws, tp, a))).text, /Hidden Assessment Co/);
    assert.equal((await ownerSession.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {})).status, 404);
    assert.equal((await ownerSession.post(`${aBase(ws, tp, a)}/confirm`, { row_version: '1' })).status, 404);
    assert.equal((await ownerSession.get('/tprm/review')).status, 403);
  } finally {
    await ownerSession.close();
  }
  assert.equal((await assessmentRow(a)).row_version, 1, 'nothing changed');

  const unassigned = await makeUser('assess-unassigned@test.local', { role: 'consultant' });
  const unassignedSession = await signIn(unassigned.email, unassigned.password);
  try {
    assert.equal((await allSteps(unassignedSession, aBase(ws, tp, a))).status, 404);
  } finally {
    await unassignedSession.close();
  }
});

test('a stale row_version is refused with 409 and nothing changes', async () => {
  const ws = await tprmClient('Stale Assessment Client');
  const tp = await addThirdParty(ws);
  const a = await start(ws, tp, consultant.session);
  const stale = '1';
  assert.equal((await postScope(ws, tp, a, LOW, { intent: 'save' }, consultant.session)).status, 302);
  let res = await consultant.session.post(`${aBase(ws, tp, a)}/scope`, scopeBody(HIGH, { services: await services(ws, tp), intent: 'propose', row_version: stale }));
  assert.equal(res.status, 409);
  assert.match(res.text, /Someone else changed this assessment/);
  assert.equal((await assessmentRow(a)).status, 'scoping');
  await propose(ws, tp, a, HIGH, {}, consultant.session);
  res = await senior.session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: stale });
  assert.equal(res.status, 409);
  assert.equal((await assessmentRow(a)).status, 'tier_proposed');
  res = await client.post(`${aBase(ws, tp, a)}/details`, { row_version: stale, due_date: '2027-01-01' });
  assert.equal(res.status, 409);
  res = await client.post(`${aBase(ws, tp, a)}/cancel`, { row_version: stale, reason: 'x' });
  assert.equal(res.status, 409);
  assert.notEqual((await tpRow(tp)).tier_source, 'assessed', 'the third party was not touched');
});

test('CSRF is required on every assessment form', async () => {
  const ws = await tprmClient('Assessment CSRF Client');
  const tp = await addThirdParty(ws);
  const a = await start(ws, tp);
  const forged = { _csrf: 'f'.repeat(64), row_version: '1' };
  for (const path of [`/tprm/clients/${ws}/third-parties/${tp}/assessments`, `${aBase(ws, tp, a)}/scope`, `${aBase(ws, tp, a)}/confirm`,
    `${aBase(ws, tp, a)}/return`, `${aBase(ws, tp, a)}/cancel`, `${aBase(ws, tp, a)}/details`]) {
    assert.equal((await client.post(path, { row_version: '1' }, { csrf: false })).status, 403, `${path} without a token`);
    assert.equal((await client.post(path, { ...forged }, { csrf: false })).status, 403, `${path} with a forged token`);
  }
  const page = await allSteps(client, aBase(ws, tp, a));
  assert.match(page.text, /data-tprm-scope-form[\s\S]*?name="_csrf" value="[a-f0-9]+"/);
  assert.equal((await assessmentRow(a)).row_version, 1);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_assessments WHERE third_party_id=?').get(tp)).c, 1);
});

test('the client decision owner must be a client owner or ISMS manager of this client', async () => {
  const ws = await tprmClient('Decision Owner Client');
  const otherWs = await tprmClient('Decision Owner Other Client');
  const tp = await addThirdParty(ws);
  const a = await start(ws, tp);
  const owner = await makeUser('assess-owner@test.local', { type: 'client', workspaceId: ws, memberRole: 'client_owner' });
  const coordinator = await makeUser('assess-coordinator@test.local', { type: 'client', workspaceId: ws, memberRole: 'isms_manager' });
  const contributor = await makeUser('assess-contributor@test.local', { type: 'client', workspaceId: ws, memberRole: 'contributor' });
  const elsewhere = await makeUser('assess-elsewhere@test.local', { type: 'client', workspaceId: otherWs, memberRole: 'client_owner' });

  const page = await allSteps(client, aBase(ws, tp, a));
  assert.match(page.text, new RegExp(`<option value="${owner.id}"`));
  assert.match(page.text, new RegExp(`<option value="${coordinator.id}"`));
  assert.doesNotMatch(page.text, new RegExp(`<option value="${contributor.id}"`));
  for (const bad of [contributor.id, elsewhere.id, consultant.id]) {
    const res = await client.post(`${aBase(ws, tp, a)}/details`, { row_version: String((await assessmentRow(a)).row_version), client_decision_owner_id: String(bad) });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.location), /must be a client owner or ISMS manager of this client/);
  }
  assert.equal((await assessmentRow(a)).client_decision_owner_id, null);
  for (const good of [coordinator, owner]) {
    const res = await client.post(`${aBase(ws, tp, a)}/details`, { row_version: String((await assessmentRow(a)).row_version), client_decision_owner_id: String(good.id) });
    assert.equal(res.status, 302);
    assert.equal(Number((await assessmentRow(a)).client_decision_owner_id), good.id);
  }
  await assert.rejects(db.prepare('UPDATE tp_assessments SET client_decision_owner_id=? WHERE id=?').run(contributor.id, a),
    /client decision owner must be a client owner or ISMS manager/, 'the database refuses a contributor');
});

test('the review queue lists proposed tiers across reachable clients; a reviewer\'s own only for a manager who may self-approve', async () => {
  const wsA = await tprmClient('Queue Client A');
  const wsB = await tprmClient('Queue Client B');
  const tpA = await addThirdParty(wsA, { name: 'Queue Alpha Co' });
  const tpB = await addThirdParty(wsB, { name: 'Queue Beta Co' });
  const tpC = await addThirdParty(wsB, { name: 'Queue Gamma Co' });
  const tpD = await addThirdParty(wsB, { name: 'Queue Scoping Co' });
  const a = await start(wsA, tpA, consultant.session);
  await propose(wsA, tpA, a, LOW, {}, consultant.session);
  const b = await start(wsB, tpB);
  await propose(wsB, tpB, b, HIGH);
  const c = await start(wsB, tpC, senior.session);
  await propose(wsB, tpC, c, CRITICAL, {}, senior.session);
  await start(wsB, tpD);
  const offWs = await tprmClient('Queue Off Client');
  const tpOff = await addThirdParty(offWs, { name: 'Queue Off Co' });
  const off = await start(offWs, tpOff);
  await propose(offWs, tpOff, off, LOW);
  await db.prepare('UPDATE tp_client_settings SET enabled=false WHERE workspace_id=?').run(offWs);

  let page = await senior.session.get('/tprm/review');
  assert.equal(page.status, 200);
  assert.match(page.text, /Queue Alpha Co/);
  assert.match(page.text, /Queue Beta Co/);
  assert.doesNotMatch(page.text, /Queue Gamma Co/, 'the senior proposed it, so it is not in their queue');
  assert.doesNotMatch(page.text, /Queue Scoping Co/, 'not proposed yet');
  assert.doesNotMatch(page.text, /Queue Off Co/);
  page = await client.get('/tprm/review');
  assert.match(page.text, /Queue Gamma Co/);
  assert.match(page.text, new RegExp(`data-tprm-review-item="${b}"[\\s\\S]*?data-tprm-review-own`), 'the manager proposed Beta');
  assert.equal((await setTwoPerson({ tiers: false })).status, 302);
  assert.doesNotMatch((await client.get('/tprm/review')).text, /Queue Beta Co/, 'not listed while managers may not self-approve');
  assert.equal((await setTwoPerson({ tiers: true })).status, 302);
  assert.match((await client.get('/tprm')).text, /data-tprm-review-link>Review queue \(\d+\)/);

  const unassigned = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, 'Queue Unassigned Client')).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(unassigned);
  const tpU = await addThirdParty(unassigned, { name: 'Queue Unassigned Co' });
  const u = await start(unassigned, tpU);
  await propose(unassigned, tpU, u, LOW);
  page = await consultant.session.get('/tprm/review');
  assert.equal(page.status, 200, 'consultants open the review queue');
  assert.match(page.text, /data-tprm-review-readonly/);
  assert.match(page.text, /Tiers waiting for confirmation/);
  for (const name of ['Queue Alpha Co', 'Queue Beta Co', 'Queue Gamma Co']) assert.match(page.text, new RegExp(name));
  assert.doesNotMatch(page.text, /Queue Scoping Co|Queue Off Co/);
  assert.doesNotMatch(page.text, /Queue Unassigned Co/, 'a client the consultant is not assigned to');
  assert.doesNotMatch(page.text, /data-tprm-review-information/, 'no information-request list for consultants');
  assert.match((await consultant.session.get('/tprm')).text, /data-tprm-review-link>Review queue \(\d+\)/);
  assert.equal((await confirm(wsB, tpB, b, consultant.session)).status, 403, 'a consultant cannot confirm a tier');

  assert.equal((await confirm(wsA, tpA, a, senior.session)).status, 302);
  page = await senior.session.get('/tprm/review');
  assert.doesNotMatch(page.text, /Queue Alpha Co/, 'a confirmed tier leaves the queue');
  const queue = await at.reviewQueue({ db, getWorkspace: null, permissionsFor: null, listWorkspaces: null }, { user_type: 'client' });
  assert.deepEqual(queue, [], 'client users get no queue from the domain');
});

test('switching TPRM off is refused for a client with no ISO programme', async () => {
  const ws = await tprmClient('TPRM Only Switch Client', { frameworks: [] });
  const settings = await client.get(`/tprm/clients/${ws}/settings`);
  assert.equal(settings.status, 200);
  assert.match(settings.text, /data-tprm-switch-off-no-iso/);
  assert.doesNotMatch(settings.text, new RegExp(`action="/tprm/clients/${ws}/disable"`));
  const res = await client.post(`/tprm/clients/${ws}/disable`, {});
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.location), /it has no ISO programme, so it would be left with no service/);
  assert.equal((await db.prepare('SELECT enabled FROM tp_client_settings WHERE workspace_id=?').get(ws)).enabled, true);
  await assert.rejects(require('../lib/tprm/settings').switchOff(db, await actorFor(manager(), ws)), err => err.status === 409 && err.noIsoProgramme);

  const iso = await tprmClient('ISO And TPRM Switch Client', { frameworks: ['iso27001'] });
  assert.equal((await client.post(`/tprm/clients/${iso}/disable`, {})).status, 302);
  assert.equal((await db.prepare('SELECT enabled FROM tp_client_settings WHERE workspace_id=?').get(iso)).enabled, false);
});

test('deleting a firm or a workspace removes its assessments with their events', async () => {
  const doomedFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Assessment Doomed Firm')").run()).lastInsertRowid);
  const ws = await tprmClient('Assessment Doomed Firm Client', { firm: doomedFirm });
  const tp = Number((await db.prepare("INSERT INTO tp_third_parties (workspace_id, name, status) VALUES (?, 'Doomed Co', 'in_use')").run(ws)).lastInsertRowid);
  const lead = await makeUser('assess-doomed-manager@test.local', { role: 'manager', firm: doomedFirm });
  const assessment = await at.start(db, await actorFor(lead, ws), tp);
  assert.equal(assessment.type, 'reassessment');
  await require('../lib/workspace-deletion').deleteFirm(db, doomedFirm);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_assessments WHERE firm_id=?').get(doomedFirm)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_events WHERE workspace_id=?').get(ws)).c, 0);

  const ws2 = await tprmClient('Assessment Deleted Client');
  const tp2 = await addThirdParty(ws2);
  const a2 = await start(ws2, tp2);
  await propose(ws2, tp2, a2, LOW);
  const deleted = await client.post(`/workspaces/${ws2}/delete`, { confirm_name: 'Assessment Deleted Client' });
  assert.equal(deleted.status, 302);
  assert.match(deleted.location, /^\/dashboard\?/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_assessments WHERE workspace_id=?').get(ws2)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_events WHERE workspace_id=?').get(ws2)).c, 0);
  const restoreCheck = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'restore-check.js'), 'utf8');
  assert.match(restoreCheck.slice(restoreCheck.indexOf('SNAPSHOT_COUNT_TABLES'), restoreCheck.indexOf('LIVE_COUNT_MIN_RATIO')), /'tp_assessments'/,
    'backup verification counts assessments');
});

test('a model change after an assessment started does not change that assessment\'s tier', async () => {
  const crit = require('../lib/tprm/criticality');
  const ws = await tprmClient('Model Change Client');
  const scopingTp = await addThirdParty(ws, { name: 'Scoping Co' });
  const confirmedTp = await addThirdParty(ws, { name: 'Confirmed Co' });
  const scoping = await start(ws, scopingTp);
  const confirmed = await start(ws, confirmedTp);
  await propose(ws, confirmedTp, confirmed, LOW);
  assert.equal((await confirm(ws, confirmedTp, confirmed, senior.session)).status, 302);
  const oldVersion = (await assessmentRow(scoping)).criticality_model_version;

  const user = { id: managerId, user_type: 'firm', firm_id: firmId, firm_role: 'manager' };
  const { model: draft } = await crit.createDraft(db, user);
  const questions = JSON.parse(JSON.stringify(draft.questions));
  questions.find(q => q.id === 'data_handled').answers.find(x => x.id === 'none').tier = 'High';
  const saved = await crit.saveDraft(db, user, draft.id, { questions, intervals: draft.intervals, rowVersion: draft.rowVersion });
  await crit.activateDraft(db, user, saved.id, { rowVersion: saved.rowVersion });

  const page = await allSteps(client, aBase(ws, scopingTp, scoping));
  assert.match(page.text, /the firm has activated a newer version; this assessment keeps the version it started under/);
  await propose(ws, scopingTp, scoping, LOW);
  let row = await assessmentRow(scoping);
  assert.equal(row.criticality_model_version, oldVersion, 'the assessment keeps its version');
  assert.equal(row.scored_tier, 'low', 'and is scored under it');
  assert.equal((await assessmentRow(confirmed)).final_tier, 'low', 'a confirmed tier is untouched');
  assert.equal((await tpRow(confirmedTp)).current_tier, 'low');

  const fresh = await addThirdParty(ws, { name: 'Fresh Co' });
  const next = await start(ws, fresh);
  row = await assessmentRow(next);
  assert.equal(row.criticality_model_version, saved.version, 'a new assessment uses the newly active version');
  await propose(ws, fresh, next, LOW);
  row = await assessmentRow(next);
  assert.equal(row.scored_tier, 'high');
  assert.equal(row.tier_explanation, 'High because: None');
});

test('the assessment page shows one step at a time (?step=) and the third-party page one tab (?tab=)', async () => {
  const ws = await tprmClient('Workspace Steps Client');
  const tp = await addThirdParty(ws, { name: 'Steps Co' });
  const a = await start(ws, tp);
  const shownSteps = html => [...html.matchAll(/data-tprm-step-panel="([a-z-]+)"(?! hidden)/g)].map(m => m[1]);
  const shownTabs = html => [...html.matchAll(/data-tprm-tab-panel="([a-z-]+)"(?! hidden)/g)].map(m => m[1]);

  let page = await client.get(aBase(ws, tp, a));
  assert.deepEqual(shownSteps(page.text), ['scope']);
  assert.match(page.text, /data-tprm-step="scope" data-tprm-step-state="active"/);
  assert.match(page.text, /data-tprm-assessment-status="scoping"/);
  page = await client.get(`${aBase(ws, tp, a)}?step=history`);
  assert.deepEqual(shownSteps(page.text), ['history']);
  assert.match(page.text, /data-tprm-step-panel="scope" hidden/);
  assert.doesNotMatch(page.text, /data-tprm-scope-form/, 'the scope step is not rendered when another step is shown');
  assert.match((await client.get(`${aBase(ws, tp, a)}?step=scope`)).text, /data-tprm-scope-form/);
  page = await client.get(`${aBase(ws, tp, a)}?step=nonsense`);
  assert.deepEqual(shownSteps(page.text), ['scope'], 'an unknown step falls back to the current one');

  await propose(ws, tp, a, LOW);
  assert.equal((await confirm(ws, tp, a, senior.session)).status, 302);
  page = await client.get(aBase(ws, tp, a));
  assert.deepEqual(shownSteps(page.text), ['questionnaire']);
  assert.match(page.text, /data-tprm-step="scope" data-tprm-step-state="done"/);
  assert.match(page.text, /data-tprm-assessment-status="tier_confirmed"/);

  const tpPage = `/tprm/clients/${ws}/third-parties/${tp}`;
  assert.deepEqual(shownTabs((await client.get(tpPage)).text), ['overview']);
  const services = await client.get(`${tpPage}?tab=services`);
  assert.deepEqual(shownTabs(services.text), ['services']);
  assert.match(services.text, /data-tprm-tab-panel="overview" hidden/);
  assert.deepEqual(shownTabs((await client.get(`${tpPage}?tab=nonsense`)).text), ['overview']);
});

test('the first assessment of a supplier in use is an Assessment, not a Reassessment; one after an earlier assessment is a Reassessment', async () => {
  const at = require('../lib/tprm/assessments');
  assert.equal(at.typeLabel('reassessment', { previous: false }), 'Assessment');
  assert.equal(at.typeLabel('reassessment', { previous: true }), 'Reassessment');
  assert.equal(at.typeLabel('onboarding'), 'Onboarding assessment');
  const ws = await tprmClient('First Assessment Client');
  const fresh = await addThirdParty(ws, { name: 'Northgate IT', client_designated_critical: '1' });
  const started = await client.post(`/tprm/clients/${ws}/third-parties/${fresh}/assessments`, {});
  assert.match(decodeURIComponent(started.location), /toast=Assessment started/);
  const a = idIn(started.location, /assessments\/(\d+)/);
  const party = await client.get(`/tprm/clients/${ws}/third-parties/${fresh}`);
  assert.match(party.text, /data-tprm-open-assessment>Continue assessment</);
  assert.doesNotMatch(party.text, /Reassessment in progress|Continue reassessment/);
  const scope = await client.get(`${aBase(ws, fresh, a)}?step=scope`);
  assert.match(scope.text, /hidden data-tprm-designation>/, 'no "the answers score it lower" before any answer');
  assert.equal(await at.isReassessment(db, await assessmentRow(a)), false);
  assert.equal((await at.typeLabelsFor(db, [{ id: a, type: 'reassessment' }])).get(a), 'Assessment');
  const hist = await client.get(`${aBase(ws, fresh, a)}?step=history`);
  assert.match(hist.text, /started the assessment/);
  assert.doesNotMatch(hist.text, /started the reassessment/);

  const lapsed = await addThirdParty(ws, { name: 'PayNimbus', last_assessment_date: '2024-01-15' });
  const b = await start(ws, lapsed);
  assert.equal(await at.isReassessment(db, await assessmentRow(b)), true, 'assessed before the app: a reassessment');
  const lapsedPage = await client.get(`/tprm/clients/${ws}/third-parties/${lapsed}`);
  assert.match(lapsedPage.text, /data-tprm-open-assessment>Continue reassessment</);
  const supplierLabel = await require('../lib/tprm/vendor-portal').reviewLabels(db, [{ id: a, type: 'reassessment' }, { id: b, type: 'reassessment' }]);
  assert.equal(supplierLabel({ id: a, type: 'reassessment' }), 'First review', 'the supplier sees a first review, not a periodic one');
  assert.equal(supplierLabel({ id: b, type: 'reassessment' }), 'Periodic review');
});
