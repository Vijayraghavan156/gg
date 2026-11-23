'use strict';

const access = require('./access');
const events = require('./events');
const placement = require('./placement');
const rulebooks = require('./rulebooks');
const { TprmError } = require('./errors');
const { todayFor } = require('../dates');

const SWITCH_UNITS = Object.freeze(['days', 'weeks', 'months']);
const SWITCH_UNIT_LABELS = Object.freeze({ days: 'days', weeks: 'weeks', months: 'months' });
const LIMITS = Object.freeze({ reason: 1000, alternative: 2000, dataReturn: 4000, notes: 4000, switchMax: 3650, condition: 2000 });
const DUE_DAYS = 90;
const EDITABLE = Object.freeze(['draft', 'changes_requested']);
const PARTS = Object.freeze([
  ['alternative_provider', 'Alternative provider'],
  ['data_return', 'Data return and deletion'],
  ['switch_time', 'Time to switch'],
  ['last_tested_on', 'Date last tested or reviewed'],
]);

const EVENT_LABELS = Object.freeze({
  'service.material_changed': 'Material flag changed',
  'exit_plan.saved': 'Exit plan saved',
  'recommendation.exit_plan_conditions_synced': 'Automatic exit plan conditions updated',
  'recommendation.auto_condition_removed': 'Automatic condition removed by a manager',
  'recommendation.override_outcome_changed': 'Outcome changed by a manager after an override',
});

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const checked = raw => raw === true || raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes';
const notAvailable = () => new TprmError(404, 'Material services and exit plans are available only for clients with a rulebook ticked.');
const serviceNotFound = () => new TprmError(404, 'This service does not exist, or it is not available to your account.');
const conflict = what => new TprmError(409,
  `Someone else changed this ${what} after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.`);
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

function requirePermission(actor, permission, message) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, permission)) {
    throw new TprmError(403, message || 'Your role does not allow this change.');
  }
}

function addDays(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(days))).toISOString().slice(0, 10);
}

function missingParts(plan) {
  if (!plan) return PARTS.map(([, label]) => label);
  const out = [];
  if (!str(plan.alternative_provider)) out.push(PARTS[0][1]);
  if (!str(plan.data_return)) out.push(PARTS[1][1]);
  if (plan.switch_time == null || !plan.switch_unit) out.push(PARTS[2][1]);
  if (!plan.last_tested_on) out.push(PARTS[3][1]);
  return out;
}

const isComplete = plan => missingParts(plan).length === 0;

function requiredSentence(name, reference) {
  const ref = String(reference || '').trim().replace(/\.+$/, '');
  if (!ref) return ` Required by ${name}.`;
  return /^(required|watch list)\b/i.test(ref) ? ` ${ref}.` : ` Required by ${name}: ${ref}.`;
}

function conditionText(serviceDescription, refs = []) {
  const head = `Document a complete exit plan for "${String(serviceDescription || 'the service').slice(0, 300)}": `
    + 'the alternative provider, how data is returned and deleted, the time to switch, and the date it was last tested or reviewed.';
  const text = head + refs.map(r => requiredSentence(r.name, r.reference_text)).join('');
  return text.length > LIMITS.condition ? `${text.slice(0, LIMITS.condition - 3)}...` : text;
}

function parsePlan(input) {
  const errors = [];
  const text = (raw, max, label) => {
    const v = str(raw);
    if (v.length > max) errors.push(`${label} must be ${max} characters or fewer.`);
    return v || null;
  };
  const values = {
    alternative_provider: text(input.alternative_provider, LIMITS.alternative, 'Alternative provider'),
    data_return: text(input.data_return, LIMITS.dataReturn, 'Data return and deletion'),
    notes: text(input.notes, LIMITS.notes, 'Notes'),
    switch_time: null,
    switch_unit: null,
    last_tested_on: null,
  };
  const time = str(input.switch_time);
  const unit = str(input.switch_unit);
  if (time || unit) {
    if (!/^\d{1,4}$/.test(time) || Number(time) < 1 || Number(time) > LIMITS.switchMax) errors.push(`Time to switch must be a whole number from 1 to ${LIMITS.switchMax}.`);
    else values.switch_time = Number(time);
    if (!SWITCH_UNITS.includes(unit)) errors.push('Choose days, weeks or months for the time to switch.');
    else values.switch_unit = unit;
  }
  const tested = str(input.last_tested_on);
  if (tested) {
    if (!placement.isYmd(tested)) errors.push('The date last tested or reviewed must be a date written YYYY-MM-DD.');
    else values.last_tested_on = tested;
  }
  return { values, errors };
}

async function regulated(db, workspaceId) {
  return (await rulebooks.currentForClient(db, workspaceId)).length > 0;
}

const SERVICE_COLUMNS = `s.id, s.third_party_id, s.description, s.material, s.material_by, s.material_at, s.material_reason,
  s.row_version, mu.name AS material_by_name`;
const PLAN_COLUMNS = `x.id, x.service_id, x.alternative_provider, x.data_return, x.switch_time, x.switch_unit,
  x.last_tested_on::text AS last_tested_on, x.notes, x.status, x.updated_by, x.updated_at, x.row_version, xu.name AS updated_by_name`;

async function servicesWithPlans(db, workspaceId, thirdPartyId) {
  const services = await db.prepare(`SELECT ${SERVICE_COLUMNS} FROM tp_services s LEFT JOIN users mu ON mu.id = s.material_by
    WHERE s.workspace_id = ? AND s.third_party_id = ? ORDER BY s.id`).all(workspaceId, Number(thirdPartyId));
  const plans = await db.prepare(`SELECT ${PLAN_COLUMNS} FROM tp_exit_plans x LEFT JOIN users xu ON xu.id = x.updated_by
    WHERE x.workspace_id = ? AND x.third_party_id = ?`).all(workspaceId, Number(thirdPartyId));
  const byService = new Map(plans.map(p => [Number(p.service_id), p]));
  return services.map(s => {
    const plan = byService.get(Number(s.id)) || null;
    return { ...s, plan, complete: !!plan && plan.status === 'complete', missing: missingParts(plan) };
  });
}

async function thirdPartyPanel(db, actor, thirdPartyId) {
  if (!actor || !actor.ws || !access.isFirmUser(actor.user)) return null;
  const current = await rulebooks.currentForClient(db, actor.ws.id);
  if (!current.length) return null;
  return {
    services: await servicesWithPlans(db, actor.ws.id, thirdPartyId),
    exitPlanRulebooks: current.filter(r => r.exit_plan_required).map(r => r.name),
    rulebookNames: current.map(r => r.name),
    canManage: access.can(actor.user, actor.perms, 'tp.manage'),
    canUnmark: access.can(actor.user, actor.perms, 'tp.manage') && access.isManager(actor.user),
    UNIT_LABELS: SWITCH_UNIT_LABELS,
  };
}

async function serviceOf(db, actor, thirdPartyId, serviceId, { forUpdate = false } = {}) {
  const sid = Number(serviceId);
  const tpId = Number(thirdPartyId);
  if (!Number.isSafeInteger(sid) || sid < 1 || !Number.isSafeInteger(tpId) || tpId < 1) throw serviceNotFound();
  const row = await db.prepare(`SELECT s.id, s.third_party_id, s.description, s.material, s.material_reason, s.row_version
    FROM tp_services s WHERE s.workspace_id = ? AND s.third_party_id = ? AND s.id = ?${forUpdate ? ' FOR UPDATE' : ''}`)
    .get(actor.ws.id, tpId, sid);
  if (!row) throw serviceNotFound();
  return row;
}

async function planOf(db, workspaceId, serviceId, { forUpdate = false } = {}) {
  return (await db.prepare(`SELECT ${PLAN_COLUMNS} FROM tp_exit_plans x LEFT JOIN users xu ON xu.id = x.updated_by
    WHERE x.workspace_id = ? AND x.service_id = ?${forUpdate ? ' FOR UPDATE OF x' : ''}`).get(workspaceId, Number(serviceId))) || null;
}

async function planPage(db, actor, thirdPartyId, serviceId) {
  requirePermission(actor, 'tp.view');
  if (!(await regulated(db, actor.ws.id))) throw notAvailable();
  const service = await serviceOf(db, actor, thirdPartyId, serviceId);
  const plan = await planOf(db, actor.ws.id, service.id);
  return { service, plan, missing: missingParts(plan), complete: !!plan && plan.status === 'complete' };
}

async function setMaterial(db, actor, thirdPartyId, serviceId, input = {}) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow changes to this client\'s third parties.');
  if (!(await regulated(db, actor.ws.id))) throw notAvailable();
  const material = checked(input.material);
  const reason = str(input.reason);
  if (!reason) throw invalid([material ? 'Say why the service is material.' : 'Say why the service is no longer material.']);
  if (reason.length > LIMITS.reason) throw invalid([`The reason must be ${LIMITS.reason} characters or fewer.`]);
  return await db.transaction(async () => {
    const service = await serviceOf(db, actor, thirdPartyId, serviceId, { forUpdate: true });
    const rowVersion = Number(input.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== Number(service.row_version)) throw conflict('service');
    if (!!service.material === material) return { changed: false, service };
    if (service.material && !material && !access.isManager(actor.user)) {
      throw new TprmError(403, 'Only a manager can mark a material service as not material.');
    }
    const res = await db.prepare(`UPDATE tp_services SET material = ?, material_by = ?, material_at = now(), material_reason = ?,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(material, actor.user.id, reason, actor.ws.id, service.id, service.row_version);
    if (res.changes !== 1) throw conflict('service');
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: service.third_party_id, actorId: actor.user.id, action: 'service.material_changed',
      before: { service_id: Number(service.id), material: !!service.material, reason: service.material_reason || null },
      after: { service_id: Number(service.id), material, reason },
    });
    const synced = await syncThirdParty(db, actor, service.third_party_id, 'material_changed');
    return { changed: true, material, synced };
  })();
}

const PLAN_FIELDS = ['alternative_provider', 'data_return', 'switch_time', 'switch_unit', 'last_tested_on', 'notes'];

async function savePlan(db, actor, thirdPartyId, serviceId, input = {}) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow changes to this client\'s third parties.');
  if (!(await regulated(db, actor.ws.id))) throw notAvailable();
  const { values, errors } = parsePlan(input);
  if (values.last_tested_on && values.last_tested_on > todayFor(actor.ws)) errors.push('The date last tested or reviewed cannot be in the future.');
  if (errors.length) throw invalid(errors);
  return await db.transaction(async () => {
    const service = await serviceOf(db, actor, thirdPartyId, serviceId, { forUpdate: true });
    const existing = await planOf(db, actor.ws.id, service.id, { forUpdate: true });
    const rowVersion = Number(input.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== (existing ? Number(existing.row_version) : 0)) throw conflict('exit plan');
    const before = {};
    const after = {};
    for (const f of PLAN_FIELDS) {
      const was = existing ? (existing[f] ?? null) : null;
      if (String(was) !== String(values[f] ?? null)) { before[f] = was; after[f] = values[f] ?? null; }
    }
    if (existing && !Object.keys(after).length) return { changed: false, plan: existing };
    if (existing) {
      const res = await db.prepare(`UPDATE tp_exit_plans SET alternative_provider = ?, data_return = ?, switch_time = ?, switch_unit = ?,
          last_tested_on = ?::date, notes = ?, updated_by = ?, updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ? AND row_version = ?`)
        .run(values.alternative_provider, values.data_return, values.switch_time, values.switch_unit, values.last_tested_on, values.notes,
          actor.user.id, actor.ws.id, existing.id, existing.row_version);
      if (res.changes !== 1) throw conflict('exit plan');
    } else {
      await db.prepare(`INSERT INTO tp_exit_plans (workspace_id, third_party_id, service_id, alternative_provider, data_return,
          switch_time, switch_unit, last_tested_on, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?)`)
        .run(actor.ws.id, service.third_party_id, service.id, values.alternative_provider, values.data_return, values.switch_time,
          values.switch_unit, values.last_tested_on, values.notes, actor.user.id, actor.user.id);
    }
    const plan = await planOf(db, actor.ws.id, service.id);
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: service.third_party_id, actorId: actor.user.id, action: 'exit_plan.saved',
      before: { service_id: Number(service.id), status: existing ? existing.status : null, ...before },
      after: { service_id: Number(service.id), status: plan.status, ...after },
    });
    const synced = await syncThirdParty(db, actor, service.third_party_id, 'exit_plan_saved');
    return { changed: true, plan, synced };
  })();
}

async function neededServiceIds(db, workspaceId, assessmentId) {
  const rows = await db.prepare('SELECT n AS id FROM tp_exit_plan_needed(?::bigint, ?::bigint) AS n ORDER BY n').all(workspaceId, assessmentId);
  return rows.map(r => Number(r.id));
}

async function overridesOf(db, workspaceId, recommendationId) {
  return await db.prepare(`SELECT o.id, o.service_id, o.service_description, o.reason, o.removed_by, o.removed_at, u.name AS removed_by_name
    FROM tp_exit_plan_overrides o LEFT JOIN users u ON u.id = o.removed_by
    WHERE o.workspace_id = ? AND o.recommendation_id = ? ORDER BY o.id`).all(workspaceId, Number(recommendationId));
}

async function requiredFor(db, workspaceId, assessmentId, recommendationId) {
  const needed = await neededServiceIds(db, workspaceId, assessmentId);
  if (!needed.length) return [];
  const overridden = new Set((await overridesOf(db, workspaceId, recommendationId)).map(o => Number(o.service_id)));
  return needed.filter(id => !overridden.has(id));
}

async function hasOverride(db, workspaceId, recommendationId) {
  return !!(await db.prepare('SELECT 1 AS x FROM tp_exit_plan_overrides WHERE workspace_id = ? AND recommendation_id = ? LIMIT 1')
    .get(workspaceId, Number(recommendationId)));
}

const OVERRIDE_KEEPS_CONDITIONS = 'A manager removed an automatic exit plan condition from this version, so the recommendation stays '
  + '"with conditions". Only a manager can change the outcome, with a reason ("Change the outcome (manager)" on this step).';

async function approveBarred(db, workspaceId, rec) {
  return rec.override_outcome !== 'approve' && await hasOverride(db, workspaceId, rec.id);
}

async function gateProblems(db, workspaceId, assessmentId, rec) {
  if (!rec.outcome || rec.outcome === 'reject') return [];
  if (rec.outcome === 'approve' && await approveBarred(db, workspaceId, rec)) return [OVERRIDE_KEEPS_CONDITIONS];
  const required = await requiredFor(db, workspaceId, assessmentId, rec.id);
  if (!required.length) return [];
  if (rec.outcome === 'approve') {
    return ['A material service in scope has no complete exit plan, so the recommendation must be "with conditions" (the client\'s rulebooks require exit plans).'];
  }
  const covered = new Set((rec.conditions || []).filter(c => c.automatic).map(c => Number(c.auto_service_id)));
  return required.some(id => !covered.has(id))
    ? ['An automatic exit plan condition is missing for a material service in scope. Save the draft again so it is added.']
    : [];
}

const autoSummary = conditions => conditions.filter(c => c.automatic)
  .map(c => ({ condition_id: Number(c.id), service_id: Number(c.auto_service_id), due_date: c.due_date || null }));

async function syncRecommendation(db, actor, assessment, rec, reason) {
  if (!db.inTransaction) throw new Error('syncRecommendation must run inside a transaction');
  const none = { changed: false, converted: false, added: [], removed: [], rowVersion: rec.row_version };
  if (!EDITABLE.includes(rec.status)) return none;
  const ws = assessment.workspace_id || actor.ws.id;
  const conditions = rec.conditions || (await db.prepare(`SELECT id, position, description, owner, due_date::text AS due_date,
      automatic, auto_service_id FROM tp_conditions WHERE workspace_id = ? AND recommendation_id = ? ORDER BY position, id`).all(ws, rec.id));
  const auto = conditions.filter(c => c.automatic);
  const want = rec.outcome === 'reject' ? [] : await requiredFor(db, ws, assessment.id, rec.id);
  const have = new Set(auto.map(c => Number(c.auto_service_id)));
  const wanted = new Set(want);
  const toRemove = auto.filter(c => !wanted.has(Number(c.auto_service_id)));
  const toAdd = want.filter(id => !have.has(id));
  const convert = rec.outcome === 'approve' && (want.length > 0 || await approveBarred(db, ws, rec));
  if (!toRemove.length && !toAdd.length && !convert) return none;

  for (const c of toRemove) {
    await db.prepare('DELETE FROM tp_conditions WHERE workspace_id = ? AND id = ? AND automatic').run(ws, c.id);
  }
  if (toAdd.length) {
    const refs = await rulebooks.exitPlanRulebooks(db, { ...actor, ws: actor.ws }, assessment);
    const services = await db.prepare(`SELECT id, description FROM tp_services WHERE workspace_id = ? AND id IN (${toAdd.map(() => '?').join(',')})`)
      .all(ws, ...toAdd);
    const desc = new Map(services.map(s => [Number(s.id), s.description]));
    let position = conditions.reduce((m, c) => Math.max(m, Number(c.position) || 0), 0);
    const due = addDays(todayFor(actor.ws), DUE_DAYS);
    for (const sid of toAdd) {
      position += 1;
      await db.prepare(`INSERT INTO tp_conditions (workspace_id, recommendation_id, position, description, owner, due_date, automatic, auto_service_id)
        VALUES (?, ?, ?, ?, 'client', ?::date, true, ?)`).run(ws, rec.id, position, conditionText(desc.get(sid), refs), due, sid);
    }
  }
  const outcome = convert ? 'approve_with_conditions' : rec.outcome;
  const res = await db.prepare(`UPDATE tp_recommendations SET outcome = ?, updated_at = now(), row_version = row_version + 1
    WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(outcome, ws, rec.id, rec.row_version);
  if (res.changes !== 1) throw conflict('recommendation');
  const after = await db.prepare(`SELECT id, auto_service_id, due_date::text AS due_date, automatic FROM tp_conditions
    WHERE workspace_id = ? AND recommendation_id = ? AND automatic ORDER BY position, id`).all(ws, rec.id);
  await events.appendEvent(db, {
    workspaceId: ws, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id, actorId: actor.user ? actor.user.id : null,
    action: 'recommendation.exit_plan_conditions_synced',
    before: { recommendation_id: Number(rec.id), version: rec.version, outcome: rec.outcome, automatic: autoSummary(auto) },
    after: {
      recommendation_id: Number(rec.id), version: rec.version, outcome, automatic: autoSummary(after), reason,
      added: toAdd, removed: toRemove.map(c => Number(c.auto_service_id)), converted_to_with_conditions: convert,
    },
  });
  return { changed: true, converted: convert, added: toAdd, removed: toRemove.map(c => Number(c.auto_service_id)), rowVersion: rec.row_version + 1 };
}

async function syncOpen(db, actor, thirdPartyId, reason) {
  if (!db.inTransaction) throw new Error('sync must run inside a transaction');
  const rows = await db.prepare(`SELECT r.id, r.version, r.status, r.outcome, r.override_outcome, r.row_version, a.id AS assessment_id, a.workspace_id,
      a.third_party_id
    FROM tp_recommendations r JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    WHERE r.workspace_id = ? AND r.status IN ('draft', 'changes_requested') AND (?::bigint IS NULL OR a.third_party_id = ?::bigint)
    ORDER BY r.id FOR UPDATE OF r`).all(actor.ws.id, thirdPartyId, thirdPartyId);
  const out = [];
  for (const r of rows) {
    const result = await syncRecommendation(db, actor, { id: Number(r.assessment_id), workspace_id: Number(r.workspace_id),
      third_party_id: Number(r.third_party_id) }, { ...r, conditions: null }, reason);
    if (result.changed) out.push({ recommendation_id: Number(r.id), ...result });
  }
  return out;
}

const syncThirdParty = (db, actor, thirdPartyId, reason) => syncOpen(db, actor, Number(thirdPartyId), reason);
const syncWorkspace = (db, actor, reason) => syncOpen(db, actor, null, reason);

async function syncAssessment(db, actor, assessment, reason) {
  return await syncOpen(db, actor, Number(assessment.third_party_id), reason);
}

function parseOutcomeChange(rec, remaining, input, { required = false } = {}) {
  const outcome = str(input.outcome) || null;
  const reason = str(input.outcome_reason);
  const errors = [];
  if (outcome && !['approve', 'reject'].includes(outcome)) errors.push('Choose the outcome from the list.');
  if (required && !outcome) errors.push('Choose the new outcome.');
  if (outcome && !reason) errors.push('Give the reason for changing the outcome.');
  if (reason.length > LIMITS.reason) errors.push(`The reason for the outcome must be ${LIMITS.reason} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  if (!outcome && rec.outcome === 'approve_with_conditions' && !remaining.length) {
    throw invalid(['Removing this condition would leave the recommendation "with conditions" but with no condition. '
      + 'Keep this condition, add another condition to the draft first, or change the outcome here, with a reason.']);
  }
  if (outcome && remaining.some(c => !c.automatic)) {
    throw invalid(['The draft has other conditions. Only "with conditions" carries conditions: remove them from the draft first, or keep the outcome.']);
  }
  if (outcome === 'approve' && remaining.some(c => c.automatic)) {
    throw invalid(['Another material service still needs its exit plan condition, so the recommendation must stay "with conditions".']);
  }
  return outcome ? { outcome, reason } : null;
}

async function removeAutoCondition(db, actor, thirdPartyId, assessmentId, recommendationId, conditionId, input = {}) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow changes to this client\'s recommendations.');
  if (!access.isManager(actor.user)) {
    throw new TprmError(403, 'Only a manager can remove an automatic condition.');
  }
  const reason = str(input.reason);
  if (!reason) throw invalid(['Give the reason for removing the automatic condition.']);
  if (reason.length > LIMITS.reason) throw invalid([`The reason must be ${LIMITS.reason} characters or fewer.`]);
  const recommendations = require('./recommendations');
  return await db.transaction(async () => {
    const assessment = await db.prepare(`SELECT id, workspace_id, third_party_id, status FROM tp_assessments
      WHERE workspace_id = ? AND third_party_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, Number(thirdPartyId), Number(assessmentId));
    if (!assessment) throw new TprmError(404, 'This assessment does not exist, or it is not available to your account.');
    const rec = await recommendations.getRecommendation(db, actor, assessment, recommendationId, { forUpdate: true });
    const rowVersion = Number(input.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== Number(rec.row_version)) throw conflict('recommendation');
    if (!EDITABLE.includes(rec.status)) {
      throw new TprmError(409, 'An automatic condition is removed only while the recommendation is a draft.');
    }
    const condition = rec.conditions.find(c => Number(c.id) === Number(conditionId) && c.automatic);
    if (!condition) throw new TprmError(404, 'This automatic condition does not exist on this recommendation.');
    const remaining = rec.conditions.filter(c => Number(c.id) !== Number(condition.id));
    const change = parseOutcomeChange(rec, remaining, input);
    const service = await db.prepare('SELECT description FROM tp_services WHERE workspace_id = ? AND id = ?').get(actor.ws.id, condition.auto_service_id);
    await db.prepare(`INSERT INTO tp_exit_plan_overrides (workspace_id, recommendation_id, service_id, service_description, reason, removed_by)
      VALUES (?, ?, ?, ?, ?, ?)`).run(actor.ws.id, rec.id, condition.auto_service_id, service ? service.description : null, reason, actor.user.id);
    await db.prepare('DELETE FROM tp_conditions WHERE workspace_id = ? AND id = ? AND automatic').run(actor.ws.id, condition.id);
    const res = change
      ? await db.prepare(`UPDATE tp_recommendations SET outcome = ?, override_outcome = ?, override_outcome_reason = ?, override_outcome_by = ?,
          override_outcome_at = now(), updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ? AND row_version = ?`)
        .run(change.outcome, change.outcome, change.reason, actor.user.id, actor.ws.id, rec.id, rec.row_version)
      : await db.prepare(`UPDATE tp_recommendations SET updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.ws.id, rec.id, rec.row_version);
    if (res.changes !== 1) throw conflict('recommendation');
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id, actorId: actor.user.id,
      action: 'recommendation.auto_condition_removed',
      before: { recommendation_id: Number(rec.id), version: rec.version, condition_id: Number(condition.id),
        service_id: Number(condition.auto_service_id), description: condition.description, due_date: condition.due_date, outcome: rec.outcome },
      after: { recommendation_id: Number(rec.id), version: rec.version, service_id: Number(condition.auto_service_id), reason, override: true,
        outcome: change ? change.outcome : rec.outcome, outcome_changed: !!change, outcome_reason: change ? change.reason : null },
    });
    if (change && change.outcome === 'reject') {
      const fresh = await recommendations.getRecommendation(db, actor, assessment, rec.id, { forUpdate: true });
      await syncRecommendation(db, actor, assessment, fresh, 'auto_condition_removed');
    }
    return { recommendation: rec, condition, outcome: change ? change.outcome : rec.outcome, outcomeChanged: !!change };
  })();
}

async function changeOutcomeAfterOverride(db, actor, thirdPartyId, assessmentId, recommendationId, input = {}) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow changes to this client\'s recommendations.');
  if (!access.isManager(actor.user)) throw new TprmError(403, 'Only a manager can change the outcome after an override.');
  const recommendations = require('./recommendations');
  return await db.transaction(async () => {
    const assessment = await db.prepare(`SELECT id, workspace_id, third_party_id, status FROM tp_assessments
      WHERE workspace_id = ? AND third_party_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, Number(thirdPartyId), Number(assessmentId));
    if (!assessment) throw new TprmError(404, 'This assessment does not exist, or it is not available to your account.');
    const rec = await recommendations.getRecommendation(db, actor, assessment, recommendationId, { forUpdate: true });
    const rowVersion = Number(input.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== Number(rec.row_version)) throw conflict('recommendation');
    if (!EDITABLE.includes(rec.status)) throw new TprmError(409, 'The outcome is changed only while the recommendation is a draft.');
    if (!(await hasOverride(db, actor.ws.id, rec.id))) {
      throw new TprmError(409, 'No automatic condition was removed from this version: the author chooses the outcome.');
    }
    const change = parseOutcomeChange(rec, rec.conditions, input, { required: true });
    const res = await db.prepare(`UPDATE tp_recommendations SET outcome = ?, override_outcome = ?, override_outcome_reason = ?, override_outcome_by = ?,
        override_outcome_at = now(), updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(change.outcome, change.outcome, change.reason, actor.user.id, actor.ws.id, rec.id, rec.row_version);
    if (res.changes !== 1) throw conflict('recommendation');
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id, actorId: actor.user.id,
      action: 'recommendation.override_outcome_changed',
      before: { recommendation_id: Number(rec.id), version: rec.version, outcome: rec.outcome },
      after: { recommendation_id: Number(rec.id), version: rec.version, outcome: change.outcome, reason: change.reason },
    });
    if (change.outcome === 'reject') {
      const fresh = await recommendations.getRecommendation(db, actor, assessment, rec.id, { forUpdate: true });
      await syncRecommendation(db, actor, assessment, fresh, 'override_outcome_changed');
    }
    return { recommendation: rec, outcome: change.outcome };
  })();
}

async function recommendationPanel(db, actor, assessment, rec) {
  const refs = await rulebooks.exitPlanRulebooks(db, actor, assessment);
  if (!refs.length && !(rec && (rec.conditions || []).some(c => c.automatic))) return null;
  const needed = await neededServiceIds(db, actor.ws.id, assessment.id);
  const overrides = rec ? await overridesOf(db, actor.ws.id, rec.id) : [];
  return {
    rulebooks: refs,
    neededCount: needed.length,
    overrides,
    canOverride: !!rec && EDITABLE.includes(rec.status) && access.isManager(actor.user) && access.can(actor.user, actor.perms, 'tp.manage'),
    outcomeChange: rec && rec.override_outcome ? { outcome: rec.override_outcome, reason: rec.override_outcome_reason,
      by: rec.override_outcome_by_name || null, at: rec.override_outcome_at } : null,
    approveBarred: !!rec && overrides.length > 0 && rec.override_outcome !== 'approve',
  };
}

async function reportLines(db, workspaceId, assessmentId) {
  const required = await db.prepare('SELECT tp_exit_plan_required(?::bigint, ?::bigint) AS r').get(workspaceId, assessmentId);
  if (!required || !required.r) return null;
  const rows = await db.prepare(`SELECT DISTINCT s.id, s.description, x.status FROM tp_assessments a
      CROSS JOIN LATERAL jsonb_array_elements(a.services_in_scope) AS e
      JOIN tp_services s ON s.workspace_id = a.workspace_id AND s.third_party_id = a.third_party_id AND s.id::text = e->>'id'
      LEFT JOIN tp_exit_plans x ON x.workspace_id = s.workspace_id AND x.service_id = s.id
    WHERE a.workspace_id = ? AND a.id = ? AND s.material ORDER BY s.id`).all(workspaceId, assessmentId);
  if (!rows.length) return null;
  return rows.map(r => ({ service: r.description, status: r.status === 'complete' ? 'In place' : 'Missing' }));
}

module.exports = {
  SWITCH_UNITS, SWITCH_UNIT_LABELS, LIMITS, DUE_DAYS, PARTS, EVENT_LABELS,
  missingParts, isComplete, conditionText, requiredSentence, parsePlan, addDays,
  regulated, servicesWithPlans, thirdPartyPanel, planPage, setMaterial, savePlan,
  neededServiceIds, requiredFor, gateProblems, syncRecommendation, syncThirdParty, syncWorkspace, syncAssessment,
  removeAutoCondition, changeOutcomeAfterOverride, parseOutcomeChange, hasOverride, approveBarred, OVERRIDE_KEEPS_CONDITIONS,
  recommendationPanel, reportLines,
};
