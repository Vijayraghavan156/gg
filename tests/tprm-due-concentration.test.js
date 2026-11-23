'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

let env;
let client;
let db;
let firmId;
let otherFirmId;
let R;
let C;
let events;
let dates;
let rbac;
let managerId;
let consultant;
let outsider;
let otherManager;
const sessions = [];

const PASSWORD = 'due-concentration-tests-password-1234';

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  R = require('../lib/tprm/reassessment');
  C = require('../lib/tprm/concentration');
  events = require('../lib/tprm/events');
  dates = require('../lib/dates');
  rbac = require('../lib/rbac');
  managerId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  otherFirmId = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Due Other Firm')`).run()).lastInsertRowid);
  consultant = await makeUser('due-consultant@test.local', { role: 'consultant' });
  outsider = await makeUser('due-outsider@test.local', { role: 'consultant' });
  otherManager = await makeUser('due-other-manager@test.local', { role: 'manager', firm: otherFirmId });
  for (const u of [consultant, outsider, otherManager]) u.session = await signIn(u.email, u.password);
});

test.after(async () => {
  for (const s of sessions) await s.close();
  for (const u of [consultant, outsider, otherManager]) if (u && u.session) await u.session.close();
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

async function tprmClient(name, { assign = true, firm = firmId } = {}) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firm, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  if (assign) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, consultant.id, 'consultant');
  return id;
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const wsRow = async id => db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
const tpRow = async id => db.prepare('SELECT *, next_due_date::text AS next_due_date FROM tp_third_parties WHERE id=?').get(id);
const managerUser = () => ({ id: managerId, firm_id: firmId, firm_role: 'manager', user_type: 'firm' });
const lookup = () => ({
  db,
  listWorkspaces: async user => db.prepare('SELECT * FROM workspaces WHERE firm_id=?').all(user.firm_id),
  getWorkspace: async (id, user) => {
    const ws = await wsRow(id);
    return ws && Number(ws.firm_id) === Number(user.firm_id) ? ws : null;
  },
  permissionsFor: async () => new Set(rbac.rolePermissions('manager').concat(['*'])),
});
const todayOf = async ws => dates.todayFor(await wsRow(ws));
const shift = (ymd, days) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const tpChain = async (ws, tp) => db.prepare(`SELECT action, actor_user_id, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='third_party' AND chain_id=? ORDER BY chain_seq`).all(ws, tp);

async function addThirdParty(ws, name, { status = 'in_use', session = client, fields = {} } = {}) {
  const res = await session.post(`/tprm/clients/${ws}/third-parties`, { name, status, ...fields });
  assert.equal(res.status, 302, `create ${name} redirects (got ${res.status})`);
  return idIn(res.location, /third-parties\/(\d+)/);
}

async function addService(ws, tp, fields) {
  const res = await client.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: 'Service', ...fields });
  assert.equal(res.status, 302, `service added (got ${res.status})`);
}

async function place(tp, { due = undefined, tier = undefined, last = undefined } = {}) {
  if (due !== undefined) await db.prepare('UPDATE tp_third_parties SET next_due_date = ?::date WHERE id = ?').run(due, tp);
  if (last !== undefined) await db.prepare('UPDATE tp_third_parties SET last_assessment_date = ?::date WHERE id = ?').run(last, tp);
  if (tier !== undefined) {
    await db.prepare('UPDATE tp_third_parties SET current_tier = ?, tier_source = ? WHERE id = ?').run(tier, tier ? 'assessed' : null, tp);
  }
}

test('buckets: overdue, no date, within 30, 31 to 60, 61 to 90 days, later is not listed', () => {
  const today = '2026-11-21';
  assert.equal(R.bucketFor('2026-11-20', today), 'overdue');
  assert.equal(R.bucketFor(null, today), 'no_date');
  assert.equal(R.bucketFor('2026-11-21', today), 'within_30');
  assert.equal(R.bucketFor('2026-12-21', today), 'within_30');
  assert.equal(R.bucketFor('2026-12-22', today), 'within_60');
  assert.equal(R.bucketFor('2027-01-20', today), 'within_60');
  assert.equal(R.bucketFor('2027-01-21', today), 'within_90');
  assert.equal(R.bucketFor('2027-02-19', today), 'within_90');
  assert.equal(R.bucketFor('2027-02-20', today), null);
  assert.deepEqual(R.BUCKETS, ['overdue', 'no_date', 'within_30', 'within_60', 'within_90']);
  assert.equal(R.triggerLabel({ reason: 'breach' }), 'Triggered: Breach');
  assert.equal(R.triggerLabel({ reason: 'ai_change' }), 'Triggered: Change of AI model or provider');
  assert.equal(R.triggerLabel({ reason: 'other', details: 'Regulator letter' }), 'Triggered: Regulator letter');
});

test('concentration rules: countries split and matched ignoring case; the fewest third parties covering the majority', () => {
  assert.deepEqual(C.splitCountries(' India,  singapore ; INDIA / United  Kingdom\nUSA '), ['India', 'singapore', 'United Kingdom', 'USA']);
  assert.deepEqual(C.splitCountries(null), []);
  const svc = (name, n) => Array.from({ length: n }, (_, i) => ({ third_party_id: name, third_party_name: name, id: `${name}${i}` }));
  const m = C.majorityProviders([...svc('AWS', 4), ...svc('Azure', 3), ...svc('Zoho', 2), ...svc('Tally', 1)], s => s.third_party_name);
  assert.equal(m.covered, 7);
  assert.deepEqual(m.chosen.map(c => c.name), ['AWS', 'Azure']);
  const tie = C.majorityProviders([...svc('B', 1), ...svc('A', 1)], s => s.third_party_name);
  assert.deepEqual(tie.chosen.map(c => c.name), ['A', 'B'], 'ties go by name; one of two is not a majority');
});

test('the due queue lists in-use third parties overdue, without a date or due within 90 days, in order, with tier, date and approval', async () => {
  const ws = await tprmClient('Due Alpha Client');
  const today = await todayOf(ws);
  const ids = {};
  for (const [name, due] of [['Overdue Old', shift(today, -40)], ['Overdue Recent', shift(today, -3)], ['No Date', null],
    ['Soon', shift(today, 5)], ['Today', today], ['Mid', shift(today, 45)], ['Late', shift(today, 80)], ['Far', shift(today, 200)]]) {
    ids[name] = await addThirdParty(ws, name);
    await place(ids[name], { due, tier: 'high', last: due && name !== 'Overdue Old' ? shift(today, -400) : null });
  }
  const proposed = await addThirdParty(ws, 'Proposed One', { status: 'proposed' });
  const exited = await addThirdParty(ws, 'Exited One', { status: 'exited' });
  await place(exited, { due: shift(today, -5) });
  const page = await client.get(`/tprm/due?client=${ws}`);
  assert.equal(page.status, 200);
  const rows = [...page.text.matchAll(/data-tprm-due-row="(\d+)" data-tprm-due-client="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(rows, ['Overdue Old', 'Overdue Recent', 'No Date', 'Today', 'Soon', 'Mid', 'Late'].map(n => ids[n]),
    'overdue (oldest first), no date, then by due date; later than 90 days, proposed and exited are not listed');
  assert.ok(!rows.includes(proposed) && !rows.includes(exited) && !rows.includes(ids.Far));
  for (const b of R.BUCKETS) assert.match(page.text, new RegExp(`data-tprm-due-bucket="${b}"`), b);
  assert.match(page.text, /data-tprm-due-approval="not_yet_assessed"/);
  assert.match(page.text, /data-tprm-due-state="due_today">Due today</);
  assert.match(page.text, new RegExp(`data-tprm-due-row="${ids['Overdue Old']}"(?:(?!<\\/tr>)[^])*data-tprm-due-state="overdue">Due [^<]*, 40 days overdue<`),
    'never assessed, its due date 40 days past: red, overdue (decision 8)');
  assert.match(page.text, new RegExp(`data-tprm-due-row="${ids['No Date']}"(?:(?!<\\/tr>)[^])*data-tprm-due-state="not_assessed">Not assessed yet<`),
    'never assessed and no due date: "Not assessed yet", not red (decision 8)');
  assert.match(page.text, /data-tprm-due-start/, 'the manager can start a reassessment from the queue');
  const queue = await R.dueQueue(lookup(), managerUser(), { clientId: ws });
  assert.deepEqual(queue.rows.map(r => r.id), rows);
  assert.equal(queue.counts.overdue, 2);
  assert.equal(queue.counts.no_date, 1);
  assert.equal(queue.counts.within_30, 2);
  assert.equal(queue.counts.within_60, 1);
  assert.equal(queue.counts.within_90, 1);

  const start = await client.post(`/tprm/clients/${ws}/third-parties/${ids['Overdue Old']}/assessments`, {});
  assert.equal(start.status, 302);
  const aid = idIn(start.location, /assessments\/(\d+)/);
  assert.equal((await db.prepare('SELECT type FROM tp_assessments WHERE id=?').get(aid)).type, 'reassessment');
  const after = await client.get(`/tprm/due?client=${ws}`);
  assert.match(after.text, new RegExp(`assessments/${aid}" data-tprm-due-open`));
  assert.match(after.text, /data-tprm-due-approval="not_yet_assessed"[^]*?Assessment in progress/);
  const own = await client.get(`/tprm/clients/${ws}?view=due`);
  assert.equal(own.status, 200);
  assert.match(own.text, /data-tprm-view="due"/);
});

test('due queue access: firm users only, each sees the clients they can reach; another firm sees none', async () => {
  const assigned = await tprmClient('Due Assigned Client');
  const unassigned = await tprmClient('Due Unassigned Client', { assign: false });
  const a = await addThirdParty(assigned, 'Assigned Vendor');
  const b = await addThirdParty(unassigned, 'Unassigned Vendor');
  await place(a, { due: null });
  await place(b, { due: null });
  const mine = await consultant.session.get('/tprm/due');
  assert.equal(mine.status, 200);
  assert.match(mine.text, new RegExp(`data-tprm-due-row="${a}"`));
  assert.doesNotMatch(mine.text, new RegExp(`data-tprm-due-row="${b}"`), 'a client the consultant is not assigned to is not listed');
  assert.match(mine.text, /data-tprm-due-start/, 'a consultant (tp.manage) can start a reassessment');
  const out = await outsider.session.get('/tprm/due');
  assert.ok([200, 403].includes(out.status));
  assert.doesNotMatch(out.text, new RegExp(`data-tprm-due-row="(${a}|${b})"`));
  const other = await otherManager.session.get('/tprm/due');
  assert.equal(other.status, 200);
  assert.doesNotMatch(other.text, new RegExp(`data-tprm-due-row="(${a}|${b})"`), 'another firm sees none of these');
  const owner = await makeUser(`due-owner-${crypto.randomBytes(3).toString('hex')}@test.local`, { type: 'client', workspaceId: assigned, memberRole: 'client_owner' });
  const s = await signIn(owner.email, owner.password);
  sessions.push(s);
  assert.equal((await s.get('/tprm/due')).status, 403, 'client users never see the firm queue');
  assert.equal((await s.get('/tprm/concentration')).status, 403);
  assert.ok([403, 404].includes((await s.get(`/tprm/clients/${assigned}/concentration`)).status));
  const home = await client.get('/tprm');
  assert.match(home.text, /href="\/tprm\/due" data-tprm-due-link/);
  assert.match(home.text, /data-tprm-firm-concentration-link/, 'managers get the firm-wide concentration link');
  assert.doesNotMatch((await consultant.session.get('/tprm')).text, /data-tprm-firm-concentration-link/);
});

test('recording a trigger sets the due date to today, keeps the previous one, writes the events and shows in the queue', async () => {
  const ws = await tprmClient('Trigger Client');
  const today = await todayOf(ws);
  const tp = await addThirdParty(ws, 'Breached Vendor');
  await place(tp, { due: shift(today, 200), tier: 'critical' });
  const page = await client.get(`/tprm/clients/${ws}/third-parties/${tp}`);
  assert.match(page.text, /data-tprm-trigger-form/);
  const before = await tpRow(tp);
  const res = await client.post(`/tprm/clients/${ws}/third-parties/${tp}/triggers`, { reason: 'breach', details: 'Ransomware at the provider', row_version: String(before.row_version) });
  assert.equal(res.status, 302);
  assert.match(toast(res), /Early reassessment triggered: due today/);
  const row = await tpRow(tp);
  assert.equal(row.next_due_date, today);
  assert.equal(row.row_version, before.row_version + 1);
  const trig = await db.prepare(`SELECT *, previous_due_date::text AS prev, new_due_date::text AS nd FROM tp_trigger_events WHERE third_party_id=?`).get(tp);
  assert.equal(trig.reason, 'breach');
  assert.equal(trig.prev, shift(today, 200));
  assert.equal(trig.nd, today);
  const chain = await tpChain(ws, tp);
  const ev = chain.find(e => e.action === 'third_party.reassessment_triggered');
  assert.ok(ev, 'event in the third party chain');
  assert.deepEqual(ev.before_state, { next_due_date: shift(today, 200) });
  assert.equal(ev.after_state.next_due_date, today);
  assert.equal(ev.after_state.reason, 'breach');
  assert.equal(ev.after_state.details, 'Ransomware at the provider');
  assert.equal(Number(ev.actor_user_id), Number((await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id));
  assert.ok((await db.prepare(`SELECT 1 FROM audit_log WHERE action='tprm_reassessment_triggered' AND entity_id=?`).get(tp)), 'audit-logged');
  const queue = await client.get(`/tprm/due?client=${ws}`);
  assert.match(queue.text, new RegExp(`data-tprm-due-row="${tp}"[^]*?data-tprm-due-trigger="breach">Triggered: Breach<`));
  const tpPage = await client.get(`/tprm/clients/${ws}/third-parties/${tp}`);
  assert.match(tpPage.text, /Early reassessment triggered/, 'the History names the event');
  const list = await client.get(`/tprm/clients/${ws}/third-parties/${tp}/triggers`);
  assert.match(list.text, /data-tprm-open-trigger>Triggered: Breach</);

  const bad = await client.post(`/tprm/clients/${ws}/third-parties/${tp}/triggers`, { reason: 'other', details: '' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Say what happened/);
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/triggers`, { reason: 'nonsense' })).status, 400);
  const other = await client.post(`/tprm/clients/${ws}/third-parties/${tp}/triggers`, { reason: 'other', details: 'Regulator letter' });
  assert.equal(other.status, 302);
  assert.match((await client.get(`/tprm/due?client=${ws}`)).text, /Triggered: Regulator letter/, 'the latest trigger is shown');
  const stale = await client.post(`/tprm/clients/${ws}/third-parties/${tp}/triggers`, { reason: 'breach', row_version: '1' });
  assert.equal(stale.status, 302);
  assert.match(toast(stale), /Someone else changed/);
  assert.deepEqual(await events.verifyChains(db, ws), []);
});

test('an overdue date is kept; proposed and exited third parties are refused; CSRF, permission and isolation hold', async () => {
  const ws = await tprmClient('Trigger Rules Client');
  const today = await todayOf(ws);
  const overdue = await addThirdParty(ws, 'Already Overdue');
  await place(overdue, { due: shift(today, -30) });
  const kept = await client.post(`/tprm/clients/${ws}/third-parties/${overdue}/triggers`, { reason: 'ownership_change' });
  assert.equal(kept.status, 302);
  assert.match(toast(kept), /Early reassessment triggered: due since \d{1,2} [A-Z][a-z]{2} \d{4}$/, 'the kept date is printed as a day, not ISO');
  assert.equal((await tpRow(overdue)).next_due_date, shift(today, -30), 'an overdue date is never moved forward');
  const g = await db.prepare('SELECT previous_due_date::text AS p, new_due_date::text AS n FROM tp_trigger_events WHERE third_party_id=?').get(overdue);
  assert.deepEqual([g.p, g.n], [shift(today, -30), shift(today, -30)]);
  assert.match((await client.get(`/tprm/due?client=${ws}`)).text, /Triggered: Change of ownership/);

  const noDate = await addThirdParty(ws, 'No Date Vendor');
  await place(noDate, { due: null });
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${noDate}/triggers`, { reason: 'ai_change' })).status, 302);
  assert.equal((await tpRow(noDate)).next_due_date, today, 'no due date becomes today');

  const proposed = await addThirdParty(ws, 'Proposed Vendor', { status: 'proposed' });
  const refused = await client.post(`/tprm/clients/${ws}/third-parties/${proposed}/triggers`, { reason: 'breach' });
  assert.equal(refused.status, 302);
  assert.match(toast(refused), /only for a third party in use/);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_trigger_events WHERE third_party_id=?').get(proposed)).c, 0);
  await assert.rejects(db.prepare(`INSERT INTO tp_trigger_events (workspace_id, third_party_id, reason, new_due_date, recorded_by)
    VALUES (?, ?, 'breach', CURRENT_DATE, 1)`).run(ws, proposed), /only for a third party in use/);
  assert.doesNotMatch((await client.get(`/tprm/clients/${ws}/third-parties/${proposed}`)).text, /data-tprm-trigger-form/);

  const [t] = await db.prepare('SELECT id FROM tp_trigger_events WHERE third_party_id=?').all(overdue);
  await assert.rejects(db.prepare(`UPDATE tp_trigger_events SET reason='other', details='x' WHERE id=?`).run(t.id), /never changes/);
  await assert.rejects(db.prepare('DELETE FROM tp_trigger_events WHERE id=?').run(t.id), /never deleted/);

  const noToken = await client.post(`/tprm/clients/${ws}/third-parties/${overdue}/triggers`, { reason: 'breach' }, { csrf: false });
  assert.equal(noToken.status, 403, 'a POST without the CSRF token is refused');
  const owner = await makeUser(`due-trigger-owner-${crypto.randomBytes(3).toString('hex')}@test.local`, { type: 'client', workspaceId: ws, memberRole: 'client_owner' });
  const os = await signIn(owner.email, owner.password);
  sessions.push(os);
  assert.ok([403, 404].includes((await os.post(`/tprm/clients/${ws}/third-parties/${overdue}/triggers`, { reason: 'breach' })).status),
    'a client user cannot record a trigger');
  const otherWs = await tprmClient('Trigger Other Client');
  assert.equal((await client.post(`/tprm/clients/${otherWs}/third-parties/${overdue}/triggers`, { reason: 'breach' })).status, 404,
    'another client\'s third party through this client\'s URL');
  assert.equal((await otherManager.session.post(`/tprm/clients/${ws}/third-parties/${overdue}/triggers`, { reason: 'breach' })).status, 404,
    'another firm');
  assert.equal((await outsider.session.get(`/tprm/clients/${ws}/third-parties/${overdue}/triggers`)).status, 404, 'a consultant not assigned');
});

test('the trigger date survives register edits and client-settings recalculations until a decision moves it', async () => {
  const ws = await tprmClient('Trigger Provisional Client');
  const today = await todayOf(ws);
  const settings = await client.get(`/tprm/clients/${ws}/settings`);
  const rv = (settings.text.match(/name="row_version" value="(\d+)"/) || [])[1];
  assert.equal((await client.post(`/tprm/clients/${ws}/settings`, { label: ['Tier 3'], tier: ['low'], row_version: rv })).status, 302);
  const tp = await addThirdParty(ws, 'Provisional Vendor', { fields: { client_label: 'Tier 3', last_assessment_date: shift(today, -10) } });
  const placed = await tpRow(tp);
  assert.equal(placed.tier_source, 'provisional_from_client_label');
  assert.ok(placed.next_due_date > today, 'its computed due date is in the future');
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/triggers`, { reason: 'breach' })).status, 302);
  assert.equal((await tpRow(tp)).next_due_date, today);
  const edit = await tpRow(tp);
  const res = await client.post(`/tprm/clients/${ws}/third-parties/${tp}`, {
    name: 'Provisional Vendor Renamed', status: 'in_use', client_label: 'Tier 3', last_assessment_date: shift(today, -10), row_version: String(edit.row_version) });
  assert.equal(res.status, 302);
  assert.equal((await tpRow(tp)).next_due_date, today, 'kept after an edit');
  const s2 = await client.get(`/tprm/clients/${ws}/settings`);
  const rv2 = (s2.text.match(/name="row_version" value="(\d+)"/) || [])[1];
  assert.equal((await client.post(`/tprm/clients/${ws}/settings`, { label: ['Tier 3'], tier: ['medium'], row_version: rv2 })).status, 302);
  const row = await tpRow(tp);
  assert.equal(row.current_tier, 'medium', 'the tier follows the new mapping');
  assert.equal(row.next_due_date, today, 'the trigger date is kept');
  assert.match((await client.get(`/tprm/due?client=${ws}`)).text, /Triggered: Breach/);
  await place(tp, { due: shift(today, 365) });
  assert.equal((await R.openTriggers(db, ws, [await tpRow(tp)])).size, 0);
  assert.equal(await R.hasOpenTrigger(db, ws, await tpRow(tp)), false);
  assert.deepEqual(await events.verifyChains(db, ws), []);
});

async function concentrationFixtures(ws, { prefix = '' } = {}) {
  const make = async (name, tier, category, services, { status = 'in_use' } = {}) => {
    const tp = await addThirdParty(ws, prefix + name, { status, fields: category ? { category } : {} });
    if (tier) await place(tp, { tier });
    for (const s of services) await addService(ws, tp, s);
    return tp;
  };
  const ids = {};
  ids.aws = await make('AWS', 'critical', 'Cloud hosting', [
    { description: 'Core banking hosting', hosting_countries: 'India, Singapore', sole_source: '1' },
    { description: 'Data warehouse', hosting_countries: 'India' },
    { description: 'Backups', hosting_countries: 'singapore' },
    { description: 'Email relay', hosting_countries: '' },
  ]);
  ids.azure = await make('Azure', 'critical', 'Cloud hosting', [
    { description: 'Directory', hosting_countries: 'India' },
    { description: 'Analytics', hosting_countries: 'India' },
    { description: 'Mobile backend', hosting_countries: 'India', sole_source: '1' },
  ]);
  ids.zoho = await make('Zoho', 'critical', 'SaaS', [
    { description: 'CRM', hosting_countries: 'India' },
    { description: 'Helpdesk', hosting_countries: 'India' },
  ]);
  ids.tally = await make('Tally', 'critical', 'Finance software', [{ description: 'Ledger', hosting_countries: 'India', sole_source: '1' }]);
  ids.stripe = await make('Stripe', 'high', 'Payments', [
    { description: 'Card payments', hosting_countries: 'USA', sole_source: '1' },
    { description: 'Payouts', hosting_countries: 'USA' },
  ]);
  ids.cleaner = await make('Cleaner', null, null, [{ description: 'Office cleaning' }]);
  ids.empty = await make('No Services', 'low', 'Misc', []);
  ids.proposed = await make('Proposed Cloud', 'critical', 'Cloud hosting', [{ description: 'Planned', hosting_countries: 'India' }], { status: 'proposed' });
  return ids;
}

test('concentration per client: groups and headline numbers on fixtures', async () => {
  const ws = await tprmClient('Concentration Client');
  const ids = await concentrationFixtures(ws);
  const actor = { user: managerUser(), perms: new Set(rbac.rolePermissions('manager').concat(['*'])), ws: await wsRow(ws) };
  const s = await C.forClient(db, actor);
  assert.equal(s.total, 13, 'services of in-use third parties only (the proposed one is left out)');
  assert.equal(s.thirdParties, 6);
  assert.equal(s.withoutServices, 1);
  const g = d => Object.fromEntries(s.groups[d].map(x => [x.key, x.count]));
  assert.deepEqual(s.groups.third_party.map(x => [x.label, x.count]),
    [['AWS', 4], ['Azure', 3], ['Stripe', 2], ['Zoho', 2], ['Cleaner', 1], ['Tally', 1]]);
  assert.deepEqual(g('tier'), { critical: 10, high: 2, '': 1 });
  assert.deepEqual(s.groups.tier.map(x => x.label), ['Critical', 'High', 'Tier needed']);
  assert.deepEqual(g('category'), { 'cloud hosting': 7, saas: 2, payments: 2, 'finance software': 1, '': 1 });
  assert.equal(s.groups.category.at(-1).label, 'No category', 'the group without a value comes last');
  assert.deepEqual(g('country'), { india: 8, singapore: 2, usa: 2, '': 2 });
  assert.deepEqual(g('sole_source'), { yes: 4, no: 9 });
  const lines = Object.fromEntries(s.headlines.map(h => [h.key, h.text]));
  assert.equal(lines.tier_critical, '7 of 10 Critical services depend on 2 third parties (AWS, Azure).');
  assert.equal(lines.tier_high, '2 of 2 High services depend on 1 third party (Stripe).');
  assert.equal(lines.top_third_party, 'AWS provides 4 of 13 services.');
  const single = C.summarise([{ id: 1, third_party_id: 1, third_party_name: 'Solo', tier: 'high', client_id: 1 }]);
  assert.equal(single.headlines.find(h => h.key === 'tier_high').text, '1 of 1 High service depends on 1 third party (Solo).');
  assert.equal(lines.top_country, '8 of 13 services are hosted in India.');
  assert.equal(lines.country_unrecorded, '2 of 13 services have no hosting country recorded.');
  assert.equal(lines.sole_source, '4 of 13 services are sole source; 4 of them are Critical or High tier.');

  const page = await client.get(`/tprm/clients/${ws}/concentration`);
  assert.equal(page.status, 200);
  assert.match(page.text, /7 of 10 Critical services depend on 2 third parties \(AWS, Azure\)\./);
  assert.match(page.text, /data-tprm-group-row="tier:critical" data-tprm-group-count="10"/);
  assert.match(page.text, /data-tprm-concentration-without="1"/);
  assert.doesNotMatch(page.text, /Proposed Cloud/);
  assert.match((await client.get(`/tprm/clients/${ws}`)).text, /href="\/tprm\/clients\/\d+\/concentration" data-tprm-concentration-link/);
  assert.equal((await consultant.session.get(`/tprm/clients/${ws}/concentration`)).status, 200);
  assert.equal((await outsider.session.get(`/tprm/clients/${ws}/concentration`)).status, 404);
  assert.equal((await otherManager.session.get(`/tprm/clients/${ws}/concentration`)).status, 404);
  const empty = await tprmClient('Concentration Empty Client');
  assert.match((await client.get(`/tprm/clients/${empty}/concentration`)).text, /data-tprm-concentration-empty/);
});

test('concentration firm-wide: managers only, third parties matched by name across clients', async () => {
  const one = await tprmClient('Firm Concentration One');
  const two = await tprmClient('Firm Concentration Two', { assign: false });
  const a = await addThirdParty(one, 'Shared Cloud Co');
  await place(a, { tier: 'critical' });
  await addService(one, a, { description: 'Hosting one', hosting_countries: 'India' });
  const b = await addThirdParty(two, '  shared cloud co ');
  await place(b, { tier: 'critical' });
  await addService(two, b, { description: 'Hosting two', hosting_countries: 'India' });
  await addService(two, b, { description: 'Hosting three', hosting_countries: 'India' });
  const page = await client.get('/tprm/concentration');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tprm-concentration="firm"/);
  const row = page.text.match(/data-tprm-group-row="third_party:shared cloud co" data-tprm-group-count="(\d+)"/);
  assert.ok(row, 'one group for both clients\' records');
  assert.equal(Number(row[1]), 3);
  assert.match(page.text, /Firm Concentration Two · /, 'the services list names the client');
  assert.equal((await consultant.session.get('/tprm/concentration')).status, 403, 'consultants open a client instead');
  const other = await otherManager.session.get('/tprm/concentration');
  assert.equal(other.status, 200);
  assert.doesNotMatch(other.text, /shared cloud co/i, 'another firm sees only its own clients');
});

test('deleting a client removes its trigger events; chains verify', async () => {
  const ws = await tprmClient('Delete Trigger Client');
  const tp = await addThirdParty(ws, 'Doomed Vendor');
  assert.equal((await client.post(`/tprm/clients/${ws}/third-parties/${tp}/triggers`, { reason: 'breach' })).status, 302);
  assert.deepEqual(await events.verifyChains(db, ws), []);
  const name = (await wsRow(ws)).client_name;
  assert.equal((await client.post(`/workspaces/${ws}/delete`, { confirm_name: name })).status, 302);
  for (const table of ['tp_trigger_events', 'tp_third_parties', 'tp_events']) {
    assert.equal((await db.prepare(`SELECT COUNT(*)::int c FROM ${table} WHERE workspace_id=?`).get(ws)).c, 0, table);
  }
  const ws2 = await tprmClient('Direct Delete Trigger Client');
  const tp2 = await addThirdParty(ws2, 'Direct Vendor');
  assert.equal((await client.post(`/tprm/clients/${ws2}/third-parties/${tp2}/triggers`, { reason: 'breach' })).status, 302);
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(ws2);
  assert.equal((await db.prepare('SELECT COUNT(*)::int c FROM tp_trigger_events WHERE workspace_id=?').get(ws2)).c, 0);
});
