'use strict';

const access = require('./access');
const events = require('./events');
const placement = require('./placement');
const clientSettings = require('./client-settings');
const { todayFor } = require('../dates');

const { TprmError } = require('./errors');

const notFound = what => new TprmError(404, `This ${what} does not exist, or it is not available to your account.`);
const conflict = what => new TprmError(409,
  `Someone else changed this ${what} after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.`);

function requirePermission(actor, permission) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, permission)) {
    throw new TprmError(403, 'Your role does not allow this change.');
  }
}

function today(actor) {
  return todayFor(actor.ws);
}

const THIRD_PARTY_FIELDS = ['name', 'legal_name', 'registration_number', 'website', 'category', 'country',
  'primary_contact_name', 'primary_contact_email', 'status', 'client_label', 'last_assessment_date',
  'client_designated_critical', 'current_tier', 'tier_source', 'next_due_date'];

const THIRD_PARTY_COLUMNS = `id, workspace_id, name, legal_name, registration_number, website, category, country,
  primary_contact_name, primary_contact_email, status, client_label,
  last_assessment_date::text AS last_assessment_date, current_tier, tier_source,
  next_due_date::text AS next_due_date, client_designated_critical, import_batch_id,
  created_by, created_at, updated_at, row_version`;

const SERVICE_FIELDS = ['description', 'data_access', 'hosting_countries', 'contract_start', 'contract_end',
  'notice_period_days', 'annual_spend', 'sole_source'];

const SERVICE_COLUMNS = `id, workspace_id, third_party_id, description, data_access, hosting_countries,
  contract_start::text AS contract_start, contract_end::text AS contract_end, notice_period_days,
  annual_spend, sole_source, material, created_at, updated_at, row_version`;

const pick = (row, fields) => Object.fromEntries(fields.map(f => [f, row[f] === undefined ? null : row[f]]));

function diff(before, after, fields) {
  const b = {};
  const a = {};
  for (const f of fields) {
    const x = before[f] === undefined ? null : before[f];
    const y = after[f] === undefined ? null : after[f];
    if (String(x) !== String(y)) { b[f] = x; a[f] = y; }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(raw, { max, label, required = false }, errors) {
  const value = raw == null ? '' : String(raw).trim();
  if (!value) {
    if (required) errors.push(`${label} is required.`);
    return null;
  }
  if (value.length > max) errors.push(`${label} must be ${max} characters or fewer.`);
  return value;
}

function ymd(raw, label, errors, { notAfter } = {}) {
  const value = raw == null ? '' : String(raw).trim();
  if (!value) return null;
  if (!placement.isYmd(value)) { errors.push(`${label} must be a date written YYYY-MM-DD.`); return null; }
  if (notAfter && value > notAfter) errors.push(`${label} cannot be in the future.`);
  return value;
}

function parseStatus(raw) {
  const key = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return placement.STATUSES.includes(key) ? key : null;
}

const checked = raw => raw === true || raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes';

function validateThirdParty(input, { today: todayYmd }) {
  const errors = [];
  const values = {
    name: text(input.name, { max: 200, label: 'Name', required: true }, errors),
    legal_name: text(input.legal_name, { max: 200, label: 'Legal name' }, errors),
    registration_number: text(input.registration_number, { max: 100, label: 'Registration number' }, errors),
    website: text(input.website, { max: 300, label: 'Website' }, errors),
    category: text(input.category, { max: 100, label: 'Category' }, errors),
    country: text(input.country, { max: 100, label: 'Country' }, errors),
    primary_contact_name: text(input.primary_contact_name, { max: 200, label: 'Primary contact' }, errors),
    primary_contact_email: text(input.primary_contact_email, { max: 200, label: 'Contact email' }, errors),
    client_label: text(input.client_label, { max: 100, label: "Client's criticality label" }, errors),
    last_assessment_date: ymd(input.last_assessment_date, 'Last assessment date', errors, { notAfter: todayYmd }),
    client_designated_critical: checked(input.client_designated_critical),
  };
  if (values.primary_contact_email && !EMAIL.test(values.primary_contact_email)) errors.push('Contact email is not a valid email address.');
  const statusRaw = input.status == null ? '' : String(input.status).trim();
  values.status = parseStatus(statusRaw);
  if (!statusRaw) errors.push('Status is required.');
  else if (!values.status) errors.push('Status must be Proposed, In use or Exited.');
  return { values, errors };
}

function validateService(input) {
  const errors = [];
  const values = {
    description: text(input.description, { max: 2000, label: 'Service description', required: true }, errors),
    data_access: text(input.data_access, { max: 2000, label: 'Data access' }, errors),
    hosting_countries: text(input.hosting_countries, { max: 500, label: 'Hosting countries' }, errors),
    contract_start: ymd(input.contract_start, 'Contract start', errors),
    contract_end: ymd(input.contract_end, 'Contract end', errors),
    sole_source: checked(input.sole_source),
    notice_period_days: null,
    annual_spend: null,
  };
  if (values.contract_start && values.contract_end && values.contract_end < values.contract_start) {
    errors.push('Contract end cannot be before contract start.');
  }
  const notice = String(input.notice_period_days == null ? '' : input.notice_period_days).trim();
  if (notice) {
    if (!/^\d{1,4}$/.test(notice) || Number(notice) > 3650) errors.push('Notice period must be a whole number of days (0 to 3650).');
    else values.notice_period_days = Number(notice);
  }
  const spend = String(input.annual_spend == null ? '' : input.annual_spend).trim().replace(/,/g, '');
  if (spend) {
    if (!/^\d{1,14}(\.\d{1,2})?$/.test(spend)) errors.push('Annual spend must be a number (up to two decimals).');
    else values.annual_spend = Number(spend);
  }
  return { values, errors };
}

const FILTERS = {
  status: ['', 'all', ...placement.STATUSES],
  tier: ['', ...placement.TIERS, 'none'],
  due: ['', 'due', 'upcoming', 'not_due'],
};

function normaliseFilters(query = {}) {
  const out = {};
  for (const [key, allowed] of Object.entries(FILTERS)) {
    const value = String(query[key] == null ? '' : query[key]);
    out[key] = allowed.includes(value) ? value : '';
  }
  out.view = query.view === 'due' ? 'due' : 'all';
  out.q = String(query.q == null ? '' : query.q).replace(/\s+/g, ' ').trim().slice(0, 100);
  out.sort = SORTS[query.sort] ? String(query.sort) : '';
  out.dir = query.dir === 'desc' ? 'desc' : 'asc';
  return out;
}

const SORTS = Object.freeze({
  name: 'lower(t.name)',
  status: "CASE t.status WHEN 'proposed' THEN 1 WHEN 'in_use' THEN 2 ELSE 3 END",
  tier: "CASE t.current_tier WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END",
  last_assessed: 't.last_assessment_date',
  next_due: 't.next_due_date',
  services: 'service_count',
});

const UPCOMING_DAYS = 90;
const DUE_SQL = "(t.status = 'in_use' AND (t.next_due_date IS NULL OR t.next_due_date <= ?::date))";

async function listThirdParties(db, actor, query = {}) {
  requirePermission(actor, 'tp.view');
  const filters = normaliseFilters(query);
  const now = today(actor);
  const where = ['t.workspace_id = ?'];
  const args = [actor.ws.id];
  if (filters.view === 'due') { where.push(DUE_SQL); args.push(now); }
  if (!filters.status) where.push("t.status <> 'exited'");
  else if (filters.status !== 'all') { where.push('t.status = ?'); args.push(filters.status); }
  if (filters.tier === 'none') where.push('t.current_tier IS NULL');
  else if (filters.tier) { where.push('t.current_tier = ?'); args.push(filters.tier); }
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    where.push("(t.name ILIKE ? OR COALESCE(t.legal_name, '') ILIKE ? OR COALESCE(t.category, '') ILIKE ? OR COALESCE(t.client_label, '') ILIKE ?)");
    args.push(like, like, like, like);
  }
  if (filters.due === 'due') { where.push(DUE_SQL); args.push(now); }
  else if (filters.due === 'upcoming') {
    where.push("t.status = 'in_use' AND t.next_due_date > ?::date AND t.next_due_date <= ?::date + ?::integer");
    args.push(now, now, UPCOMING_DAYS);
  } else if (filters.due === 'not_due') {
    where.push(`NOT ${DUE_SQL}`); args.push(now);
  }
  const order = filters.sort
    ? `${SORTS[filters.sort]} ${filters.dir === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}, lower(t.name), t.id`
    : filters.view === 'due'
      ? 't.next_due_date ASC NULLS FIRST, lower(t.name), t.id'
      : 'lower(t.name), t.id';
  const rows = await db.prepare(`SELECT ${THIRD_PARTY_COLUMNS},
      (SELECT COUNT(*) FROM tp_services s WHERE s.workspace_id = t.workspace_id AND s.third_party_id = t.id)::integer AS service_count
    FROM tp_third_parties t WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args);
  const counts = await db.prepare(`SELECT COUNT(*)::integer AS total,
      COUNT(*) FILTER (WHERE ${DUE_SQL})::integer AS due,
      COUNT(*) FILTER (WHERE t.status = 'exited')::integer AS exited
    FROM tp_third_parties t WHERE t.workspace_id = ?`).get(now, actor.ws.id);
  return { rows: rows.map(r => ({ ...r, due: placement.isDue(r, now) })), filters, counts, today: now, upcomingDays: UPCOMING_DAYS };
}

async function getThirdParty(db, actor, id, { forUpdate = false } = {}) {
  requirePermission(actor, 'tp.view');
  const tpId = Number(id);
  if (!Number.isSafeInteger(tpId) || tpId < 1) throw notFound('third party');
  const row = await db.prepare(`SELECT ${THIRD_PARTY_COLUMNS} FROM tp_third_parties
    WHERE workspace_id = ? AND id = ?${forUpdate ? ' FOR UPDATE' : ''}`).get(actor.ws.id, tpId);
  if (!row) throw notFound('third party');
  return row;
}

async function listServices(db, actor, thirdPartyId) {
  requirePermission(actor, 'tp.view');
  return await db.prepare(`SELECT ${SERVICE_COLUMNS} FROM tp_services
    WHERE workspace_id = ? AND third_party_id = ? ORDER BY id`).all(actor.ws.id, thirdPartyId);
}

async function getService(db, actor, thirdPartyId, serviceId, { forUpdate = false } = {}) {
  requirePermission(actor, 'tp.view');
  const sid = Number(serviceId);
  if (!Number.isSafeInteger(sid) || sid < 1) throw notFound('service');
  const row = await db.prepare(`SELECT ${SERVICE_COLUMNS} FROM tp_services
    WHERE workspace_id = ? AND third_party_id = ? AND id = ?${forUpdate ? ' FOR UPDATE' : ''}`).get(actor.ws.id, thirdPartyId, sid);
  if (!row) throw notFound('service');
  return row;
}

async function recentEvents(db, actor, thirdPartyId, limit = 20) {
  requirePermission(actor, 'tp.view');
  return await db.prepare(`SELECT e.id, e.chain_seq, e.action, e.before_state, e.after_state, e.created_at,
      u.name AS actor_name
    FROM tp_events e LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.workspace_id = ? AND e.chain_type = 'third_party' AND e.chain_id = ?
    ORDER BY e.chain_seq DESC LIMIT ?`).all(actor.ws.id, thirdPartyId, limit);
}

async function sameNamed(db, workspaceId, name, exceptId = null) {
  if (!name) return [];
  return await db.prepare(`SELECT id, name, status FROM tp_third_parties
    WHERE workspace_id = ? AND lower(btrim(name)) = lower(btrim(?)) AND id IS DISTINCT FROM ?::bigint ORDER BY id`)
    .all(workspaceId, name, exceptId);
}

async function placed(db, actor, values, existing = null, context = null) {
  if (existing && existing.tier_source === 'assessed') {
    return { current_tier: existing.current_tier, tier_source: existing.tier_source, next_due_date: existing.next_due_date };
  }
  const settings = context ? context.settings : await clientSettings.get(db, actor.ws.id);
  const intervals = context ? context.intervals : (await clientSettings.intervals(db, actor.ws, settings)).effective;
  const p = placement.provisionalPlacement({
    status: values.status,
    clientLabel: values.client_label,
    lastAssessmentDate: values.last_assessment_date,
    designatedCritical: values.client_designated_critical,
    labelMap: settings.label_tier_map,
    intervals,
    today: today(actor),
  });
  let nextDue = p.nextDueDate;
  if (existing && nextDue === today(actor) && existing.next_due_date && existing.next_due_date <= nextDue) {
    nextDue = existing.next_due_date;
  }
  if (existing && nextDue && existing.next_due_date && nextDue > existing.next_due_date && values.status === 'in_use'
      && await require('./reassessment').hasOpenTrigger(db, actor.ws.id, existing)) nextDue = existing.next_due_date;
  return { current_tier: p.tier, tier_source: p.tierSource, next_due_date: nextDue };
}

function inputErrors(errors) {
  return new TprmError(400, errors.join(' '), { errors });
}

async function createThirdParty(db, actor, input, { confirmDuplicate = false, firstService = null } = {}) {
  requirePermission(actor, 'tp.manage');
  const { values, errors } = validateThirdParty(input, { today: today(actor) });
  const service = firstService ? validateService(firstService) : null;
  if (service) errors.push(...service.errors);
  if (errors.length) throw inputErrors(errors);
  const duplicates = await sameNamed(db, actor.ws.id, values.name);
  if (duplicates.length && !confirmDuplicate) return { needsConfirmation: true, duplicates, values };
  return await db.transaction(async () => {
    const tier = await placed(db, actor, values);
    const row = { ...values, ...tier };
    const info = await db.prepare(`INSERT INTO tp_third_parties
      (workspace_id, name, legal_name, registration_number, website, category, country,
       primary_contact_name, primary_contact_email, status, client_label, last_assessment_date,
       client_designated_critical, current_tier, tier_source, next_due_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?, ?::date, ?)`).run(
      actor.ws.id, row.name, row.legal_name, row.registration_number, row.website, row.category, row.country,
      row.primary_contact_name, row.primary_contact_email, row.status, row.client_label, row.last_assessment_date,
      row.client_designated_critical, row.current_tier, row.tier_source, row.next_due_date, actor.user.id);
    const id = Number(info.lastInsertRowid);
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: id, actorId: actor.user.id,
      action: 'third_party.created', after: pick(row, THIRD_PARTY_FIELDS),
    });
    const added = service ? await insertService(db, actor, id, service.values) : null;
    return { thirdParty: await getThirdParty(db, actor, id), service: added, duplicates };
  })();
}

async function updateThirdParty(db, actor, id, input, { confirmDuplicate = false } = {}) {
  requirePermission(actor, 'tp.manage');
  const rowVersion = Number(input.row_version);
  const { values, errors } = validateThirdParty(input, { today: today(actor) });
  if (errors.length) throw inputErrors(errors);
  return await db.transaction(async () => {
    const existing = await getThirdParty(db, actor, id, { forUpdate: true });
    if (!Number.isInteger(rowVersion) || rowVersion !== existing.row_version) throw conflict('third party');
    const duplicates = values.name.trim().toLowerCase() === existing.name.trim().toLowerCase()
      ? [] : await sameNamed(db, actor.ws.id, values.name, existing.id);
    if (duplicates.length && !confirmDuplicate) return { needsConfirmation: true, duplicates, values };
    const row = { ...values, ...(await placed(db, actor, values, existing)) };
    const change = diff(existing, row, THIRD_PARTY_FIELDS);
    if (!change.changed) return { thirdParty: existing, duplicates, unchanged: true };
    const res = await db.prepare(`UPDATE tp_third_parties SET
        name = ?, legal_name = ?, registration_number = ?, website = ?, category = ?, country = ?,
        primary_contact_name = ?, primary_contact_email = ?, status = ?, client_label = ?,
        last_assessment_date = ?::date, client_designated_critical = ?, current_tier = ?, tier_source = ?,
        next_due_date = ?::date, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(
      row.name, row.legal_name, row.registration_number, row.website, row.category, row.country,
      row.primary_contact_name, row.primary_contact_email, row.status, row.client_label,
      row.last_assessment_date, row.client_designated_critical, row.current_tier, row.tier_source,
      row.next_due_date, actor.ws.id, existing.id, rowVersion);
    if (res.changes !== 1) throw conflict('third party');
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: existing.id, actorId: actor.user.id,
      action: 'third_party.updated', before: change.before, after: change.after,
    });
    return { thirdParty: await getThirdParty(db, actor, existing.id), duplicates };
  })();
}

const PLACEMENT_FIELDS = ['current_tier', 'tier_source', 'next_due_date'];

async function recalculateProvisional(db, actor, { actorId = actor.user && actor.user.id } = {}) {
  if (!db.inTransaction) throw new Error('recalculateProvisional must run inside a transaction');
  const settings = await clientSettings.get(db, actor.ws.id);
  const context = { settings, intervals: (await clientSettings.intervals(db, actor.ws, settings)).effective };
  const rows = await db.prepare(`SELECT ${THIRD_PARTY_COLUMNS} FROM tp_third_parties
    WHERE workspace_id = ? AND (tier_source IS NULL OR tier_source = 'provisional_from_client_label')
    ORDER BY id FOR UPDATE`).all(actor.ws.id);
  let changed = 0;
  for (const existing of rows) {
    const next = await placed(db, actor, existing, existing, context);
    const change = diff(existing, next, PLACEMENT_FIELDS);
    if (!change.changed) continue;
    await db.prepare(`UPDATE tp_third_parties SET current_tier = ?, tier_source = ?, next_due_date = ?::date,
        updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND tier_source IS NOT DISTINCT FROM ?`)
      .run(next.current_tier, next.tier_source, next.next_due_date, actor.ws.id, existing.id, existing.tier_source);
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: existing.id, actorId,
      action: 'third_party.placement_recalculated',
      before: { ...change.before, reason: 'client_settings_changed' }, after: change.after,
    });
    changed += 1;
  }
  return changed;
}

async function insertService(db, actor, thirdPartyId, values, extra = {}) {
  if (!db.inTransaction) throw new Error('insertService must run inside a transaction');
  const info = await db.prepare(`INSERT INTO tp_services
    (workspace_id, third_party_id, description, data_access, hosting_countries, contract_start, contract_end,
     notice_period_days, annual_spend, sole_source, created_by)
    VALUES (?, ?, ?, ?, ?, ?::date, ?::date, ?, ?, ?, ?)`).run(
    actor.ws.id, thirdPartyId, values.description, values.data_access, values.hosting_countries, values.contract_start,
    values.contract_end, values.notice_period_days, values.annual_spend, values.sole_source, actor.user.id);
  const serviceId = Number(info.lastInsertRowid);
  await events.appendEvent(db, {
    workspaceId: actor.ws.id, thirdPartyId, actorId: actor.user.id,
    action: 'service.added', after: { service_id: serviceId, ...pick(values, SERVICE_FIELDS), ...extra },
  });
  return await getService(db, actor, thirdPartyId, serviceId);
}

async function addService(db, actor, thirdPartyId, input) {
  requirePermission(actor, 'tp.manage');
  const { values, errors } = validateService(input);
  if (errors.length) throw inputErrors(errors);
  return await db.transaction(async () => {
    const tp = await getThirdParty(db, actor, thirdPartyId, { forUpdate: true });
    return await insertService(db, actor, tp.id, values);
  })();
}

async function updateService(db, actor, thirdPartyId, serviceId, input) {
  requirePermission(actor, 'tp.manage');
  const rowVersion = Number(input.row_version);
  const { values, errors } = validateService(input);
  if (errors.length) throw inputErrors(errors);
  return await db.transaction(async () => {
    const tp = await getThirdParty(db, actor, thirdPartyId);
    const existing = await getService(db, actor, tp.id, serviceId, { forUpdate: true });
    if (!Number.isInteger(rowVersion) || rowVersion !== existing.row_version) throw conflict('service');
    const change = diff(existing, values, SERVICE_FIELDS);
    if (!change.changed) return existing;
    const res = await db.prepare(`UPDATE tp_services SET description = ?, data_access = ?, hosting_countries = ?,
        contract_start = ?::date, contract_end = ?::date, notice_period_days = ?, annual_spend = ?, sole_source = ?,
        updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND third_party_id = ? AND id = ? AND row_version = ?`).run(
      values.description, values.data_access, values.hosting_countries, values.contract_start, values.contract_end,
      values.notice_period_days, values.annual_spend, values.sole_source, actor.ws.id, tp.id, existing.id, rowVersion);
    if (res.changes !== 1) throw conflict('service');
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: tp.id, actorId: actor.user.id,
      action: 'service.updated', before: { service_id: existing.id, ...change.before }, after: { service_id: existing.id, ...change.after },
    });
    return await getService(db, actor, tp.id, existing.id);
  })();
}

async function removeService(db, actor, thirdPartyId, serviceId, input) {
  requirePermission(actor, 'tp.manage');
  const rowVersion = Number(input.row_version);
  return await db.transaction(async () => {
    const tp = await getThirdParty(db, actor, thirdPartyId);
    const existing = await getService(db, actor, tp.id, serviceId, { forUpdate: true });
    if (!Number.isInteger(rowVersion) || rowVersion !== existing.row_version) throw conflict('service');
    const res = await db.prepare('DELETE FROM tp_services WHERE workspace_id = ? AND third_party_id = ? AND id = ? AND row_version = ?')
      .run(actor.ws.id, tp.id, existing.id, rowVersion);
    if (res.changes !== 1) throw conflict('service');
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: tp.id, actorId: actor.user.id,
      action: 'service.removed', before: { service_id: existing.id, ...pick(existing, SERVICE_FIELDS) },
    });
    await require('./exit-plans').syncThirdParty(db, actor, tp.id, 'service_removed');
    return existing;
  })();
}

module.exports = {
  TprmError, requirePermission, today,
  THIRD_PARTY_FIELDS, THIRD_PARTY_COLUMNS, pick,
  validateThirdParty, validateService, parseStatus, normaliseFilters,
  listThirdParties, getThirdParty, listServices, getService, recentEvents, sameNamed,
  createThirdParty, updateThirdParty, recalculateProvisional, insertService, addService, updateService, removeService,
};
