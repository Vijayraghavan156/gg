'use strict';

const access = require('./access');
const events = require('./events');
const criticality = require('./criticality');
const register = require('./register');
const { TprmError } = require('./errors');
const wording = require('./client-wording');

const STATUS_LABELS = Object.freeze({
  submitted: 'Waiting for your consultants',
  accepted: 'Added as a third party',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
});
const FIRM_STATUS_LABELS = Object.freeze({
  submitted: 'New request',
  accepted: 'Added',
  declined: 'Declined',
  withdrawn: 'Withdrawn by the client',
});
const REASSESS_STATUS_LABELS = Object.freeze({
  submitted: 'Waiting for your consultants',
  accepted: 'Reassessment started',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
});
const REASSESS_FIRM_STATUS_LABELS = Object.freeze({
  submitted: 'New request',
  accepted: 'Reassessment started',
  declined: 'Declined',
  withdrawn: 'Withdrawn by the client',
});
const KIND_LABELS = Object.freeze({ new_supplier: 'New supplier', reassessment: 'Reassessment' });
const statusLabel = (row, { firm = false } = {}) => (row && row.kind === 'reassessment'
  ? (firm ? REASSESS_FIRM_STATUS_LABELS : REASSESS_STATUS_LABELS)
  : (firm ? FIRM_STATUS_LABELS : STATUS_LABELS))[row && row.status] || (row && row.status) || '';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLUMNS = `r.id, r.workspace_id, r.status, r.name, r.legal_name, r.website, r.country, r.contact_name, r.contact_email,
  r.service_description, r.business_unit, r.service_volume, r.owner_user_id, r.planned_start::text AS planned_start, r.notes,
  r.criticality_model_id, r.answers, r.requested_by, r.requested_at, r.decided_by, r.decided_at, r.decline_reason,
  r.third_party_id, r.updated_at, r.row_version, r.kind, r.preferred_date::text AS preferred_date, r.assessment_id,
  ru.name AS requested_by_name, ou.name AS owner_name, du.name AS decided_by_name`;
const FROM = `FROM tp_client_requests r LEFT JOIN users ru ON ru.id = r.requested_by LEFT JOIN users ou ON ou.id = r.owner_user_id
  LEFT JOIN users du ON du.id = r.decided_by`;

const invalid = errors => new TprmError(400, errors.join(' '), { errors });
const notFound = () => new TprmError(404, 'This request does not exist, or it is not available to your account.');

function text(raw, max, label, errors, required = false) {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) { if (required) errors.push(`${label} is required.`); return null; }
  if (v.length > max) errors.push(`${label} must be ${max} characters or fewer.`);
  return v;
}

async function modelFor(db, ws) {
  return await criticality.getActiveModel(db, Number(ws.firm_id));
}

function questionsOf(model) {
  return ((model && model.questions) || []).filter(q => q && Array.isArray(q.answers) && q.answers.length);
}

async function validate(db, ws, input) {
  const errors = [];
  const values = {
    name: text(input.name, 200, 'Supplier name', errors, true),
    legal_name: text(input.legal_name, 200, 'Legal name', errors),
    website: text(input.website, 300, 'Website', errors),
    country: text(input.country, 100, 'Country', errors),
    contact_name: text(input.contact_name, 200, 'Contact name', errors),
    contact_email: text(input.contact_email, 200, 'Contact email', errors),
    service_description: text(input.service_description, 2000, 'What they will do', errors, true),
    business_unit: text(input.business_unit, 100, 'Business unit', errors),
    service_volume: text(input.service_volume, 200, 'Volume', errors),
    notes: text(input.notes, 2000, 'Anything else', errors),
    planned_start: null,
    owner_user_id: null,
  };
  if (values.contact_email && !EMAIL.test(values.contact_email)) errors.push('Contact email is not a valid email address.');
  const start = String(input.planned_start || '').trim();
  if (start) {
    const d = new Date(`${start}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== start) errors.push('Planned start must be a real date.');
    else values.planned_start = start;
  }
  const owner = String(input.owner_user_id || '').trim();
  if (owner) {
    const n = Number(owner);
    if (!Number.isSafeInteger(n) || n < 1) errors.push('Choose the owner from the list.');
    else values.owner_user_id = n;
  }
  const model = await modelFor(db, ws);
  const raw = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? input.answers : {};
  const answers = {};
  const missing = [];
  for (const q of questionsOf(model)) {
    const v = String(raw[q.id] || '').trim();
    if (!v) { if (q.kind === 'criticality') missing.push(q.text); continue; }
    if (!q.answers.some(a => a && a.id === v)) { errors.push(`Choose one of the answers to "${wording.forClient(q.text)}".`); continue; }
    answers[q.id] = v;
  }
  if (missing.length) errors.push(`Answer every question under "How much it matters" (${missing.length} not answered). Choose "Not sure" where you do not know, if it is offered, or ask your consultants.`);
  if (errors.length) throw invalid(errors);
  if (values.owner_user_id) await register.assertClientOwner(db, ws.id, values.owner_user_id);
  return { values, answers, modelId: model ? Number(model.id) : null };
}

async function append(db, ws, actorId, action, after, thirdPartyId = null) {
  await events.appendEvent(db, { workspaceId: ws.id, thirdPartyId, actorId, action, before: null, after });
}

async function submit(db, ws, user, input = {}) {
  if (!user || !access.isClientUser(user)) throw notFound();
  const { values, answers, modelId } = await validate(db, ws, input);
  return await db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`tp_client_request:${Number(ws.id)}`);
    const same = await db.prepare(`SELECT id, requested_at FROM tp_client_requests WHERE workspace_id = ? AND status = 'submitted' AND kind = 'new_supplier'
      AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(?), '\\s+', ' ', 'g')) ORDER BY id LIMIT 1`).get(ws.id, values.name);
    if (same) {
      const msg = `You have already sent a request for ${values.name}, and it is waiting for your consultants. Open it on the Requests tab instead of sending it again.`;
      throw new TprmError(409, msg, { errors: [msg], requestId: Number(same.id) });
    }
    const row = await db.prepare(`INSERT INTO tp_client_requests (workspace_id, name, legal_name, website, country, contact_name, contact_email,
        service_description, business_unit, service_volume, owner_user_id, planned_start, notes, criticality_model_id, answers, requested_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::date, ?, ?, ?::jsonb, ?) RETURNING id`).get(ws.id, values.name, values.legal_name, values.website,
      values.country, values.contact_name, values.contact_email, values.service_description, values.business_unit, values.service_volume,
      values.owner_user_id, values.planned_start, values.notes, modelId, JSON.stringify(answers), user.id);
    return { id: Number(row.id), name: values.name };
  })();
}

async function list(db, workspaceId, { open = false } = {}) {
  return await db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE r.workspace_id = ?${open ? " AND r.status = 'submitted'" : ''}
    ORDER BY CASE r.status WHEN 'submitted' THEN 0 ELSE 1 END, r.requested_at DESC, r.id DESC`).all(workspaceId);
}

async function get(db, workspaceId, id, { forUpdate = false } = {}) {
  const row = await db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE r.workspace_id = ? AND r.id = ?${forUpdate ? ' FOR UPDATE OF r' : ''}`)
    .get(workspaceId, Number(id) || 0);
  if (!row) throw notFound();
  return row;
}

async function withAnswerLabels(db, ws, row) {
  const model = row.criticality_model_id ? await criticality.getVersion(db, Number(ws.firm_id), row.criticality_model_id) : null;
  const answers = row.answers || {};
  const rows = questionsOf(model).filter(q => answers[q.id] !== undefined).map(q => {
    const a = q.answers.find(x => x.id === answers[q.id]);
    return { text: q.text, answer: a ? a.label : answers[q.id], kind: q.kind };
  });
  return { ...row, answerRows: rows };
}

async function firstAssessment(db, ws, row) {
  if (row.kind !== 'reassessment' || !row.third_party_id) return false;
  const t = await db.prepare('SELECT last_assessment_date::text AS last FROM tp_third_parties WHERE workspace_id = ? AND id = ?').get(ws.id, row.third_party_id);
  if (!t) return false;
  const { ymdInZone, workspaceTimeZone } = require('../dates');
  return !t.last || t.last > ymdInZone(new Date(row.requested_at), workspaceTimeZone(ws));
}

async function forClient(db, ws, id) {
  const row = await withAnswerLabels(db, ws, await get(db, ws.id, id));
  return { ...row, first_assessment: await firstAssessment(db, ws, row),
    answerRows: row.answerRows.map(r => ({ ...r, text: wording.forClient(r.text), answer: wording.forClient(r.answer) })) };
}

async function withdraw(db, ws, user, id, input = {}) {
  if (!user || !access.isClientUser(user)) throw notFound();
  return await db.transaction(async () => {
    const row = await get(db, ws.id, id, { forUpdate: true });
    if (row.status !== 'submitted') throw new TprmError(409, 'Your consultants have already acted on this request.');
    if (Number(input.row_version) !== Number(row.row_version)) throw new TprmError(409, 'This request changed after you opened it. Reload the page and try again.');
    await db.prepare(`UPDATE tp_client_requests SET status = 'withdrawn', decided_by = ?, decided_at = now(), updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ?`).run(user.id, ws.id, row.id);
    return { id: Number(row.id) };
  })();
}

async function openAssessmentId(db, workspaceId, thirdPartyId) {
  const row = await db.prepare(`SELECT id FROM tp_assessments WHERE workspace_id = ? AND third_party_id = ? AND status NOT IN ('completed', 'cancelled')
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(workspaceId, thirdPartyId);
  return row ? Number(row.id) : null;
}

async function openReassessmentRequest(db, workspaceId, thirdPartyId) {
  const row = await db.prepare(`SELECT id FROM tp_client_requests WHERE workspace_id = ? AND third_party_id = ? AND kind = 'reassessment'
    AND status = 'submitted' ORDER BY id LIMIT 1`).get(workspaceId, thirdPartyId);
  return row ? Number(row.id) : null;
}

async function reassessmentState(db, ws, thirdParty) {
  if (!thirdParty || thirdParty.status !== 'in_use') return { allowed: false, reason: 'not_in_use', requestId: null };
  const requestId = await openReassessmentRequest(db, ws.id, thirdParty.id);
  if (requestId) return { allowed: false, reason: 'requested', requestId };
  if (await openAssessmentId(db, ws.id, thirdParty.id)) return { allowed: false, reason: 'open_review', requestId: null };
  return { allowed: true, reason: null, requestId: null };
}

function validateReassessment(input, today, { first = false } = {}) {
  const errors = [];
  const reason = text(input.reason, 2000, first ? 'Why you want it assessed' : 'Why you want it reassessed', errors, true);
  let preferred = null;
  const raw = String(input.preferred_date || '').trim();
  if (raw) {
    const d = new Date(`${raw}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) errors.push('The preferred date must be a real date.');
    else if (today && raw < today) errors.push('The preferred date cannot be in the past.');
    else preferred = raw;
  }
  if (errors.length) throw invalid(errors);
  return { reason, preferred };
}

async function requestReassessment(db, ws, user, thirdPartyId, input = {}) {
  if (!user || !access.isClientUser(user)) throw notFound();
  const tpId = Number(thirdPartyId);
  if (!Number.isSafeInteger(tpId) || tpId < 1) throw notFound();
  const known = await db.prepare('SELECT last_assessment_date FROM tp_third_parties WHERE workspace_id = ? AND id = ?').get(ws.id, tpId);
  const { reason, preferred } = validateReassessment(input, require('../dates').todayFor(ws), { first: !!known && !known.last_assessment_date });
  return await db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`tp_client_request:${Number(ws.id)}`);
    const tp = await db.prepare('SELECT id, name, status, last_assessment_date FROM tp_third_parties WHERE workspace_id = ? AND id = ? FOR UPDATE').get(ws.id, tpId);
    if (!tp) throw notFound();
    const state = await reassessmentState(db, ws, { id: Number(tp.id), status: tp.status });
    if (state.reason === 'requested') {
      const msg = `You have already asked for ${tp.name} to be reassessed, and the request is waiting for your consultants.`;
      throw new TprmError(409, msg, { errors: [msg], requestId: state.requestId });
    }
    if (state.reason === 'open_review') throw new TprmError(409, `${tp.name} already has a review open, so there is nothing to ask for.`);
    if (!state.allowed) throw new TprmError(409, `Only a third party in use can be reassessed.`);
    const row = await db.prepare(`INSERT INTO tp_client_requests (workspace_id, kind, name, service_description, preferred_date, third_party_id, requested_by)
      VALUES (?, 'reassessment', ?, ?, ?::date, ?, ?) RETURNING id`).get(ws.id, tp.name, reason, preferred, tp.id, user.id);
    await append(db, ws, user.id, 'client_request.reassessment_requested', { request_id: Number(row.id), preferred_date: preferred }, Number(tp.id));
    return { id: Number(row.id), name: tp.name, thirdPartyId: Number(tp.id), firstAssessment: !tp.last_assessment_date };
  })();
}

async function acceptReassessment(db, actor, row, input) {
  if (Number(input.row_version) !== Number(row.row_version)) throw new TprmError(409, 'This request changed after you opened it. Reload the page and try again.');
  if (!row.third_party_id) throw new TprmError(409, 'The third party on this request no longer exists. Decline it with a reason instead.');
  const tpId = Number(row.third_party_id);
  await register.getThirdParty(db, actor, tpId);
  return await db.transaction(async () => {
    const locked = await get(db, actor.ws.id, row.id, { forUpdate: true });
    if (locked.status !== 'submitted') throw new TprmError(409, 'This request has already been dealt with.');
    if (Number(locked.row_version) !== Number(row.row_version)) throw new TprmError(409, 'This request changed after you opened it. Reload the page and try again.');
    const assessment = await require('./assessments').start(db, actor, tpId);
    const res = await db.prepare(`UPDATE tp_client_requests SET status = 'accepted', assessment_id = ?, decided_by = ?, decided_at = now(),
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND status = 'submitted'`)
      .run(Number(assessment.id), actor.user.id, actor.ws.id, row.id);
    if (res.changes !== 1) throw new TprmError(409, 'This request has already been dealt with.');
    await append(db, actor.ws, actor.user.id, 'client_request.accepted', { request_id: Number(row.id), name: row.name, kind: 'reassessment', assessment_id: Number(assessment.id) }, tpId);
    return { thirdPartyId: tpId, assessmentId: Number(assessment.id), kind: 'reassessment', typeLabel: assessment.type_label || null };
  })();
}

async function accept(db, actor, id, input = {}) {
  register.requirePermission(actor, 'tp.manage');
  const row = await getForFirm(db, actor, id);
  if (row.status !== 'submitted') throw new TprmError(409, 'This request has already been dealt with.');
  if (row.kind === 'reassessment') return await acceptReassessment(db, actor, row, input);
  if (Number(input.row_version) !== Number(row.row_version)) throw new TprmError(409, 'This request changed after you opened it. Reload the page and try again.');
  const result = await register.createThirdParty(db, actor, {
    name: row.name, legal_name: row.legal_name, website: row.website, country: row.country,
    primary_contact_name: row.contact_name, primary_contact_email: row.contact_email, status: 'proposed',
    business_unit: row.business_unit, service_volume: row.service_volume, client_owner_user_id: row.owner_user_id,
  }, { confirmDuplicate: input.confirm_duplicate === '1', firstService: { description: row.service_description } });
  if (result.needsConfirmation) return { needsConfirmation: true, duplicates: result.duplicates, request: row };
  const tpId = Number(result.thirdParty.id);
  await db.transaction(async () => {
    const res = await db.prepare(`UPDATE tp_client_requests SET status = 'accepted', third_party_id = ?, decided_by = ?, decided_at = now(),
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND status = 'submitted'`)
      .run(tpId, actor.user.id, actor.ws.id, row.id);
    if (res.changes !== 1) throw new TprmError(409, 'This request has already been dealt with.');
    await append(db, actor.ws, actor.user.id, 'client_request.accepted', { request_id: Number(row.id), name: row.name }, tpId);
  })();
  return { thirdPartyId: tpId };
}

async function visibleTo(db, user, rows) {
  if (!rows.length || !(await require('./scope').restricted(db, user))) return rows;
  const vis = await require('./scope').visibleIds(db, user, [...new Set(rows.map(r => Number(r.workspace_id)))]);
  return rows.filter(r => r.kind !== 'reassessment' || (r.third_party_id && vis.has(Number(r.third_party_id))));
}

async function getForFirm(db, actor, id, opts = {}) {
  const row = await get(db, actor.ws.id, id, opts);
  if ((await visibleTo(db, actor.user, [row])).length !== 1) throw notFound();
  return row;
}

async function decline(db, actor, id, input = {}) {
  register.requirePermission(actor, 'tp.manage');
  await getForFirm(db, actor, id);
  const reason = String(input.reason || '').trim();
  if (!reason) throw invalid(['Say why, so the client knows what to do next.']);
  if (reason.length > 1000) throw invalid(['The reason must be 1,000 characters or fewer.']);
  return await db.transaction(async () => {
    const row = await get(db, actor.ws.id, id, { forUpdate: true });
    if (row.status !== 'submitted') throw new TprmError(409, 'This request has already been dealt with.');
    if (Number(input.row_version) !== Number(row.row_version)) throw new TprmError(409, 'This request changed after you opened it. Reload the page and try again.');
    await db.prepare(`UPDATE tp_client_requests SET status = 'declined', decline_reason = ?, decided_by = ?, decided_at = now(), updated_at = now(),
        row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(reason, actor.user.id, actor.ws.id, row.id);
    return { id: Number(row.id) };
  })();
}

async function scopingAnswersFor(db, workspaceId, thirdPartyId, model) {
  const row = await db.prepare(`SELECT id, criticality_model_id, answers FROM tp_client_requests
    WHERE workspace_id = ? AND third_party_id = ? AND status = 'accepted' AND kind = 'new_supplier' AND answers_used_at IS NULL ORDER BY decided_at DESC LIMIT 1`)
    .get(workspaceId, thirdPartyId);
  if (!row || !model || Number(row.criticality_model_id) !== Number(model.id)) return null;
  const answers = {};
  for (const q of questionsOf(model)) {
    const v = row.answers && row.answers[q.id];
    if (v && q.answers.some(a => a.id === v)) answers[q.id] = v;
  }
  await db.prepare('UPDATE tp_client_requests SET answers_used_at = now() WHERE workspace_id = ? AND id = ?').run(workspaceId, row.id);
  return Object.keys(answers).length ? { requestId: Number(row.id), answers } : null;
}

module.exports = {
  STATUS_LABELS, FIRM_STATUS_LABELS, REASSESS_STATUS_LABELS, REASSESS_FIRM_STATUS_LABELS, KIND_LABELS, statusLabel,
  reassessmentState, requestReassessment, visibleTo, getForFirm, modelFor, questionsOf, submit, list, get, withAnswerLabels, forClient, withdraw, accept, decline, scopingAnswersFor,
};
