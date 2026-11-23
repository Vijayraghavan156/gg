'use strict';

const GENESIS = '0'.repeat(64);

function chainOf({ assessmentId, thirdPartyId }) {
  if (assessmentId != null) return { type: 'assessment', id: Number(assessmentId) };
  if (thirdPartyId != null) return { type: 'third_party', id: Number(thirdPartyId) };
  throw new TypeError('A TPRM event needs an assessment or a third party.');
}

async function latestHash(db, workspaceId, chain) {
  const row = await db.prepare(`SELECT hash FROM tp_events
    WHERE workspace_id=? AND chain_type=? AND chain_id=? ORDER BY chain_seq DESC LIMIT 1`)
    .get(workspaceId, chain.type, chain.id);
  return row ? row.hash : GENESIS;
}

const json = value => (value === undefined || value === null ? null : JSON.stringify(value));

async function appendEvent(db, { workspaceId, thirdPartyId = null, assessmentId = null, actorId = null, action, before = null, after = null }) {
  const chain = chainOf({ assessmentId, thirdPartyId });
  const write = async () => {
    await db.lockChain(`tp_events:${workspaceId}:${chain.type}:${chain.id}`);
    const prevHash = await latestHash(db, workspaceId, chain);
    return await db.prepare(`INSERT INTO tp_events
      (workspace_id, chain_type, chain_id, third_party_id, assessment_id, actor_user_id, action, before_state, after_state, prev_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
      RETURNING id, chain_seq, prev_hash, hash`)
      .get(workspaceId, chain.type, chain.id, thirdPartyId, assessmentId, actorId, action, json(before), json(after), prevHash);
  };
  return db.inTransaction ? await write() : await db.transaction(write)();
}

async function verifyChains(db, workspaceId = null) {
  const rows = await db.prepare('SELECT * FROM tp_verify_event_chains(?::bigint)').all(workspaceId);
  return rows.map(r => ({
    workspaceId: r.broken_workspace_id,
    chainType: r.broken_chain_type,
    chainId: r.broken_chain_id,
    eventId: r.event_id,
    seq: r.event_seq,
    problem: r.problem,
  }));
}

module.exports = { GENESIS, appendEvent, verifyChains };
