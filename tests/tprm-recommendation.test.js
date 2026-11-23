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
let rec;
let events;
let rbac;
let consultant;
let senior;
let senior2;

const PASSWORD = 'recommendation-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };
const VALID_UNTIL = '2099-12-31';
const DUE = '2099-06-30';

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  rec = require('../lib/tprm/recommendations');
  events = require('../lib/tprm/events');
  rbac = require('../lib/rbac');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  const me = await db.prepare('SELECT id, firm_role FROM users WHERE email=?').get(env.login.email);
  managerId = me.id;
  assert.equal(rbac.normalizeRole(me.firm_role), 'manager', 'the default test login is a manager');
  consultant = await makeUser('rec-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('rec-senior@test.local', { role: 'senior_consultant' });
  senior2 = await makeUser('rec-senior2@test.local', { role: 'senior_consultant' });
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

async function tprmClient(name, { firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firm, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (firm === firmId) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, consultant.id, 'consultant');
  const owner = await makeUser(`rec-owner-${id}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
  owners.set(id, owner.id);
  return id;
}
const owners = new Map();
async function nameOwner(ws, a) {
  await db.prepare('UPDATE tp_assessments SET client_decision_owner_id=? WHERE workspace_id=? AND id=?').run(owners.get(Number(ws)), ws, a);
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const aBase = (ws, tp, a) => `/tprm/clients/${ws}/third-parties/${tp}/assessments/${a}`;
const rBase = (ws, tp, a) => `${aBase(ws, tp, a)}/recommendations`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const recRow = async id => db.prepare('SELECT *, valid_until::text AS valid_until FROM tp_recommendations WHERE id=?').get(id);
const recsOf = async a => db.prepare('SELECT *, valid_until::text AS valid_until FROM tp_recommendations WHERE assessment_id=? ORDER BY version').all(a);
const conditionsOf = async r => db.prepare('SELECT *, due_date::text AS due_date FROM tp_conditions WHERE recommendation_id=? ORDER BY position').all(r);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);

async function addThirdParty(ws, body = {}) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name: 'Acme', status: 'in_use', ...body });
  assert.equal(res.status, 302, `create redirects (got ${res.status})`);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Payroll processing' })).status, 302);
  return tp;
}

async function startAssessment(ws, tp, session = consultant.session) {
  const res = await session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(res.status, 302);
  const a = idIn(res.location, /assessments\/(\d+)/);
  await nameOwner(ws, a);
  return a;
}

async function proposeTier(ws, tp, a, session = consultant.session) {
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  const res = await session.post(`${aBase(ws, tp, a)}/scope`, body);
  assert.equal(res.status, 302);
  assert.equal((await assessmentRow(a)).status, 'tier_proposed');
}

async function confirmTier(ws, tp, a, session = senior.session) {
  const res = await session.post(`${aBase(ws, tp, a)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) });
  assert.equal(res.status, 302);
  assert.equal((await assessmentRow(a)).status, 'tier_confirmed');
}

async function confirmedAssessment(name, { status = 'in_use', ws = null } = {}) {
  const wsId = ws || await tprmClient(`${name} Client`);
  const tp = await addThirdParty(wsId, { name, status });
  const a = await startAssessment(wsId, tp);
  await proposeTier(wsId, tp, a);
  await confirmTier(wsId, tp, a);
  return { ws: wsId, tp, a };
}

async function createDraft({ ws, tp, a }, session = consultant.session) {
  const res = await session.post(rBase(ws, tp, a), { row_version: String((await assessmentRow(a)).row_version) });
  assert.equal(res.status, 302, `create redirects (got ${res.status}: ${res.text || ''})`);
  const rows = await recsOf(a);
  return Number(rows[rows.length - 1].id);
}

function draftBody(fields = {}, conditions = []) {
  const body = { outcome: 'approve_with_conditions', residual_rating: 'medium', rationale: 'Controls are adequate once MFA is enforced.',
    valid_until: VALID_UNTIL, ...fields };
  conditions.forEach((c, i) => {
    for (const [k, v] of Object.entries(c)) body[`conditions[${i}][${k}]`] = v;
  });
  return body;
}
const ONE_CONDITION = [{ description: 'Enforce MFA for all admin accounts', owner: 'vendor', due_date: DUE }];

async function save(ctx, rid, body, { intent = 'save', session = consultant.session } = {}) {
  return await session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}`, { ...body, intent, row_version: String((await recRow(rid)).row_version) });
}

async function submitted(ctx, rid, body = draftBody({}, ONE_CONDITION), session = consultant.session) {
  const res = await save(ctx, rid, body, { intent: 'submit', session });
  assert.equal(res.status, 302);
  assert.equal((await recRow(rid)).status, 'in_review', `submitted (${toast(res)})`);
}

async function issue(ctx, rid, session = senior.session, extra = {}) {
  return await session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: String((await recRow(rid)).row_version), ...extra });
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

test('a recommendation can only be drafted once the tier is confirmed', async () => {
  const ws = await tprmClient('Rec Gate Client');
  const tp = await addThirdParty(ws, { name: 'Gate Co' });
  const a = await startAssessment(ws, tp);
  const tryCreate = async () => consultant.session.post(rBase(ws, tp, a), { row_version: String((await assessmentRow(a)).row_version) });

  let page = await allSteps(consultant.session, aBase(ws, tp, a));
  assert.match(page.text, /data-tprm-rec-not-ready/);
  assert.doesNotMatch(page.text, /data-tprm-rec-create-form/);
  assert.equal((await tryCreate()).status, 409, 'not while scoping');
  await proposeTier(ws, tp, a);
  assert.equal((await tryCreate()).status, 409, 'not while the tier waits for confirmation');
  await assert.rejects(rec.createDraft(db, await actorFor(consultant, ws), tp, a, { row_version: (await assessmentRow(a)).row_version }),
    err => err.status === 409 && /tier must be confirmed/.test(err.message));
  await assert.rejects(db.prepare(`INSERT INTO tp_recommendations (workspace_id, assessment_id, version, author_id) VALUES (?,?,1,?)`)
    .run(ws, a, consultant.id), /needs an open assessment with a confirmed tier/, 'the database refuses too');
  assert.equal((await recsOf(a)).length, 0);

  await confirmTier(ws, tp, a);
  page = await allSteps(consultant.session, aBase(ws, tp, a));
  assert.match(page.text, /data-tprm-rec-create-form/);
  const rid = await createDraft({ ws, tp, a });
  const row = await recRow(rid);
  assert.equal(row.version, 1);
  assert.equal(row.status, 'draft');
  assert.equal(Number(row.author_id), consultant.id);
  assert.equal((await assessmentRow(a)).status, 'recommendation_draft');
  assert.equal((await tryCreate()).status, 409, 'one draft at a time');
  assert.equal((await recsOf(a)).length, 1);
});

test('outcome labels follow the assessment type', async () => {
  assert.equal(rec.outcomeLabel('onboarding', 'approve'), 'Onboard');
  assert.equal(rec.outcomeLabel('onboarding', 'approve_with_conditions'), 'Onboard with conditions');
  assert.equal(rec.outcomeLabel('onboarding', 'reject'), 'Do not onboard');
  assert.equal(rec.outcomeLabel('reassessment', 'approve'), 'Continue');
  assert.equal(rec.outcomeLabel('reassessment', 'approve_with_conditions'), 'Continue with conditions');
  assert.equal(rec.outcomeLabel('reassessment', 'reject'), 'Exit');

  const onboarding = await confirmedAssessment('Labels New Co', { status: 'proposed' });
  assert.equal((await assessmentRow(onboarding.a)).type, 'onboarding');
  await createDraft(onboarding);
  let page = await allSteps(consultant.session, aBase(onboarding.ws, onboarding.tp, onboarding.a));
  for (const label of ['Onboard', 'Onboard with conditions', 'Do not onboard']) assert.match(page.text, new RegExp(`<span>${label}</span>`));
  assert.doesNotMatch(page.text, /<span>Continue<\/span>|<span>Exit<\/span>/);

  const reassessment = await confirmedAssessment('Labels Old Co');
  const rid = await createDraft(reassessment);
  page = await allSteps(consultant.session, aBase(reassessment.ws, reassessment.tp, reassessment.a));
  for (const label of ['Continue', 'Continue with conditions', 'Exit']) assert.match(page.text, new RegExp(`<span>${label}</span>`));
  assert.doesNotMatch(page.text, /<span>Onboard<\/span>/);
  await submitted(reassessment, rid, draftBody({ outcome: 'reject' }));
  assert.equal((await issue(reassessment, rid)).status, 302);
  const issuedEvent = (await chain(reassessment.ws, reassessment.a)).find(e => e.action === 'recommendation.issued');
  assert.equal(issuedEvent.after_state.outcome, 'reject');
  assert.equal(issuedEvent.after_state.outcome_label, 'Exit');
  page = await allSteps(consultant.session, aBase(reassessment.ws, reassessment.tp, reassessment.a));
  assert.match(page.text, /data-tprm-rec-outcome[^>]*>(?:<[^>]+>)*Exit</);
});

test('conditions: required with conditions, forbidden otherwise, owner and due date before issue', async () => {
  const ctx = await confirmedAssessment('Conditions Co');
  const rid = await createDraft(ctx);

  let res = await save(ctx, rid, draftBody(), { intent: 'submit' });
  assert.equal(res.status, 302);
  assert.match(toast(res), /Draft saved but not submitted: Add at least one condition/);
  assert.equal((await recRow(rid)).status, 'draft');
  assert.equal((await recRow(rid)).outcome, 'approve_with_conditions', 'the draft was saved');

  res = await save(ctx, rid, draftBody({}, [{ description: 'Provide a SOC 2 report' }]), { intent: 'submit' });
  assert.match(toast(res), /Condition 1: choose who owns it/);
  assert.match(toast(res), /Condition 1: set a due date/);
  assert.equal((await conditionsOf(rid)).length, 1, 'an incomplete condition is kept on the draft');
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-problems[\s\S]*Condition 1: choose who owns it/);

  res = await save(ctx, rid, draftBody({ outcome: 'approve' }, ONE_CONDITION), { intent: 'submit' });
  assert.match(toast(res), /Remove the conditions/);
  assert.equal((await recRow(rid)).status, 'draft');

  const before = (await recRow(rid)).row_version;
  res = await save(ctx, rid, draftBody({}, [{ owner: 'client', due_date: DUE }]));
  assert.match(toast(res), /Condition 1: describe the condition/);
  assert.equal((await recRow(rid)).row_version, before);

  await db.prepare(`UPDATE tp_recommendations SET outcome='approve_with_conditions' WHERE id=?`).run(rid);
  await db.prepare('DELETE FROM tp_conditions WHERE recommendation_id=?').run(rid);
  await db.prepare(`UPDATE tp_recommendations SET status='in_review', submitted_at=now() WHERE id=?`).run(rid);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status='issued', reviewer_id=?, reviewed_at=now(), issued_at=now() WHERE id=?`)
    .run(senior.id, rid), /approve_with_conditions needs at least one condition/);
  await db.prepare(`UPDATE tp_recommendations SET status='changes_requested', reviewer_id=?, reviewed_at=now(), review_comment='x' WHERE id=?`).run(senior.id, rid);
  await db.prepare(`INSERT INTO tp_conditions (workspace_id, recommendation_id, description) VALUES (?,?,'No owner')`).run(ctx.ws, rid);
  await db.prepare(`UPDATE tp_recommendations SET status='in_review' WHERE id=?`).run(rid);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status='issued', reviewer_id=?, reviewed_at=now(), issued_at=now() WHERE id=?`)
    .run(senior.id, rid), /every condition needs an owner and a due date/);
  await db.prepare(`UPDATE tp_recommendations SET status='changes_requested' WHERE id=?`).run(rid);
  await db.prepare(`UPDATE tp_recommendations SET outcome='approve' WHERE id=?`).run(rid);
  await db.prepare(`UPDATE tp_conditions SET owner='client', due_date=? WHERE recommendation_id=?`).run(DUE, rid);
  await db.prepare(`UPDATE tp_recommendations SET status='in_review' WHERE id=?`).run(rid);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status='issued', reviewer_id=?, reviewed_at=now(), issued_at=now() WHERE id=?`)
    .run(senior.id, rid), /only approve_with_conditions carries conditions/);
  await assert.rejects(db.prepare(`INSERT INTO tp_conditions (workspace_id, recommendation_id, description) VALUES (?,?,'While in review')`).run(ctx.ws, rid),
    /conditions change only while their recommendation is a draft/);

  await db.prepare(`UPDATE tp_recommendations SET status='changes_requested' WHERE id=?`).run(rid);
  res = await save(ctx, rid, draftBody({}, [{ ...ONE_CONDITION[0] }, { description: 'No owner', remove: '1' }]), { intent: 'submit' });
  assert.equal((await recRow(rid)).status, 'in_review', toast(res));
  const conditions = await conditionsOf(rid);
  assert.deepEqual(conditions.map(c => [c.description, c.owner, c.due_date, c.status]),
    [['Enforce MFA for all admin accounts', 'vendor', DUE, 'open']]);
  assert.equal((await issue(ctx, rid)).status, 302);
  assert.equal((await recRow(rid)).status, 'issued');
});

test('the author never reviews: route, domain and database', async () => {
  const ctx = await confirmedAssessment('Maker Checker Co');
  const rid = await createDraft(ctx, client);
  await submitted(ctx, rid, draftBody({}, ONE_CONDITION), client);
  const page = await allSteps(client, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.doesNotMatch(page.text, /data-tprm-rec-issue-form/);
  assert.match(page.text, /You wrote this recommendation/);

  let res = await issue(ctx, rid, client);
  assert.equal(res.status, 403);
  assert.match(res.text, /You wrote this recommendation, so a second person must issue it/);
  res = await client.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/request-changes`, { row_version: String((await recRow(rid)).row_version), comment: 'Self review' });
  assert.equal(res.status, 403);
  await assert.rejects(rec.issue(db, await actorFor(manager(), ctx.ws), ctx.tp, ctx.a, rid, { row_version: (await recRow(rid)).row_version }),
    err => err.status === 403);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status='issued', reviewer_id=author_id, reviewed_at=now(), issued_at=now() WHERE id=?`).run(rid),
    /tp_recommendations_maker_checker/);
  assert.equal((await recRow(rid)).status, 'in_review');

  assert.equal((await issue(ctx, rid, consultant.session)).status, 403);
  res = await save(ctx, rid, draftBody({ rationale: 'Edited by someone else' }), { session: senior.session });
  assert.equal(res.status, 403);
  assert.match(res.text, /Only the author of this recommendation can edit it/);

  assert.equal((await issue(ctx, rid, senior.session)).status, 302);
  const row = await recRow(rid);
  assert.equal(row.status, 'issued');
  assert.equal(Number(row.reviewer_id), senior.id);
});

async function setTwoPerson(values) {
  const row = await db.prepare('SELECT row_version FROM tp_firm_settings WHERE firm_id=?').get(firmId);
  const body = { row_version: String(row ? row.row_version : 0) };
  if (values.tiers !== false) body.self_approve_tiers = '1';
  if (values.recommendations) body.self_issue_recommendations = '1';
  const res = await client.post('/tprm/settings/two-person', body);
  assert.equal(res.status, 302, toast(res));
  return res;
}

test('self-issue: off by default; when on, a manager author issues with a reason (firm-side only); consultants and seniors never', async () => {
  const ctx = await confirmedAssessment('Self Issue Co');
  await nameOwner(ctx.ws, ctx.a);
  const rid = await createDraft(ctx, client);
  await submitted(ctx, rid, draftBody({}, ONE_CONDITION), client);
  assert.doesNotMatch((await allSteps(client, aBase(ctx.ws, ctx.tp, ctx.a))).text, /data-tprm-rec-self-issue-form/);
  let res = await issue(ctx, rid, client, { self_issue_reason: 'Only manager on the account' });
  assert.equal(res.status, 403);
  assert.match(res.text, /does not let managers issue their own/);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status='issued', reviewer_id=author_id, reviewed_at=now(), issued_at=now(),
    self_issue_reason='x' WHERE id=?`).run(rid), /when the firm allows managers to issue their own/, 'the database reads the setting');

  await setTwoPerson({ recommendations: true });
  const audit = await db.prepare(`SELECT details FROM audit_log WHERE action='tprm_two_person_rules_changed' ORDER BY id DESC LIMIT 1`).get();
  assert.match(String(audit.details), /"managers_self_issue_recommendations":true/);
  try {
    const page = await allSteps(client, aBase(ctx.ws, ctx.tp, ctx.a));
    assert.match(page.text, /data-tprm-rec-self-issue-form/);
    assert.match((await client.get('/tprm/review')).text, new RegExp(`data-tprm-review-recommendation="${rid}"[\\s\\S]*?data-tprm-review-own-recommendation`));
    res = await issue(ctx, rid, client);
    assert.match(toast(res), /Give the self-issue reason/);
    assert.equal((await recRow(rid)).status, 'in_review');
    await assert.rejects(rec.issue(db, await actorFor(manager(), ctx.ws), ctx.tp, ctx.a, rid, { row_version: (await recRow(rid)).row_version }),
      err => err.status === 400, 'the domain wants the reason too');
    const reason = 'SENTINEL-SELF-ISSUE: the only manager on this engagement, reviewed with the partner';
    res = await issue(ctx, rid, client, { self_issue_reason: reason });
    assert.equal(res.status, 302, toast(res));
    const row = await recRow(rid);
    assert.deepEqual([row.status, Number(row.reviewer_id), Number(row.author_id), row.self_issue_reason], ['issued', managerId, managerId, reason]);
    const ev = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'recommendation.issued');
    assert.deepEqual([ev.after_state.self_issued, ev.after_state.self_issue_reason, ev.after_state.setting],
      [true, reason, { managers_self_issue_recommendations: true }]);
    const firmPage = (await allSteps(client, aBase(ctx.ws, ctx.tp, ctx.a))).text;
    assert.match(firmPage, /data-tprm-rec-self-issued[^>]*>Self-issued by [^:]+: SENTINEL-SELF-ISSUE/);
    assert.match(firmPage, /data-tprm-history-self-issued[^>]*>[^<]*Self-issued by [^:]+: SENTINEL-SELF-ISSUE/);
    const owner = await signIn(`rec-owner-${ctx.ws}@test.local`, PASSWORD);
    try {
      const portalPage = await owner.get(`/workspaces/${ctx.ws}/client-portal/third-party-risk/recommendations/${rid}`);
      assert.equal(portalPage.status, 200);
      assert.doesNotMatch(portalPage.text, /SENTINEL-SELF-ISSUE|Self-issued/);
      assert.doesNotMatch((await owner.get(`/workspaces/${ctx.ws}/client-portal/third-party-risk`)).text, /SENTINEL-SELF-ISSUE/);
    } finally { await owner.close(); }
    const report = require('../lib/tprm/report');
    const snap = await db.prepare('SELECT content FROM tp_recommendation_snapshots WHERE recommendation_id=?').get(rid);
    assert.doesNotMatch(snap.content, /SENTINEL-SELF-ISSUE/);
    const html = report.renderHtml(await report.reportData(db, await wsRow(ctx.ws), rid), { displayName: 'Firm', addressLines: [], contactLine: '' });
    const who = html.match(/data-report-signoff="issued"><dt>Reviewed and issued by<\/dt><dd><div [^>]*data-report-signoff-name>([^<]+)<\/div><div [^>]*data-report-signoff-role>Manager<\/div><div [^>]*data-report-signoff-date>\d{1,2} [A-Z][a-z]{2} \d{4}</);
    assert.ok(who, 'issued on and by');
    assert.match(html, new RegExp(`data-report-signoff="prepared"><dt>Prepared by</dt><dd><div [^>]*data-report-signoff-name>${who[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</div>`));
    assert.doesNotMatch(html, /SENTINEL-SELF-ISSUE|Self-issued/);
    await assert.rejects(db.prepare('UPDATE tp_recommendations SET self_issue_reason = ? WHERE id = ?').run('later', rid), /never changes|immutable/);

    const ctx2 = await confirmedAssessment('Self Issue Senior Co');
    await nameOwner(ctx2.ws, ctx2.a);
    const rid2 = await createDraft(ctx2, senior.session);
    await submitted(ctx2, rid2, draftBody({}, ONE_CONDITION), senior.session);
    assert.doesNotMatch((await allSteps(senior.session, aBase(ctx2.ws, ctx2.tp, ctx2.a))).text, /data-tprm-rec-self-issue-form/);
    res = await issue(ctx2, rid2, senior.session, { self_issue_reason: 'x' });
    assert.equal(res.status, 403);
    assert.match(res.text, /You wrote this recommendation, so a second person must issue it/);
    await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status='issued', reviewer_id=author_id, reviewed_at=now(), issued_at=now(),
      self_issue_reason='x' WHERE id=?`).run(rid2), /only as a manager of the firm/);
    await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status='issued', reviewer_id=author_id, reviewed_at=now(), issued_at=now() WHERE id=?`).run(rid2),
      /tp_recommendations_maker_checker/);
    assert.equal((await issue(ctx2, rid2, senior2.session)).status, 302);
    assert.equal((await recRow(rid2)).self_issue_reason, null);
  } finally {
    await setTwoPerson({ recommendations: false });
  }
});
test('issuing is idempotent: a repeated or concurrent request issues once, with one event', async () => {
  const ctx = await confirmedAssessment('Idempotent Co');
  const rid = await createDraft(ctx);
  await submitted(ctx, rid);
  const version = String((await recRow(rid)).row_version);
  const post = () => senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: version });
  const first = await post();
  const second = await post();
  assert.equal(first.status, 302);
  assert.equal(second.status, 302);
  assert.match(toast(second), /was already issued/);
  const issuedEvents = async (c) => (await chain(c.ws, c.a)).filter(e => e.action === 'recommendation.issued').length;
  assert.equal(await issuedEvents(ctx), 1);
  assert.equal((await recsOf(ctx.a)).filter(r => r.status === 'issued').length, 1);
  const issuedAt = (await recRow(rid)).issued_at;

  assert.equal((await senior2.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: version })).status, 409);
  assert.deepEqual((await recRow(rid)).issued_at, issuedAt);

  const ctx2 = await confirmedAssessment('Concurrent Issue Co');
  const rid2 = await createDraft(ctx2);
  await submitted(ctx2, rid2);
  const v2 = String((await recRow(rid2)).row_version);
  const both = await Promise.all([1, 2].map(() => senior.session.post(`${rBase(ctx2.ws, ctx2.tp, ctx2.a)}/${rid2}/issue`, { row_version: v2 })));
  assert.deepEqual(both.map(r => r.status), [302, 302]);
  assert.equal(await issuedEvents(ctx2), 1);
  assert.equal((await recRow(rid2)).status, 'issued');
  assert.deepEqual(await events.verifyChains(db, ctx2.ws), []);
});

test('an issued recommendation and its conditions are immutable (database trigger)', async () => {
  const ctx = await confirmedAssessment('Immutable Co');
  const rid = await createDraft(ctx);
  await submitted(ctx, rid);
  assert.equal((await issue(ctx, rid)).status, 302);

  for (const sql of [
    `UPDATE tp_recommendations SET rationale='Rewritten' WHERE id=?`,
    `UPDATE tp_recommendations SET outcome='reject' WHERE id=?`,
    `UPDATE tp_recommendations SET valid_until='2100-01-01' WHERE id=?`,
  ]) await assert.rejects(db.prepare(sql).run(rid), /only a draft can be edited/, sql);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET review_comment='later' WHERE id=?`).run(rid), /issued recommendation is immutable/);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status='withdrawn', withdrawn_at=now(), withdrawn_by=?, withdraw_reason='x' WHERE id=?`).run(consultant.id, rid),
    /issued recommendation is immutable/, 'an issued recommendation is not withdrawn');
  await assert.rejects(db.prepare(`DELETE FROM tp_recommendations WHERE id=?`).run(rid), /never deleted/);
  await assert.rejects(db.prepare(`UPDATE tp_conditions SET description='Softer' WHERE recommendation_id=?`).run(rid), /conditions change only while/);
  await assert.rejects(db.prepare(`DELETE FROM tp_conditions WHERE recommendation_id=?`).run(rid), /conditions change only while/);
  await assert.rejects(db.prepare(`INSERT INTO tp_conditions (workspace_id, recommendation_id, description, owner, due_date) VALUES (?,?,'Extra','client',?)`).run(ctx.ws, rid, DUE),
    /conditions change only while/);

  const res = await save(ctx, rid, draftBody({ rationale: 'Rewritten' }, ONE_CONDITION));
  assert.equal(res.status, 409);
  assert.equal((await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/withdraw`, { row_version: String((await recRow(rid)).row_version), reason: 'x' })).status, 409);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, new RegExp(`data-tprm-rec-issued="${rid}"`));
  assert.doesNotMatch(page.text, /data-tprm-rec-form|data-tprm-rec-withdraw|data-tprm-rec-create-form/);
  assert.equal((await recRow(rid)).rationale, 'Controls are adequate once MFA is enforced.');
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_issued');
});

test('changes requested, the author revises the same version, a second person issues it', async () => {
  const ctx = await confirmedAssessment('Revise Co', { status: 'proposed' });
  const rid = await createDraft(ctx);
  await submitted(ctx, rid);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_in_review');

  let res = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/request-changes`, { row_version: String((await recRow(rid)).row_version), comment: '' });
  assert.match(toast(res), /Say what needs to change/);
  assert.equal((await recRow(rid)).status, 'in_review');
  res = await senior.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/request-changes`, { row_version: String((await recRow(rid)).row_version), comment: 'Residual should be high' });
  assert.equal(res.status, 302);
  let row = await recRow(rid);
  assert.equal(row.status, 'changes_requested');
  assert.equal(row.review_comment, 'Residual should be high');
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_draft');
  let page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-changes-requested[\s\S]*Residual should be high/);
  assert.match(page.text, /data-tprm-rec-form/);

  assert.equal((await save(ctx, rid, draftBody({ residual_rating: 'high' }, ONE_CONDITION))).status, 302);
  assert.equal((await recRow(rid)).status, 'changes_requested');
  await submitted(ctx, rid, draftBody({ residual_rating: 'high' }, ONE_CONDITION));
  assert.equal((await issue(ctx, rid, senior2.session)).status, 302);
  row = await recRow(rid);
  assert.equal(row.version, 1);
  assert.equal(row.status, 'issued');
  assert.equal(row.residual_rating, 'high');
  assert.equal(Number(row.reviewer_id), senior2.id);
  assert.equal((await recsOf(ctx.a)).length, 1);

  page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-version="1"/);
  assert.match(page.text, /data-tprm-rec-outcome[^>]*>(?:<[^>]+>)*Onboard with conditions</);
  assert.match(page.text, /data-tprm-rec-issued-by[^>]*>(?:<[^>]+>)*rec-senior2@test.local/);
  assert.doesNotMatch(page.text, /data-tprm-rec-form/);
  assert.match(page.text, /Recommendation issued/);

  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action).filter(x => x.startsWith('recommendation.'));
  assert.deepEqual(actions, ['recommendation.drafted', 'recommendation.saved', 'recommendation.submitted',
    'recommendation.changes_requested', 'recommendation.saved', 'recommendation.submitted', 'recommendation.issued']);
  const changes = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'recommendation.changes_requested');
  assert.equal(changes.after_state.comment, 'Residual should be high', 'each round\'s comment is kept in the event');
  assert.equal(Number(changes.actor_user_id), senior.id);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('the author can withdraw before issue; the next draft is a new version', async () => {
  const ctx = await confirmedAssessment('Withdraw Co');
  const rid = await createDraft(ctx);
  await submitted(ctx, rid);
  const withdrawUrl = id => `${rBase(ctx.ws, ctx.tp, ctx.a)}/${id}/withdraw`;

  let res = await senior.session.post(withdrawUrl(rid), { row_version: String((await recRow(rid)).row_version), reason: 'Not mine' });
  assert.equal(res.status, 403, 'only the author withdraws');
  res = await consultant.session.post(withdrawUrl(rid), { row_version: String((await recRow(rid)).row_version), reason: '' });
  assert.match(toast(res), /Give a reason for withdrawing/);
  assert.equal((await recRow(rid)).status, 'in_review');
  res = await consultant.session.post(withdrawUrl(rid), { row_version: String((await recRow(rid)).row_version), reason: 'Waiting for the pen test' });
  assert.equal(res.status, 302);
  const row = await recRow(rid);
  assert.equal(row.status, 'withdrawn');
  assert.equal(row.withdraw_reason, 'Waiting for the pen test');
  assert.equal((await assessmentRow(ctx.a)).status, 'tier_confirmed');
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET rationale='x' WHERE id=?`).run(rid), /withdrawn recommendation cannot be changed/);
  const queue = await senior.session.get('/tprm/review');
  assert.doesNotMatch(queue.text, new RegExp(`data-tprm-review-recommendation="${rid}"`));

  const next = await createDraft(ctx);
  assert.equal((await recRow(next)).version, 2);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-earlier-version="1"[\s\S]*Waiting for the pen test/);
  assert.equal((await chain(ctx.ws, ctx.a)).filter(e => e.action === 'recommendation.withdrawn').length, 1);
});

test('startNewVersion after an issue: a new draft from the issued content; issuing it supersedes the old one', async () => {
  const ctx = await confirmedAssessment('New Version Co');
  const actor = await actorFor(consultant, ctx.ws);
  await assert.rejects(rec.startNewVersion(db, actor, ctx.tp, ctx.a, { reason: 'Too early' }), err => err.status === 409);
  const v1 = await createDraft(ctx);
  await assert.rejects(rec.startNewVersion(db, actor, ctx.tp, ctx.a, { reason: 'Still a draft' }), err => err.status === 409);
  await submitted(ctx, v1);
  assert.equal((await issue(ctx, v1)).status, 302);
  const v1Before = await recRow(v1);

  await assert.rejects(rec.startNewVersion(db, actor, ctx.tp, ctx.a, { reason: '' }), err => err.status === 400);
  const v2 = await rec.startNewVersion(db, actor, ctx.tp, ctx.a, { reason: 'The client asked for more information' });
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'draft');
  assert.equal(v2.outcome, 'approve_with_conditions');
  assert.equal(v2.rationale, v1Before.rationale);
  assert.deepEqual(v2.conditions.map(c => [c.description, c.owner, c.due_date]), [['Enforce MFA for all admin accounts', 'vendor', DUE]]);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_draft');
  assert.equal((await recRow(v1)).status, 'issued', 'version 1 stays live while version 2 is drafted');
  await assert.rejects(rec.startNewVersion(db, actor, ctx.tp, ctx.a, { reason: 'Again' }), err => err.status === 409);

  assert.equal((await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${v2.id}/withdraw`, { row_version: String((await recRow(v2.id)).row_version), reason: 'Answered by email' })).status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_issued');
  assert.equal((await recRow(v1)).status, 'issued');

  const v3 = await rec.startNewVersion(db, actor, ctx.tp, ctx.a, { reason: 'New evidence from the client' });
  assert.equal(v3.version, 3);
  await submitted(ctx, v3.id, draftBody({ outcome: 'approve', rationale: 'The MFA gap is closed.' }));
  assert.equal((await issue(ctx, v3.id, senior2.session)).status, 302);
  const rows = await recsOf(ctx.a);
  assert.deepEqual(rows.map(r => [r.version, r.status]), [[1, 'withdrawn'], [2, 'withdrawn'], [3, 'issued']]);
  assert.equal(rows.filter(r => r.status === 'issued').length, 1, 'one live issued recommendation');
  const v1After = await recRow(v1);
  assert.equal(Number(v1After.superseded_by_id), Number(v3.id));
  for (const f of ['outcome', 'residual_rating', 'rationale', 'valid_until', 'author_id', 'reviewer_id', 'issued_at', 'review_comment']) {
    assert.deepEqual(v1After[f], v1Before[f], `version 1 keeps its ${f}`);
  }
  assert.equal((await conditionsOf(v1)).length, 1, 'version 1 keeps its condition');
  assert.equal((await conditionsOf(v3.id)).length, 0);
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action).filter(x => x.startsWith('recommendation.'));
  assert.deepEqual(actions.slice(-3), ['recommendation.submitted', 'recommendation.issued', 'recommendation.superseded']);
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-version="3"/);
  assert.match(page.text, /data-tprm-rec-earlier-version="1"[\s\S]*superseded by a later version/);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('the review queue lists recommendations in review across reachable clients, never the reviewer\'s own', async () => {
  const wsA = await tprmClient('Rec Queue Client A');
  const wsB = await tprmClient('Rec Queue Client B');
  const a = await confirmedAssessment('RQ Alpha Co', { ws: wsA });
  const b = await confirmedAssessment('RQ Beta Co', { ws: wsB });
  const c = await confirmedAssessment('RQ Draft Co', { ws: wsB });
  const d = await confirmedAssessment('RQ Senior Co', { ws: wsB });
  const ra = await createDraft(a);
  await submitted(a, ra);
  const rb = await createDraft(b, client);
  await submitted(b, rb, draftBody({}, ONE_CONDITION), client);
  await createDraft(c);
  const rd = await createDraft(d, senior.session);
  await submitted(d, rd, draftBody({}, ONE_CONDITION), senior.session);

  let page = await senior.session.get('/tprm/review');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-review-recommendations/);
  assert.match(page.text, new RegExp(`data-tprm-review-recommendation="${ra}"`));
  assert.match(page.text, new RegExp(`data-tprm-review-recommendation="${rb}"`));
  assert.doesNotMatch(page.text, new RegExp(`data-tprm-review-recommendation="${rd}"`), 'the senior wrote it');
  assert.doesNotMatch(page.text, /RQ Draft Co/, 'a draft is not in review');
  assert.match(page.text, /Continue with conditions/);
  const href = (page.text.match(new RegExp(`data-tprm-review-recommendation="${ra}">\\s*<td><a href="([^"]+)"`)) || [])[1];
  assert.equal(href, `${aBase(a.ws, a.tp, a.a)}?step=recommendation#recommendation`, 'the row links to the assessment step');
  const target = await senior.session.get(href.split('#')[0]);
  assert.equal(target.status, 200);
  assert.match(target.text, /data-tprm-rec-issue-form/, 'the reviewer lands on the issue form');
  page = await client.get('/tprm/review');
  assert.match(page.text, new RegExp(`data-tprm-review-recommendation="${rd}"`));
  assert.doesNotMatch(page.text, new RegExp(`data-tprm-review-recommendation="${rb}"`), 'the manager wrote it');
  const count = Number(((await senior.session.get('/tprm')).text.match(/data-tprm-review-link>Review queue \((\d+)\)/) || [])[1]);
  assert.ok(count >= 2, 'the /tprm review count includes recommendations');
  const readOnly = await consultant.session.get('/tprm/review');
  assert.equal(readOnly.status, 200);
  assert.match(readOnly.text, /data-tprm-review-readonly/);
  assert.match(readOnly.text, new RegExp(`data-tprm-review-recommendation="${ra}"`));
  assert.doesNotMatch(readOnly.text, /data-tprm-rec-issue-form|\/issue"/);

  assert.equal((await issue(a, ra)).status, 302);
  await client.post(`${aBase(b.ws, b.tp, b.a)}/cancel`, { row_version: String((await assessmentRow(b.a)).row_version), reason: 'Client dropped it' });
  assert.equal((await assessmentRow(b.a)).status, 'cancelled');
  page = await senior.session.get('/tprm/review');
  assert.doesNotMatch(page.text, new RegExp(`data-tprm-review-recommendation="(?:${ra}|${rb})"`));
  assert.equal((await issue(b, rb)).status, 409, 'a cancelled assessment\'s recommendation is not issued');
  assert.deepEqual(await rec.reviewQueue({ db }, { user_type: 'client' }), []);
});

test('isolation: another client, another firm, client users and unassigned consultants get 404', async () => {
  const ctx = await confirmedAssessment('Rec Hidden Co');
  const other = await confirmedAssessment('Rec Other Co');
  const rid = await createDraft(ctx);
  await submitted(ctx, rid);
  const v = String((await recRow(rid)).row_version);

  for (const path of [`${rBase(other.ws, ctx.tp, ctx.a)}/${rid}/issue`, `${rBase(other.ws, other.tp, other.a)}/${rid}/issue`,
    `${rBase(ctx.ws, ctx.tp, other.a)}/${rid}/issue`]) {
    assert.equal((await senior.session.post(path, { row_version: v })).status, 404, path);
  }
  const otherA = await startAssessment(ctx.ws, await addThirdParty(ctx.ws, { name: 'Rec Sibling Co' }));
  assert.ok(otherA);
  await assert.rejects(rec.getRecommendation(db, await actorFor(manager(), other.ws), { id: ctx.a }, rid), err => err.status === 404);

  const otherFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Recommendation Other Firm')").run()).lastInsertRowid);
  const outsider = await makeUser('rec-other-firm@test.local', { role: 'manager', firm: otherFirm });
  const outsiderSession = await signIn(outsider.email, outsider.password);
  try {
    assert.equal((await outsiderSession.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, { row_version: v })).status, 404);
    assert.equal((await outsiderSession.post(rBase(ctx.ws, ctx.tp, ctx.a), { row_version: '1' })).status, 404);
    assert.doesNotMatch((await outsiderSession.get('/tprm/review')).text, /Rec Hidden Co/);
  } finally {
    await outsiderSession.close();
  }

  const owner = await makeUser('rec-client-owner@test.local', { type: 'client', workspaceId: ctx.ws, memberRole: 'client_owner' });
  const ownerSession = await signIn(owner.email, owner.password);
  try {
    const hidden = await allSteps(ownerSession, aBase(ctx.ws, ctx.tp, ctx.a));
    assert.equal(hidden.status, 404);
    assert.doesNotMatch(hidden.text, /data-tprm-recommendation-step/);
    for (const path of [`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/issue`, `${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/withdraw`, `${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}`]) {
      assert.equal((await ownerSession.post(path, { row_version: v, reason: 'x' })).status, 404, path);
    }
  } finally {
    await ownerSession.close();
  }

  const unassigned = await makeUser('rec-unassigned@test.local', { role: 'consultant' });
  const unassignedSession = await signIn(unassigned.email, unassigned.password);
  try {
    assert.equal((await unassignedSession.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}/withdraw`, { row_version: v, reason: 'x' })).status, 404);
    assert.equal((await unassignedSession.post(rBase(ctx.ws, ctx.tp, ctx.a), { row_version: '1' })).status, 404);
  } finally {
    await unassignedSession.close();
  }
  const row = await recRow(rid);
  assert.equal(row.status, 'in_review');
  assert.equal(String(row.row_version), v, 'nothing changed');
});

test('a stale row_version is refused with 409 and nothing changes', async () => {
  const ctx = await confirmedAssessment('Rec Stale Co');
  const staleAssessment = String((await assessmentRow(ctx.a)).row_version - 1);
  assert.equal((await consultant.session.post(rBase(ctx.ws, ctx.tp, ctx.a), { row_version: staleAssessment })).status, 409);
  const rid = await createDraft(ctx);
  const url = `${rBase(ctx.ws, ctx.tp, ctx.a)}/${rid}`;
  const stale = String((await recRow(rid)).row_version);
  assert.equal((await save(ctx, rid, draftBody({}, ONE_CONDITION))).status, 302);
  let res = await consultant.session.post(url, { ...draftBody({ rationale: 'Lost update' }), intent: 'save', row_version: stale });
  assert.equal(res.status, 409);
  assert.match(res.text, /Someone else changed this recommendation/);
  assert.equal((await consultant.session.post(url, { ...draftBody({}, ONE_CONDITION), intent: 'submit', row_version: stale })).status, 409);
  assert.equal((await consultant.session.post(`${url}/withdraw`, { row_version: stale, reason: 'x' })).status, 409);
  assert.equal((await recRow(rid)).status, 'draft');
  await submitted(ctx, rid);
  assert.equal((await senior.session.post(`${url}/issue`, { row_version: stale })).status, 409);
  assert.equal((await senior.session.post(`${url}/request-changes`, { row_version: stale, comment: 'x' })).status, 409);
  const row = await recRow(rid);
  assert.equal(row.status, 'in_review');
  assert.equal(row.rationale, 'Controls are adequate once MFA is enforced.');
});

test('CSRF is required on every recommendation form', async () => {
  const ctx = await confirmedAssessment('Rec CSRF Co');
  const rid = await createDraft(ctx);
  const base = rBase(ctx.ws, ctx.tp, ctx.a);
  const before = (await recRow(rid)).row_version;
  for (const path of [base, `${base}/${rid}`, `${base}/${rid}/issue`, `${base}/${rid}/request-changes`, `${base}/${rid}/withdraw`]) {
    assert.equal((await client.post(path, { row_version: '1' }, { csrf: false })).status, 403, `${path} without a token`);
    assert.equal((await client.post(path, { _csrf: 'f'.repeat(64), row_version: '1' }, { csrf: false })).status, 403, `${path} with a forged token`);
  }
  const page = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(page.text, /data-tprm-rec-form[\s\S]*?name="_csrf" value="[a-f0-9]+"/);
  assert.equal((await recRow(rid)).row_version, before);
  assert.equal((await recsOf(ctx.a)).length, 1);
});

test('every change writes an event in the assessment chain and the chain verifies', async () => {
  const ctx = await confirmedAssessment('Rec Events Co');
  const rid = await createDraft(ctx);
  await save(ctx, rid, draftBody({ outcome: 'approve', residual_rating: 'low' }));
  await submitted(ctx, rid, draftBody({ outcome: 'approve', residual_rating: 'low' }));
  assert.equal((await issue(ctx, rid, senior.session, { comment: 'Agreed' })).status, 302);
  const rows = (await chain(ctx.ws, ctx.a)).filter(e => e.action.startsWith('recommendation.'));
  assert.deepEqual(rows.map(e => e.action), ['recommendation.drafted', 'recommendation.saved', 'recommendation.submitted', 'recommendation.issued']);
  assert.deepEqual(rows.map(e => Number(e.actor_user_id)), [consultant.id, consultant.id, consultant.id, senior.id]);
  const issued = rows[3].after_state;
  assert.equal(issued.recommendation_id, rid);
  assert.equal(issued.version, 1);
  assert.equal(issued.outcome_label, 'Continue');
  assert.equal(issued.residual_rating, 'low');
  assert.equal(issued.valid_until, VALID_UNTIL);
  assert.equal(issued.reviewer_id, senior.id);
  assert.equal(issued.comment, 'Agreed');
  assert.deepEqual(issued.conditions, []);
  assert.equal(rows[1].before_state.outcome, null);
  assert.equal(rows[1].after_state.outcome, 'approve');
  assert.equal((await recRow(rid)).review_comment, 'Agreed');
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
  const history = await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(history.text, /data-tprm-assessment-history[\s\S]*data-tprm-history-action="recommendation.issued"/);
});

test('deleting a workspace or a firm removes its recommendations and conditions', async () => {
  const ctx = await confirmedAssessment('Rec Doomed Co');
  const rid = await createDraft(ctx);
  await submitted(ctx, rid);
  assert.equal((await issue(ctx, rid)).status, 302);
  const name = (await wsRow(ctx.ws)).client_name;
  const deleted = await client.post(`/workspaces/${ctx.ws}/delete`, { confirm_name: name });
  assert.equal(deleted.status, 302);
  for (const table of ['tp_recommendations', 'tp_conditions', 'tp_assessments', 'tp_events']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ctx.ws)).c, 0, table);
  }

  const ctx2 = await confirmedAssessment('Rec Cascade Co');
  const rid2 = await createDraft(ctx2);
  await submitted(ctx2, rid2);
  assert.equal((await issue(ctx2, rid2)).status, 302);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(ctx2.ws);
  for (const table of ['tp_recommendations', 'tp_conditions']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ctx2.ws)).c, 0, table);
  }

  const at = require('../lib/tprm/assessments');
  const doomedFirm = Number((await db.prepare("INSERT INTO firms (name) VALUES ('Recommendation Doomed Firm')").run()).lastInsertRowid);
  const ws3 = await tprmClient('Rec Doomed Firm Client', { firm: doomedFirm });
  const tp3 = Number((await db.prepare("INSERT INTO tp_third_parties (workspace_id, name, status) VALUES (?, 'Doomed Co', 'in_use')").run(ws3)).lastInsertRowid);
  const svc3 = Number((await db.prepare("INSERT INTO tp_services (workspace_id, third_party_id, description) VALUES (?, ?, 'Hosting')").run(ws3, tp3)).lastInsertRowid);
  const lead = await actorFor(await makeUser('rec-doomed-manager@test.local', { role: 'manager', firm: doomedFirm }), ws3);
  const second = await actorFor(await makeUser('rec-doomed-manager2@test.local', { role: 'manager', firm: doomedFirm }), ws3);
  const started = await at.start(db, lead, tp3);
  await nameOwner(ws3, started.id);
  const answers = {};
  for (const [q, x] of Object.entries(LOW)) answers[q] = x;
  const { assessment: proposed } = await at.propose(db, lead, tp3, started.id, { services: [String(svc3)], answers, row_version: started.row_version });
  const confirmed = await at.confirm(db, second, tp3, started.id, { row_version: proposed.row_version });
  const draft = await rec.createDraft(db, lead, tp3, started.id, { row_version: confirmed.row_version });
  const saved = await rec.saveDraft(db, lead, tp3, started.id, draft.id, {
    ...draftBody(), conditions: [{ description: 'Encrypt backups', owner: 'client', due_date: DUE }], row_version: draft.row_version });
  const sent = await rec.submit(db, lead, tp3, started.id, draft.id, { row_version: saved.recommendation.row_version });
  await rec.issue(db, second, tp3, started.id, draft.id, { row_version: sent.row_version });
  assert.equal((await recRow(draft.id)).status, 'issued');
  await require('../lib/workspace-deletion').deleteFirm(db, doomedFirm);
  for (const table of ['tp_recommendations', 'tp_conditions', 'tp_assessments', 'tp_events']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ws3)).c, 0, table);
  }
  const restoreCheck = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'restore-check.js'), 'utf8');
  const counted = restoreCheck.slice(restoreCheck.indexOf('SNAPSHOT_COUNT_TABLES'), restoreCheck.indexOf('LIVE_COUNT_MIN_RATIO'));
  assert.match(counted, /'tp_recommendations'/);
  assert.match(counted, /'tp_conditions'/);
});

test('the recommendation keeps a private draft: saved by the author, read back, used up by a save, refused elsewhere', async () => {
  const ctx = await confirmedAssessment('Draft Keeping Co');
  const rid = await createDraft(ctx);
  const url = `/tprm/clients/${ctx.ws}/form-drafts/tprm-recommendation/${rid}`;
  const version = String((await recRow(rid)).row_version);
  const put = (session, payload, extra = {}) => session.put(url, { payload, baseVersion: version, generation: 0, expectedDraftVersion: 0,
    clientSaveId: `save-${Math.random()}`, contextKey: '', ...extra }, { json: true, csrf: true });

  const saved = await put(consultant.session, { rationale: 'Half written', 'conditions[0][description]': 'Enforce MFA', unknown_field: 'dropped' });
  assert.equal(saved.status, 200, saved.text);
  const read = JSON.parse((await consultant.session.get(url)).text);
  assert.equal(read.draft.payload.rationale, 'Half written');
  assert.equal(read.draft.payload['conditions[0][description]'], 'Enforce MFA');
  assert.equal(read.draft.payload.unknown_field, undefined, 'only the form\'s own fields are kept');

  assert.equal(JSON.parse((await senior.session.get(url)).text).draft, null, 'drafts are private to their author');
  assert.equal((await consultant.session.get(`/tprm/clients/${ctx.ws}/form-drafts/tprm-recommendation/999999`)).status, 403);
  assert.equal((await consultant.session.get(`/tprm/clients/999999/form-drafts/tprm-recommendation/${rid}`)).status, 403);

  const res = await save(ctx, rid, draftBody({}, ONE_CONDITION));
  assert.equal(res.status, 302);
  assert.equal(JSON.parse((await consultant.session.get(url)).text).draft, null, 'a saved form starts clean');

  await submitted(ctx, rid);
  assert.equal((await consultant.session.get(url)).status, 403);
});
