'use strict';

const access = require('./access');
const events = require('./events');
const placement = require('./placement');
const { TprmError } = require('./errors');
const { todayFor } = require('../dates');

const REASONS = Object.freeze(['breach', 'ownership_change', 'ai_change', 'other']);
const REASON_LABELS = Object.freeze({
  breach: 'Breach',
  ownership_change: 'Change of ownership',
  ai_change: 'Change of AI model or provider',
  other: 'Other',
});
const LIMITS = Object.freeze({ details: 1000 });
const EVENT_LABELS = Object.freeze({ 'third_party.reassessment_triggered': 'Early reassessment triggered' });

const BUCKETS = Object.freeze(['overdue', 'no_date', 'within_30', 'within_60', 'within_90']);
const BUCKET_LABELS = Object.freeze({
  overdue: 'Overdue',
  no_date: 'Not assessed yet',
  within_30: 'Due within 30 days',
  within_60: 'Due in 31 to 60 days',
  within_90: 'Due in 61 to 90 days',
});
const WINDOW_DAYS = 90;

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

function requirePermission(actor, permission) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, permission)) {
    throw new TprmError(403, 'Your role does not allow changes to this client\'s third parties.');
  }
}

function daysBetween(a, b) {
  const t = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86400000);
}

function bucketFor(nextDueDate, today) {
  if (!nextDueDate) return 'no_date';
  const days = daysBetween(today, nextDueDate);
  if (days < 0) return 'overdue';
  if (days <= 30) return 'within_30';
  if (days <= 60) return 'within_60';
  if (days <= WINDOW_DAYS) return 'within_90';
  return null;
}

function triggerLabel(trigger) {
  if (!trigger) return null;
  if (trigger.reason === 'other') return `Triggered: ${trigger.details}`;
  return `Triggered: ${REASON_LABELS[trigger.reason]}`;
}

function parseTrigger(input = {}) {
  const errors = [];
  const reason = str(input.reason);
  const details = str(input.details) || null;
  if (!REASONS.includes(reason)) errors.push('Choose what happened.');
  if (reason === 'other' && !details) errors.push('Say what happened.');
  if (details && details.length > LIMITS.details) errors.push(`The details must be ${LIMITS.details} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  return { reason, details };
}

const TRIGGER_COLUMNS = `g.id, g.workspace_id, g.third_party_id, g.reason, g.details,
  g.previous_due_date::text AS previous_due_date, g.new_due_date::text AS new_due_date, g.recorded_by, g.recorded_at`;

async function openTriggers(db, workspaceId, thirdParties) {
  const list = (thirdParties || []).filter(t => t && t.next_due_date);
  if (!list.length) return new Map();
  const rows = await db.prepare(`SELECT DISTINCT ON (g.third_party_id) ${TRIGGER_COLUMNS}, u.name AS recorded_by_name
    FROM tp_trigger_events g LEFT JOIN users u ON u.id = g.recorded_by
    WHERE g.workspace_id = ? AND g.third_party_id IN (${list.map(() => '?').join(',')})
    ORDER BY g.third_party_id, g.id DESC`).all(workspaceId, ...list.map(t => Number(t.id)));
  const due = new Map(list.map(t => [Number(t.id), t.next_due_date]));
  const out = new Map();
  for (const r of rows) {
    if (due.get(Number(r.third_party_id)) === r.new_due_date) out.set(Number(r.third_party_id), { ...r, label: triggerLabel(r) });
  }
  return out;
}

async function hasOpenTrigger(db, workspaceId, thirdParty) {
  if (!thirdParty || thirdParty.status !== 'in_use') return false;
  return (await openTriggers(db, workspaceId, [thirdParty])).has(Number(thirdParty.id));
}

async function listTriggers(db, actor, thirdPartyId) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, 'tp.view')) throw new TprmError(403, 'Your role does not allow this.');
  return await db.prepare(`SELECT ${TRIGGER_COLUMNS}, u.name AS recorded_by_name
    FROM tp_trigger_events g LEFT JOIN users u ON u.id = g.recorded_by
    WHERE g.workspace_id = ? AND g.third_party_id = ? ORDER BY g.id DESC`).all(actor.ws.id, Number(thirdPartyId));
}

async function recordTrigger(db, actor, thirdPartyId, input = {}) {
  requirePermission(actor, 'tp.manage');
  const values = parseTrigger(input);
  const register = require('./register');
  return await db.transaction(async () => {
    const tp = await register.getThirdParty(db, actor, thirdPartyId, { forUpdate: true });
    if (tp.status !== 'in_use') {
      throw new TprmError(409, 'An early reassessment is triggered only for a third party in use. A proposed third party gets its onboarding assessment; an exited one is not assessed.');
    }
    const rowVersion = Number(input.row_version);
    if (input.row_version != null && input.row_version !== '' && rowVersion !== tp.row_version) {
      throw new TprmError(409, 'Someone else changed this third party after you opened it. Nothing was saved: reload the page, then record the event again.');
    }
    const today = todayFor(actor.ws);
    const previous = tp.next_due_date || null;
    const nextDue = previous && previous < today ? previous : today;
    const row = await db.prepare(`INSERT INTO tp_trigger_events
      (workspace_id, third_party_id, reason, details, previous_due_date, new_due_date, recorded_by)
      VALUES (?, ?, ?, ?, ?::date, ?::date, ?) RETURNING id`)
      .get(actor.ws.id, tp.id, values.reason, values.details, previous, nextDue, actor.user.id);
    if (previous !== nextDue) {
      const res = await db.prepare(`UPDATE tp_third_parties SET next_due_date = ?::date, updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(nextDue, actor.ws.id, tp.id, tp.row_version);
      if (res.changes !== 1) throw new TprmError(409, 'Someone else changed this third party after you opened it. Nothing was saved: reload the page, then record the event again.');
    }
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: tp.id, actorId: actor.user.id,
      action: 'third_party.reassessment_triggered',
      before: { next_due_date: previous },
      after: { trigger_id: Number(row.id), reason: values.reason, details: values.details, next_due_date: nextDue },
    });
    return { triggerId: Number(row.id), previous, nextDue, thirdParty: await register.getThirdParty(db, actor, tp.id) };
  })();
}

async function dueQueue(deps, user, { clientId = null, todayOverride = null } = {}) {
  if (!access.isFirmUser(user) || !access.firmCan(user, 'tp.view')) return { rows: [], clients: [], counts: {} };
  const { enabled } = await access.listFirmClients(deps, user);
  const decisions = require('./decisions');
  const rows = [];
  const clients = [];
  for (const c of enabled) {
    const loaded = await access.loadFirmWorkspace(deps, user, c.id);
    if (!loaded) continue;
    clients.push({ id: Number(c.id), name: c.name });
    if (clientId && Number(clientId) !== Number(c.id)) continue;
    const ws = loaded.ws;
    const today = todayOverride || todayFor(ws);
    const parties = await deps.db.prepare(`SELECT t.id, t.name, t.status, t.category, t.current_tier, t.tier_source,
        t.next_due_date::text AS next_due_date, t.last_assessment_date::text AS last_assessment_date, t.row_version
      FROM tp_third_parties t
      WHERE t.workspace_id = ? AND t.status = 'in_use' AND (t.next_due_date IS NULL OR t.next_due_date <= ?::date + ?::integer)`)
      .all(ws.id, today, WINDOW_DAYS);
    const shownParties = await require('./scope').keep(deps.db, user, parties.map(p => ({ ...p, workspace_id: ws.id })), { tp: 'id' });
    parties.length = 0;
    parties.push(...shownParties);
    if (!parties.length) continue;
    const approvals = await decisions.approvals(deps.db, ws, parties.map(p => Number(p.id)), { today });
    const triggers = await openTriggers(deps.db, ws.id, parties);
    const canStart = access.can(user, loaded.perms, 'tp.manage');
    for (const p of parties) {
      const bucket = bucketFor(p.next_due_date, today);
      if (!bucket) continue;
      const approval = approvals.get(Number(p.id)) || null;
      rows.push({
        clientId: Number(ws.id), clientName: c.name, today,
        id: Number(p.id), name: p.name, category: p.category, tier: p.current_tier, tierSource: p.tier_source,
        nextDueDate: p.next_due_date, lastAssessmentDate: p.last_assessment_date, days:p.next_due_date ? daysBetween(today, p.next_due_date) : null, bucket,
        approval, openAssessment: approval ? approval.openAssessment : null,
        trigger: triggers.get(Number(p.id)) || null, canStart,
      });
    }
  }
  const order = b => BUCKETS.indexOf(b);
  rows.sort((a, b) => order(a.bucket) - order(b.bucket)
    || String(a.nextDueDate || '').localeCompare(String(b.nextDueDate || ''))
    || a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name) || a.id - b.id);
  const counts = Object.fromEntries(BUCKETS.map(b => [b, rows.filter(r => r.bucket === b).length]));
  return { rows, clients, counts };
}

module.exports = {
  REASONS, REASON_LABELS, LIMITS, EVENT_LABELS, BUCKETS, BUCKET_LABELS, WINDOW_DAYS,
  daysBetween, bucketFor, triggerLabel, parseTrigger,
  openTriggers, hasOpenTrigger, listTriggers, recordTrigger, dueQueue,
  TIER_LABELS: placement.TIER_LABELS,
};
