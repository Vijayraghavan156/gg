'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { bootClient, makeClient } = require('./helpers');

const PASSWORD = 'tprm-scope-tests-password-1234';
const OTHER = 'Zephyr Hidden Logistics';
const MINE = 'Quill Own Analytics';

let env;
let db;
let firmId;
let manager;
let consultant;
let senior;
const sessions = [];

test.before(async () => {
  env = await bootClient();
  db = require('../db').db;
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  manager = await makeUser('scope-manager@test.local', 'manager', 'Mina Manager');
  consultant = await makeUser('scope-consultant@test.local', 'consultant', 'Cody Consultant');
  senior = await makeUser('scope-senior@test.local', 'senior_consultant', 'Sana Senior');
});

test.after(async () => {
  await db.prepare('UPDATE tp_firm_settings SET consultants_own_only = false WHERE firm_id = ?').run(firmId);
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

test('only mine: a scoped consultant never sees another third party, in any list, count or page; seniors and managers still do', async () => {
  const ws = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'["iso27001"]','certification_support')`).run(firmId, 'Scope Test Client')).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(ws);
  for (const u of [consultant, senior]) await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(ws, u.id, u.firm_role);
  const m = await sessionFor(manager);
  const add = async name => {
    const res = await m.post(`/tprm/clients/${ws}/third-parties`, { name, status: 'in_use' });
    const tp = Number((String(res.location).match(/third-parties\/(\d+)/) || [])[1]);
    assert.equal((await m.post(`/tprm/clients/${ws}/third-parties/${tp}/services`, { description: `Service of ${name}` })).status, 302);
    return tp;
  };
  const other = await add(OTHER);
  const mine = await add(MINE);
  assert.equal((await m.post(`/tprm/clients/${ws}/third-parties/${mine}/team`, { team_owner_id: String(consultant.id) })).status, 302);
  const started = await m.post(`/tprm/clients/${ws}/third-parties/${other}/assessments`, {});
  const otherA = Number((String(started.location).match(/assessments\/(\d+)/) || [])[1]);
  assert.ok(otherA);

  const c = await sessionFor(consultant);
  assert.match((await c.get(`/tprm/clients/${ws}`)).text, new RegExp(OTHER), 'off by default: the consultant sees everything');
  assert.equal((await c.post('/tprm/settings/access', { consultants_own_only: '1' })).status, 403, 'only a manager changes it');
  assert.equal((await m.post('/tprm/settings/access', { consultants_own_only: '1' })).status, 302);
  assert.equal((await m.post(`/tprm/clients/${ws}/third-parties/${other}/subprocessors`, { name: 'Hiddenvault Hosting', service: 'Hosting', countries: 'IN' })).status, 302);
  const subs = require('../lib/tprm/subprocessors');
  assert.ok((await subs.knownNames(db, ws, manager)).includes('Hiddenvault Hosting'), 'a manager is offered every name');
  assert.ok(!(await subs.knownNames(db, ws, consultant)).includes('Hiddenvault Hosting'), 'a scoped consultant is not offered names from third parties they cannot open');

  const pages = ['/tprm', '/tprm?who=all', `/tprm/clients/${ws}`, `/tprm/clients/${ws}?view=due`, `/tprm/clients/${ws}?status=all`,
    '/tprm/due', '/tprm/conditions', '/tprm/questionnaires', '/tprm/review', `/tprm/clients/${ws}/concentration`,
    `/tprm/clients/${ws}/third-parties/${mine}`];
  for (const p of pages) {
    const res = await c.get(p);
    assert.ok([200, 403].includes(res.status), `${p}: ${res.status}`);
    assert.doesNotMatch(res.text, new RegExp(OTHER), `${p} hides the other third party`);
  }
  assert.match((await c.get(`/tprm/clients/${ws}`)).text, new RegExp(MINE), 'the register lists the consultant\'s own');
  for (const p of [`/tprm/clients/${ws}/third-parties/${other}`, `/tprm/clients/${ws}/third-parties/${other}/edit`,
    `/tprm/clients/${ws}/third-parties/${other}/assessments/${otherA}`, `/tprm/clients/${ws}/third-parties/${other}/assessments/${otherA}?step=review`]) {
    assert.equal((await c.get(p)).status, 404, `${p} is not found`);
  }
  const renamed = await c.post(`/tprm/clients/${ws}/third-parties/${other}`, { name: 'Renamed', status: 'in_use' });
  assert.equal(renamed.status, 404, `rename: ${renamed.status} ${renamed.location || ''}`);
  const reminded = await c.post(`/tprm/clients/${ws}/questionnaires-out/${otherA}/remind`, {});
  assert.equal(reminded.status, 404, `remind: ${reminded.status} ${reminded.location || ''}`);
  await c.post(`/tprm/clients/${ws}/third-parties/bulk-lead`, { ids: String(other), lead: String(consultant.id) });
  assert.notEqual(Number((await db.prepare('SELECT lead_consultant_id FROM tp_assessments WHERE id = ?').get(otherA)).lead_consultant_id), consultant.id,
    'a bulk action cannot reach it either');

  const created = await c.post(`/tprm/clients/${ws}/third-parties`, { name: 'Consultant Added Co', status: 'proposed' });
  const newId = Number((String(created.location).match(/third-parties\/(\d+)/) || [])[1]);
  assert.equal((await c.get(`/tprm/clients/${ws}/third-parties/${newId}`)).status, 200, 'a third party the consultant adds is theirs');

  for (const u of [senior, manager]) {
    assert.match((await (await sessionFor(u)).get(`/tprm/clients/${ws}`)).text, new RegExp(OTHER), `${u.firm_role} still sees it`);
  }
  assert.equal((await m.post('/tprm/settings/access', {})).status, 302);
  assert.equal((await c.get(`/tprm/clients/${ws}/third-parties/${other}`)).status, 200, 'switched off again: visible');
});
