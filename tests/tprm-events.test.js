'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootClient } = require('./helpers');

let env;
let client;
let db;
let events;
let firmId;
let actorId;

test.before(async () => {
  env = await bootClient();
  client = env.client;
  db = require('../db').db;
  events = require('../lib/tprm/events');
  firmId = (await db.prepare('SELECT id FROM firms ORDER BY id LIMIT 1').get()).id;
  actorId = (await db.prepare('SELECT id FROM users WHERE email=?').get(env.login.email)).id;
});

test.after(async () => { if (client) await client.close(); });

async function tprmWorkspace(name) {
  const id = Number((await db.prepare(`INSERT INTO workspaces (firm_id,client_name,frameworks,engagement_outcome)
    VALUES (?,?,'[]','certification_support')`).run(firmId, name)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_client_settings (workspace_id, enabled) VALUES (?, true)').run(id);
  return id;
}

async function thirdParty(ws, name = 'Third party') {
  return Number((await db.prepare('INSERT INTO tp_third_parties (workspace_id, name) VALUES (?, ?)').run(ws, name)).lastInsertRowid);
}

async function assessment(ws, tp) {
  const model = await db.prepare(`SELECT id, version FROM tp_criticality_models WHERE firm_id=? AND status='active'`).get(firmId);
  return Number((await db.prepare(`INSERT INTO tp_assessments
    (workspace_id, firm_id, third_party_id, type, criticality_model_id, criticality_model_version)
    VALUES (?, ?, ?, 'reassessment', ?, ?) RETURNING id`).get(ws, firmId, tp, model.id, model.version)).id);
}

async function withGuardSuspended(fn) {
  await db.exec('ALTER TABLE tp_events DISABLE TRIGGER tp_events_append_only');
  try { return await fn(); } finally { await db.exec('ALTER TABLE tp_events ENABLE TRIGGER tp_events_append_only'); }
}

test('events chain per third party and per assessment, and the verifier accepts an intact chain', async () => {
  const ws = await tprmWorkspace('Event Chain Client');
  const acme = await thirdParty(ws, 'Acme');
  const other = await thirdParty(ws, 'Other');
  const first = await events.appendEvent(db, { workspaceId: ws, thirdPartyId: acme, actorId, action: 'third_party.created', after: { name: 'Acme' } });
  const second = await events.appendEvent(db, { workspaceId: ws, thirdPartyId: acme, actorId, action: 'third_party.updated', before: { name: 'Acme' }, after: { name: 'Acme Ltd' } });
  const otherChain = await events.appendEvent(db, { workspaceId: ws, thirdPartyId: other, actorId, action: 'third_party.created' });
  const assessmentId = await assessment(ws, acme);
  const assessmentEvent = await events.appendEvent(db, { workspaceId: ws, thirdPartyId: acme, assessmentId, actorId, action: 'assessment.started' });

  assert.equal(first.prev_hash, events.GENESIS);
  assert.equal(first.chain_seq, 1);
  assert.equal(second.prev_hash, first.hash, 'each event links to the previous one in its chain');
  assert.equal(second.chain_seq, 2);
  assert.equal(otherChain.prev_hash, events.GENESIS, 'another third party starts its own chain');
  assert.equal(assessmentEvent.prev_hash, events.GENESIS, 'an assessment has its own chain');
  const stored = await db.prepare('SELECT chain_type, chain_id FROM tp_events WHERE id=?').get(assessmentEvent.id);
  assert.deepEqual(stored, { chain_type: 'assessment', chain_id: assessmentId });
  await assert.rejects(events.appendEvent(db, { workspaceId: ws, thirdPartyId: acme, assessmentId: 987654321, actorId, action: 'assessment.started' }),
    /foreign key/, 'an assessment event must belong to an assessment of the same client');
  await assert.rejects(events.appendEvent(db, { workspaceId: ws, thirdPartyId: 987654321, actorId, action: 'third_party.created' }),
    /foreign key/, 'an event must belong to a third party of the same client');
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(await events.verifyChains(db, ws), []);
});

test('tp_events rejects update, delete and truncate', async () => {
  const ws = await tprmWorkspace('Append Only Client');
  const row = await events.appendEvent(db, { workspaceId: ws, thirdPartyId: await thirdParty(ws), actorId, action: 'third_party.created' });
  await assert.rejects(db.prepare("UPDATE tp_events SET action='third_party.deleted' WHERE id=?").run(row.id), /append-only/);
  await assert.rejects(db.prepare('DELETE FROM tp_events WHERE id=?').run(row.id), /append-only/);
  await assert.rejects(db.exec('TRUNCATE tp_events'), /append-only/);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_events WHERE id=?').get(row.id)).c, 1);
});

test('a forked chain is rejected: prev_hash must be the latest hash of that chain', async () => {
  const ws = await tprmWorkspace('Fork Client');
  const tp = await thirdParty(ws);
  const fresh = await thirdParty(ws, 'Fresh');
  const first = await events.appendEvent(db, { workspaceId: ws, thirdPartyId: tp, actorId, action: 'third_party.created' });
  await events.appendEvent(db, { workspaceId: ws, thirdPartyId: tp, actorId, action: 'third_party.updated' });
  const insert = prev => db.prepare(`INSERT INTO tp_events (workspace_id, chain_type, chain_id, third_party_id, actor_user_id, action, prev_hash)
    VALUES (?, 'third_party', ?, ?, ?, 'third_party.updated', ?)`).run(ws, tp, tp, actorId, prev);
  await assert.rejects(insert(first.hash), /fork rejected/, 'a second successor of the first event is a fork');
  await assert.rejects(insert(events.GENESIS), /fork rejected/, 'a second genesis is a fork');
  await assert.rejects(insert('a'.repeat(64)), /fork rejected/);
  await assert.rejects(db.prepare(`INSERT INTO tp_events (workspace_id, chain_type, chain_id, third_party_id, action, prev_hash, hash)
    VALUES (?, 'third_party', ?, ?, 'third_party.created', ?, ?)`).run(ws, fresh, fresh, events.GENESIS, 'b'.repeat(64)),
  /hash does not match/, 'a supplied hash must match the content');
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM tp_events WHERE workspace_id=? AND chain_id=?").get(ws, tp)).c, 2);
  assert.deepEqual(await events.verifyChains(db, ws), []);
});

test('the verifier reports the first broken row of a tampered chain', async () => {
  const ws = await tprmWorkspace('Tamper Client');
  const tampered = await thirdParty(ws);
  const intact = await thirdParty(ws, 'Intact');
  const rows = [];
  for (const action of ['third_party.created', 'third_party.updated', 'third_party.updated', 'third_party.exited']) {
    rows.push(await events.appendEvent(db, { workspaceId: ws, thirdPartyId: tampered, actorId, action, after: { step: rows.length } }));
  }
  const untouched = await events.appendEvent(db, { workspaceId: ws, thirdPartyId: intact, actorId, action: 'third_party.created' });

  await withGuardSuspended(() => db.prepare(`UPDATE tp_events SET after_state='{"step":"forged"}'::jsonb WHERE id=?`).run(rows[1].id));
  let broken = await events.verifyChains(db, ws);
  assert.equal(broken.length, 1, 'only the tampered chain is reported, once');
  assert.deepEqual(broken[0], { workspaceId: ws, chainType: 'third_party', chainId: tampered, eventId: rows[1].id, seq: 2, problem: 'hash_mismatch' });
  assert.ok(!broken.some(b => b.eventId === untouched.id));

  await withGuardSuspended(() => db.prepare('DELETE FROM tp_events WHERE id=?').run(rows[1].id));
  broken = await events.verifyChains(db, ws);
  assert.deepEqual(broken.map(b => [b.eventId, b.problem]), [[rows[2].id, 'sequence_gap']], 'a removed event breaks the chain at its successor');

  const all = await events.verifyChains(db);
  assert.ok(all.some(b => b.workspaceId === ws), 'the firm-wide verification sees it too');
});

test('deleting a whole workspace removes its tp_events and tp_client_settings and keeps the guards', async () => {
  const doomed = await tprmWorkspace('Deleted TPRM Client');
  const kept = await tprmWorkspace('Kept TPRM Client');
  const doomedTp = await thirdParty(doomed);
  const batch = Number((await db.prepare(`INSERT INTO tp_import_batches (workspace_id, file_sha256, row_count, status, committed_at, imported_count)
    VALUES (?, ?, 1, 'committed', now(), 1)`).run(doomed, 'c'.repeat(64))).lastInsertRowid);
  const importedTp = Number((await db.prepare('INSERT INTO tp_third_parties (workspace_id, name, import_batch_id) VALUES (?, ?, ?)')
    .run(doomed, 'Imported', batch)).lastInsertRowid);
  await events.appendEvent(db, { workspaceId: doomed, thirdPartyId: importedTp, actorId, action: 'third_party.imported' });
  await db.prepare('INSERT INTO tp_services (workspace_id, third_party_id, description) VALUES (?, ?, ?)').run(doomed, doomedTp, 'Hosting');
  await events.appendEvent(db, { workspaceId: doomed, thirdPartyId: doomedTp, actorId, action: 'third_party.created' });
  await events.appendEvent(db, { workspaceId: doomed, thirdPartyId: doomedTp, assessmentId: await assessment(doomed, doomedTp), actorId, action: 'assessment.started' });
  const keptEvent = await events.appendEvent(db, { workspaceId: kept, thirdPartyId: await thirdParty(kept), actorId, action: 'third_party.created' });

  const { immutableMutationTriggers } = require('../lib/workspace-deletion');
  const guards = await immutableMutationTriggers(db);
  assert.ok(guards.some(g => g.table_name === 'tp_events' && g.name === 'tp_events_append_only'),
    'workspace deletion recognises the append-only guard');

  const deleted = await client.post(`/workspaces/${doomed}/delete`, { confirm_name: 'Deleted TPRM Client' });
  assert.equal(deleted.status, 302);
  assert.match(deleted.location, /^\/dashboard\?/, 'the delete succeeds');
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM workspaces WHERE id=?').get(doomed)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_events WHERE workspace_id=?').get(doomed)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_client_settings WHERE workspace_id=?').get(doomed)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?').get(doomed)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_services WHERE workspace_id=?').get(doomed)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_import_batches WHERE workspace_id=?').get(doomed)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_assessments WHERE workspace_id=?').get(doomed)).c, 0);

  assert.deepEqual(await immutableMutationTriggers(db), guards, 'the guard is enabled again');
  await assert.rejects(db.prepare('DELETE FROM tp_events WHERE id=?').run(keptEvent.id), /append-only/);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_events WHERE workspace_id=?').get(kept)).c, 1, 'another client is untouched');
  assert.deepEqual(await events.verifyChains(db, kept), []);
});

test('a direct workspace delete cascades through the guard once the workspace row is gone', async () => {
  const ws = await tprmWorkspace('Cascade TPRM Client');
  const batch = Number((await db.prepare(`INSERT INTO tp_import_batches (workspace_id, file_sha256, row_count)
    VALUES (?, ?, 1)`).run(ws, 'd'.repeat(64))).lastInsertRowid);
  const tp = Number((await db.prepare('INSERT INTO tp_third_parties (workspace_id, name, import_batch_id) VALUES (?, ?, ?)')
    .run(ws, 'Imported', batch)).lastInsertRowid);
  await db.prepare('INSERT INTO tp_services (workspace_id, third_party_id, description) VALUES (?, ?, ?)').run(ws, tp, 'Payroll');
  await events.appendEvent(db, { workspaceId: ws, thirdPartyId: tp, actorId, action: 'third_party.created' });
  await events.appendEvent(db, { workspaceId: ws, thirdPartyId: tp, assessmentId: await assessment(ws, tp), actorId, action: 'assessment.started' });
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(ws);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_assessments WHERE workspace_id=?').get(ws)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_events WHERE workspace_id=?').get(ws)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_third_parties WHERE workspace_id=?').get(ws)).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM tp_import_batches WHERE workspace_id=?').get(ws)).c, 0);
});
