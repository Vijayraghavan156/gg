'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'subprocessors-tests-password-1234';
const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily' };

let env;
let client;
let db;
let firmId;
let otherFirmId;
let SP;
let C;
let events;
let consultant;
let senior;
let otherManager;
const sessions = [];

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  SP = require('../lib/tprm/subprocessors');
  C = require('../lib/tprm/concentration');
  events = require('../lib/tprm/events');
  firmId = Number((await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id);
  otherFirmId = Number((await db.prepare(`INSERT INTO firms (name) VALUES ('Subprocessors Other Firm')`).run()).lastInsertRowid);
  consultant = await makeUser('sp-consultant@test.local', { role: 'consultant' });
  senior = await makeUser('sp-senior@test.local', { role: 'senior_consultant' });
  otherManager = await makeUser('sp-other-manager@test.local', { role: 'manager', firm: otherFirmId });
  for (const u of [consultant, senior, otherManager]) u.session = await signIn(u.email, u.password);
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

async function tprmClient(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(id, u.id, u.firm_role);
  const owner = await makeUser(`sp-owner-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@test.local`, { type: 'client', workspaceId: id, memberRole: 'client_owner' });
  owner.session = await signIn(owner.email, owner.password);
  sessions.push(owner.session);
  return { id, owner };
}

const idIn = (location, pattern) => Number((String(location).match(pattern) || [])[1]);
const toast = res => decodeURIComponent(String(res.location || '').replace(/\+/g, ' '));
const tpBase = (ws, tp) => `/tprm/clients/${ws}/third-parties/${tp}`;
const spRows = async tp => db.prepare('SELECT * FROM tp_subprocessors WHERE third_party_id=? ORDER BY id').all(tp);
const chain = async (ws, tp) => db.prepare(`SELECT action, before_state, after_state FROM tp_events
  WHERE workspace_id=? AND chain_type='third_party' AND chain_id=? ORDER BY chain_seq`).all(ws, tp);
const assessmentRow = async id => db.prepare('SELECT * FROM tp_assessments WHERE id=?').get(id);

async function addThirdParty(ws, name, status = 'in_use') {
  const res = await client.post(`/tprm/clients/${ws}/third-parties`, { name, status });
  assert.equal(res.status, 302);
  const tp = idIn(res.location, /third-parties\/(\d+)/);
  assert.equal((await client.post(`${tpBase(ws, tp)}/services`, { description: `${name} service` })).status, 302);
  return tp;
}

async function addSp(ws, tp, body, session = consultant.session) {
  await session.get(tpBase(ws, tp));
  return await session.post(`${tpBase(ws, tp)}/subprocessors`, body);
}

async function submittedAnswers(ws, tp) {
  const started = await consultant.session.post(`${tpBase(ws, tp)}/assessments`, {});
  const a = idIn(started.location, /assessments\/(\d+)/);
  const sid = (await db.prepare('SELECT id FROM tp_services WHERE third_party_id=?').get(tp)).id;
  const body = { services: [String(sid)], intent: 'propose', row_version: String((await assessmentRow(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await consultant.session.post(`${tpBase(ws, tp)}/assessments/${a}/scope`, body)).status, 302);
  assert.equal((await senior.session.post(`${tpBase(ws, tp)}/assessments/${a}/confirm`, { row_version: String((await assessmentRow(a)).row_version) })).status, 302);
  assert.equal((await consultant.session.post(`${tpBase(ws, tp)}/assessments/${a}/questionnaire`, { delivery_model: 'vendor_hosted' })).status, 302);
  const q = await db.prepare('SELECT id FROM tp_questionnaires WHERE assessment_id=?').get(a);
  const ids = {};
  await db.exec('ALTER TABLE tp_answers DISABLE TRIGGER tp_answers_guard');
  await db.exec('ALTER TABLE tp_questionnaires DISABLE TRIGGER tp_questionnaires_guard');
  try {
    for (const [qid, response, detail] of [['FTP-01', 'text', 'Amazon Web Services (hosting, Mumbai); Twilio (SMS, USA)'], ['FTP-05', 'no', '30 days notice for new subprocessors'], ['GOV-01', 'text', 'Reviewed every year']]) {
      ids[qid] = Number((await db.prepare(`INSERT INTO tp_answers (workspace_id, assessment_id, questionnaire_id, question_id, response, detail, saved_at, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, now(), now()) RETURNING id`).get(ws, a, q.id, qid, response, detail)).id);
    }
    await db.prepare(`UPDATE tp_questionnaires SET status = 'submitted', sent_at = COALESCE(sent_at, now()), submitted_at = now() WHERE id = ?`).run(q.id);
  } finally {
    await db.exec('ALTER TABLE tp_answers ENABLE TRIGGER tp_answers_guard');
    await db.exec('ALTER TABLE tp_questionnaires ENABLE TRIGGER tp_questionnaires_guard');
  }
  return ids;
}

test('subprocessors: added, edited and removed by the firm for any TPRM client; validation, stale rows, CSRF, events', async () => {
  const c = await tprmClient('SP CRUD Client');
  const tp = await addThirdParty(c.id, 'Payments Gateway Ltd');
  const page = await consultant.session.get(tpBase(c.id, tp));
  assert.match(page.text, /data-tprm-subprocessors/, 'shown for an unregulated client too');
  assert.match(page.text, /data-tprm-subprocessor-helper-empty/);
  assert.match(page.text, /No questionnaire submitted by this third party yet/);
  assert.doesNotMatch(page.text, /data-tprm-exit-plans/, 'the regulated features stay hidden');

  const added = await addSp(c.id, tp, { name: '  Amazon Web Services ', service: 'Hosting', country: 'India' });
  assert.equal(added.status, 302);
  assert.match(toast(added), /Subprocessor added/);
  const [row] = await spRows(tp);
  assert.deepEqual([row.name, row.service, row.country, row.source, row.answer_id], ['Amazon Web Services', 'Hosting', 'India', 'manual', null]);
  assert.match(toast(await addSp(c.id, tp, { name: '' })), /Name the subprocessor/);
  assert.match(toast(await addSp(c.id, tp, { name: 'x'.repeat(201) })), /200 characters/);
  assert.equal((await consultant.session.post(`${tpBase(c.id, tp)}/subprocessors`, { name: 'No token' }, { csrf: false })).status, 403);
  assert.equal((await spRows(tp)).length, 1);

  const edit = await consultant.session.get(`${tpBase(c.id, tp)}/subprocessors/${row.id}/edit`);
  assert.equal(edit.status, 200);
  const updated = await consultant.session.post(`${tpBase(c.id, tp)}/subprocessors/${row.id}`, { name: 'AWS', service: 'Hosting and backups', country: 'India', row_version: String(row.row_version) });
  assert.match(toast(updated), /Subprocessor updated/);
  const stale = await consultant.session.post(`${tpBase(c.id, tp)}/subprocessors/${row.id}`, { name: 'AWS 2', row_version: String(row.row_version) });
  assert.match(toast(stale), /Someone else changed this subprocessor/);
  const same = await consultant.session.post(`${tpBase(c.id, tp)}/subprocessors/${row.id}`, { name: 'AWS', service: 'Hosting and backups', country: 'India', row_version: String(row.row_version + 1) });
  assert.match(toast(same), /No changes to save/);
  assert.match((await consultant.session.get(tpBase(c.id, tp))).text, /data-tprm-subprocessor="\d+"[\s\S]*?AWS/);
  assert.ok([403, 404].includes((await c.owner.session.post(`${tpBase(c.id, tp)}/subprocessors`, { name: 'Client add' })).status));
  const removed = await consultant.session.post(`${tpBase(c.id, tp)}/subprocessors/${row.id}/remove`, { row_version: String(row.row_version + 1) });
  assert.match(toast(removed), /Subprocessor removed/);
  assert.equal((await spRows(tp)).length, 0);
  const ev = (await chain(c.id, tp)).filter(e => e.action.startsWith('subprocessor.'));
  assert.deepEqual(ev.map(e => e.action), ['subprocessor.added', 'subprocessor.updated', 'subprocessor.removed']);
  assert.equal(ev[1].after_state.name, 'AWS');
  assert.deepEqual(await events.verifyChains(db, c.id), []);
});

test('the helper shows the third party\'s FTP-01 answer first; a row copied from it keeps the answer (checked by the database)', async () => {
  const c = await tprmClient('SP Helper Client');
  const tp = await addThirdParty(c.id, 'Helper Vendor Ltd', 'proposed');
  const ids = await submittedAnswers(c.id, tp);
  const page = await consultant.session.get(tpBase(c.id, tp));
  assert.match(page.text, /data-tprm-subprocessor-answer="FTP-01"[\s\S]*Amazon Web Services \(hosting, Mumbai\); Twilio/);
  assert.ok(page.text.indexOf('data-tprm-subprocessor-answer="FTP-01"') < page.text.indexOf('data-tprm-subprocessor-answer="FTP-05"'), 'FTP-01 first');
  assert.doesNotMatch(page.text, /data-tprm-subprocessor-answer="GOV-01"/, 'only the subcontractor questions');
  assert.match(page.text, new RegExp(`<option value="${ids['FTP-01']}"[^>]*>From the answer to FTP-01`));
  assert.equal((await addSp(c.id, tp, { name: 'Twilio', service: 'SMS', country: 'USA', answer_id: String(ids['FTP-01']) })).status, 302);
  const [row] = await spRows(tp);
  assert.deepEqual([row.source, Number(row.answer_id)], ['questionnaire', ids['FTP-01']]);
  assert.match((await consultant.session.get(tpBase(c.id, tp))).text, /From the questionnaire[\s\S]{0,80}\(FTP-01\)/);
  assert.match(toast(await addSp(c.id, tp, { name: 'X', answer_id: String(ids['GOV-01']) })), /latest submitted questionnaire/);
  const tp2 = await addThirdParty(c.id, 'Other Helper Vendor');
  assert.match(toast(await addSp(c.id, tp2, { name: 'X', answer_id: String(ids['FTP-01']) })), /latest submitted questionnaire/);
  await assert.rejects(db.prepare(`INSERT INTO tp_subprocessors (workspace_id, third_party_id, name, source, answer_id) VALUES (?, ?, 'X', 'questionnaire', ?)`)
    .run(c.id, tp2, ids['FTP-01']), /submitted answer of this third party/);
  await assert.rejects(db.prepare(`INSERT INTO tp_subprocessors (workspace_id, third_party_id, name, source) VALUES (?, ?, 'X', 'questionnaire')`)
    .run(c.id, tp2), /source_answer/);
  await assert.rejects(db.prepare('UPDATE tp_subprocessors SET third_party_id = ? WHERE id = ?').run(tp2, row.id), /never moves/);
});

test('fourth parties: shared subprocessors on the client\'s concentration view, firm-wide for managers, and in the portal (own, names only)', async () => {
  const pure = C.fourthParties([
    { name: 'AWS', third_party_id: 1, third_party_name: 'A', client_id: 9 },
    { name: ' aws ', third_party_id: 2, third_party_name: 'B', client_id: 9 },
    { name: 'AWS', third_party_id: 2, third_party_name: 'B', client_id: 9 },
    { name: 'Twilio', third_party_id: 1, third_party_name: 'A', client_id: 9 },
  ], { inUse: 4 });
  assert.deepEqual(pure.list.map(g => [g.label, g.count]), [['AWS', 2], ['Twilio', 1]], 'matched ignoring case and spaces; a third party once');
  assert.deepEqual(pure.headlines.map(h => h.text), ['An outage at AWS affects 2 of your 4 third parties in use (A, B).']);

  const c = await tprmClient('SP Concentration Client');
  const t1 = await addThirdParty(c.id, 'Core Banking Co');
  const t2 = await addThirdParty(c.id, 'Card Processor Co');
  const t3 = await addThirdParty(c.id, 'Proposed Vendor Co', 'proposed');
  await addSp(c.id, t1, { name: 'AWS', service: 'Hosting' });
  await addSp(c.id, t2, { name: 'aws', service: 'Hosting' });
  await addSp(c.id, t2, { name: 'Twilio' });
  await addSp(c.id, t3, { name: 'AWS' });
  const other = await tprmClient('SP Concentration Other Client');
  const o1 = await addThirdParty(other.id, 'Other Client Vendor');
  await addSp(other.id, o1, { name: 'AWS' });
  await addSp(other.id, o1, { name: 'Secret Fourth Party' });

  const view = await consultant.session.get(`/tprm/clients/${c.id}/concentration`);
  assert.equal(view.status, 200);
  assert.match(view.text, /data-tprm-fourth-parties="client"/);
  assert.match(view.text, /An outage at AWS affects 2 of your 2 third parties in use \(Card Processor Co, Core Banking Co\)/, 'in use only: the proposed one is not counted');
  assert.match(view.text, /data-tprm-fourth-row="AWS" data-tprm-fourth-count="2"/);
  assert.doesNotMatch(view.text, /Secret Fourth Party|Other Client Vendor/);

  const firm = await client.get('/tprm/concentration');
  assert.equal(firm.status, 200);
  assert.match(firm.text, /data-tprm-fourth-parties="firm"/);
  assert.match(firm.text, /AWS is a subprocessor of 3 third parties across 2 clients/);
  assert.equal((await consultant.session.get('/tprm/concentration')).status, 403, 'firm-wide is for managers');

  const portalView = await c.owner.session.get(`/workspaces/${c.id}/client-portal/third-party-risk/concentration`);
  assert.equal(portalView.status, 200);
  assert.match(portalView.text, /data-tprm-fourth-parties="portal"/);
  assert.match(portalView.text, /An outage at AWS affects 2 of your 2 third parties in use/);
  assert.doesNotMatch(portalView.text, /Secret Fourth Party|Other Client Vendor|\/tprm\/clients\//, 'own client only, no firm links');
  assert.notEqual((await other.owner.session.get(`/workspaces/${c.id}/client-portal/third-party-risk/concentration`)).status, 200, 'another client\'s user is refused');
});

test('isolation: another client\'s or firm\'s subprocessor is not found', async () => {
  const a = await tprmClient('SP Iso A');
  const b = await tprmClient('SP Iso B');
  const ta = await addThirdParty(a.id, 'Iso Vendor A');
  const tb = await addThirdParty(b.id, 'Iso Vendor B');
  await addSp(a.id, ta, { name: 'AWS' });
  const [row] = await spRows(ta);
  assert.equal((await consultant.session.get(`${tpBase(b.id, tb)}/subprocessors/${row.id}/edit`)).status, 404);
  assert.equal((await consultant.session.post(`${tpBase(b.id, tb)}/subprocessors/${row.id}/remove`, { row_version: '1' })).status, 404);
  assert.equal((await consultant.session.post(`${tpBase(b.id, ta)}/subprocessors`, { name: 'Cross' })).status, 404);
  assert.equal((await otherManager.session.post(`${tpBase(a.id, ta)}/subprocessors`, { name: 'Foreign' })).status, 404);
  assert.equal((await otherManager.session.get(`${tpBase(a.id, ta)}/subprocessors/${row.id}/edit`)).status, 404);
  await assert.rejects(db.prepare(`INSERT INTO tp_subprocessors (workspace_id, third_party_id, name, source) VALUES (?, ?, 'X', 'manual')`).run(b.id, ta), /foreign key/);
  assert.equal((await spRows(ta)).length, 1);
});

test('the client sees "After the first assessment" for a third party never assessed, and the real date once one was', async () => {
  const c = await tprmClient('Next Review Client');
  const fresh = await addThirdParty(c.id, 'Never Assessed Co');
  const page = await c.owner.session.get(`/workspaces/${c.id}/client-portal/third-party-risk/third-parties/${fresh}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<dt>Next review<\/dt><dd>After the first assessment<\/dd>/);

  const res = await client.post(`/tprm/clients/${c.id}/third-parties`, { name: 'Assessed Before Co', status: 'in_use', last_assessment_date: '2025-06-01' });
  const before = idIn(res.location, /third-parties\/(\d+)/);
  const due = (await db.prepare('SELECT next_due_date::text AS d FROM tp_third_parties WHERE id=?').get(before)).d;
  assert.ok(due, 'a past assessment sets the next due date');
  const later = await c.owner.session.get(`/workspaces/${c.id}/client-portal/third-party-risk/third-parties/${before}`);
  assert.doesNotMatch(later.text, /After the first assessment/);
});
