'use strict';

const access = require('./access');
const events = require('./events');
const placement = require('./placement');
const criticality = require('./criticality');
const clientSettings = require('./client-settings');
const { TprmError } = require('./errors');
const twoPerson = require('./two-person');
const { isUniqueViolation } = require('../pg');

const TYPES = Object.freeze(['onboarding', 'reassessment']);
const TYPE_LABELS = Object.freeze({ onboarding: 'Onboarding assessment', reassessment: 'Reassessment' });
const TYPE_FOR_STATUS = Object.freeze({ proposed: 'onboarding', in_use: 'reassessment' });

const STATUSES = Object.freeze(['scoping', 'tier_proposed', 'tier_confirmed',
  'recommendation_draft', 'recommendation_in_review', 'recommendation_issued', 'information_requested', 'completed', 'cancelled']);
const CLOSED_STATUSES = Object.freeze(['completed', 'cancelled']);
const STATUS_LABELS = Object.freeze({
  scoping: 'Scope and tier',
  tier_proposed: 'Tier waiting for confirmation',
  tier_confirmed: 'Tier confirmed',
  recommendation_draft: 'Recommendation being drafted',
  recommendation_in_review: 'Recommendation in review',
  recommendation_issued: 'Recommendation issued',
  information_requested: 'Client requested more information',
  completed: 'Completed',
  cancelled: 'Cancelled',
});

const OVERRIDE_DIRECTIONS = Object.freeze(['none', 'raise', 'lower']);
const DESIGNATION_CHOICES = Object.freeze(['keep_client_designation', 'use_scored_tier']);
const DESIGNATION_REASON = 'Client designates as Critical';
const LIMITS = Object.freeze({ reason: 1000, comment: 2000 });
const RANK = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

const isOpen = a => !!a && !CLOSED_STATUSES.includes(a.status);

const FROZEN_STATUSES = Object.freeze(['recommendation_in_review', 'recommendation_issued', 'information_requested', 'completed']);
const isFrozen = a => !!a && FROZEN_STATUSES.includes(a.status);
const evidenceChangeable = a => isOpen(a) && !isFrozen(a);
function evidenceFrozenMessage(a) {
  switch (a && a.status) {
    case 'cancelled': return 'This assessment is cancelled, so its evidence and findings can no longer change.';
    case 'completed': return 'This assessment is completed, so its evidence and findings can no longer change.';
    case 'recommendation_in_review':
      return 'The recommendation is in review, so the evidence and findings it is based on are frozen. '
        + 'To change them, the author recalls the recommendation to draft, or the reviewer requests changes.';
    case 'recommendation_issued':
      return 'The recommendation has been issued, so the evidence and findings it is based on are frozen. '
        + 'Start a revised recommendation version to change them.';
    case 'information_requested':
      return 'The client asked for more information. Start the revised recommendation first: '
        + 'the evidence and findings stay frozen until then.';
    default: return null;
  }
}

const notFound = () => new TprmError(404, 'This assessment does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed this assessment after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.');
const wrongStage = a => new TprmError(409,
  `This assessment is at "${STATUS_LABELS[a.status] || a.status}", so that step is not available. Reload the page to see where it is.`);
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

function requirePermission(actor, permission, message) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, permission)) {
    throw new TprmError(403, message || 'Your role does not allow this change.');
  }
}

const COLUMNS = `a.id, a.workspace_id, a.firm_id, a.third_party_id, a.type, a.status, a.services_in_scope,
  a.criticality_model_id, a.criticality_model_version, a.answers, a.scored_tier, a.deciding_question_id,
  a.deciding_answer_id, a.tier_explanation, a.final_tier, a.override_direction, a.override_reason,
  a.client_designation_choice, a.client_designation_used, a.proposed_by, a.proposed_at, a.confirmed_by,
  a.confirmed_at, a.returned_by, a.returned_at, a.return_comment, a.cancelled_by, a.cancelled_at, a.cancel_reason,
  a.lead_consultant_id, a.reviewer_id, a.client_decision_owner_id, a.due_date::text AS due_date,
  a.created_by, a.created_at, a.updated_at, a.row_version, a.self_approval_reason`;

const NAMES = `pu.name AS proposed_by_name, cu.name AS confirmed_by_name, ru.name AS returned_by_name,
  lu.name AS lead_consultant_name, ou.name AS client_decision_owner_name`;
const NAME_JOINS = `LEFT JOIN users pu ON pu.id = a.proposed_by
  LEFT JOIN users cu ON cu.id = a.confirmed_by
  LEFT JOIN users ru ON ru.id = a.returned_by
  LEFT JOIN users lu ON lu.id = a.lead_consultant_id
  LEFT JOIN users ou ON ou.id = a.client_decision_owner_id`;

const SCOPE_FIELDS = ['services_in_scope', 'answers', 'scored_tier', 'deciding_question_id', 'deciding_answer_id',
  'tier_explanation', 'final_tier', 'override_direction', 'override_reason', 'client_designation_choice',
  'client_designation_used'];

function pick(row, fields) {
  return Object.fromEntries(fields.map(f => [f, row[f] === undefined ? null : row[f]]));
}

function diff(before, after, fields) {
  const b = {};
  const a = {};
  for (const f of fields) {
    const x = before[f] === undefined ? null : before[f];
    const y = after[f] === undefined ? null : after[f];
    if (JSON.stringify(x) !== JSON.stringify(y)) { b[f] = x; a[f] = y; }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const list = raw => (Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]).map(v => String(v).trim()).filter(Boolean);

async function thirdPartyOf(db, actor, thirdPartyId, { forUpdate = false } = {}) {
  return require('./register').getThirdParty(db, actor, thirdPartyId, { forUpdate });
}

async function getAssessment(db, actor, thirdPartyId, assessmentId, { forUpdate = false } = {}) {
  requirePermission(actor, 'tp.view');
  const tpId = Number(thirdPartyId);
  const id = Number(assessmentId);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(tpId) || tpId < 1) throw notFound();
  const row = forUpdate
    ? await db.prepare(`SELECT ${COLUMNS} FROM tp_assessments a WHERE a.workspace_id = ? AND a.third_party_id = ? AND a.id = ? FOR UPDATE`)
      .get(actor.ws.id, tpId, id)
    : await db.prepare(`SELECT ${COLUMNS}, ${NAMES} FROM tp_assessments a ${NAME_JOINS}
        WHERE a.workspace_id = ? AND a.third_party_id = ? AND a.id = ?`).get(actor.ws.id, tpId, id);
  if (!row) throw notFound();
  return row;
}

async function listForThirdParty(db, actor, thirdPartyId) {
  requirePermission(actor, 'tp.view');
  return await db.prepare(`SELECT ${COLUMNS}, ${NAMES} FROM tp_assessments a ${NAME_JOINS}
    WHERE a.workspace_id = ? AND a.third_party_id = ? ORDER BY a.created_at DESC, a.id DESC`).all(actor.ws.id, Number(thirdPartyId));
}

async function openAssessment(db, workspaceId, thirdPartyId) {
  return await db.prepare(`SELECT a.id, a.status, a.type FROM tp_assessments a
    WHERE a.workspace_id = ? AND a.third_party_id = ? AND a.status NOT IN ('completed', 'cancelled')`).get(workspaceId, thirdPartyId);
}

async function assessmentEvents(db, actor, assessment, limit = 50) {
  requirePermission(actor, 'tp.view');
  return await db.prepare(`SELECT e.id, e.chain_seq, e.action, e.before_state, e.after_state, e.created_at, u.name AS actor_name
    FROM tp_events e LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.workspace_id = ? AND e.chain_type = 'assessment' AND e.chain_id = ?
    ORDER BY e.chain_seq DESC LIMIT ?`).all(actor.ws.id, assessment.id, limit);
}

async function modelOf(db, assessment) {
  const model = await criticality.getVersion(db, Number(assessment.firm_id), assessment.criticality_model_id);
  if (!model) throw new TprmError(500, 'The criticality model version this assessment was started under is missing.');
  return model;
}

const OWNER_ROLES = ['client_owner', 'isms_manager'];
async function previousAnswers(db, workspaceId, thirdPartyId, model) {
  const last = await db.prepare(`SELECT answers, criticality_model_id FROM tp_assessments WHERE workspace_id = ? AND third_party_id = ? AND status = 'completed'
    ORDER BY created_at DESC, id DESC LIMIT 1`).get(workspaceId, thirdPartyId);
  if (!last || Number(last.criticality_model_id) !== Number(model.id) || !last.answers) return null;
  const answers = {};
  for (const q of (model.questions || [])) {
    const v = last.answers[q.id];
    if (v && (q.answers || []).some(a => a.id === v)) answers[q.id] = v;
  }
  return Object.keys(answers).length ? { answers } : null;
}

async function leadCandidates(db, ws) {
  return await db.prepare(`SELECT u.id, u.name, u.email FROM users u
    WHERE u.user_type = 'firm' AND u.active = 1 AND u.firm_id = ?
      AND (u.firm_role = 'manager' OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ? AND m.user_id = u.id))
    ORDER BY lower(u.name), u.id`).all(Number(ws.firm_id), Number(ws.id));
}

async function setLead(db, actor, assessmentId, leadId) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow changes to this assessment.');
  const id = Number(leadId);
  if (!Number.isSafeInteger(id) || id < 1 || !(await leadCandidates(db, actor.ws)).some(c => Number(c.id) === id)) {
    throw invalid(['Choose the lead from the people at your firm who work on this client.']);
  }
  return await db.transaction(async () => {
    const assessment = await db.prepare(`SELECT ${COLUMNS} FROM tp_assessments a WHERE a.workspace_id = ? AND a.id = ? FOR UPDATE`)
      .get(actor.ws.id, Number(assessmentId) || 0);
    if (!assessment) throw new TprmError(404, 'This assessment does not exist, or it is not available to your account.');
    if (!isOpen(assessment)) throw wrongStage(assessment);
    if (Number(assessment.lead_consultant_id) === id) return { unchanged: true };
    await db.prepare('UPDATE tp_assessments SET lead_consultant_id = ?, updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?')
      .run(id, actor.ws.id, assessment.id);
    await append(db, actor, assessment, 'assessment.details_updated', { lead_consultant_id: assessment.lead_consultant_id == null ? null : Number(assessment.lead_consultant_id) },
      { lead_consultant_id: id });
    return { changed: true };
  })();
}

async function decisionOwnerCandidates(db, workspaceId) {
  const rows = await db.prepare(`SELECT u.id, u.name, u.email, m.role FROM users u
    JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ?
    WHERE u.user_type = 'client' AND u.active = 1 ORDER BY lower(u.name), u.id`).all(workspaceId);
  const rbac = require('../rbac');
  return rows.filter(r => OWNER_ROLES.includes(rbac.normalizeRole(r.role)));
}

function clientSaysCritical(thirdParty, settings) {
  if (thirdParty.client_designated_critical) return true;
  return placement.tierForLabel(settings && settings.label_tier_map, thirdParty.client_label) === 'critical';
}

function evaluate({ model, assessment, thirdParty, services, settings, user, input, forProposal = false, checkAuthority = true }) {
  const errors = [];
  const questions = model.questions || [];

  const byId = new Map(services.map(s => [String(s.id), s]));
  const chosenIds = [...new Set(list(input.services))];
  const unknown = chosenIds.filter(id => !byId.has(id));
  if (unknown.length) errors.push('A chosen service is no longer recorded for this third party. Reload the page and choose again.');
  const servicesInScope = chosenIds.filter(id => byId.has(id))
    .map(id => ({ id: Number(id), description: byId.get(id).description }));
  if (forProposal && !servicesInScope.length) errors.push('Choose at least one service in scope.');

  const rawAnswers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? input.answers : {};
  const answers = {};
  for (const question of questions) {
    const value = str(rawAnswers[question.id]);
    if (!value) continue;
    if (!(question.answers || []).some(a => a.id === value)) {
      errors.push(`"${value}" is not an answer to "${question.text}".`);
      continue;
    }
    answers[question.id] = value;
  }
  const unanswered = questions.filter(q => q.kind === 'criticality' && !answers[q.id]);
  let score = null;
  if (!unanswered.length) {
    try {
      score = criticality.scoreTier(model, answers);
    } catch (err) {
      if (!(err instanceof criticality.CriticalityError)) throw err;
      errors.push(err.message);
    }
  } else if (forProposal) {
    errors.push(`Answer every criticality question before proposing the tier (${unanswered.length} unanswered).`);
  }

  const designationRequired = !!(score && assessment.type === 'reassessment'
    && clientSaysCritical(thirdParty, settings) && score.tier !== 'critical');
  let designationChoice = str(input.designation_choice) || null;
  if (designationChoice && !DESIGNATION_CHOICES.includes(designationChoice)) {
    errors.push('Choose to keep the client\'s designation (Critical) or use the scored tier.');
    designationChoice = null;
  }
  if (!designationRequired) designationChoice = null;
  else if (forProposal && !designationChoice) {
    errors.push(`The client designates this third party as Critical but the answers score ${score.tierLabel}. Choose to keep the client's designation (Critical) or use the scored tier before proposing.`);
  }

  let direction = str(input.override_direction) || 'none';
  let overrideTier = criticality.toTierKey(str(input.override_tier));
  let reason = str(input.override_reason) || null;
  let designationUsed = false;
  if (str(input.override_preset) === 'client_designation') {
    direction = 'raise';
    overrideTier = 'critical';
    reason = DESIGNATION_REASON;
    designationUsed = true;
  }
  if (!OVERRIDE_DIRECTIONS.includes(direction)) { errors.push('Choose whether to keep, raise or lower the scored tier.'); direction = 'none'; }
  if (designationChoice === 'keep_client_designation') {
    if (direction !== 'none' && !(direction === 'raise' && overrideTier === 'critical')) {
      errors.push('You chose to keep the client\'s designation (Critical), so the tier cannot be overridden as well.');
    }
    direction = 'raise';
    overrideTier = 'critical';
    reason = DESIGNATION_REASON;
    designationUsed = true;
  }
  if (direction === 'raise' && overrideTier === 'critical' && reason === DESIGNATION_REASON) designationUsed = true;
  let finalTier = score ? score.tier : null;
  if (direction !== 'none') {
    if (!score) {
      errors.push('Answer every criticality question before overriding the tier.');
    } else if (!overrideTier) {
      errors.push(`Choose the tier to ${direction} it to.`);
    } else if (direction === 'raise' && RANK[overrideTier] <= RANK[score.tier]) {
      errors.push(`Raising means a tier above the scored ${score.tierLabel}.`);
    } else if (direction === 'lower' && RANK[overrideTier] >= RANK[score.tier]) {
      errors.push(`Lowering means a tier below the scored ${score.tierLabel}.`);
    } else {
      finalTier = overrideTier;
    }
    if (!reason) errors.push(`Give a reason for ${direction === 'raise' ? 'raising' : 'lowering'} the tier.`);
    else if (reason.length > LIMITS.reason) errors.push(`The reason must be ${LIMITS.reason} characters or fewer.`);
    if (checkAuthority && direction === 'lower' && !access.isManager(user)) {
      throw new TprmError(403, 'Only a manager can lower a tier. Propose the scored tier, or ask a manager to lower it.');
    }
  } else {
    reason = null;
  }

  const values = {
    services_in_scope: servicesInScope,
    answers,
    scored_tier: score ? score.tier : null,
    deciding_question_id: score ? score.decidingQuestion.id : null,
    deciding_answer_id: score ? score.decidingAnswer.id : null,
    tier_explanation: score ? score.explanation : null,
    final_tier: finalTier,
    override_direction: direction,
    override_reason: reason,
    client_designation_choice: designationChoice,
    client_designation_used: designationUsed,
  };
  if (errors.length) {
    values.override_direction = 'none';
    values.override_reason = null;
    values.final_tier = values.scored_tier;
    values.client_designation_used = false;
  }
  return { values, score, errors, designationRequired, complete: !!score && !errors.length };
}

const json = v => JSON.stringify(v);

async function append(db, actor, assessment, action, before, after) {
  await events.appendEvent(db, {
    workspaceId: actor.ws.id, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id,
    actorId: actor.user.id, action, before, after,
  });
}

function checkVersion(assessment, input) {
  const rowVersion = Number(input && input.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion !== assessment.row_version) throw conflict();
  return rowVersion;
}

async function start(db, actor, thirdPartyId, { automatic = false } = {}) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow starting an assessment.');
  try {
    return await db.transaction(async () => {
      const tp = await thirdPartyOf(db, actor, thirdPartyId, { forUpdate: true });
      const type = TYPE_FOR_STATUS[tp.status];
      if (!type) throw new TprmError(409, 'This third party has exited, so it is not assessed. Change its status first if the client uses it again.');
      const open = await openAssessment(db, actor.ws.id, tp.id);
      if (open) {
        throw new TprmError(409, 'This third party already has an open assessment. Continue that one, or cancel it first.', { openAssessmentId: open.id });
      }
      const model = await criticality.getActiveModel(db, Number(actor.ws.firm_id));
      if (!model) throw new TprmError(409, 'The firm has no active criticality model. A manager must activate one before assessments can start.');
      const fromRequest = type === 'onboarding' ? await require('./client-requests').scopingAnswersFor(db, actor.ws.id, tp.id, model)
        : automatic ? await previousAnswers(db, actor.ws.id, tp.id, model) : null;
      const row = await db.prepare(`INSERT INTO tp_assessments
        (workspace_id, firm_id, third_party_id, type, status, criticality_model_id, criticality_model_version,
         lead_consultant_id, created_by, answers)
        VALUES (?, ?, ?, ?, 'scoping', ?, ?, ?, ?, ?::jsonb) RETURNING id`)
        .get(actor.ws.id, Number(actor.ws.firm_id), tp.id, type, model.id, model.version, actor.user.id, actor.user.id,
          JSON.stringify(fromRequest ? fromRequest.answers : {}));
      const assessment = await getAssessment(db, actor, tp.id, row.id);
      await append(db, actor, assessment, 'assessment.started', null, {
        type, status: 'scoping', third_party_id: tp.id, third_party_status: tp.status,
        criticality_model_id: model.id, criticality_model_version: model.version, lead_consultant_id: actor.user.id, ...(automatic ? { started_automatically: true } : {}),
      });
      return assessment;
    })();
  } catch (err) {
    if (isUniqueViolation(err)) throw new TprmError(409, 'This third party already has an open assessment. Continue that one, or cancel it first.');
    throw err;
  }
}

async function loadForScope(db, actor, thirdPartyId, assessmentId, input) {
  const tp = await thirdPartyOf(db, actor, thirdPartyId, { forUpdate: true });
  const assessment = await getAssessment(db, actor, tp.id, assessmentId, { forUpdate: true });
  checkVersion(assessment, input);
  if (assessment.status !== 'scoping') throw wrongStage(assessment);
  const model = await modelOf(db, assessment);
  const services = await require('./register').listServices(db, actor, tp.id);
  const settings = await clientSettings.get(db, actor.ws.id);
  return { tp, thirdParty: tp, assessment, model, services, settings };
}

async function writeScope(db, actor, assessment, values, { status = 'scoping', proposed = false } = {}) {
  const res = await db.prepare(`UPDATE tp_assessments SET services_in_scope = ?::jsonb, answers = ?::jsonb,
      scored_tier = ?, deciding_question_id = ?, deciding_answer_id = ?, tier_explanation = ?, final_tier = ?,
      override_direction = ?, override_reason = ?, client_designation_choice = ?, client_designation_used = ?,
      status = ?, proposed_by = CASE WHEN ? THEN ?::bigint ELSE proposed_by END,
      proposed_at = CASE WHEN ? THEN now() ELSE proposed_at END,
      updated_at = now(), row_version = row_version + 1
    WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(
    json(values.services_in_scope), json(values.answers), values.scored_tier, values.deciding_question_id,
    values.deciding_answer_id, values.tier_explanation, values.final_tier, values.override_direction,
    values.override_reason, values.client_designation_choice, values.client_designation_used,
    status, proposed, actor.user.id, proposed, actor.ws.id, assessment.id, assessment.row_version);
  if (res.changes !== 1) throw conflict();
}

async function saveScope(db, actor, thirdPartyId, assessmentId, input) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow changes to this assessment.');
  return await db.transaction(async () => {
    const ctx = await loadForScope(db, actor, thirdPartyId, assessmentId, input);
    const evaluation = evaluate({ ...ctx, user: actor.user, input, forProposal: false });
    if (evaluation.errors.length) throw invalid(evaluation.errors);
    const change = diff(ctx.assessment, evaluation.values, SCOPE_FIELDS);
    if (!change.changed) return { assessment: ctx.assessment, evaluation, unchanged: true };
    await writeScope(db, actor, ctx.assessment, evaluation.values);
    await append(db, actor, ctx.assessment, 'assessment.scope_saved', change.before, change.after);
    return { assessment: await getAssessment(db, actor, ctx.tp.id, ctx.assessment.id), evaluation };
  })();
}

async function propose(db, actor, thirdPartyId, assessmentId, input) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow proposing a tier.');
  return await db.transaction(async () => {
    const ctx = await loadForScope(db, actor, thirdPartyId, assessmentId, input);
    const evaluation = evaluate({ ...ctx, user: actor.user, input, forProposal: true });
    if (evaluation.errors.length) throw invalid(evaluation.errors);
    const values = evaluation.values;
    await writeScope(db, actor, ctx.assessment, values, { status: 'tier_proposed', proposed: true });
    await append(db, actor, ctx.assessment, 'assessment.tier_proposed', { status: 'scoping' }, {
      status: 'tier_proposed', ...pick(values, SCOPE_FIELDS),
      criticality_model_id: ctx.assessment.criticality_model_id,
      criticality_model_version: ctx.assessment.criticality_model_version,
    });
    return { assessment: await getAssessment(db, actor, ctx.tp.id, ctx.assessment.id), evaluation };
  })();
}

async function loadForReview(db, actor, thirdPartyId, assessmentId, input, verb, { allowSelf = false } = {}) {
  requirePermission(actor, 'tp.review', `Only a senior consultant or a manager can ${verb} a proposed tier.`);
  const tp = await thirdPartyOf(db, actor, thirdPartyId, { forUpdate: true });
  const assessment = await getAssessment(db, actor, tp.id, assessmentId, { forUpdate: true });
  checkVersion(assessment, input);
  if (assessment.status !== 'tier_proposed') throw wrongStage(assessment);
  const setting = (await twoPerson.settingsFor(db, actor.ws.firm_id)).selfApproveTiers;
  let selfApproval = null;
  if (Number(assessment.proposed_by) === Number(actor.user.id)) {
    if (!allowSelf || !access.isManager(actor.user)) {
      throw new TprmError(403, `You proposed this tier, so a second person must ${verb} it.`);
    }
    if (!setting) {
      throw new TprmError(403, `You proposed this tier, so a second person must ${verb} it: your firm does not let managers self-approve tiers.`);
    }
    selfApproval = twoPerson.selfReason(input && input.self_approval_reason, 'self-approval');
  }
  return { tp, assessment, selfApproval, setting };
}

async function confirm(db, actor, thirdPartyId, assessmentId, input) {
  return await db.transaction(async () => {
    const { tp, assessment, selfApproval, setting } = await loadForReview(db, actor, thirdPartyId, assessmentId, input, 'confirm', { allowSelf: true });
    const res = await db.prepare(`UPDATE tp_assessments SET status = 'tier_confirmed', confirmed_by = ?, confirmed_at = now(),
        self_approval_reason = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.user.id, selfApproval, actor.ws.id, assessment.id, assessment.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, 'assessment.tier_confirmed', { status: 'tier_proposed' }, {
      status: 'tier_confirmed', final_tier: assessment.final_tier, scored_tier: assessment.scored_tier,
      override_direction: assessment.override_direction, proposed_by: assessment.proposed_by,
      self_approved: !!selfApproval, self_approval_reason: selfApproval,
      setting: { managers_self_approve_tiers: setting },
    });
    const before = { current_tier: tp.current_tier, tier_source: tp.tier_source };
    const after = { current_tier: assessment.final_tier, tier_source: 'assessed' };
    await db.prepare(`UPDATE tp_third_parties SET current_tier = ?, tier_source = 'assessed', updated_at = now(),
        row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`).run(assessment.final_tier, actor.ws.id, tp.id);
    await events.appendEvent(db, {
      workspaceId: actor.ws.id, thirdPartyId: tp.id, actorId: actor.user.id, action: 'third_party.tier_assessed',
      before, after: { ...after, assessment_id: assessment.id, assessment_type: assessment.type },
    });
    return await getAssessment(db, actor, tp.id, assessment.id);
  })();
}

async function sendBack(db, actor, thirdPartyId, assessmentId, input) {
  const comment = str(input && input.comment);
  return await db.transaction(async () => {
    const { tp, assessment } = await loadForReview(db, actor, thirdPartyId, assessmentId, input, 'send back');
    if (!comment) throw invalid(['Say what needs to change before the tier can be confirmed.']);
    if (comment.length > LIMITS.comment) throw invalid([`The comment must be ${LIMITS.comment} characters or fewer.`]);
    const res = await db.prepare(`UPDATE tp_assessments SET status = 'scoping', returned_by = ?, returned_at = now(),
        return_comment = ?, proposed_by = NULL, proposed_at = NULL, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.user.id, comment, actor.ws.id, assessment.id, assessment.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, 'assessment.tier_returned',
      { status: 'tier_proposed', proposed_by: assessment.proposed_by }, { status: 'scoping', comment });
    return await getAssessment(db, actor, tp.id, assessment.id);
  })();
}

const CANCEL_WITHDRAW_REASON = 'Assessment cancelled';
const notCancellable = () => new TprmError(409,
  'A recommendation has been issued on this assessment, so it can no longer be cancelled. '
  + 'The client decides on it in the client portal; if more information is needed, a revised version is issued instead.');

async function cancel(db, actor, thirdPartyId, assessmentId, input) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow cancelling an assessment.');
  const reason = str(input && input.reason);
  return await db.transaction(async () => {
    const tp = await thirdPartyOf(db, actor, thirdPartyId, { forUpdate: true });
    const assessment = await getAssessment(db, actor, tp.id, assessmentId, { forUpdate: true });
    checkVersion(assessment, input);
    if (!isOpen(assessment)) throw wrongStage(assessment);
    const recs = await db.prepare(`SELECT id, version, status, issued_at FROM tp_recommendations
      WHERE workspace_id = ? AND assessment_id = ? ORDER BY version FOR UPDATE`).all(actor.ws.id, assessment.id);
    if (['recommendation_issued', 'information_requested'].includes(assessment.status) || recs.some(r => r.issued_at)) {
      throw notCancellable();
    }
    if (!reason) throw invalid(['Give a reason for cancelling the assessment.']);
    if (reason.length > LIMITS.reason) throw invalid([`The reason must be ${LIMITS.reason} characters or fewer.`]);
    const withdrawn = [];
    for (const r of recs.filter(x => ['draft', 'in_review', 'changes_requested'].includes(x.status))) {
      await db.prepare(`UPDATE tp_recommendations SET status = 'withdrawn', withdrawn_by = ?, withdrawn_at = now(),
          withdraw_reason = ?, updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
        .run(actor.user.id, CANCEL_WITHDRAW_REASON, actor.ws.id, r.id);
      await append(db, actor, assessment, 'recommendation.withdrawn',
        { recommendation_id: Number(r.id), version: r.version, status: r.status },
        { recommendation_id: Number(r.id), version: r.version, status: 'withdrawn', reason: CANCEL_WITHDRAW_REASON,
          assessment_status: 'cancelled' });
      withdrawn.push({ recommendation_id: Number(r.id), version: r.version });
    }
    await require('./questionnaires').closeForCancelledAssessment(db, actor, assessment);
    const res = await db.prepare(`UPDATE tp_assessments SET status = 'cancelled', cancelled_by = ?, cancelled_at = now(),
        cancel_reason = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.user.id, reason, actor.ws.id, assessment.id, assessment.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, 'assessment.cancelled', { status: assessment.status },
      { status: 'cancelled', reason, ...(withdrawn.length ? { withdrawn_recommendations: withdrawn } : {}) });
    return await getAssessment(db, actor, tp.id, assessment.id);
  })();
}

async function canCancel(db, actor, assessment) {
  if (!isOpen(assessment) || ['recommendation_issued', 'information_requested'].includes(assessment.status)) return false;
  const row = await db.prepare(`SELECT 1 FROM tp_recommendations WHERE workspace_id = ? AND assessment_id = ?
    AND issued_at IS NOT NULL LIMIT 1`).get(actor.ws.id, assessment.id);
  return !row;
}

const DETAIL_FIELDS = ['due_date', 'client_decision_owner_id', 'lead_consultant_id'];

async function updateDetails(db, actor, thirdPartyId, assessmentId, input) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow changes to this assessment.');
  const errors = [];
  const dueDate = str(input.due_date) || null;
  if (dueDate && !placement.isYmd(dueDate)) errors.push('Due date must be a date written YYYY-MM-DD.');
  const leadRaw = str(input.lead_consultant_id);
  const ownerRaw = str(input.client_decision_owner_id);
  const ownerId = ownerRaw ? Number(ownerRaw) : null;
  if (ownerRaw && (!Number.isSafeInteger(ownerId) || ownerId < 1)) errors.push('Choose the client decision owner from the list.');
  if (errors.length) throw invalid(errors);
  return await db.transaction(async () => {
    const tp = await thirdPartyOf(db, actor, thirdPartyId);
    const assessment = await getAssessment(db, actor, tp.id, assessmentId, { forUpdate: true });
    checkVersion(assessment, input);
    if (!isOpen(assessment)) throw wrongStage(assessment);
    if (ownerId && ownerId !== Number(assessment.client_decision_owner_id)) {
      const candidates = await decisionOwnerCandidates(db, actor.ws.id);
      if (!candidates.some(c => Number(c.id) === ownerId)) {
        throw invalid(['The client decision owner must be a client owner or ISMS manager of this client.']);
      }
    }
    const currentLead = assessment.lead_consultant_id == null ? null : Number(assessment.lead_consultant_id);
    let leadId = currentLead;
    if (leadRaw) {
      leadId = Number(leadRaw);
      if (leadId !== currentLead && !(await leadCandidates(db, actor.ws)).some(c => Number(c.id) === leadId)) {
        throw invalid(['Choose the lead from the people at your firm who work on this client.']);
      }
    }
    const values = { due_date: dueDate, client_decision_owner_id: ownerId, lead_consultant_id: leadId };
    const change = diff({ due_date: assessment.due_date, client_decision_owner_id: assessment.client_decision_owner_id == null ? null : Number(assessment.client_decision_owner_id),
      lead_consultant_id: currentLead }, values, DETAIL_FIELDS);
    if (!change.changed) return { assessment, unchanged: true };
    const res = await db.prepare(`UPDATE tp_assessments SET due_date = ?::date, client_decision_owner_id = ?, lead_consultant_id = ?,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(dueDate, ownerId, leadId, actor.ws.id, assessment.id, assessment.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, 'assessment.details_updated', change.before, change.after);
    return { assessment: await getAssessment(db, actor, tp.id, assessment.id) };
  })();
}

async function reviewableClients(deps, user, permission) {
  const { enabled } = await access.listFirmClients(deps, user);
  const reviewable = [];
  for (const c of enabled) {
    const loaded = await access.loadFirmWorkspace(deps, user, c.id, { permission });
    if (loaded) reviewable.push({ id: Number(c.id), name: c.name });
  }
  return reviewable;
}

async function reviewQueue(deps, user, { readOnly = false } = {}) {
  const permission = readOnly ? 'tp.manage' : 'tp.review';
  if (!access.isFirmUser(user) || !access.firmCan(user, permission)) return [];
  const reviewable = await reviewableClients(deps, user, permission);
  if (!reviewable.length) return [];
  const ownAllowed = !readOnly && access.isManager(user) && (await twoPerson.settingsFor(deps.db, user.firm_id)).selfApproveTiers;
  const names = new Map(reviewable.map(c => [c.id, c.name]));
  const ids = reviewable.map(c => c.id);
  const rows = await deps.db.prepare(`SELECT a.id, a.workspace_id, a.third_party_id, a.type, a.scored_tier, a.final_tier,
      a.override_direction, a.proposed_by, a.proposed_at, a.due_date::text AS due_date, t.name AS third_party_name,
      pu.name AS proposed_by_name
    FROM tp_assessments a
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    LEFT JOIN users pu ON pu.id = a.proposed_by
    WHERE a.status = 'tier_proposed' AND a.workspace_id IN (${ids.map(() => '?').join(',')})
      AND (?::boolean OR a.proposed_by IS DISTINCT FROM ?::bigint)
    ORDER BY a.proposed_at ASC, a.id`).all(...ids, readOnly || ownAllowed, user.id);
  return rows.map(r => ({ ...r, client_name: names.get(Number(r.workspace_id)), own: Number(r.proposed_by) === Number(user.id) }));
}

async function selfApprovedRecently(deps, user, { days = 30 } = {}) {
  if (!access.isFirmUser(user) || !(access.firmCan(user, 'tp.review') || access.firmCan(user, 'tp.manage'))) return [];
  const reviewable = await reviewableClients(deps, user, access.firmCan(user, 'tp.review') ? 'tp.review' : 'tp.manage');
  if (!reviewable.length) return [];
  const names = new Map(reviewable.map(c => [c.id, c.name]));
  const ids = reviewable.map(c => c.id);
  const rows = await deps.db.prepare(`SELECT a.id, a.workspace_id, a.third_party_id, a.type, a.final_tier, a.confirmed_at,
      a.self_approval_reason, t.name AS third_party_name, cu.name AS confirmed_by_name
    FROM tp_assessments a
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    LEFT JOIN users cu ON cu.id = a.confirmed_by
    WHERE a.workspace_id IN (${ids.map(() => '?').join(',')}) AND a.self_approval_reason IS NOT NULL
      AND a.confirmed_at >= now() - (?::integer * interval '1 day')
    ORDER BY a.confirmed_at DESC, a.id DESC LIMIT 50`).all(...ids, days);
  return rows.map(r => ({ ...r, client_name: names.get(Number(r.workspace_id)) }));
}

const STEP_OF_ANCHOR = Object.freeze({
  scope: 'scope', questionnaire: 'questionnaire',
  'questionnaire-answers': 'review', 'questionnaire-reports': 'review', 'ai-review': 'review',
  evidence: 'evidence', findings: 'evidence', 'data-location': 'evidence',
  'contract-review': 'contract',
  recommendation: 'recommendation', report: 'recommendation',
  decision: 'decision', conditions: 'decision',
  details: 'details', history: 'history',
});
function stepUrl(base, anchor) {
  const a = String(anchor || '').replace(/^#/, '');
  const stepKey = STEP_OF_ANCHOR[a] || (/^answer-\d+$/.test(a) ? 'review' : null);
  return `${base}${stepKey ? `?step=${stepKey}` : ''}${a ? `#${a}` : ''}`;
}

module.exports = {
  TYPES, TYPE_LABELS, TYPE_FOR_STATUS, STATUSES, CLOSED_STATUSES, STATUS_LABELS, OVERRIDE_DIRECTIONS,
  DESIGNATION_CHOICES, DESIGNATION_REASON, LIMITS, isOpen,
  FROZEN_STATUSES, isFrozen, evidenceChangeable, evidenceFrozenMessage, CANCEL_WITHDRAW_REASON, canCancel,
  getAssessment, listForThirdParty, openAssessment, assessmentEvents, modelOf, decisionOwnerCandidates, leadCandidates, setLead,
  clientSaysCritical, evaluate,
  start, saveScope, propose, confirm, sendBack, cancel, updateDetails, reviewQueue, selfApprovedRecently,
  STEP_OF_ANCHOR, stepUrl,
};
