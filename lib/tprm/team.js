'use strict';

const access = require('./access');
const events = require('./events');
const { TprmError } = require('./errors');

const ROLE_LABELS = Object.freeze({ owner: 'Owner', reviewer: 'Reviewer' });

async function candidates(db, ws) {
  return await require('./assessments').leadCandidates(db, ws);
}

async function reviewerCandidates(db, ws) {
  const rows = await require('./assessments').firmPeople(db, ws);
  return rows.filter(u => access.firmCan(u, 'tp.review')).map(u => ({ id: u.id, name: u.name, email: u.email }));
}

async function tierConfirmers(db, ws, assessment) {
  const proposer = Number(assessment && assessment.proposed_by) || null;
  const people = (await reviewerCandidates(db, ws)).filter(u => Number(u.id) !== proposer);
  const named = assessment && assessment.reviewer_id ? people.find(u => Number(u.id) === Number(assessment.reviewer_id)) : null;
  return named ? [named] : people;
}

async function forThirdParty(db, workspaceId, thirdPartyId) {
  const row = await db.prepare(`SELECT t.team_owner_id, t.team_reviewer_id, ou.name AS owner_name, ou.active AS owner_active,
      ru.name AS reviewer_name, ru.active AS reviewer_active
    FROM tp_third_parties t LEFT JOIN users ou ON ou.id = t.team_owner_id LEFT JOIN users ru ON ru.id = t.team_reviewer_id
    WHERE t.workspace_id = ? AND t.id = ?`).get(Number(workspaceId), Number(thirdPartyId));
  if (!row) return null;
  const person = (id, name, active) => (id ? { id: Number(id), name: name || 'Unknown', active: Number(active) === 1 } : null);
  return { owner: person(row.team_owner_id, row.owner_name, row.owner_active), reviewer: person(row.team_reviewer_id, row.reviewer_name, row.reviewer_active) };
}

async function defaultsFor(db, ws, thirdPartyId, fallbackLeadId) {
  const team = await forThirdParty(db, ws.id, thirdPartyId);
  const allowed = new Set((await candidates(db, ws)).map(c => Number(c.id)));
  const reviewers = new Set((await reviewerCandidates(db, ws)).map(c => Number(c.id)));
  const ok = (p, set) => (p && p.active && set.has(p.id) ? p.id : null);
  const lead = ok(team && team.owner, allowed) || Number(fallbackLeadId);
  const reviewer = ok(team && team.reviewer, reviewers);
  return { leadId: lead, reviewerId: reviewer && reviewer !== lead ? reviewer : null };
}

function pickId(raw, label, errors) {
  const s = raw == null ? '' : String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) { errors.push(`Choose the ${label} from the list.`); return null; }
  return n;
}

async function set(db, actor, thirdPartyId, input = {}) {
  if (!access.can(actor.user, actor.perms, 'tp.manage')) throw new TprmError(403, 'Your role does not allow changes to this third party.');
  const errors = [];
  const ownerId = pickId(input.team_owner_id, 'owner', errors);
  const reviewerId = pickId(input.team_reviewer_id, 'reviewer', errors);
  if (ownerId && reviewerId && ownerId === reviewerId) errors.push('The owner and the reviewer must be two different people.');
  if (errors.length) throw new TprmError(400, errors.join(' '), { errors });
  return await db.transaction(async () => {
    const tp = await db.prepare(`SELECT id, team_owner_id, team_reviewer_id, row_version FROM tp_third_parties
      WHERE workspace_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, Number(thirdPartyId) || 0);
    if (!tp) throw new TprmError(404, 'This third party does not exist, or it is not available to your account.');
    const allowed = new Set((await candidates(db, actor.ws)).map(c => Number(c.id)));
    const reviewers = new Set((await reviewerCandidates(db, actor.ws)).map(c => Number(c.id)));
    const before = { team_owner_id: tp.team_owner_id == null ? null : Number(tp.team_owner_id), team_reviewer_id: tp.team_reviewer_id == null ? null : Number(tp.team_reviewer_id) };
    if (ownerId && ownerId !== before.team_owner_id && !allowed.has(ownerId)) {
      const m = 'Choose the owner from the people at your firm who work on this client.';
      throw new TprmError(400, m, { errors: [m] });
    }
    if (reviewerId && reviewerId !== before.team_reviewer_id && !reviewers.has(reviewerId)) {
      const m = 'Choose the reviewer from the people at your firm who work on this client and may confirm tiers and issue recommendations.';
      throw new TprmError(400, m, { errors: [m] });
    }
    const after = { team_owner_id: ownerId, team_reviewer_id: reviewerId };
    if (before.team_owner_id === after.team_owner_id && before.team_reviewer_id === after.team_reviewer_id) return { unchanged: true };
    await db.prepare(`UPDATE tp_third_parties SET team_owner_id = ?, team_reviewer_id = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ?`).run(ownerId, reviewerId, actor.ws.id, tp.id);
    const open = await db.prepare(`SELECT id, lead_consultant_id, reviewer_id FROM tp_assessments
      WHERE workspace_id = ? AND third_party_id = ? AND status NOT IN ('completed', 'cancelled') FOR UPDATE`).get(actor.ws.id, tp.id);
    if (open && Number(open.reviewer_id || 0) !== Number(reviewerId || 0)) {
      const next = reviewerId && reviewerId !== Number(open.lead_consultant_id) ? reviewerId : null;
      if (Number(open.reviewer_id || 0) !== Number(next || 0)) {
        await db.prepare('UPDATE tp_assessments SET reviewer_id = ?, updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?')
          .run(next, actor.ws.id, open.id);
      }
    }
    const changed = k => before[k] !== after[k];
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: tp.id, actorId: actor.user.id, action: 'third_party.team_changed',
      before: Object.fromEntries(Object.keys(after).filter(changed).map(k => [k, before[k]])),
      after: Object.fromEntries(Object.keys(after).filter(changed).map(k => [k, after[k]])),
    });
    return { changed: true };
  })();
}

module.exports = { ROLE_LABELS, candidates, reviewerCandidates, tierConfirmers, forThirdParty, defaultsFor, set };
