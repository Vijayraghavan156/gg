'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient, allSteps } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
let env;
let client;
let db;
let firmId;
let otherFirmId;
let CR;
let R;
let events;
let rbac;
let dates;
let consultant;
let senior;
let otherManager;
let main;
const sessions = [];

const PASSWORD = 'contract-review-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };
const VALID_UNTIL = '2099-12-31';
const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tprm-question-bank.json'), 'utf8'));

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  CR = require('../lib/tprm/contract-review');
  R = require('../lib/tprm/reassessment');
  events = require('../lib/tprm/events');
  rbac = require('../lib/rbac');
  dates = require('../lib/dates');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  otherFirmId = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Contract Other Firm')`).run()).lastInsertRowid);
  consultant = await makeUser('cr-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('cr-senior@test.local', { role: 'senior_consultant' });
  otherManager = await makeUser('cr-other-manager@test.local', { role: 'manager', firm: otherFirmId });
  for (const u of [consultant, senior, otherManager]) u.session = await signIn(u.email, u.password);
  main = await tprmClient('Contract Main Client');
});

test.after(async () => {
  for (const s of sessions) await s.close();
  for (const u of [consultant, senior, otherManager]) if (u && u.session) await u.session.close();
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

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const owner = await makeUser(`cr-owner-${slug}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
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
const aBase = ctx => `/tprm/clients/${ctx.ws}/third-parties/${ctx.tp}/assessments/${ctx.a}`;
const crBase = ctx => `${aBase(ctx)}/contract-review`;
const recPage = (ws, rid) => `/workspaces/${ws}/client-portal/third-party-risk/recommendations/${rid}`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const recRow = async id => db.prepare('SELECT * FROM tp_recommendations WHERE id=?').get(id);
const rowsOf = async a => db.prepare('SELECT * FROM tp_contract_reviews WHERE assessment_id=? ORDER BY position').all(a);
const chain = async (ws, a) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='assessment' AND chain_id=? ORDER BY chain_seq`).all(ws, a);
const wsRow = async id => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const tpRow = async id => db.prepare('SELECT *, next_due_date::text AS next_due_date FROM tp_third_parties WHERE id=?').get(id);
const conditional = BANK.contract_checklist.filter(c => c.applies_to === 'All clients (good practice)' && c.required === 'Conditional');

async function addThirdParty(ws, name, status = 'proposed') {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Hosting' })).status, 302);
  return tp;
}

async function started(name, { status = 'proposed', ws = main.id } = {}) {
  const tp = await addThirdParty(ws, name, status);
  const res = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  assert.equal(res.status, 302);
  return { ws, tp, a: idIn(res.location, /assessments\/(\d+)/) };
}

async function confirmed(name, opts = {}) {
  const ctx = await started(name, opts);
  const owner = opts.owner || main.owner;
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ctx.ws, ctx.tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(ctx.a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ctx)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ctx)}/confirm`, { row_version: String((await assessmentRow(ctx.a)).row_version) })).status, 302);
  const res = await consultant.session.post(`${aBase(ctx)}/details`, {
    client_decision_owner_id: String(owner.id), due_date: '', row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(res.status, 302);
  return ctx;
}

async function startChecklist(ctx, session = consultant.session) {
  const res = await session.post(`${crBase(ctx)}/start`, {});
  assert.equal(res.status, 302, `started (${toast(res)})`);
  return res;
}

async function submitRecommendation(ctx, outcome = 'approve') {
  const draft = await consultant.session.post(`${aBase(ctx)}/recommendations`, { row_version: String((await assessmentRow(ctx.a)).row_version) });
  assert.equal(draft.status, 302, `draft created (${toast(draft)})`);
  const rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=? ORDER BY version DESC LIMIT 1').get(ctx.a)).id);
  const res = await consultant.session.post(`${aBase(ctx)}/recommendations/${rid}`, {
    outcome, residual_rating: 'medium', rationale: 'Controls are adequate.', valid_until: VALID_UNTIL, intent: 'submit',
    row_version: String((await recRow(rid)).row_version) });
  assert.equal(res.status, 302, `submitted (${toast(res)})`);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_in_review');
  return rid;
}

function saveBody(rows, changes) {
  const body = {};
  for (const r of rows) {
    const c = changes[r.clause_id] || {};
    const pick = (k, d) => (c[k] !== undefined ? c[k] : d);
    body[`rows[r${r.id}][status]`] = pick('status', r.status);
    body[`rows[r${r.id}][contract_reference]`] = pick('contract_reference', r.contract_reference || '');
    body[`rows[r${r.id}][comment]`] = pick('comment', r.comment || '');
    body[`rows[r${r.id}][finding_id]`] = pick('finding_id', r.finding_id ? String(r.finding_id) : '');
    body[`rows[r${r.id}][row_version]`] = String(pick('row_version', r.row_version));
  }
  return body;
}

test('bank version 1 holds the 47 clauses; only "All clients" clauses are in scope; conditional ones follow the modules', async () => {
  const v1 = await db.prepare('SELECT content, content_sha256 FROM tp_question_bank_versions WHERE version = 1').get();
  assert.equal(v1.content.contract_checklist.length, 47, 'the published version 1 contains the contract checklist');
  const scope = CR.clausesInScope(v1.content);
  assert.equal(scope.length, 39);
  assert.ok(scope.every(c => c.applies_to === 'All clients (good practice)'));
  assert.equal(CR.clausesInScope(v1.content, { rulebooks: ['RBI'] }).length, 42, 'a rulebook adds its clauses');
  assert.deepEqual(CR.clausesInScope({ questions: [] }), [], 'a bank without a checklist has no clauses');
  const rows = scope.map(c => ({ clause_id: c.id, conditional: c.required === 'Conditional', module: c.module === '-' ? null : c.module, status: 'not_reviewed' }));
  assert.equal(CR.visibleRows(rows, null).length, 39, 'no questionnaire: every clause shows');
  assert.equal(CR.visibleRows(rows, []).length, 31, 'no modules: only the unconditional clauses');
  assert.equal(CR.visibleRows(rows, ['Hosting Platform & Cloud Provider']).length, 34);
  assert.equal(CR.visibleRows(rows, ['Hosting Platform & Cloud Provider', 'Software & Application Security']).length, 37);
  const reviewed = rows.map(r => (r.clause_id === 'CT-28' ? { ...r, status: 'missing' } : r));
  assert.ok(CR.visibleRows(reviewed, []).some(r => r.clause_id === 'CT-28'), 'a reviewed clause always shows');
  assert.equal(conditional.length, 8);
});

test('starting creates the clauses for every client from the latest bank (no questionnaire), once', async () => {
  const ctx = await started('Checklist Start Co');
  const page = await allSteps(consultant.session, aBase(ctx));
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-contract-step/);
  assert.match(page.text, /data-tprm-contract-start/);
  await startChecklist(ctx);
  const rows = await rowsOf(ctx.a);
  assert.equal(rows.length, 39);
  const bank = await db.prepare('SELECT id, version, content_sha256 FROM tp_question_bank_versions ORDER BY version DESC LIMIT 1').get();
  assert.ok(rows.every(r => Number(r.bank_version_id) === Number(bank.id) && r.status === 'not_reviewed'));
  assert.deepEqual(rows.filter(r => r.conditional).map(r => r.clause_id).sort(), conditional.map(c => c.id).sort());
  assert.equal(rows.find(r => r.clause_id === 'CT-39').module, 'Hosting Platform & Cloud Provider');
  const ev = (await chain(ctx.ws, ctx.a)).find(e => e.action === 'contract_review.started');
  assert.equal(ev.after_state.bank_sha256, bank.content_sha256);
  assert.equal(ev.after_state.clause_count, 39);
  assert.equal(ev.after_state.bank_from, 'latest');
  const again = await consultant.session.post(`${crBase(ctx)}/start`, {});
  assert.match(toast(again), /already started/);
  assert.equal((await rowsOf(ctx.a)).length, 39);
  const list = await consultant.session.get(crBase(ctx));
  assert.equal(list.status, 200);
  assert.equal((list.text.match(/data-tprm-clause="/g) || []).length, 39, 'no questionnaire: every conditional clause shows');
  assert.match(list.text, /data-tprm-contract-form/);
  await assert.rejects(db.prepare(`INSERT INTO tp_contract_reviews (workspace_id, assessment_id, bank_version_id, bank_version, clause_id, position, applies_to, created_by)
    VALUES (?, ?, ?, ?, 'CT-99', 99, 'All clients (good practice)', 1)`).run(ctx.ws, ctx.a, bank.id, bank.version), /not in the pinned question bank/);
  await assert.rejects(db.prepare(`UPDATE tp_contract_reviews SET clause_id = 'CT-02' WHERE id = ?`).run(rows[0].id), /never changes|clause_key/);
});

test('with a questionnaire: its bank version is pinned and conditional clauses follow its modules at read time', async () => {
  const ctx = await confirmed('Checklist Modules Co');
  const prep = await consultant.session.post(`${aBase(ctx)}/questionnaire`, { delivery_model: 'vendor_hosted' });
  assert.equal(prep.status, 302, toast(prep));
  const q = await db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id=?').get(ctx.a);
  assert.ok(q.modules.some(m => m.module === 'Hosting Platform & Cloud Provider' && m.included));
  await startChecklist(ctx);
  const rows = await rowsOf(ctx.a);
  assert.ok(rows.every(r => Number(r.bank_version_id) === Number(q.bank_version_id)));
  assert.equal((await chain(ctx.ws, ctx.a)).find(e => e.action === 'contract_review.started').after_state.bank_from, 'questionnaire');
  let page = await consultant.session.get(crBase(ctx));
  const shown = () => [...page.text.matchAll(/data-tprm-clause="([^"]+)"/g)].map(m => m[1]);
  assert.equal(shown().length, 34, '31 unconditional + 3 Hosting Platform & Cloud Provider');
  assert.ok(shown().includes('CT-39') && !shown().includes('CT-28'));
  assert.match(page.text, /data-tprm-contract-hidden="5"/);
  const add = await consultant.session.post(`${aBase(ctx)}/questionnaire/modules`, {
    op: 'add', module: 'Software & Application Security', reason: 'Supplies an API', row_version: String(q.row_version) });
  assert.equal(add.status, 302, toast(add));
  page = await consultant.session.get(crBase(ctx));
  assert.equal(shown().length, 37);
  assert.ok(shown().includes('CT-28'));
  const panel = await CR.panel(db, { user: { id: consultant.id, user_type: 'firm', firm_id: firmId, firm_role: 'consultant' },
    perms: new Set(rbac.rolePermissions('consultant')), ws: await wsRow(ctx.ws) }, await assessmentRow(ctx.a));
  assert.equal(panel.total, 37);
  assert.equal(panel.hiddenCount, 2);
});

test('saving statuses, references, comments and links; stale and invalid input refused; raise finding pre-filled and linked', async () => {
  const ctx = await confirmed('Checklist Save Co');
  await startChecklist(ctx);
  let rows = await rowsOf(ctx.a);
  const res = await consultant.session.post(crBase(ctx), saveBody(rows, {
    'CT-01': { status: 'present_satisfactory', contract_reference: 'MSA 3.1' },
    'CT-02': { status: 'present_gap', contract_reference: 'Schedule 2', comment: 'SLA has no service credits.' },
    'CT-03': { status: 'missing', comment: 'No SLA review clause.' },
    'CT-08': { status: 'not_required', comment: 'Not relevant to this service.' },
  }));
  assert.equal(res.status, 302, toast(res));
  assert.match(toast(res), /4 clauses changed/);
  rows = await rowsOf(ctx.a);
  const by = id => rows.find(r => r.clause_id === id);
  assert.equal(by('CT-02').status, 'present_gap');
  assert.equal(by('CT-02').contract_reference, 'Schedule 2');
  assert.equal(by('CT-02').comment, 'SLA has no service credits.');
  assert.equal(Number(by('CT-02').reviewed_by), consultant.id);
  assert.ok(by('CT-02').reviewed_at);
  assert.equal(by('CT-02').row_version, 2);
  assert.equal(by('CT-05').row_version, 1, 'unchanged rows are not written');
  const ev = (await chain(ctx.ws, ctx.a)).filter(e => e.action === 'contract_review.updated').at(-1);
  assert.deepEqual(ev.after_state.rows.map(r => r.clause_id), ['CT-01', 'CT-02', 'CT-03', 'CT-08']);
  assert.deepEqual(ev.before_state.rows[1], { clause_id: 'CT-02', status: 'not_reviewed', contract_reference: null, comment: null });
  assert.match(toast(await consultant.session.post(crBase(ctx), saveBody(rows, {}))), /No changes to save/);
  const stale = await consultant.session.post(crBase(ctx), saveBody(rows, { 'CT-05': { status: 'missing' }, 'CT-02': { row_version: 1, status: 'missing' } }));
  assert.equal(stale.status, 409);
  assert.equal((await rowsOf(ctx.a)).find(r => r.clause_id === 'CT-05').status, 'not_reviewed');
  const bad = await consultant.session.post(crBase(ctx), saveBody(rows, { 'CT-05': { status: 'great' }, 'CT-06': { contract_reference: 'x'.repeat(301) } }));
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Choose a status for every clause/);
  assert.match(bad.text, /300 characters or fewer/);
  const ap = await allSteps(consultant.session, aBase(ctx));
  assert.match(ap.text, /data-tprm-contract-progress>4 of 39 clauses reviewed/);
  assert.match(ap.text, /data-tprm-contract-gaps/);

  const form = await consultant.session.get(`${crBase(ctx)}/${by('CT-03').id}/finding`);
  assert.equal(form.status, 200);
  assert.match(form.text, /name="control_ref" value="A\.5\.20"/);
  assert.match(form.text, /<option value="low" selected>/, 'severity from the tier (Low)');
  assert.match(form.text, /name="title" value="Contract clause CT-03: Service Scope &amp; SLA"/);
  assert.match(form.text, /Contract review: Missing\.[^]*Reviewer comment: No SLA review clause\./);
  assert.match(form.text, /SLA review frequency/);
  const raised = await consultant.session.post(`${crBase(ctx)}/${by('CT-03').id}/finding`, {
    control_ref: 'A.5.20', severity: 'medium', title: 'No SLA review clause', description: 'The contract has no SLA review.',
    contract_row_version: String(by('CT-03').row_version) });
  assert.equal(raised.status, 302, toast(raised));
  assert.match(toast(raised), /linked to CT-03/);
  const finding = await db.prepare('SELECT * FROM tp_findings WHERE assessment_id=? AND title=?').get(ctx.a, 'No SLA review clause');
  assert.ok(finding);
  assert.equal(finding.source, 'consultant');
  rows = await rowsOf(ctx.a);
  assert.equal(Number(by('CT-03').id) && Number(rows.find(r => r.clause_id === 'CT-03').finding_id), Number(finding.id));
  const actions = (await chain(ctx.ws, ctx.a)).map(e => e.action);
  assert.ok(actions.indexOf('finding.added') < actions.indexOf('contract_review.finding_raised'));
  const twice = await consultant.session.post(`${crBase(ctx)}/${rows.find(r => r.clause_id === 'CT-03').id}/finding`, {
    severity: 'low', title: 'Again', contract_row_version: String(rows.find(r => r.clause_id === 'CT-03').row_version) });
  assert.equal(twice.status, 409);
  const staleRaise = await consultant.session.post(`${crBase(ctx)}/${rows.find(r => r.clause_id === 'CT-02').id}/finding`, {
    severity: 'low', title: 'Stale', contract_row_version: '1' });
  assert.equal(staleRaise.status, 409);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_findings WHERE assessment_id=?').get(ctx.a)).c, 1, 'nothing was added');
  const invalid = await consultant.session.post(`${crBase(ctx)}/${rows.find(r => r.clause_id === 'CT-02').id}/finding`, {
    severity: '', title: '', contract_row_version: String(rows.find(r => r.clause_id === 'CT-02').row_version) });
  assert.equal(invalid.status, 400);
  assert.match(invalid.text, /data-tprm-form-errors/);
  const link = await consultant.session.post(crBase(ctx), saveBody(rows, { 'CT-02': { finding_id: String(finding.id) } }));
  assert.equal(link.status, 302, toast(link));
  const other = await confirmed('Checklist Other Finding Co');
  await consultant.session.post(`${aBase(other)}/findings`, { status: 'open', severity: 'low', title: 'Elsewhere' });
  const foreign = await db.prepare('SELECT id FROM tp_findings WHERE assessment_id=?').get(other.a);
  rows = await rowsOf(ctx.a);
  const cross = await consultant.session.post(crBase(ctx), saveBody(rows, { 'CT-08': { finding_id: String(foreign.id) } }));
  assert.equal(cross.status, 400);
  await assert.rejects(db.prepare('UPDATE tp_contract_reviews SET finding_id=? WHERE assessment_id=? AND clause_id=?').run(foreign.id, ctx.a, 'CT-08'),
    /tp_contract_reviews_finding_fk|foreign key/);
  const f = await db.prepare('SELECT row_version FROM tp_findings WHERE id=?').get(finding.id);
  assert.equal((await consultant.session.post(`${aBase(ctx)}/findings/${finding.id}/remove`, { row_version: String(f.row_version) })).status, 302);
  rows = await rowsOf(ctx.a);
  assert.equal(rows.find(r => r.clause_id === 'CT-03').finding_id, null);
  assert.equal(rows.find(r => r.clause_id === 'CT-03').status, 'missing');
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
});

test('the checklist freezes with the findings; it never reaches the client portal; a trigger ends with the positive decision', async () => {
  const ws = main.id;
  const tp = await addThirdParty(ws, 'Checklist Freeze Co', 'in_use');
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/triggers`, { reason: 'ai_change', details: 'Switched model provider' })).status, 302);
  const today = dates.todayFor(await wsRow(ws));
  assert.equal((await tpRow(tp)).next_due_date, today);
  const started2 = await consultant.session.post(`/tprm/clients/${ws}/third-parties/${tp}/assessments`, {});
  const ctx = { ws, tp, a: idIn(started2.location, /assessments\/(\d+)/) };
  assert.equal((await assessmentRow(ctx.a)).type, 'reassessment');
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(ws, tp)).map(r => String(r.id));
  const body = { services: svc, intent: 'propose', row_version: String((await assessmentRow(ctx.a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${aBase(ctx)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ctx)}/confirm`, { row_version: String((await assessmentRow(ctx.a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(`${aBase(ctx)}/details`, {
    client_decision_owner_id: String(main.owner.id), due_date: '', row_version: String((await assessmentRow(ctx.a)).row_version) })).status, 302);
  await startChecklist(ctx);
  let rows = await rowsOf(ctx.a);
  const SECRET = `CONTRACT-ONLY-COMMENT-${crypto.randomBytes(4).toString('hex')}`;
  assert.equal((await consultant.session.post(crBase(ctx), saveBody(rows, {
    'CT-05': { status: 'present_gap', comment: SECRET, contract_reference: 'DPA-REF-77' } }))).status, 302);
  rows = await rowsOf(ctx.a);

  const rid = await submitRecommendation(ctx);
  const save = await consultant.session.post(crBase(ctx), saveBody(rows, { 'CT-06': { status: 'missing' } }));
  assert.equal(save.status, 409);
  assert.match(save.text, /evidence, findings and contract checklist it is based on are frozen/);
  assert.equal((await consultant.session.get(`${crBase(ctx)}/${rows[1].id}/finding`)).status, 409);
  assert.equal((await consultant.session.post(`${crBase(ctx)}/${rows[1].id}/finding`, { severity: 'low', title: 'x', contract_row_version: String(rows[1].row_version) })).status, 409);
  await assert.rejects(db.prepare(`UPDATE tp_contract_reviews SET status='missing' WHERE id=?`).run(rows[1].id), /frozen/);
  await assert.rejects(db.prepare('DELETE FROM tp_contract_reviews WHERE id=?').run(rows[1].id), /frozen/);
  const page = await consultant.session.get(crBase(ctx));
  assert.match(page.text, /data-tprm-contract-frozen/);
  assert.doesNotMatch(page.text, /data-tprm-contract-form|data-tprm-contract-save|data-tprm-raise-contract-finding/);
  assert.match(page.text, new RegExp(SECRET), 'the firm still reads it');
  assert.equal((await consultant.session.post(`${aBase(ctx)}/recommendations/${rid}/recall`, { row_version: String((await recRow(rid)).row_version) })).status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_draft');
  rows = await rowsOf(ctx.a);
  assert.equal((await consultant.session.post(crBase(ctx), saveBody(rows, { 'CT-06': { status: 'present_satisfactory' } }))).status, 302);
  const resubmit = await consultant.session.post(`${aBase(ctx)}/recommendations/${rid}`, {
    outcome: 'approve', residual_rating: 'medium', rationale: 'Controls are adequate.', valid_until: VALID_UNTIL, intent: 'submit',
    row_version: String((await recRow(rid)).row_version) });
  assert.equal(resubmit.status, 302);
  assert.equal((await senior.session.post(`${aBase(ctx)}/recommendations/${rid}/issue`, { row_version: String((await recRow(rid)).row_version) })).status, 302);
  assert.equal((await assessmentRow(ctx.a)).status, 'recommendation_issued');

  const owner = await sessionFor(main.owner);
  for (const url of [`/workspaces/${ws}/client-portal/third-party-risk`, recPage(ws, rid)]) {
    const res = await owner.get(url);
    assert.equal(res.status, 200, url);
    assert.doesNotMatch(res.text, new RegExp(`${SECRET}|DPA-REF-77|Contract checklist|data-tprm-contract|CT-05`), url);
  }
  assert.ok([403, 404].includes((await owner.get(crBase(ctx))).status), 'the firm page is not for client users');
  assert.ok([403, 404].includes((await allSteps(owner, aBase(ctx))).status));

  assert.equal((await R.openTriggers(db, ws, [await tpRow(tp)])).size, 1);
  const decided = await owner.post(`${recPage(ws, rid)}/decision`, { outcome: 'approve' });
  assert.equal(decided.status, 302, toast(decided));
  assert.equal((await assessmentRow(ctx.a)).status, 'completed');
  const after = await tpRow(tp);
  assert.ok(after.next_due_date > today, 'the decision moved the due date on');
  assert.equal((await R.openTriggers(db, ws, [after])).size, 0, 'the trigger has ended');
  assert.doesNotMatch((await client.get(`/tprm/due?client=${ws}`)).text, new RegExp(`data-tprm-due-row="${tp}"[^]*?Triggered`));
  await assert.rejects(db.prepare(`UPDATE tp_contract_reviews SET comment='late' WHERE id=?`).run(rows[0].id), /frozen/);
  assert.deepEqual(await events.verifyChains(db, ws), []);
});

test('the third party\'s questionnaire page never shows the checklist; only the contract module reads the table', async () => {
  const ctx = await confirmed('Checklist Vendor Page Co');
  assert.equal((await consultant.session.post(`${aBase(ctx)}/questionnaire`, { delivery_model: 'vendor_hosted' })).status, 302);
  await startChecklist(ctx);
  const rows = await rowsOf(ctx.a);
  const SECRET = `VENDOR-NEVER-SEES-${crypto.randomBytes(4).toString('hex')}`;
  assert.equal((await consultant.session.post(crBase(ctx), saveBody(rows, { 'CT-01': { status: 'missing', comment: SECRET } }))).status, 302);
  const summary = await require('../lib/tprm/contract-review').reportSummary(db,
    await db.prepare('SELECT * FROM workspaces WHERE id=?').get(ctx.ws), await db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(ctx.a));
  assert.equal(summary.missing, 1);
  assert.equal(summary.clauses, summary.satisfactory + summary.gaps + summary.missing + summary.not_required + summary.not_reviewed);
  assert.ok(summary.clauses <= rows.length && summary.clauses > 1);
  assert.equal(JSON.stringify(summary).includes(SECRET), false);
  const q = await db.prepare('SELECT row_version FROM tp_questionnaires WHERE assessment_id=?').get(ctx.a);
  const created = await consultant.session.post(`${aBase(ctx)}/questionnaire/links`, {
    recipient_name: 'Vendor Person', recipient_email: 'vendor@example.test', expires_in_days: '30', row_version: String(q.row_version) });
  assert.equal(created.status, 200, `link created (${created.status} ${toast(created)})`);
  const token = (created.text.match(/\/vendor\/q\/([A-Za-z0-9_-]{43})/) || [])[1];
  assert.ok(token, 'the link is shown once');
  const anon = makeClient(env.app);
  sessions.push(anon);
  const vendorPage = await anon.get(`/vendor/q/${token}`);
  assert.equal(vendorPage.status, 200);
  assert.doesNotMatch(vendorPage.text, new RegExp(`${SECRET}|Contract checklist|data-tprm-contract|Contract clause`));

  const offenders = [];
  const walk = dir => {
    for (const item of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, item.name);
      if (item.isDirectory()) walk(rel);
      else if (/\.(js|ejs)$/.test(item.name) && /tp_contract_reviews/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) offenders.push(rel);
    }
  };
  for (const dir of ['routes', 'lib', 'views']) walk(dir);
  assert.deepEqual(offenders.sort(), [path.join('lib', 'restore-check.js'), path.join('lib', 'tprm', 'contract-review.js')].sort());
  for (const v of fs.readdirSync(path.join(ROOT, 'views')).filter(n => /portal|vendor/.test(n))) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'views', v), 'utf8'), /contractReview|contract-review|tprm_assessment_contract/, v);
  }
  for (const f of ['routes/tprm-vendor.js', 'lib/tprm/vendor-answers.js', 'lib/tprm/decisions.js', 'routes/third-party-risk.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /contract-review/, f);
  }
});

test('isolation: another client\'s or firm\'s checklist is not found; CSRF is required', async () => {
  const one = await confirmed('Checklist Isolation One');
  await startChecklist(one);
  const [row] = await rowsOf(one.a);
  const other = await tprmClient('Checklist Isolation Client');
  const two = await confirmed('Checklist Isolation Two', { ws: other.id, owner: other.owner });
  await startChecklist(two);
  assert.equal((await consultant.session.get(`${crBase(two)}/${row.id}/finding`)).status, 404);
  const rows2 = await rowsOf(two.a);
  const crossBody = saveBody(rows2.slice(0, 1), {});
  crossBody[`rows[r${row.id}][status]`] = 'missing';
  crossBody[`rows[r${row.id}][row_version]`] = String(row.row_version);
  assert.equal((await consultant.session.post(crBase(two), crossBody)).status, 404);
  assert.equal((await rowsOf(one.a))[0].status, 'not_reviewed');
  assert.equal((await consultant.session.get(`/tprm/clients/${one.ws}/third-parties/${two.tp}/assessments/${two.a}/contract-review`)).status, 404);
  assert.equal((await otherManager.session.get(crBase(one))).status, 404);
  assert.equal((await otherManager.session.post(`${crBase(one)}/start`, {})).status, 404);
  const noToken = await consultant.session.post(crBase(one), saveBody([row], { [row.clause_id]: { status: 'missing' } }), { csrf: false });
  assert.equal(noToken.status, 403);
  assert.equal((await consultant.session.post(`${crBase(one)}/start`, {}, { csrf: false })).status, 403);
  assert.equal((await rowsOf(one.a))[0].status, 'not_reviewed');
});

test('deleting a client removes its checklists (frozen, with a linked finding); chains verify', async () => {
  const doomed = await tprmClient('Checklist Delete Client');
  const ctx = await confirmed('Checklist Delete Co', { ws: doomed.id, owner: doomed.owner });
  await startChecklist(ctx);
  const rows = await rowsOf(ctx.a);
  assert.equal((await consultant.session.post(crBase(ctx), saveBody(rows, { 'CT-01': { status: 'missing' } }))).status, 302);
  const r1 = (await rowsOf(ctx.a))[0];
  assert.equal((await consultant.session.post(`${crBase(ctx)}/${r1.id}/finding`, {
    severity: 'low', title: 'Delete me', contract_row_version: String(r1.row_version) })).status, 302);
  await submitRecommendation(ctx);
  assert.deepEqual(await events.verifyChains(db, ctx.ws), []);
  const name = (await wsRow(ctx.ws)).client_name;
  assert.equal((await client.post(`/workspaces/${ctx.ws}/delete`, { confirm_name: name })).status, 302);
  for (const table of ['tp_contract_reviews', 'tp_findings', 'tp_assessments', 'tp_events']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ctx.ws)).c, 0, table);
  }
  const direct = await tprmClient('Checklist Direct Delete Client');
  const d = await confirmed('Checklist Direct Co', { ws: direct.id, owner: direct.owner });
  await startChecklist(d);
  const dr = (await rowsOf(d.a))[0];
  assert.equal((await consultant.session.post(`${crBase(d)}/${dr.id}/finding`, { severity: 'low', title: 'Direct', contract_row_version: String(dr.row_version) })).status, 302);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(direct.id);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_contract_reviews WHERE workspace_id=?').get(direct.id)).c, 0);
});
