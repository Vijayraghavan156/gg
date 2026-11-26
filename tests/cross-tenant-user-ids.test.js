'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient, openTestDb } = require('./helpers');

let env;
let client;
let db;
let firmA;
let wsA;
let ownUser;
let foreign;
let foreignReview;
let foreignItem;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = await openTestDb(env.dbUrl);
  firmA = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  wsA = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome,stage)
    VALUES (?,'Own Client','["iso27001"]','certification_support','gap_assessment')`).run(firmA)).lastInsertRowid);
  ownUser = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES ('own-consultant@test.local','x','Own Consultant','firm',?,'consultant',1)`).run(firmA)).lastInsertRowid);

  const firmB = Number((await db.prepare("INSERT INTO firms(name) VALUES ('Other Firm')").run()).lastInsertRowid);
  const wsB = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,'Other Client','["iso27001"]','certification_support')`).run(firmB)).lastInsertRowid);
  foreign = Number((await db.prepare(`INSERT INTO users (email,password_hash,name,user_type,firm_id,firm_role,active)
    VALUES ('other-firm-manager@test.local','x','Other Firm Manager','firm',?,'manager',1)`).run(firmB)).lastInsertRowid);
  await db.prepare('INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)').run(wsB, foreign, 'manager');
  foreignReview = Number((await db.prepare(`INSERT INTO access_reviews (workspace_id,period_start,period_end,status,reviewer)
    VALUES (?,'2026-01-01','2026-03-31','open','Other Firm Manager')`).run(wsB)).lastInsertRowid);
  foreignItem = Number((await db.prepare(`INSERT INTO access_review_items (review_id,user_id,"current_role")
    VALUES (?,?,'manager')`).run(foreignReview, foreign)).lastInsertRowid);
});

test.after(async () => {
  if (db) await db.close();
  if (client) await client.close();
});

const taskCount = async () => Number((await db.prepare('SELECT COUNT(*) c FROM tasks WHERE workspace_id=?').get(wsA)).c);

test('member stats are only for people on this client; another firm\'s user is not found', async () => {
  const other = await client.get(`/workspaces/${wsA}/members/${foreign}/stats`);
  assert.equal(other.status, 404);
  assert.doesNotMatch(other.text, /other-firm-manager@test\.local|Other Firm Manager/);
  const own = await client.get(`/workspaces/${wsA}/members/${ownUser}/stats`);
  assert.equal(own.status, 200);
});

test('an access review item of another client cannot be decided through this client', async () => {
  const res = await client.post(`/workspaces/${wsA}/access-reviews/${foreignReview}/items/${foreignItem}`,
    { decision: 'remove', decision_reason: 'written from another firm' });
  assert.equal(res.status, 404);
  const item = await db.prepare('SELECT decision, decision_reason FROM access_review_items WHERE id=?').get(foreignItem);
  assert.equal(item.decision, null);
  assert.equal(item.decision_reason, null);
  assert.ok(await db.prepare('SELECT 1 FROM workspace_members WHERE user_id=?').get(foreign), 'the other firm keeps its member');
});

test('a task cannot be given to someone outside this client: new, edited, from a template, or in bulk', async () => {
  const before = await taskCount();
  const created = await client.post(`/workspaces/${wsA}/tasks`, { title: 'Foreign assignee', assignee_id: String(foreign) });
  assert.equal(created.status, 400);
  assert.match(created.text, /not on this client/);
  assert.equal(await taskCount(), before);

  assert.equal((await client.post(`/workspaces/${wsA}/tasks`, { title: 'Own assignee', assignee_id: String(ownUser) })).status, 302);
  const task = await db.prepare('SELECT id, assignee_id FROM tasks WHERE workspace_id=? AND title=?').get(wsA, 'Own assignee');
  assert.equal(Number(task.assignee_id), ownUser);

  assert.equal((await client.post(`/workspaces/${wsA}/tasks/${task.id}`, { assignee_id: String(foreign) })).status, 400);
  assert.equal(Number((await db.prepare('SELECT assignee_id FROM tasks WHERE id=?').get(task.id)).assignee_id), ownUser);

  assert.equal((await client.post(`/workspaces/${wsA}/bulk/tasks`, { ids: String(task.id), op: 'reassign', assignee: String(foreign) })).status, 400);
  assert.equal(Number((await db.prepare('SELECT assignee_id FROM tasks WHERE id=?').get(task.id)).assignee_id), ownUser);

  const tpl = await db.prepare('SELECT id FROM task_templates WHERE is_system=1 ORDER BY id LIMIT 1').get();
  const countBefore = await taskCount();
  assert.equal((await client.post(`/workspaces/${wsA}/tasks/from-template/${tpl.id}`, { assignee_id: String(foreign) })).status, 400);
  assert.equal(await taskCount(), countBefore);
});

test('a permission template cannot be applied to someone outside this client', async () => {
  const tpl = await db.prepare('SELECT id FROM permission_templates WHERE firm_id IS NULL ORDER BY id LIMIT 1').get();
  const res = await client.post(`/workspaces/${wsA}/access/apply-template`, { template_id: String(tpl.id), user_id: String(foreign) });
  assert.equal(res.status, 400);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) c FROM workspace_role_overrides WHERE user_id=?').get(foreign)).c), 0);
});

test('a delivery plan phase cannot be owned by someone outside this client', async () => {
  assert.equal((await client.get(`/workspaces/${wsA}/engagement-plan`)).status, 200);
  const phase = await db.prepare(`SELECT ph.id FROM engagement_delivery_phases ph JOIN engagement_delivery_plans p ON p.id=ph.plan_id
    WHERE p.workspace_id=? ORDER BY ph.sort_order LIMIT 1`).get(wsA);
  await client.post(`/workspaces/${wsA}/engagement-plan/phases/${phase.id}`, { owner_id: String(foreign) });
  assert.notEqual(Number((await db.prepare('SELECT owner_id FROM engagement_delivery_phases WHERE id=?').get(phase.id)).owner_id), foreign);
  await client.post(`/workspaces/${wsA}/engagement-plan/phases/${phase.id}`, { owner_id: String(ownUser) });
  assert.equal(Number((await db.prepare('SELECT owner_id FROM engagement_delivery_phases WHERE id=?').get(phase.id)).owner_id), ownUser);
});
