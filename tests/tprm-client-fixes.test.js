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

const PASSWORD = 'client-fixes-tests-password-1234';
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
  consultant = await makeUser('fix-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('fix-senior@test.local', { role: 'senior_consultant' });
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
  const owner = await makeUser(`fix-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
  const other = await makeUser(`fix-coord-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'isms_manager' });
  const contributor = await makeUser(`fix-contrib-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'contributor' });
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

function multipart(token, files, fields = {}) {
  const boundary = '----tprmfix' + crypto.randomBytes(8).toString('hex');
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

const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
const CLIENT_COND = { 'conditions[1][description]': 'Sign the data processing agreement', 'conditions[1][owner]': 'client', 'conditions[1][due_date]': DUE };
const condsOf = async rid => db.prepare('SELECT *, due_date::text AS due_date FROM tp_conditions WHERE recommendation_id=? ORDER BY position').all(rid);
const waitingCount = text => Number((text.match(/data-tprm-cv-tab="waiting">Waiting on you <small[^>]*>(\d+)</) || [])[1]);
const quoteless = text => String(text).replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, '\'');

async function portalProof(session, ws, rid, cid) {
  await session.get(recPage(ws, rid));
  const row = await db.prepare('SELECT row_version FROM tp_conditions WHERE id=?').get(cid);
  const form = multipart(session.getCsrfToken(), [{ filename: 'signed.pdf', content: `${PDF}% fix\n`, type: 'application/pdf' }],
    { note: 'Signed copy', row_version: row.row_version });
  const res = await session.post(`${portal(ws)}/conditions/${cid}/proofs`, form.body, { headers: form.headers });
  for (const f of await db.prepare('SELECT stored_path FROM tp_condition_proof_files WHERE condition_id=?').all(cid)) createdPaths.add(f.stored_path);
  return res;
}

test('only a decision less cautious than the advice is a risk acceptance', async () => {
  assert.equal(D.acceptsRisk('reject', 'approve'), false);
  assert.equal(D.acceptsRisk('approve_with_conditions', 'approve'), false);
  assert.equal(D.acceptsRisk('approve', 'approve_with_conditions'), true);
  assert.equal(D.acceptsRisk('approve_with_conditions', 'reject'), true);
  assert.equal(D.acceptsRisk('request_more_information', 'reject'), false);
  const c = await tprmClient('Fix Risk Client');
  const ctx = await confirmed(c, 'Riskier Co', { status: 'proposed' });
  const rid = await issued(ctx, 'reject');
  const owner = await sessionFor(c.owner);
  const page = await owner.get(recPage(ctx.ws, rid));
  assert.match(page.text, /value="approve"[^>]*data-accepts-risk/);
  assert.doesNotMatch(page.text, /value="reject"[^>]*data-accepts-risk/);
  let res = await decide(owner, ctx.ws, rid, { outcome: 'approve', rationale: 'Business need' });
  assert.equal(res.status, 400);
  assert.match(res.text, /less cautious than the recommendation: set the date your risk acceptance expires/);
  res = await decide(owner, ctx.ws, rid, { outcome: 'approve', rationale: 'Business need', risk_acceptance_until: '2098-06-30' });
  assert.equal(res.status, 302);
  const after = await owner.get(recPage(ctx.ws, rid));
  assert.match(after.text, /data-tprm-portal-risk-accepted/);
  assert.match(after.text, /Risk accepted until/);
  const css = fs.readFileSync(path.join(ROOT, 'public', 'tprm.css'), 'utf8');
  assert.match(css, /input\[data-accepts-risk\]:checked\) \[data-tprm-risk-acceptance\]/, 'the date field shows only for a less cautious choice');
  assert.doesNotMatch(css, /input\[data-diverges\]:checked\) \[data-tprm-risk-acceptance\]/);
});

test('the decision is checked before the confirmation, and the confirmation names the option', async () => {
  const c = await tprmClient('Fix Confirm Client');
  const ctx = await confirmed(c, 'Confirm Co', { status: 'proposed' });
  const rid = await issued(ctx, 'approve');
  const owner = await sessionFor(c.owner);
  const page = await owner.get(recPage(ctx.ws, rid));
  assert.match(page.text, /data-label="Need more information"/);
  assert.match(page.text, /rationale\.required = /, 'the rationale is required in the browser before the dialog opens');
  assert.match(page.text, /title\.value = picked/, 'the dialog title names the option');
  const confirmFields = { _tp_confirm_title: 'Record your decision?', _tp_confirm_body: 'Final.', _tp_confirm_action: 'Record decision' };
  let res = await owner.post(`${recPage(ctx.ws, rid)}/decision`, { ...confirmFields, outcome: 'request_more_information', rationale: '' });
  assert.equal(res.status, 400, 'without JavaScript the missing rationale is reported before any confirmation');
  assert.match(res.text, /Say what more information you need/);
  assert.doesNotMatch(res.text, /data-tprm-confirm-page/);
  res = await owner.post(`${recPage(ctx.ws, rid)}/decision`, { ...confirmFields, outcome: 'request_more_information', rationale: 'Please send the SOC 2 report' });
  assert.equal(res.status, 200);
  assert.match(res.text, /data-tprm-confirm-page/);
  assert.match(quoteless(res.text), /Record "Need more information" as your decision\?/);
  assert.match(res.text, /data-tprm-client-view/, 'the confirmation uses the client layout');
  assert.doesNotMatch(res.text, /Jump to a client/);
  assert.equal((await decisionsOf(ctx.a)).length, 0, 'nothing is recorded before the confirmation');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'tprm-client.css'), 'utf8');
  assert.match(css, /\.cv-main \.callout-title \{ text-transform: none;/);
});

test('after "Need more information" the page says it waits for the consultants, and points to the revised version', async () => {
  const c = await tprmClient('Fix More Info Client');
  const ctx = await confirmed(c, 'More Info Co', { status: 'proposed' });
  const v1 = await issued(ctx, 'approve');
  const owner = await sessionFor(c.owner);
  assert.equal((await decide(owner, ctx.ws, v1, { outcome: 'request_more_information', rationale: 'How are files deleted?' })).status, 302);
  let page = quoteless((await owner.get(recPage(ctx.ws, v1))).text);
  assert.match(page, /data-tprm-portal-pending="information_requested"[^>]*>[^<]*Waiting for your consultants' answer|Waiting for your consultants' answer/);
  assert.doesNotMatch(page, /Waiting for your decision/);
  assert.doesNotMatch(page, /data-tprm-portal-after/, 'the before-you-decide text is gone');
  assert.match(page, /data-tprm-portal-next="request_more_information"/);
  assert.equal((await consultant.session.post(`${rBase(ctx.ws, ctx.tp, ctx.a)}/new-version`, { reason: 'Answered.' })).status, 302);
  const v2 = Number((await recsOf(ctx.a)).pop().id);
  await issued(ctx, 'approve', { rid: v2 });
  page = (await owner.get(recPage(ctx.ws, v1))).text;
  assert.doesNotMatch(page, /will issue a revised recommendation/);
  assert.match(page, new RegExp(`href="${recPage(ctx.ws, v2)}">open version 2</a> and decide on it`));
});

test('decision state on the third-party page, conditions and Waiting on you', async () => {
  const c = await tprmClient('Fix Conditions Client');
  const ctx = await confirmed(c, 'Conditions Co', { status: 'proposed' });
  const rid = await issued(ctx, 'approve_with_conditions', { extra: CLIENT_COND });
  const clientCond = (await condsOf(rid)).find(x => x.owner === 'client');
  const owner = await sessionFor(c.owner);
  const party = `${portal(c.id)}/third-parties/${ctx.tp}`;

  let overview = (await owner.get(party)).text;
  assert.doesNotMatch(overview, /Approval valid until/, 'no approval date before a decision');
  assert.doesNotMatch(overview, /Your condition \d+ due/, 'no condition due date before a decision');
  assert.match(overview, /data-tprm-cv-recommendation-until/);
  assert.match(overview, /Onboard with conditions/);
  assert.doesNotMatch(overview, /Approve with conditions/);
  let conds = (await owner.get(`${party}?tab=conditions`)).text;
  assert.doesNotMatch(conds, /Send proof/, 'no proof can be sent before the decision');
  assert.match(conds, /Applies if you decide with conditions/);
  assert.match(conds, /<td>You<\/td>/);
  assert.match(conds, /<td>Supplier<\/td>/);
  const before = (await owner.get(recPage(ctx.ws, rid))).text;
  assert.match(before, /Who: You ·/);
  assert.match(before, /Who: Supplier ·/);
  assert.doesNotMatch(before, /You \(the client\)/);

  assert.equal((await decide(owner, ctx.ws, rid, { outcome: 'approve_with_conditions' })).status, 302);
  overview = (await owner.get(party)).text;
  assert.match(overview, /data-tprm-cv-approval-until/);
  assert.match(overview, /Your condition 2 due/);
  assert.match(overview, /data-tprm-cv-conditions-state="open"/, 'the header says conditions are open');
  assert.match(overview, /data-tprm-cv-latest-decision>Onboard with conditions</);
  const reviews = (await owner.get(`${party}?tab=reviews`)).text;
  assert.doesNotMatch(reviews, /Approve with conditions/);
  conds = (await owner.get(`${party}?tab=conditions`)).text;
  assert.match(conds, /Send proof/);
  const contributor = await sessionFor(c.contributor);
  assert.doesNotMatch((await contributor.get(`${party}?tab=conditions`)).text, /Send proof/, 'only people who can send proof are offered it');
  assert.doesNotMatch((await contributor.get(portal(c.id))).text, /Send proof/);
  assert.match((await owner.get(portal(c.id))).text, />Send proof<\/a>/);
  const rec = (await owner.get(recPage(ctx.ws, rid))).text;
  assert.doesNotMatch(rec, /What happens after you decide/);
  assert.match(rec, /data-tprm-portal-next="approve_with_conditions"/);
  assert.match(rec, /data-tprm-portal-next-conditions="open"/);
  assert.match(rec, /Owner: You ·/);
  assert.doesNotMatch(rec, /Owner: Client/);

  let home = (await owner.get(portal(c.id))).text;
  assert.equal(waitingCount(home), 1);
  assert.match(home, new RegExp(`data-tprm-portal-own-condition="${clientCond.id}"`));
  assert.equal((await portalProof(owner, ctx.ws, rid, clientCond.id)).status, 302);
  home = (await owner.get(portal(c.id))).text;
  assert.equal(waitingCount(home), 0, 'proof waiting on the consultants is not waiting on you');
  assert.doesNotMatch(home, new RegExp(`data-tprm-portal-own-condition="${clientCond.id}"`));
  assert.match(home, new RegExp(`data-tprm-portal-proof-pending-item="${clientCond.id}"`));
  assert.doesNotMatch((await owner.get(`${portal(c.id)}?tab=waiting`)).text, new RegExp(`data-tprm-portal-row="${ctx.tp}"`));

  await allSteps(senior.session, aBase(ctx.ws, ctx.tp, ctx.a));
  const changes = await senior.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/conditions/${clientCond.id}/request-changes`, {
    comment: 'Please send the countersigned page.', row_version: String((await db.prepare('SELECT row_version FROM tp_conditions WHERE id=?').get(clientCond.id)).row_version) });
  assert.equal(changes.status, 302);
  const feedback = (await owner.get(recPage(ctx.ws, rid))).text;
  assert.match(feedback, /data-tprm-portal-proof-reviewer>by fix-senior@test\.local, \d/, 'the feedback says who and when');
  assert.equal(waitingCount((await owner.get(portal(c.id))).text), 1, 'changes asked for are waiting on you again');
});

test('Home counts match their labels and Reports', async () => {
  const c = await tprmClient('Fix Counts Client');
  await addThirdParty(c.id, 'Plain In Use Co', 'in_use');
  const assessing = await confirmed(c, 'Being Assessed Co', { status: 'in_use' });
  const waiting = await confirmed(c, 'Waiting Decision Co', { status: 'proposed' });
  await issued(waiting, 'approve');
  const owner = await sessionFor(c.owner);
  const home = (await owner.get(portal(c.id))).text;
  assert.match(home, /data-tprm-cv-under-assessment>Being assessed<b>1<\/b>/);
  assert.match(home, /data-tprm-cv-not-assessed>Not assessed yet<b>1<\/b>/, 'a supplier under assessment is not counted as not assessed');
  assert.match(home, /data-tprm-cv-in-use="2"/);
  assert.match(home, /In use, no review open/);
  const reports = (await owner.get(`${portal(c.id)}/concentration`)).text;
  assert.match(reports, /data-tprm-concentration-in-use="2"/, 'Reports counts in use the same way');
  const card = home.slice(home.indexOf('data-tprm-portal-decisions-needed'), home.indexOf('</ul>', home.indexOf('data-tprm-portal-decisions-needed')));
  assert.match(card, /data-tprm-cv-need-tier>Low tier · Recommendation version 1/);
  assert.doesNotMatch(card, /cv-tag/, 'the tier is plain text, not a badge');
  assert.ok(assessing.a);
});

test('an overdue review stays on the Due card and Renewals; a never-assessed supplier does not', async () => {
  const c = await tprmClient('Fix Due Client');
  const late = await addThirdParty(c.id, 'Late Review Co', 'in_use');
  const fresh = await addThirdParty(c.id, 'Never Assessed Co', 'in_use');
  const ws = await wsRow(c.id);
  const t = dates.todayFor(ws);
  const past = new Date(Date.parse(`${t}T00:00:00Z`) - 5 * 86400000).toISOString().slice(0, 10);
  await db.prepare('UPDATE tp_third_parties SET last_assessment_date = ?::date, next_due_date = ?::date WHERE id = ?').run('2020-01-01', past, late);
  await db.prepare('UPDATE tp_third_parties SET last_assessment_date = NULL, next_due_date = NULL WHERE id = ?').run(fresh);
  const owner = await sessionFor(c.owner);
  const home = (await owner.get(portal(c.id))).text;
  assert.match(home, /data-tprm-cv-overdue-reviews="1"/);
  assert.match(home, /1 review overdue/);
  assert.doesNotMatch(home, /condition overdue/);
  const renewals = (await owner.get(`${portal(c.id)}?tab=renewals`)).text;
  assert.match(renewals, new RegExp(`data-tprm-portal-row="${late}"`), 'an overdue review is listed');
  assert.doesNotMatch(renewals, new RegExp(`data-tprm-portal-row="${fresh}"`), 'a supplier never assessed is not a renewal');
  const h = await require('../lib/tprm/client-view').home(db, ws, {}, null);
  assert.equal(h.tabCounts.renewals, 1);
  assert.equal(h.tiles.due.months.reduce((n, m) => n + m.reviews, 0), 0, 'an overdue review is not counted in a future month');
});

test('a supplier\'s first assessment is not called a reassessment', async () => {
  const c = await tprmClient('Fix Type Client');
  const ctx = await confirmed(c, 'First Look Co', { status: 'in_use' });
  assert.equal((await assessmentRow(ctx.a)).type, 'reassessment');
  const rid = await issued(ctx, 'approve');
  const owner = await sessionFor(c.owner);
  const rec = (await owner.get(recPage(ctx.ws, rid))).text;
  assert.match(rec, /<div class="eyebrow">Assessment · version 1<\/div>/);
  const reviews = (await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=reviews`)).text;
  assert.match(reviews, /<td><b>Assessment<\/b><\/td>/);
  assert.doesNotMatch(reviews, /Reassessment/);
  const scoping = (await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=scoping`)).text;
  assert.doesNotMatch(scoping, /Reassessment/);
});

test('a decision leaves comments open on open findings for both sides; a closed finding says why it is closed', async () => {
  const c = await tprmClient('Fix Comments Client');
  const ctx = await confirmed(c, 'Comments Co');
  await addFinding(ctx, { severity: 'medium', title: 'Open gap', description: 'Still open', control_ref: 'A.8.1' });
  await addFinding(ctx, { severity: 'low', title: 'Closed gap', description: 'Fixed', control_ref: 'A.8.2' });
  await addFinding(ctx, { severity: 'medium', title: 'Shared gap', description: 'With the supplier', control_ref: 'A.8.3' });
  const fid = async title => Number((await db.prepare('SELECT id FROM tp_findings WHERE workspace_id=? AND assessment_id=? AND title=?').get(ctx.ws, ctx.a, title)).id);
  const open = await fid('Open gap');
  const closed = await fid('Closed gap');
  const shared = await fid('Shared gap');
  const row = await db.prepare('SELECT row_version FROM tp_findings WHERE id=?').get(closed);
  assert.equal((await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${closed}`, {
    severity: 'low', title: 'Closed gap', description: 'Fixed', control_ref: 'A.8.2', status: 'closed', close_reason: 'Fixed and checked', row_version: String(row.row_version) })).status, 302);
  assert.equal((await db.prepare('SELECT status FROM tp_findings WHERE id=?').get(closed)).status, 'closed');
  assert.equal((await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${shared}/share`, { title: 'Shared gap', body: 'Please fix' })).status, 302);
  const iid = Number((await db.prepare('SELECT id FROM tp_issues WHERE workspace_id=? AND finding_id=?').get(ctx.ws, shared)).id);
  const rid = await issued(ctx, 'approve');
  const owner = await sessionFor(c.owner);
  assert.equal((await decide(owner, ctx.ws, rid, { outcome: 'approve' })).status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'completed');

  const tpId = String(ctx.tp);
  assert.match(toast(await owner.post(`${portal(c.id)}/findings/${open}/comments`, { body: 'Is a compensating control enough?', third_party_id: tpId })), /Comment added/);
  assert.match(toast(await owner.post(`${portal(c.id)}/findings/${closed}/comments`, { body: 'Late', third_party_id: tpId })), /This finding is closed/);
  assert.match(toast(await owner.post(`${portal(c.id)}/issues/${iid}/comments`, { body: 'Any news?', third_party_id: tpId })), /Comment added/);
  const tab = (await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=issues`)).text;
  assert.match(tab, /data-tprm-cv-notes-closed><b>Comments closed\.<\/b> This finding is closed/);
  assert.match(tab, /data-tprm-cv-finding-form/);

  await allSteps(consultant.session, aBase(ctx.ws, ctx.tp, ctx.a));
  assert.match(toast(await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${open}/client-reply`, { body: 'Yes, if documented.' })), /Reply sent to the client/);
  assert.match(toast(await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/findings/${closed}/client-reply`, { body: 'No' })), /This finding is closed/);
  assert.match(toast(await consultant.session.post(`${aBase(ctx.ws, ctx.tp, ctx.a)}/issues/${iid}/reply`, { body: 'Chasing the supplier.' })), /Reply sent/);
  const firmPage = (await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}?step=evidence`)).text;
  assert.match(firmPage, /data-tprm-finding-reply/);
  assert.match(firmPage, /data-tprm-issue-reply/);
  assert.doesNotMatch(firmPage, /data-tprm-issue-withdraw/, 'a completed assessment still cannot withdraw issues');
});

test('the request form and Scoping speak to the client, and promise only what is true', async () => {
  const wording = require('../lib/tprm/client-wording');
  assert.equal(wording.forClient('What happens to the client if the service stops?'), 'What happens to your organisation if the service stops?');
  assert.equal(wording.forClient('What access will it have to the client\'s systems?'), 'What access will it have to your systems?');
  assert.equal(wording.forClient('Will the third party\'s staff work at client sites, or will it hold client data at its own sites?'),
    'Will the third party\'s staff work at your sites, or will it hold your data at its own sites?');
  assert.equal(wording.forClient('It has privileged, admin or network-connected access to the client\'s systems'),
    'It has privileged, admin or network-connected access to your systems');
  assert.equal(wording.forClient('Can the service create or change payments, trades, holdings or client-asset records?'),
    'Can the service create or change payments, trades, holdings or client-asset records?');
  const c = await tprmClient('Fix Wording Client');
  const owner = await sessionFor(c.owner);
  const form = (await owner.get(`${portal(c.id)}/requests/new`)).text;
  assert.doesNotMatch(quoteless(form), /\bthe client\b|the client's/);
  assert.match(form, /What happens to your organisation if the service stops\?/);
  assert.doesNotMatch(form, /as they go/);
  const ctx = await confirmed(c, 'Wording Co');
  const scoping = quoteless((await owner.get(`${portal(c.id)}/third-parties/${ctx.tp}?tab=scoping`)).text);
  assert.match(scoping, /data-tprm-cv-scoping=/);
  assert.doesNotMatch(scoping, /\bthe client\b|the client's/);
  const firm = quoteless((await consultant.session.get(`${aBase(ctx.ws, ctx.tp, ctx.a)}`)).text);
  assert.match(firm, /the client/, 'the firm keeps its own wording');
});

test('no duplicate open request; a sent request opens read-only; Withdraw asks first, with or without JavaScript', async () => {
  const c = await tprmClient('Fix Requests Client');
  const owner = await sessionFor(c.owner);
  await owner.get(`${portal(c.id)}/requests/new`);
  const body = { name: 'Orbit Secure Shred', service_description: 'Shredding archive boxes', owner_user_id: String(c.owner.id) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await owner.post(`${portal(c.id)}/requests`, { ...body })).status, 302);
  const again = await owner.post(`${portal(c.id)}/requests`, { ...body, name: '  orbit  secure SHRED ' });
  assert.equal(again.status, 409, 'the same supplier cannot be requested twice while the first request is open');
  assert.match(again.text, /already sent a request/);
  const rows = await db.prepare('SELECT * FROM tp_client_requests WHERE workspace_id=? ORDER BY id').all(c.id);
  assert.equal(rows.length, 1);
  const r = rows[0];

  const tab = (await owner.get(`${portal(c.id)}?tab=requests`)).text;
  assert.match(tab, new RegExp(`href="${portal(c.id)}/requests/${r.id}" data-tprm-cv-request-link="${r.id}"`));
  assert.match(tab, /name="_tp_confirm_title" value="Withdraw the request for Orbit Secure Shred\?"/);
  const view = await owner.get(`${portal(c.id)}/requests/${r.id}`);
  assert.equal(view.status, 200);
  assert.match(view.text, new RegExp(`data-tprm-cv-request-view="${r.id}"`));
  assert.match(view.text, /Shredding archive boxes/);
  assert.match(view.text, /Minor inconvenience/);
  assert.match(view.text, /data-tprm-cv-request-withdraw/);
  assert.match(view.text, /data-tprm-client-view/);
  const other = await tprmClient('Fix Requests Other');
  const otherOwner = await sessionFor(other.owner);
  assert.equal((await otherOwner.get(`${portal(other.id)}/requests/${r.id}`)).status, 404);

  const confirmFields = { _tp_confirm_title: 'Withdraw the request for Orbit Secure Shred?', _tp_confirm_body: 'Cannot be undone.', _tp_confirm_action: 'Withdraw request', _tp_confirm_tone: 'problem' };
  const ask = await owner.post(`${portal(c.id)}/requests/${r.id}/withdraw`, { ...confirmFields, row_version: String(r.row_version) });
  assert.equal(ask.status, 200);
  assert.match(ask.text, /data-tprm-confirm-page/);
  assert.match(ask.text, /data-tprm-client-view/, 'the no-JavaScript confirmation uses the client layout');
  assert.doesNotMatch(ask.text, /Jump to a client/);
  assert.equal((await db.prepare('SELECT status FROM tp_client_requests WHERE id=?').get(r.id)).status, 'submitted', 'nothing happens until confirmed');
  const done = await owner.post(`${portal(c.id)}/requests/${r.id}/withdraw`, { ...confirmFields, _tp_confirmed: '1', row_version: String(r.row_version) });
  assert.match(toast(done), /Request withdrawn/);
  assert.equal((await db.prepare('SELECT status FROM tp_client_requests WHERE id=?').get(r.id)).status, 'withdrawn');
  assert.equal((await owner.post(`${portal(c.id)}/requests`, { ...body })).status, 302, 'once withdrawn it can be sent again');
});

test('a client account gets client error pages and client help; firm users keep theirs', async () => {
  const c = await tprmClient('Fix Errors Client');
  const owner = await sessionFor(c.owner);
  const wrong = await owner.get('/workspaces/999999/client-portal/third-party-risk');
  assert.equal(wrong.status, 403);
  assert.match(wrong.text, /This page does not exist, or it is not available to your account\./);
  assert.doesNotMatch(wrong.text, /switched tenants|Jump to a client|>Clients<|Playbooks/);
  assert.match(wrong.text, /Back to your portal/);
  const missing = await owner.get(`${portal(c.id)}/third-parties/999999`);
  assert.equal(missing.status, 404);
  assert.match(missing.text, /data-tprm-cv-error/);
  assert.match(missing.text, /data-tprm-client-view/);
  assert.doesNotMatch(missing.text, /Jump to a client|Playbooks/);
  const firm = await consultant.session.get('/workspaces/999999');
  assert.match(firm.text, /switched tenants/, 'firm wording stays for firm users');
  assert.match(firm.text, /Something went wrong/);

  const isoPortal = await owner.get(`/workspaces/${c.id}/client-portal`);
  assert.equal(isoPortal.status, 200);
  assert.match(isoPortal.text, /data-help-area="actions"/);
  assert.match(isoPortal.text, /data-help-area="third-party-risk"/);
  assert.doesNotMatch(isoPortal.text, /<strong>Approvals<\/strong>|<strong>Engagement<\/strong>/);
  assert.doesNotMatch(isoPortal.text, /Use the Contact team button/);
  const js = fs.readFileSync(path.join(ROOT, 'public', 'site-enhancements.js'), 'utf8');
  assert.doesNotMatch(js, /button\.href = '#'/, 'Contact team never points nowhere');
});

test('firm searches ignore accents too: the command search, the register and the pipeline', async () => {
  const c = await tprmClient('Fix Firm Search Client');
  const ctx = await confirmed(c, 'Crédit Agricole Hébergement');
  const s = consultant.session;
  for (const q of ['credit agricole', 'CRÉDIT', 'hebergement']) {
    const found = JSON.parse((await s.get(`/api/search?${new URLSearchParams({ q })}`)).text).filter(r => r.type === 'Third party').map(r => r.href);
    assert.ok(found.includes(`/tprm/clients/${c.id}/third-parties/${ctx.tp}`), `command search: ${q}`);
    assert.match((await s.get(`/tprm/clients/${c.id}?q=${encodeURIComponent(q)}`)).text, new RegExp(`data-tprm-row="${ctx.tp}"`), `register: ${q}`);
    assert.match((await s.get(`/tprm?q=${encodeURIComponent(q)}`)).text, new RegExp(`data-tprm-pipeline-row="${ctx.a}"`), `pipeline: ${q}`);
  }
  assert.doesNotMatch((await s.get(`/tprm/clients/${c.id}?q=${encodeURIComponent('zz-nothing')}`)).text, new RegExp(`data-tprm-row="${ctx.tp}"`));
  assert.doesNotMatch((await s.get(`/tprm/clients/${c.id}?q=${encodeURIComponent('cr_dit')}`)).text, new RegExp(`data-tprm-row="${ctx.tp}"`), 'an underscore is not a wildcard');
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'lib', 'tprm', 'text-fold.js'), 'utf8'), /[^\x00-\x7f]/, 'the accent range is written with escapes, not raw combining characters');
});

test('search ignores accents and case; the Added card does not stretch', async () => {
  const c = await tprmClient('Fix Search Client');
  const tp = await addThirdParty(c.id, 'Société Générale Services', 'in_use');
  const owner = await sessionFor(c.owner);
  for (const q of ['societe', 'SOCIÉTÉ', 'generale']) {
    assert.match((await owner.get(`${portal(c.id)}?q=${encodeURIComponent(q)}`)).text, new RegExp(`data-tprm-portal-row="${tp}"`), q);
  }
  const css = fs.readFileSync(path.join(ROOT, 'public', 'tprm-client.css'), 'utf8');
  assert.match(css, /\.cv-hub > \[data-tprm-cv-tile="added"\] \.cv-foot \{ margin-top: 10px; \}/);
  assert.match(css, /\.cv-hub > \[data-tprm-cv-tile="added"\], \.cv-hub > \.cv-stack \{ grid-column: 1 \/ -1; \}/);
});

test('the client activity credits the issued recommendation to the reviewer who issued it, not its author', async () => {
  const c = await tprmClient('Fix Issuer Client');
  const ctx = await confirmed(c, 'Issuer Co');
  const rid = await issued(ctx, 'approve');
  const row = await db.prepare('SELECT author_id, reviewer_id FROM tp_recommendations WHERE id = ?').get(rid);
  assert.equal(Number(row.author_id), Number(consultant.id));
  assert.equal(Number(row.reviewer_id), Number(senior.id));
  const party = await require('../lib/tprm/client-view').thirdParty(db, await wsRow(ctx.ws), ctx.tp);
  const line = party.activity.find(a => /issued/.test(a.text));
  assert.equal(line.who, senior.email);
});
