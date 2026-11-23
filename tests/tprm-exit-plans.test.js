'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient, allSteps } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'exit-plans-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };
const VALID_UNTIL = '2099-12-31';
const FULL_PLAN = {
  alternative_provider: 'Second Cloud Ltd, already on the approved list',
  data_return: 'Full export in open formats within 30 days; deletion certificate within 60 days',
  switch_time: '6', switch_unit: 'months', last_tested_on: '2026-10-01', notes: 'Tabletop review with the client in October',
};

let env;
let client;
let db;
let firmId;
let otherFirmId;
let EP;
let RB;
let events;
let report;
let dates;
let consultant;
let senior;
let otherManager;
const sessions = [];
const createdPaths = new Set();

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  EP = require('../lib/tprm/exit-plans');
  RB = require('../lib/tprm/rulebooks');
  events = require('../lib/tprm/events');
  report = require('../lib/tprm/report');
  dates = require('../lib/dates');
  report.configure({ renderPdf: async html => Buffer.from(`%PDF-1.4 stub ${crypto.createHash('sha256').update(html).digest('hex')}`) });
  firmId = Number((await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id);
  otherFirmId = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Exit Plans Other Firm')`).run()).lastInsertRowid);
  consultant = await makeUser('ep-consultant@test.local', { role: 'consultant', name: 'Casey Consultant' });
  senior = await makeUser('ep-senior@test.local', { role: 'senior_consultant', name: 'Sam Senior' });
  otherManager = await makeUser('ep-other-manager@test.local', { role: 'manager', firm: otherFirmId });
  for (const u of [consultant, senior, otherManager]) u.session = await signIn(u.email, u.password);
});

test.after(async () => {
  for (const p of await db.prepare('SELECT stored_path FROM tp_condition_proof_files').all()) createdPaths.add(p.stored_path);
  for (const stored of createdPaths) {
    for (const dir of fs.existsSync(path.join(ROOT, 'uploads')) ? fs.readdirSync(path.join(ROOT, 'uploads')) : []) {
      try { fs.unlinkSync(path.join(ROOT, 'uploads', dir, stored)); } catch (_) {}
    }
  }
  for (const s of sessions) await s.close();
  for (const u of [consultant, senior, otherManager]) if (u && u.session) await u.session.close();
  if (client) await client.close();
});

async function makeUser(email, { type = 'firm', role = 'consultant', firm = firmId, workspaceId = null, memberRole = null, name = null } = {}) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,?,?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), name || email, type, type === 'firm' ? firm : null,
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

const slugOf = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function tprmClient(name, ticked = []) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  const owner = await makeUser(`ep-owner-${slugOf(name)}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner', name: `Owner of ${name}` });
  if (ticked.length) assert.equal((await tick(id, ticked)).status, 302);
  return { id, owner };
}

async function tick(ws, keys) {
  const ids = [];
  for (const k of keys) ids.push(String((await db.prepare('SELECT id FROM tp_rulebooks WHERE firm_id=? AND key=?').get(firmId, k)).id));
  const fp = RB.fingerprint((await db.prepare('SELECT rulebook_id FROM tp_client_rulebooks WHERE workspace_id=?').all(ws)).map(r => Number(r.rulebook_id)));
  return await client.post(`/tprm/clients/${ws}/rulebooks`, { rulebook: ids, fingerprint: fp });
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const tpBase = (ws, tp) => `/tprm/clients/${ws}/third-parties/${tp}`;
const aBase = ctx => `${tpBase(ctx.ws, ctx.tp)}/assessments/${ctx.a}`;
const rBase = ctx => `${aBase(ctx)}/recommendations`;
const portal = ws => `/workspaces/${ws}/client-portal/third-party-risk`;
const recPage = ctx => `${portal(ctx.ws)}/recommendations/${ctx.rid}`;
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);
const recRow = async id => db.prepare('SELECT *, valid_until::text AS valid_until FROM tp_recommendations WHERE id=?').get(id);
const serviceRow = async id => db.prepare('SELECT * FROM tp_services WHERE id=?').get(id);
const conditionsOf = async rid => db.prepare('SELECT *, due_date::text AS due_date FROM tp_conditions WHERE recommendation_id=? ORDER BY position, id').all(rid);
const autoOf = async rid => (await conditionsOf(rid)).filter(c => c.automatic);
const chain = async (ws, type, id) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type=? AND chain_id=? ORDER BY chain_seq`).all(ws, type, id);
const wsRow = async id => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);

async function addThirdParty(ws, name, status = 'proposed', services = [{ description: 'Core banking hosting' }]) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  for (const s of services) assert.equal((await client.post(`${tpBase(ws, tp)}/services`, s)).status, 302);
  const sids = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=? ORDER BY id').all(ws, tp)).map(r => Number(r.id));
  return { tp, sids };
}

async function markMaterial(ws, tp, sid, material = true, session = consultant.session) {
  await session.get(tpBase(ws, tp));
  return await session.post(`${tpBase(ws, tp)}/services/${sid}/material`, {
    ...(material ? { material: '1' } : {}), reason: material ? 'Supports a critical function (RBI outsourcing)' : 'No longer supports a critical function',
    row_version: String((await serviceRow(sid)).row_version) });
}

async function savePlan(ws, tp, sid, values, session = consultant.session) {
  const plan = await db.prepare('SELECT row_version FROM tp_exit_plans WHERE service_id=?').get(sid);
  return await session.post(`${tpBase(ws, tp)}/services/${sid}/exit-plan`, { ...values, row_version: String(plan ? plan.row_version : 0) });
}

async function confirmed(c, name, { status = 'proposed', material = false, draft = true, services } = {}) {
  const ws = c.id;
  const { tp, sids } = await addThirdParty(ws, name, status, services);
  if (material) for (const sid of sids) assert.equal((await markMaterial(ws, tp, sid)).status, 302);
  const started = await consultant.session.post(`${tpBase(ws, tp)}/assessments`, {});
  assert.equal(started.status, 302);
  const a = idIn(started.location, /assessments\/(\d+)/);
  const body = { services: sids.map(String), intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  const ctx = { ws, tp, a, sids, c };
  assert.equal((await consultant.session.post(`${aBase(ctx)}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${aBase(ctx)}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(`${aBase(ctx)}/details`, {
    client_decision_owner_id: String(c.owner.id), due_date: '', row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  if (draft) {
    assert.equal((await consultant.session.post(rBase(ctx), { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
    ctx.rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=? ORDER BY version DESC').get(a)).id);
  }
  return ctx;
}

async function saveDraft(ctx, outcome, extra = {}, { intent = 'save' } = {}) {
  await allSteps(consultant.session, aBase(ctx));
  const auto = await autoOf(ctx.rid);
  const body = { outcome, residual_rating: 'medium', rationale: 'Adequate for the service.', valid_until: outcome === 'reject' ? '' : VALID_UNTIL,
    intent, row_version: String((await recRow(ctx.rid)).row_version), ...extra };
  for (const c of auto) if (body[`auto_conditions[c${c.id}][due_date]`] === undefined) body[`auto_conditions[c${c.id}][due_date]`] = c.due_date;
  return await consultant.session.post(`${rBase(ctx)}/${ctx.rid}`, body);
}

async function issue(ctx) {
  return await senior.session.post(`${rBase(ctx)}/${ctx.rid}/issue`, { row_version: String((await recRow(ctx.rid)).row_version) });
}

async function decideOn(ctx, outcome) {
  const owner = await sessionFor(ctx.c.owner);
  await owner.get(recPage(ctx));
  const res = await owner.post(`${recPage(ctx)}/decision`, { outcome });
  assert.equal(res.status, 302, `decision recorded (${toast(res)})`);
}

function multipart(token, files, fields = {}) {
  const boundary = '----tprmep' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  if (token) parts.push(`--${boundary}`, 'Content-Disposition: form-data; name="_csrf"', '', token);
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${k}"`, '', String(v));
  for (const f of files) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="files"; filename="${f.filename}"`, `Content-Type: ${f.type || 'text/plain'}`, '', f.content);
  }
  parts.push(`--${boundary}--`, '');
  return { body: parts.join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function withDisabled(table, trigger, fn) {
  await db.exec(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try { return await fn(); } finally { await db.exec(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); }
}

test('material flag: hidden for an unregulated client, shown and changed (tp.manage) for an RBI-ticked one, with events', async () => {
  const plain = await tprmClient('EP Unregulated Client');
  const { tp: ptp, sids: [psid] } = await addThirdParty(plain.id, 'Plain Vendor Ltd');
  const page = await consultant.session.get(tpBase(plain.id, ptp));
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /data-tprm-exit-plans/, 'an unregulated client sees no material flag or exit plan');
  assert.doesNotMatch(page.text, /Mark material/);
  assert.equal((await markMaterial(plain.id, ptp, psid)).status, 404);
  assert.equal((await consultant.session.get(`${tpBase(plain.id, ptp)}/services/${psid}/exit-plan`)).status, 404);
  assert.equal((await savePlan(plain.id, ptp, psid, FULL_PLAN)).status, 404);
  assert.equal((await serviceRow(psid)).material, false);

  const rbi = await tprmClient('EP RBI Client', ['rbi_commercial_banks']);
  const { tp, sids: [sid] } = await addThirdParty(rbi.id, 'Core Bank Hosting Ltd');
  const shown = await consultant.session.get(tpBase(rbi.id, tp));
  assert.match(shown.text, /data-tprm-exit-plans/);
  assert.match(shown.text, /data-tprm-exit-plans-required/);
  assert.match(shown.text, new RegExp(`data-tprm-material-service="${sid}" data-tprm-material="no"`));
  await consultant.session.get(tpBase(rbi.id, tp));
  const noReason = await consultant.session.post(`${tpBase(rbi.id, tp)}/services/${sid}/material`, { material: '1', reason: '', row_version: String((await serviceRow(sid)).row_version) });
  assert.match(toast(noReason), /Say why the service is material/);
  const stale = await consultant.session.post(`${tpBase(rbi.id, tp)}/services/${sid}/material`, { material: '1', reason: 'x', row_version: '99' });
  assert.match(toast(stale), /Someone else changed this service/);
  assert.equal((await markMaterial(rbi.id, tp, sid)).status, 302);
  const row = await serviceRow(sid);
  assert.equal(row.material, true);
  assert.equal(Number(row.material_by), consultant.id);
  assert.match(row.material_reason, /critical function/);
  const marked = (await consultant.session.get(tpBase(rbi.id, tp))).text;
  assert.match(marked, new RegExp(`data-tprm-material-service="${sid}" data-tprm-material="yes"`));
  assert.doesNotMatch(marked, /data-tprm-unmark-material/, 'a consultant is not offered "Mark not material"');
  assert.match(marked, /data-tprm-unmark-manager-only/);
  assert.equal((await markMaterial(rbi.id, tp, sid, false)).status, 403, 'a consultant cannot unmark');
  assert.equal((await markMaterial(rbi.id, tp, sid, false, senior.session)).status, 403, 'a senior consultant cannot unmark');
  await assert.rejects(EP.setMaterial(db, { user: { ...consultant }, perms: new Set(require('../lib/rbac').rolePermissions('consultant')), ws: await wsRow(rbi.id) }, tp, sid,
    { reason: 'x', row_version: String((await serviceRow(sid)).row_version) }), err => err.status === 403, 'the domain refuses too');
  await assert.rejects(db.prepare(`UPDATE tp_services SET material = false, material_by = ?, material_at = now(), material_reason = 'x' WHERE id = ?`)
    .run(consultant.id, sid), /only a manager/);
  await assert.rejects(db.prepare(`UPDATE tp_services SET material = false WHERE id = ?`).run(sid), /only a manager/);
  assert.equal((await serviceRow(sid)).material, true);
  assert.match((await client.get(tpBase(rbi.id, tp))).text, /data-tprm-unmark-material/, 'the manager is offered it');
  const noUnmarkReason = await client.post(`${tpBase(rbi.id, tp)}/services/${sid}/material`, { reason: '', row_version: String((await serviceRow(sid)).row_version) });
  assert.match(toast(noUnmarkReason), /Say why the service is no longer material/);
  assert.equal((await markMaterial(rbi.id, tp, sid, false, client)).status, 302);
  const unmarked = await serviceRow(sid);
  assert.equal(unmarked.material, false);
  assert.equal(Number(unmarked.material_by), Number((await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id));
  assert.match(unmarked.material_reason, /No longer supports/);
  const ev = (await chain(rbi.id, 'third_party', tp)).filter(e => e.action === 'service.material_changed');
  assert.deepEqual(ev.map(e => [e.before_state.material, e.after_state.material]), [[false, true], [true, false]]);
  assert.equal(Number(ev[0].actor_user_id), consultant.id);
  const ownerSession = await sessionFor(rbi.owner);
  assert.ok([403, 404].includes((await ownerSession.post(`${tpBase(rbi.id, tp)}/services/${sid}/material`, { material: '1', reason: 'x', row_version: '1' })).status), 'a client user is refused');
  assert.equal((await consultant.session.post(`${tpBase(rbi.id, tp)}/services/${sid}/material`, { material: '1', reason: 'x', row_version: String((await serviceRow(sid)).row_version) }, { csrf: false })).status, 403);
});

test('exit plan completeness: complete only when the four parts are filled (the database computes it); validation and events', async () => {
  assert.deepEqual(EP.missingParts(null), ['Alternative provider', 'Data return and deletion', 'Time to switch', 'Date last tested or reviewed']);
  assert.deepEqual(EP.missingParts({ alternative_provider: 'X', data_return: ' ', switch_time: 3, switch_unit: 'weeks', last_tested_on: null }),
    ['Data return and deletion', 'Date last tested or reviewed']);
  assert.equal(EP.isComplete({ alternative_provider: 'X', data_return: 'Y', switch_time: 3, switch_unit: 'weeks', last_tested_on: '2026-01-01' }), true);

  const rbi = await tprmClient('EP Plan Client', ['rbi_commercial_banks']);
  const { tp, sids: [sid] } = await addThirdParty(rbi.id, 'Plan Vendor Ltd');
  const form = await consultant.session.get(`${tpBase(rbi.id, tp)}/services/${sid}/exit-plan`);
  assert.equal(form.status, 200);
  assert.match(form.text, /data-tprm-exit-plan-state="none"/);
  const partial = await savePlan(rbi.id, tp, sid, { alternative_provider: 'Second Cloud Ltd', data_return: 'Export in 30 days' });
  assert.equal(partial.status, 302);
  assert.match(toast(partial), /incomplete/);
  assert.equal((await db.prepare('SELECT status FROM tp_exit_plans WHERE service_id=?').get(sid)).status, 'incomplete');
  const bad = await savePlan(rbi.id, tp, sid, { ...FULL_PLAN, switch_unit: 'years', last_tested_on: '2999-01-01' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Choose days, weeks or months/);
  assert.match(bad.text, /cannot be in the future/);
  const stale = await consultant.session.post(`${tpBase(rbi.id, tp)}/services/${sid}/exit-plan`, { ...FULL_PLAN, row_version: '0' });
  assert.match(toast(stale), /Someone else changed this exit plan/);
  const full = await savePlan(rbi.id, tp, sid, FULL_PLAN);
  assert.match(toast(full), /complete\)/);
  assert.equal((await db.prepare('SELECT status FROM tp_exit_plans WHERE service_id=?').get(sid)).status, 'complete');
  await db.prepare('UPDATE tp_exit_plans SET last_tested_on = NULL WHERE service_id=?').run(sid);
  assert.equal((await db.prepare('SELECT status FROM tp_exit_plans WHERE service_id=?').get(sid)).status, 'incomplete');
  await assert.rejects(db.prepare(`UPDATE tp_exit_plans SET switch_unit = NULL WHERE service_id=?`).run(sid), /switch_pair/);
  const saved = (await chain(rbi.id, 'third_party', tp)).filter(e => e.action === 'exit_plan.saved');
  assert.deepEqual(saved.map(e => e.after_state.status), ['incomplete', 'complete']);
  const other = await tprmClient('EP Plan Other Client', ['rbi_commercial_banks']);
  const { tp: otp } = await addThirdParty(other.id, 'Other Plan Vendor');
  assert.equal((await consultant.session.get(`${tpBase(other.id, otp)}/services/${sid}/exit-plan`)).status, 404);
  assert.equal((await otherManager.session.get(`${tpBase(rbi.id, tp)}/services/${sid}/exit-plan`)).status, 404);
  await client.post(`${tpBase(rbi.id, tp)}/services/${sid}/remove`, { row_version: String((await serviceRow(sid)).row_version) });
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS c FROM tp_exit_plans WHERE service_id=?').get(sid)).c, 0);
});

test('automatic condition: added for a material service without a complete plan when the rulebook requires it; "approve" becomes "with conditions"', async () => {
  const rbi = await tprmClient('EP Auto Client', ['rbi_commercial_banks']);
  const ctx = await confirmed(rbi, 'Auto Vendor Ltd', { material: true });
  const [auto] = await autoOf(ctx.rid);
  assert.ok(auto, 'the draft starts with the automatic condition');
  assert.equal(auto.owner, 'client');
  assert.equal(Number(auto.auto_service_id), ctx.sids[0]);
  assert.match(auto.description, /Document a complete exit plan for "Core banking hosting"/);
  assert.ok(auto.description.endsWith(' Required under the RBI Master Direction - Managing Risks in Outsourcing, 2025 (Commercial Banks).'),
    auto.description);
  assert.doesNotMatch(auto.description, /verify|unverified|pending|todo|https?:/i, 'no research remarks reach the client');
  assert.equal(auto.due_date, EP.addDays(dates.todayFor(await wsRow(rbi.id)), 90), 'due 90 days after it was added');
  const page = await allSteps(consultant.session, aBase(ctx));
  assert.match(page.text, new RegExp(`data-tprm-rec-auto-condition="${auto.id}"`));

  const saved = await saveDraft(ctx, 'approve');
  assert.equal(saved.status, 302);
  assert.match(toast(saved), /now "with conditions"/);
  assert.equal((await recRow(ctx.rid)).outcome, 'approve_with_conditions');
  assert.equal((await autoOf(ctx.rid)).length, 1);
  const dueSaved = await saveDraft(ctx, 'approve_with_conditions', { [`auto_conditions[c${auto.id}][due_date]`]: '2099-02-28' });
  assert.match(toast(dueSaved), /Draft saved/);
  assert.equal((await autoOf(ctx.rid))[0].due_date, '2099-02-28');
  await assert.rejects(db.prepare('UPDATE tp_conditions SET description = ? WHERE id = ?').run('Edited', auto.id), /never change/);
  await assert.rejects(db.prepare('DELETE FROM tp_conditions WHERE id = ?').run(auto.id), /manager's override/);
  await saveDraft(ctx, 'reject');
  assert.equal((await autoOf(ctx.rid)).length, 0, 'a reject carries no automatic condition');
  await saveDraft(ctx, 'approve_with_conditions');
  assert.equal((await autoOf(ctx.rid)).length, 1);
  const synced = (await chain(rbi.id, 'assessment', ctx.a)).filter(e => e.action === 'recommendation.exit_plan_conditions_synced');
  assert.ok(synced.length >= 3);
  assert.equal(synced.find(e => e.after_state.converted_to_with_conditions).after_state.outcome, 'approve_with_conditions');

  const done = await confirmed(rbi, 'Complete Plan Vendor', { material: true, draft: false });
  assert.equal((await savePlan(rbi.id, done.tp, done.sids[0], FULL_PLAN)).status, 302);
  assert.equal((await consultant.session.post(rBase(done), { row_version: String((await assessmentRow(done.a)).row_version) })).status, 302);
  done.rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=?').get(done.a)).id);
  assert.equal((await autoOf(done.rid)).length, 0);
  await saveDraft(done, 'approve');
  assert.equal((await recRow(done.rid)).outcome, 'approve', 'a complete plan: plain Onboard stays');

  const gdpr = await tprmClient('EP GDPR Client', ['eu_gdpr']);
  const g = await confirmed(gdpr, 'GDPR Vendor', { material: true });
  assert.equal((await autoOf(g.rid)).length, 0, 'EU GDPR does not require exit plans');
  await saveDraft(g, 'approve');
  assert.equal((await recRow(g.rid)).outcome, 'approve');

  const plain = await tprmClient('EP Plain Auto Client');
  const p = await confirmed(plain, 'Plain Auto Vendor');
  await db.prepare('UPDATE tp_services SET material = true WHERE id = ?').run(p.sids[0]);
  await saveDraft(p, 'approve');
  assert.equal((await recRow(p.rid)).outcome, 'approve');
  assert.equal((await autoOf(p.rid)).length, 0, 'nothing automatic for an unregulated client');
  assert.doesNotMatch((await allSteps(consultant.session, aBase(p))).text, /data-tprm-rec-auto/);
  await saveDraft(p, 'approve_with_conditions', {
    'conditions[0][description]': 'Document an exit plan', 'conditions[0][owner]': 'client', 'conditions[0][due_date]': '2099-01-31' });
  assert.deepEqual((await conditionsOf(p.rid)).map(c => [c.description, c.automatic]), [['Document an exit plan', false]]);
});

test('approve is refused by the domain and the database while a material service lacks a complete plan; issue re-checks', async () => {
  const rbi = await tprmClient('EP Gate Client', ['rbi_payments_banks']);
  const ctx = await confirmed(rbi, 'Gate Vendor Ltd', { material: true });
  await saveDraft(ctx, 'approve_with_conditions');
  const auto = (await autoOf(ctx.rid))[0];
  await withDisabled('tp_conditions', 'tp_conditions_automatic', () => db.prepare('DELETE FROM tp_conditions WHERE id=?').run(auto.id));
  await db.prepare(`UPDATE tp_recommendations SET outcome = 'approve' WHERE id = ?`).run(ctx.rid);
  const R = require('../lib/tprm/recommendations');
  const rbac = require('../lib/rbac');
  const actor = { user: { id: consultant.id, user_type: 'firm', firm_id: firmId, firm_role: 'consultant' },
    perms: new Set(rbac.rolePermissions('consultant')), ws: await wsRow(rbi.id) };
  await assert.rejects(R.submit(db, actor, ctx.tp, ctx.a, ctx.rid, { row_version: (await recRow(ctx.rid)).row_version }), e => e.status === 409 && /out of date/.test(e.message));
  assert.equal((await autoOf(ctx.rid)).length, 0, 'the refused submit changed nothing');
  assert.match((await EP.gateProblems(db, rbi.id, ctx.a, { ...(await recRow(ctx.rid)), conditions: [] }))[0], /must be "with conditions"/);
  assert.equal((await recRow(ctx.rid)).status, 'draft');
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status = 'in_review', submitted_at = now() WHERE id = ?`).run(ctx.rid), /"with conditions" outcome/);
  await db.prepare(`UPDATE tp_recommendations SET outcome = 'approve_with_conditions' WHERE id = ?`).run(ctx.rid);
  await db.prepare(`INSERT INTO tp_conditions (workspace_id, recommendation_id, position, description, owner, due_date) VALUES (?, ?, 5, 'Other', 'vendor', '2099-01-01')`).run(rbi.id, ctx.rid);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status = 'in_review', submitted_at = now() WHERE id = ?`).run(ctx.rid), /needs its automatic condition/);
  const fixed = await saveDraft(ctx, 'approve_with_conditions', { 'conditions[0][description]': 'Other', 'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': '2099-01-01' }, { intent: 'submit' });
  assert.equal(fixed.status, 302, toast(fixed));
  assert.match(toast(fixed), /conditions were updated\. Check it, then submit/, 'a changed draft is shown again before it is submitted');
  assert.equal((await autoOf(ctx.rid)).length, 1);
  assert.equal((await recRow(ctx.rid)).status, 'draft');
  const OTHER = { 'conditions[0][description]': 'Other', 'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': '2099-01-01' };
  assert.equal((await saveDraft(ctx, 'approve_with_conditions', OTHER, { intent: 'submit' })).status, 302);
  assert.equal((await recRow(ctx.rid)).status, 'in_review');

  const other = await db.prepare(`INSERT INTO tp_services (workspace_id, third_party_id, description) VALUES (?, ?, 'Payments switch') RETURNING id`).get(rbi.id, ctx.tp);
  await db.prepare(`UPDATE tp_assessments SET services_in_scope = services_in_scope || ?::jsonb WHERE id = ?`).run(JSON.stringify([{ id: Number(other.id), description: 'Payments switch' }]), ctx.a);
  assert.equal((await markMaterial(rbi.id, ctx.tp, Number(other.id))).status, 302);
  const refused = await issue(ctx);
  assert.equal(refused.status, 409);
  assert.match(refused.text, /cannot be issued/);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET status = 'issued', reviewer_id = ?, reviewed_at = now(), issued_at = now() WHERE id = ?`).run(senior.id, ctx.rid), /automatic condition/);
  assert.equal((await recRow(ctx.rid)).status, 'in_review');
  await allSteps(senior.session, aBase(ctx));
  assert.equal((await senior.session.post(`${rBase(ctx)}/${ctx.rid}/request-changes`, { comment: 'Second material service', row_version: String((await recRow(ctx.rid)).row_version) })).status, 302);
  assert.equal((await autoOf(ctx.rid)).length, 1, 'changes requested: recomputed on the next save');
  await saveDraft(ctx, 'approve_with_conditions', OTHER, { intent: 'submit' });
  assert.equal((await autoOf(ctx.rid)).length, 2);
  assert.equal((await recRow(ctx.rid)).status, 'changes_requested', 'the new condition is shown before submitting');
  await saveDraft(ctx, 'approve_with_conditions', OTHER, { intent: 'submit' });
  assert.equal((await recRow(ctx.rid)).status, 'in_review');
  assert.equal((await issue(ctx)).status, 302);
  assert.equal((await recRow(ctx.rid)).status, 'issued');
});

test('manager override: only a manager removes an automatic condition, with a reason; it is not added again; the database holds it', async () => {
  const rbi = await tprmClient('EP Override Client', ['rbi_commercial_banks']);
  const ctx = await confirmed(rbi, 'Override Vendor Ltd', { material: true });
  await saveDraft(ctx, 'approve');
  const auto = (await autoOf(ctx.rid))[0];
  const url = `${rBase(ctx)}/${ctx.rid}/auto-conditions/${auto.id}/remove`;
  await allSteps(consultant.session, aBase(ctx));
  assert.equal((await consultant.session.post(url, { reason: 'Not needed', row_version: String((await recRow(ctx.rid)).row_version) })).status, 403, 'a consultant cannot');
  assert.equal((await senior.session.post(url, { reason: 'Not needed', row_version: String((await recRow(ctx.rid)).row_version) })).status, 403, 'a senior consultant cannot');
  const page = await allSteps(client, aBase(ctx));
  assert.match(page.text, /data-tprm-rec-auto-override-form/);
  assert.doesNotMatch((await allSteps(consultant.session, aBase(ctx))).text, /data-tprm-rec-auto-override-form/);
  const noReason = await client.post(url, { reason: '', row_version: String((await recRow(ctx.rid)).row_version) });
  assert.match(toast(noReason), /Give the reason/);
  assert.equal((await client.post(url, { reason: 'x', row_version: '1' })).status, 302);
  assert.equal((await autoOf(ctx.rid)).length, 1, 'a stale form changes nothing');
  await assert.rejects(db.prepare(`INSERT INTO tp_exit_plan_overrides (workspace_id, recommendation_id, service_id, reason, removed_by) VALUES (?, ?, ?, 'x', ?)`)
    .run(rbi.id, ctx.rid, ctx.sids[0], consultant.id), /only a manager/);
  const last = await client.post(url, { reason: 'The client exits this service within three months anyway', row_version: String((await recRow(ctx.rid)).row_version) });
  assert.match(toast(last), /would leave the recommendation "with conditions" but with no condition/);
  assert.equal((await autoOf(ctx.rid)).length, 1, 'nothing removed');
  const noOutcomeReason = await client.post(url, { reason: 'x', outcome: 'approve', outcome_reason: '', row_version: String((await recRow(ctx.rid)).row_version) });
  assert.match(toast(noOutcomeReason), /reason for changing the outcome/);
  assert.equal((await saveDraft(ctx, 'approve_with_conditions', { 'conditions[0][description]': 'Share the board-approved exit strategy',
    'conditions[0][owner]': 'client', 'conditions[0][due_date]': '2099-01-31' })).status, 302);
  const withOther = await client.post(url, { reason: 'Exit plan on file elsewhere', outcome: 'approve', outcome_reason: 'x', row_version: String((await recRow(ctx.rid)).row_version) });
  assert.match(toast(withOther), /other conditions/, 'Onboard with a condition still on the draft is refused');
  const removed = await client.post(url, { reason: 'The client exits this service within three months anyway', row_version: String((await recRow(ctx.rid)).row_version) });
  assert.equal(removed.status, 302, toast(removed));
  assert.match(toast(removed), /Automatic condition removed/);
  assert.equal((await autoOf(ctx.rid)).length, 0);
  assert.equal((await recRow(ctx.rid)).outcome, 'approve_with_conditions', 'the override does not make it a plain Onboard');
  const o = await db.prepare('SELECT * FROM tp_exit_plan_overrides WHERE recommendation_id=?').get(ctx.rid);
  assert.equal(Number(o.removed_by), Number((await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id));
  assert.match(o.reason, /three months/);
  const ev = (await chain(rbi.id, 'assessment', ctx.a)).find(e => e.action === 'recommendation.auto_condition_removed');
  assert.match(ev.after_state.reason, /three months/);
  await saveDraft(ctx, 'approve_with_conditions');
  assert.equal((await autoOf(ctx.rid)).length, 0);
  const shown = (await allSteps(consultant.session, aBase(ctx))).text;
  assert.match(shown, /data-tprm-rec-auto-overrides/);
  assert.match(shown, /data-tprm-rec-override-keeps/);
  assert.doesNotMatch(shown, /data-tprm-rec-override-outcome-form/, 'a consultant has no outcome change');
  await assert.rejects(db.prepare('UPDATE tp_exit_plan_overrides SET reason = ? WHERE id = ?').run('y', o.id), /never changes/);
  await assert.rejects(db.prepare('DELETE FROM tp_exit_plan_overrides WHERE id = ?').run(o.id), /never deleted/);
  const plain = await saveDraft(ctx, 'approve');
  assert.match(toast(plain), /stays "with conditions"/);
  assert.equal((await recRow(ctx.rid)).outcome, 'approve_with_conditions');
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET outcome = 'approve' WHERE id = ?`).run(ctx.rid), /stays "with conditions"/);
  await assert.rejects(db.prepare(`UPDATE tp_recommendations SET override_outcome = 'approve', override_outcome_reason = 'x',
    override_outcome_by = ?, override_outcome_at = now(), outcome = 'approve' WHERE id = ?`).run(consultant.id, ctx.rid), /only a manager/);
  const outcomeUrl = `${rBase(ctx)}/${ctx.rid}/override-outcome`;
  assert.equal((await consultant.session.post(outcomeUrl, { outcome: 'approve', outcome_reason: 'x', row_version: String((await recRow(ctx.rid)).row_version) })).status, 403);
  assert.match(toast(await client.post(outcomeUrl, { outcome: 'approve', outcome_reason: '', row_version: String((await recRow(ctx.rid)).row_version) })),
    /reason for changing the outcome/);
  assert.equal((await conditionsOf(ctx.rid)).length, 0);
  const submitEmpty = await saveDraft(ctx, 'approve_with_conditions', {}, { intent: 'submit' });
  assert.match(toast(submitEmpty), /at least one condition/);
  const changed = await client.post(outcomeUrl, { outcome: 'approve', outcome_reason: 'The service ends before the plan would be due',
    row_version: String((await recRow(ctx.rid)).row_version) });
  assert.equal(changed.status, 302, toast(changed));
  const rec = await recRow(ctx.rid);
  assert.deepEqual([rec.outcome, rec.override_outcome, rec.override_outcome_reason],
    ['approve', 'approve', 'The service ends before the plan would be due']);
  assert.ok(rec.override_outcome_at);
  const oev = (await chain(rbi.id, 'assessment', ctx.a)).find(e => e.action === 'recommendation.override_outcome_changed');
  assert.match(oev.after_state.reason, /service ends/);
  assert.match((await allSteps(client, aBase(ctx))).text, /data-tprm-rec-override-outcome="approve"/);
  assert.equal((await saveDraft(ctx, 'approve')).status, 302);
  assert.equal((await recRow(ctx.rid)).outcome, 'approve');
  assert.equal((await otherManager.session.post(url, { reason: 'x', row_version: '1' })).status, 404);
});

test('recompute while the draft is editable: material flag, exit plan and rulebook ticks; frozen once issued', async () => {
  const rbi = await tprmClient('EP Recompute Client', ['rbi_commercial_banks']);
  const ctx = await confirmed(rbi, 'Recompute Vendor Ltd');
  await saveDraft(ctx, 'approve');
  assert.equal((await autoOf(ctx.rid)).length, 0);
  const marked = await markMaterial(rbi.id, ctx.tp, ctx.sids[0]);
  assert.match(toast(marked), /exit plan conditions were updated/);
  assert.equal((await autoOf(ctx.rid)).length, 1);
  assert.equal((await recRow(ctx.rid)).outcome, 'approve_with_conditions');
  await savePlan(rbi.id, ctx.tp, ctx.sids[0], FULL_PLAN);
  assert.equal((await autoOf(ctx.rid)).length, 0);
  await savePlan(rbi.id, ctx.tp, ctx.sids[0], { ...FULL_PLAN, last_tested_on: '' });
  assert.equal((await autoOf(ctx.rid)).length, 1);
  assert.equal((await tick(rbi.id, [])).status, 302);
  assert.equal((await autoOf(ctx.rid)).length, 0);
  assert.equal((await tick(rbi.id, ['rbi_commercial_banks'])).status, 302);
  assert.equal((await autoOf(ctx.rid)).length, 1);

  assert.equal((await saveDraft(ctx, 'approve_with_conditions', {}, { intent: 'submit' })).status, 302);
  assert.equal((await recRow(ctx.rid)).status, 'in_review');
  assert.equal((await issue(ctx)).status, 302);
  const issued = await autoOf(ctx.rid);
  assert.equal(issued.length, 1);
  await savePlan(rbi.id, ctx.tp, ctx.sids[0], FULL_PLAN);
  assert.equal((await markMaterial(rbi.id, ctx.tp, ctx.sids[0], false, client)).status, 302);
  assert.deepEqual((await autoOf(ctx.rid)).map(c => c.id), issued.map(c => c.id), 'the issued condition stays');
  await assert.rejects(db.prepare('UPDATE tp_conditions SET due_date = ? WHERE id = ?').run('2099-05-05', issued[0].id), /draft/);
  await assert.rejects(withDisabled('tp_conditions', 'tp_conditions_automatic', () => db.prepare('DELETE FROM tp_conditions WHERE id = ?').run(issued[0].id)), /draft/);
});

test('questionnaire pins decide: a questionnaire prepared before the tick pins nothing, so nothing automatic happens', async () => {
  const c = await tprmClient('EP Pins Client');
  const ctx = await confirmed(c, 'Pins Vendor Ltd', { draft: false });
  const prep = await consultant.session.post(`${aBase(ctx)}/questionnaire`, { delivery_model: 'vendor_hosted' });
  assert.equal(prep.status, 302, toast(prep));
  assert.deepEqual((await db.prepare('SELECT rulebooks FROM tp_questionnaires WHERE assessment_id=?').get(ctx.a)).rulebooks, []);
  assert.equal((await tick(c.id, ['rbi_commercial_banks'])).status, 302);
  assert.equal((await markMaterial(c.id, ctx.tp, ctx.sids[0])).status, 302, 'the client is regulated now: the flag exists');
  assert.equal((await consultant.session.post(rBase(ctx), { row_version: String((await assessmentRow(ctx.a)).row_version) })).status, 302);
  ctx.rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=?').get(ctx.a)).id);
  await saveDraft(ctx, 'approve');
  assert.equal((await autoOf(ctx.rid)).length, 0, 'the pins (none) apply, not the ticks: applies from the next assessment');
  assert.equal((await recRow(ctx.rid)).outcome, 'approve');
});

test('condition text: the reference text of the rulebook as it is now, even when the questionnaire pinned an earlier version', async () => {
  const c = await tprmClient('EP Current Text Client', ['rbi_commercial_banks']);
  const ctx = await confirmed(c, 'Current Text Vendor Ltd', { draft: false, material: true });
  const prep = await consultant.session.post(`${aBase(ctx)}/questionnaire`, { delivery_model: 'vendor_hosted' });
  assert.equal(prep.status, 302, toast(prep));
  const pin = (await db.prepare('SELECT rulebooks FROM tp_questionnaires WHERE assessment_id=?').get(ctx.a)).rulebooks;
  assert.deepEqual(pin.map(r => r.key), ['rbi_commercial_banks']);
  const rb = await db.prepare(`SELECT * FROM tp_rulebooks WHERE firm_id=? AND key='rbi_commercial_banks'`).get(firmId);
  const url = `/tprm/settings/rulebooks/${rb.id}`;
  const form = { enabled: '1', exit_plan_required: '1', data_country: 'IN', question_ids: rb.question_ids.join(', '),
    reference_text: 'Required under the RBI outsourcing directions for commercial banks (reworded)', research_note: rb.research_note || '',
    row_version: String(rb.row_version) };
  assert.equal((await client.post(url, form)).status, 302);
  assert.equal((await db.prepare('SELECT rulebooks FROM tp_questionnaires WHERE assessment_id=?').get(ctx.a)).rulebooks[0].version, pin[0].version);
  assert.equal((await consultant.session.post(rBase(ctx), { row_version: String((await assessmentRow(ctx.a)).row_version) })).status, 302);
  ctx.rid = Number((await db.prepare('SELECT id FROM tp_recommendations WHERE assessment_id=?').get(ctx.a)).id);
  const [auto] = await autoOf(ctx.rid);
  assert.ok(auto.description.endsWith(' Required under the RBI outsourcing directions for commercial banks (reworded).'), auto.description);
  assert.match(EP.conditionText('X', [{ name: 'EU - DORA', reference_text: 'DORA Articles 28 to 30' }]), / Required by EU - DORA: DORA Articles 28 to 30\.$/);
  assert.match(EP.conditionText('X', [{ name: 'EU - DORA', reference_text: null }]), / Required by EU - DORA\.$/);
  const cur = await db.prepare('SELECT * FROM tp_rulebooks WHERE id=?').get(rb.id);
  assert.equal((await client.post(url, { ...form, reference_text: rb.reference_text, row_version: String(cur.row_version) })).status, 302);
});

test('migration 112: draft automatic conditions are recomputed with the clean text; issued ones stay as issued', async () => {
  const c = await tprmClient('EP Migration Text Client', ['rbi_commercial_banks']);
  const draft = await confirmed(c, 'Draft Text Vendor Ltd', { material: true });
  const done = await confirmed(c, 'Issued Text Vendor Ltd', { material: true });
  assert.equal((await saveDraft(done, 'approve_with_conditions', {}, { intent: 'submit' })).status, 302);
  assert.equal((await issue(done)).status, 302);
  const legacy = 'RBI Managing Risks in Outsourcing Directions, 28 Nov 2025 (Commercial Banks: https://rbi.org.in/x; NBFCs: id=12941) - para refs to verify';
  const old = d => `Document a complete exit plan for "${d}": the alternative provider, how data is returned and deleted, the time to switch, and the date it was last tested or reviewed. Required by RBI - Commercial Banks: ${legacy}.`;
  const [dAuto] = await autoOf(draft.rid);
  const [iAuto] = await autoOf(done.rid);
  await withDisabled('tp_conditions', 'tp_conditions_automatic', async () => {
    await db.prepare('UPDATE tp_conditions SET description = ? WHERE id = ?').run(old('Core banking hosting'), dAuto.id);
  });
  await withDisabled('tp_conditions', 'tp_conditions_guard', () => withDisabled('tp_conditions', 'tp_conditions_automatic', async () => {
    await db.prepare('UPDATE tp_conditions SET description = ? WHERE id = ?').run(old('Core banking hosting'), iAuto.id);
  }));
  await require('../migrations/112_tprm_rulebook_reference_texts').up(db);
  const dNow = (await autoOf(draft.rid))[0];
  assert.equal(dNow.description, EP.conditionText('Core banking hosting',
    [{ name: 'RBI - Commercial Banks', reference_text: 'Required under the RBI Master Direction - Managing Risks in Outsourcing, 2025 (Commercial Banks)' }]));
  assert.equal((await autoOf(done.rid))[0].description, old('Core banking hosting'), 'an issued condition is frozen');
  await assert.rejects(db.prepare('UPDATE tp_conditions SET description = ? WHERE id = ?').run('x', dNow.id), /never change/);
});

test('the firm-only research note never reaches the client portal or the report', async () => {
  const rb = await db.prepare(`SELECT * FROM tp_rulebooks WHERE firm_id=? AND key='rbi_commercial_banks'`).get(firmId);
  const url = `/tprm/settings/rulebooks/${rb.id}`;
  const form = { enabled: '1', exit_plan_required: '1', data_country: 'IN', question_ids: rb.question_ids.join(', '),
    reference_text: rb.reference_text, research_note: 'SENTINEL-NOTE-EP see https://example.invalid, para 4 to verify', row_version: String(rb.row_version) };
  assert.equal((await client.post(url, form)).status, 302);
  try {
    const c = await tprmClient('EP Note Client', ['rbi_commercial_banks']);
    const ctx = await confirmed(c, 'Note Vendor Ltd', { material: true });
    assert.equal((await saveDraft(ctx, 'approve_with_conditions', {}, { intent: 'submit' })).status, 302);
    assert.equal((await issue(ctx)).status, 302);
    await decideOn(ctx, 'approve_with_conditions');
    const owner = await sessionFor(ctx.c.owner);
    const portalPage = await owner.get(recPage(ctx));
    assert.equal(portalPage.status, 200);
    assert.match(portalPage.text, /Required under the RBI Master Direction/);
    assert.doesNotMatch(portalPage.text, /SENTINEL-NOTE-EP|para refs to verify/);
    const list = await owner.get(portal(ctx.ws));
    assert.doesNotMatch(list.text, /SENTINEL-NOTE-EP/);
    const snap = await db.prepare('SELECT content FROM tp_recommendation_snapshots WHERE recommendation_id=?').get(ctx.rid);
    assert.doesNotMatch(snap.content, /SENTINEL-NOTE-EP|para refs to verify/);
    const html = report.renderHtml(await report.reportData(db, await wsRow(c.id), ctx.rid), { displayName: 'Firm', addressLines: [], contactLine: '' });
    assert.match(html, /Required under the RBI Master Direction/);
    assert.doesNotMatch(html, /SENTINEL-NOTE-EP|para refs to verify/);
    const pdf = await owner.get(`${recPage(ctx)}/report.pdf`);
    if (pdf.status === 200) assert.doesNotMatch(pdf.text, /SENTINEL-NOTE-EP/);
    assert.doesNotMatch((await allSteps(client, aBase(ctx))).text, /SENTINEL-NOTE-EP/);
    assert.match((await client.get(url)).text, /SENTINEL-NOTE-EP/);
  } finally {
    const cur = await db.prepare('SELECT * FROM tp_rulebooks WHERE id=?').get(rb.id);
    assert.equal((await client.post(url, { ...form, research_note: rb.research_note || '', row_version: String(cur.row_version) })).status, 302);
  }
});

test('lifecycle (5A): the client uploads the exit plan as proof on the automatic condition; the firm verifies it', async () => {
  const rbi = await tprmClient('EP Lifecycle Client', ['rbi_commercial_banks']);
  const ctx = await confirmed(rbi, 'Lifecycle Vendor Ltd', { material: true });
  assert.equal((await saveDraft(ctx, 'approve_with_conditions', {}, { intent: 'submit' })).status, 302);
  assert.equal((await recRow(ctx.rid)).status, 'in_review');
  assert.equal((await issue(ctx)).status, 302);
  const auto = (await autoOf(ctx.rid))[0];
  await decideOn(ctx, 'approve_with_conditions');
  const owner = await sessionFor(ctx.c.owner);
  const portalPage = await owner.get(recPage(ctx));
  assert.match(portalPage.text, /Document a complete exit plan/);
  assert.match(portalPage.text, /data-tprm-portal-proof-form/);
  const form = multipart(owner.getCsrfToken(), [{ filename: 'exit-plan.txt', content: 'Our exit plan for core banking hosting', type: 'text/plain' }],
    { note: 'Exit plan approved by the board', row_version: String((await db.prepare('SELECT row_version FROM tp_conditions WHERE id=?').get(auto.id)).row_version) });
  const up = await owner.post(`${portal(ctx.ws)}/conditions/${auto.id}/proofs`, form.body, { headers: form.headers });
  assert.equal(up.status, 302, toast(up));
  for (const f of await db.prepare('SELECT stored_path FROM tp_condition_proof_files WHERE workspace_id=?').all(ctx.ws)) createdPaths.add(f.stored_path);
  assert.equal((await db.prepare('SELECT status FROM tp_conditions WHERE id=?').get(auto.id)).status, 'proof_submitted');
  await allSteps(consultant.session, aBase(ctx));
  const verified = await consultant.session.post(`${aBase(ctx)}/conditions/${auto.id}/verify`, {
    comment: 'Checked the plan', row_version: String((await db.prepare('SELECT row_version FROM tp_conditions WHERE id=?').get(auto.id)).row_version) });
  assert.equal(verified.status, 302, toast(verified));
  assert.equal((await db.prepare('SELECT status FROM tp_conditions WHERE id=?').get(auto.id)).status, 'verified');
});

test('report snapshot: exit plan lines per material service and the automatic condition, frozen at issue; unregulated reports keep their shape', async () => {
  const rbi = await tprmClient('EP Report Client', ['rbi_commercial_banks']);
  const ctx = await confirmed(rbi, 'Report Vendor Ltd', { material: true, services: [{ description: 'Core banking hosting' }, { description: 'Print services' }] });
  assert.equal((await markMaterial(rbi.id, ctx.tp, ctx.sids[1], false, client)).status, 302);
  assert.equal((await saveDraft(ctx, 'approve_with_conditions', {}, { intent: 'submit' })).status, 302);
  assert.equal((await recRow(ctx.rid)).status, 'in_review');
  assert.equal((await issue(ctx)).status, 302);
  const snap = await db.prepare('SELECT content FROM tp_recommendation_snapshots WHERE recommendation_id=?').get(ctx.rid);
  const content = JSON.parse(snap.content);
  assert.deepEqual(content.exitPlans, [{ service: 'Core banking hosting', status: 'Missing' }]);
  assert.equal(content.conditions.filter(c => c.automatic).length, 1);
  await savePlan(rbi.id, ctx.tp, ctx.sids[0], FULL_PLAN);
  const again = await db.prepare('SELECT content FROM tp_recommendation_snapshots WHERE recommendation_id=?').get(ctx.rid);
  assert.equal(again.content, snap.content);
  const html = report.renderHtml(await report.reportData(db, await wsRow(rbi.id), ctx.rid), { displayName: 'Firm', addressLines: [], contactLine: '' });
  assert.match(html, /data-report-exit-plans/);
  assert.match(html, /Exit plan: missing/);
  assert.match(html, /\(automatic: [^)<]+&#39;s rulebooks require an exit plan\)/);
  assert.equal((await client.get(`${rBase(ctx)}/${ctx.rid}/report.pdf`)).status, 200);

  const plain = await tprmClient('EP Report Plain Client');
  const p = await confirmed(plain, 'Plain Report Vendor');
  assert.equal((await saveDraft(p, 'approve', {}, { intent: 'submit' })).status, 302);
  assert.equal((await issue(p)).status, 302);
  const pc = JSON.parse((await db.prepare('SELECT content FROM tp_recommendation_snapshots WHERE recommendation_id=?').get(p.rid)).content);
  assert.equal('exitPlans' in pc, false);
  assert.ok(pc.conditions.every(c => !('automatic' in c)));
  assert.doesNotMatch(report.renderHtml(await report.reportData(db, await wsRow(plain.id), p.rid), { displayName: 'Firm', addressLines: [], contactLine: '' }), /Exit plans/);
});

test('reassessment: Continue becomes "Continue with conditions"; Exit raises none; the history names the events; CSRF on the plan and the override', async () => {
  const rbi = await tprmClient('EP Reassessment Client', ['rbi_nbfc_middle_layer']);
  const ctx = await confirmed(rbi, 'Reassessed Vendor Ltd', { status: 'in_use', material: true });
  assert.equal((await assessmentRow(ctx.a)).type, 'reassessment');
  const saved = await saveDraft(ctx, 'approve');
  assert.match(toast(saved), /now "with conditions"/);
  const page = await allSteps(consultant.session, aBase(ctx));
  assert.match(page.text, /value="approve_with_conditions" checked> <span>Continue with conditions/);
  assert.match(page.text, /data-tprm-history-action="recommendation.exit_plan_conditions_synced"/, 'History shows the event');
  assert.equal((await autoOf(ctx.rid)).length, 1);
  await saveDraft(ctx, 'reject');
  assert.equal((await autoOf(ctx.rid)).length, 0, 'Exit raises none');
  assert.equal((await recRow(ctx.rid)).outcome, 'reject');
  await saveDraft(ctx, 'approve_with_conditions');
  const auto = (await autoOf(ctx.rid))[0];
  await db.prepare(`UPDATE tp_conditions SET due_date = '2020-01-01' WHERE id = ?`).run(auto.id);
  const late = await saveDraft(ctx, 'approve_with_conditions', {}, { intent: 'submit' });
  assert.match(toast(late), /The automatic exit plan condition: the due date is in the past/);
  assert.equal((await consultant.session.post(`${tpBase(rbi.id, ctx.tp)}/services/${ctx.sids[0]}/exit-plan`, { ...FULL_PLAN, row_version: '0' }, { csrf: false })).status, 403);
  assert.equal((await client.post(`${rBase(ctx)}/${ctx.rid}/auto-conditions/${auto.id}/remove`, { reason: 'x', row_version: String((await recRow(ctx.rid)).row_version) }, { csrf: false })).status, 403);
  assert.equal((await autoOf(ctx.rid)).length, 1);
  assert.equal((await db.prepare('SELECT COUNT(*)::int AS c FROM tp_exit_plans WHERE service_id=?').get(ctx.sids[0])).c, 0);
});

test('PHASE 6 GATE: an RBI-regulated client\'s material service with no exit plan cannot reach a plain Onboard; an unregulated client sees none of it', async () => {
  const rbi = await tprmClient('EP Gate RBI Bank', ['rbi_commercial_banks']);
  const ctx = await confirmed(rbi, 'Gate Core Hosting Ltd', { material: true });
  const tried = await saveDraft(ctx, 'approve', {}, { intent: 'submit' });
  assert.equal(tried.status, 302);
  assert.match(toast(tried), /now "with conditions"/);
  let rec = await recRow(ctx.rid);
  assert.equal(rec.outcome, 'approve_with_conditions');
  assert.equal(rec.status, 'draft', 'a converted draft is shown again before it is submitted');
  await assert.rejects(withDisabled('tp_conditions', 'tp_conditions_automatic', async () => {
    await db.prepare(`UPDATE tp_recommendations SET outcome = 'approve' WHERE id = ?`).run(ctx.rid);
    await db.prepare('DELETE FROM tp_conditions WHERE recommendation_id = ?').run(ctx.rid);
    await db.prepare(`UPDATE tp_recommendations SET status = 'in_review', submitted_at = now() WHERE id = ?`).run(ctx.rid);
  }), /"with conditions" outcome/);
  await saveDraft(ctx, 'approve');
  assert.equal((await saveDraft(ctx, 'approve_with_conditions', {}, { intent: 'submit' })).status, 302);
  assert.equal((await recRow(ctx.rid)).status, 'in_review');
  assert.equal((await issue(ctx)).status, 302);
  rec = await recRow(ctx.rid);
  assert.deepEqual([rec.status, rec.outcome], ['issued', 'approve_with_conditions']);
  assert.deepEqual((await autoOf(ctx.rid)).map(c => c.owner), ['client']);
  const owner = await sessionFor(rbi.owner);
  const portalPage = await owner.get(recPage(ctx));
  assert.match(portalPage.text, /Onboard with conditions/);
  assert.match(portalPage.text, /Document a complete exit plan/);

  const plain = await tprmClient('EP Gate Unregulated Co');
  const p = await confirmed(plain, 'Gate Plain Vendor');
  const tpPage = await consultant.session.get(tpBase(plain.id, p.tp));
  assert.doesNotMatch(tpPage.text, /data-tprm-exit-plans|Mark material|Exit plan/);
  assert.equal((await markMaterial(plain.id, p.tp, p.sids[0])).status, 404);
  const aPage = await allSteps(consultant.session, aBase(p));
  assert.doesNotMatch(aPage.text, /data-tprm-rec-auto|exit plan/i);
  assert.equal((await saveDraft(p, 'approve', {}, { intent: 'submit' })).status, 302);
  assert.equal((await issue(p)).status, 302);
  assert.deepEqual([(await recRow(p.rid)).status, (await recRow(p.rid)).outcome], ['issued', 'approve']);
  assert.equal((await conditionsOf(p.rid)).length, 0);
});

test('isolation and events: another workspace or firm gets 404; chains verify', async () => {
  const a = await tprmClient('EP Iso A', ['rbi_commercial_banks']);
  const b = await tprmClient('EP Iso B', ['rbi_commercial_banks']);
  const { tp, sids: [sid] } = await addThirdParty(a.id, 'Iso Vendor A');
  assert.equal((await consultant.session.post(`${tpBase(b.id, tp)}/services/${sid}/material`, { material: '1', reason: 'x', row_version: '1' })).status, 404);
  assert.equal((await consultant.session.get(`${tpBase(b.id, tp)}/services/${sid}/exit-plan`)).status, 404);
  assert.equal((await otherManager.session.post(`${tpBase(a.id, tp)}/services/${sid}/material`, { material: '1', reason: 'x', row_version: '1' })).status, 404);
  const { tp: btp } = await addThirdParty(b.id, 'Iso Vendor B');
  await assert.rejects(db.prepare(`INSERT INTO tp_exit_plans (workspace_id, third_party_id, service_id) VALUES (?, ?, ?)`).run(b.id, btp, sid), /foreign key/);
  assert.deepEqual(await events.verifyChains(db), []);
});

test('deleting a client removes its exit plans, overrides and subprocessors (route and cascade)', async () => {
  const purge = async (name, viaRoute) => {
    const c = await tprmClient(name, ['rbi_commercial_banks']);
    const ctx = await confirmed(c, `${name} Vendor`, { material: true });
    await saveDraft(ctx, 'approve');
    await savePlan(c.id, ctx.tp, ctx.sids[0], { alternative_provider: 'Other' });
    const auto = (await autoOf(ctx.rid))[0];
    await allSteps(client, aBase(ctx));
    assert.equal((await client.post(`${rBase(ctx)}/${ctx.rid}/auto-conditions/${auto.id}/remove`, { reason: 'Purge test', outcome: 'reject',
      outcome_reason: 'Purge test', row_version: String((await recRow(ctx.rid)).row_version) })).status, 302);
    await client.post(`${tpBase(c.id, ctx.tp)}/subprocessors`, { name: 'AWS', service: 'Hosting', country: 'India' });
    for (const t of ['tp_exit_plans', 'tp_exit_plan_overrides', 'tp_subprocessors']) {
      assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${t} WHERE workspace_id=?`).get(c.id)).c, 1, `${t} before`);
    }
    if (viaRoute) assert.equal((await client.post(`/workspaces/${c.id}/delete`, { confirm_name: name })).status, 302);
    else await db.prepare('DELETE FROM workspaces WHERE id=?').run(c.id);
    for (const t of ['tp_exit_plans', 'tp_exit_plan_overrides', 'tp_subprocessors', 'tp_conditions']) {
      assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${t} WHERE workspace_id=?`).get(c.id)).c, 0, `${t} (${viaRoute ? 'route' : 'cascade'})`);
    }
  };
  await purge('EP Deleted Client', true);
  await purge('EP Cascade Client', false);
  const restoreCheck = fs.readFileSync(path.join(ROOT, 'lib', 'restore-check.js'), 'utf8');
  assert.match(restoreCheck, /'tp_exit_plans', 'tp_exit_plan_overrides', 'tp_subprocessors'/);
});
