'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'tprm-team-tests-password-1234';

let env;
let db;
let firmId;
let manager;
let owner;
let reviewer;
let outsider;
const sessions = [];

test.before(async () => {
  env = await bootClient();
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  manager = await makeUser('team-manager@test.local', 'manager', 'Mona Manager');
  owner = await makeUser('team-owner@test.local', 'consultant', 'Omar Owner');
  reviewer = await makeUser('team-reviewer@test.local', 'senior_consultant', 'Rhea Reviewer');
  outsider = await makeUser('team-outsider@test.local', 'consultant', 'Oscar Outsider');
});

test.after(async () => {
  for (const s of sessions) await s.close();
  if (env && env.client) await env.client.close();
});

async function makeUser(email, role, name) {
  const id = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES (?,?,?,'firm',?,?,1)`).run(email, bcrypt.hashSync(PASSWORD, 4), name, firmId, role)).lastInsertRowid);
  return { id, email, firm_role: role, user_type: 'firm', firm_id: firmId, name };
}

async function sessionFor(user) {
  if (user.session) return user.session;
  const session = makeClient(env.app);
  const page = await session.get('/login');
  const csrf = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  const res = await session.post('/login', { email: user.email, password: PASSWORD, _csrf: csrf }, { csrf: false });
  assert.equal(res.status, 302, `${user.email} signs in`);
  await session.get('/dashboard');
  sessions.push(session);
  user.session = session;
  return session;
}

async function clientWithThirdParty(name) {
  const ws = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, `${name} Client`)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(ws);
  for (const u of [owner, reviewer]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(ws, u.id, u.firm_role);
  const m = await sessionFor(manager);
  const res = await m.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
  assert.equal(res.status, 302);
  const tp = Number((String(res.location).match(/third-parties\/(\d+)/) || [])[1]);
  return { ws, tp, base: `/tprm/clients/${ws}/third-parties/${tp}` };
}

const teamOf = async (ws, tp) => require('../lib/tprm/team').forThirdParty(db, ws, tp);
const openOf = async (ws, tp) => db.prepare(`SELECT id, lead_consultant_id, reviewer_id FROM tp_assessments
  WHERE workspace_id = ? AND third_party_id = ? AND status NOT IN ('completed', 'cancelled')`).get(ws, tp);

test('a manager names the owner and reviewer; the page shows them and history records the change', async () => {
  const c = await clientWithThirdParty('Harbour Couriers');
  const m = await sessionFor(manager);
  const before = await m.get(c.base);
  assert.equal(before.status, 200);
  assert.match(before.text, /data-tprm-team-owner[\s\S]*?No owner named/);
  const res = await m.post(`${c.base}/team`, { team_owner_id: String(owner.id), team_reviewer_id: String(reviewer.id) });
  assert.equal(res.status, 302);
  const team = await teamOf(c.ws, c.tp);
  assert.deepEqual([team.owner.id, team.reviewer.id], [owner.id, reviewer.id]);
  const page = await m.get(c.base);
  assert.match(page.text, /data-tprm-team-owner[\s\S]*?Omar Owner/);
  assert.match(page.text, /data-tprm-team-reviewer[\s\S]*?Rhea Reviewer/);
  const ev = await db.prepare(`SELECT after_state FROM tp_events WHERE workspace_id = ? AND third_party_id = ? AND action = 'third_party.team_changed'`).get(c.ws, c.tp);
  assert.deepEqual(ev.after_state, { team_owner_id: owner.id, team_reviewer_id: reviewer.id });
});

test('the owner and reviewer must be two people who work on the client', async () => {
  const c = await clientWithThirdParty('Pinecrest Analytics');
  const m = await sessionFor(manager);
  const same = await m.post(`${c.base}/team`, { team_owner_id: String(owner.id), team_reviewer_id: String(owner.id) });
  assert.equal(same.status, 400);
  assert.match(same.text, /two different people/);
  const stranger = await m.post(`${c.base}/team`, { team_owner_id: String(outsider.id) });
  assert.equal(stranger.status, 400);
  assert.match(stranger.text, /people at your firm who work on this client/);
  const cannotReview = await m.post(`${c.base}/team`, { team_owner_id: String(reviewer.id), team_reviewer_id: String(owner.id) });
  assert.equal(cannotReview.status, 400);
  assert.match(cannotReview.text, /may confirm tiers and issue recommendations/);
  const page = await m.get(c.base);
  const reviewerSelect = (page.text.match(/<select class="select" id="team_reviewer_id"[\s\S]*?<\/select>/) || [''])[0];
  assert.match(reviewerSelect, /Rhea Reviewer/);
  assert.doesNotMatch(reviewerSelect, /Omar Owner/, 'a consultant who cannot review is not offered as reviewer');
  const team = await teamOf(c.ws, c.tp);
  assert.equal(team.owner, null);
});

test('a new review starts with the owner as lead and the reviewer named; changes follow the open review', async () => {
  const c = await clientWithThirdParty('Lattice Payroll');
  const m = await sessionFor(manager);
  assert.equal((await m.post(`${c.base}/team`, { team_owner_id: String(owner.id), team_reviewer_id: String(reviewer.id) })).status, 302);
  const started = await m.post(`${c.base}/assessments`, {});
  assert.equal(started.status, 302);
  let open = await openOf(c.ws, c.tp);
  assert.deepEqual([Number(open.lead_consultant_id), Number(open.reviewer_id)], [owner.id, reviewer.id]);

  assert.equal((await m.post(`${c.base}/team`, { team_owner_id: String(owner.id), team_reviewer_id: '' })).status, 302);
  open = await openOf(c.ws, c.tp);
  assert.equal(open.reviewer_id, null);
  assert.equal((await m.post(`${c.base}/team`, { team_owner_id: String(owner.id), team_reviewer_id: String(reviewer.id) })).status, 302);
  open = await openOf(c.ws, c.tp);
  assert.equal(Number(open.reviewer_id), reviewer.id);

  assert.equal((await m.post(`/tprm/clients/${c.ws}/third-parties/bulk-lead`, { ids: String(c.tp), lead: String(reviewer.id) })).status, 302);
  open = await openOf(c.ws, c.tp);
  assert.deepEqual([Number(open.lead_consultant_id), open.reviewer_id], [reviewer.id, null]);
});

test('without a team, the person who starts the review leads it', async () => {
  const c = await clientWithThirdParty('Quarry Facilities');
  const m = await sessionFor(manager);
  assert.equal((await m.post(`${c.base}/assessments`, {})).status, 302);
  const open = await openOf(c.ws, c.tp);
  assert.deepEqual([Number(open.lead_consultant_id), open.reviewer_id], [manager.id, null]);
});

test('"waiting for me": a tier waits for the named reviewer only while that person can act; otherwise for any reviewer', async () => {
  const other = await makeUser(`team-senior-${Date.now()}@test.local`, 'senior_consultant', 'Sita Senior');
  const c = await clientWithThirdParty('Orchard Couriers');
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(c.ws, other.id, other.firm_role);
  const m = await sessionFor(manager);
  assert.equal((await m.post(`${c.base}/services`, { description: 'Parcel delivery' })).status, 302);
  assert.equal((await m.post(`${c.base}/team`, { team_owner_id: String(owner.id), team_reviewer_id: String(reviewer.id) })).status, 302);
  const o = await sessionFor(owner);
  const started = await o.post(`${c.base}/assessments`, {});
  const a = Number((String(started.location).match(/assessments\/(\d+)/) || [])[1]);
  const svc = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id=? AND third_party_id=?').all(c.ws, c.tp)).map(r => String(r.id));
  const LOW = { data_handled: 'none', service_stops: 'minor', system_access: 'none', regulated: 'no', replaceability: 'easily', delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no' };
  const body = { services: svc, intent: 'propose', row_version: String((await db.prepare('SELECT row_version FROM tp_assessments WHERE id=?').get(a)).row_version) };
  for (const [q, x] of Object.entries(LOW)) body[`answers[${q}]`] = x;
  assert.equal((await o.post(`${c.base}/assessments/${a}/scope`, body)).status, 302);
  const waitingFor = async user => new RegExp(`data-tprm-pipeline-row="${a}"`).test((await (await sessionFor(user)).get('/tprm?who=me')).text);
  assert.equal(await waitingFor(reviewer), true, 'the named reviewer');
  assert.equal(await waitingFor(other), false, 'not another reviewer while the named one can act');
  await db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(reviewer.id);
  try {
    assert.equal(await waitingFor(other), true, 'any reviewer once the named one cannot act');
  } finally {
    await db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(reviewer.id);
  }
});
