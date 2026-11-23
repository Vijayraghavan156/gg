'use strict';

const access = require('./access');
const events = require('./events');
const placement = require('./placement');
const assessments = require('./assessments');
const findings = require('./findings');
const { TprmError } = require('./errors');
const twoPerson = require('./two-person');
const { isUniqueViolation } = require('../pg');
const { todayFor } = require('../dates');

const exitPlans = () => require('./exit-plans');

const STATUSES = Object.freeze(['draft', 'in_review', 'changes_requested', 'issued', 'withdrawn']);
const OPEN_STATUSES = Object.freeze(['draft', 'in_review', 'changes_requested']);
const EDITABLE_STATUSES = Object.freeze(['draft', 'changes_requested']);
const STATUS_LABELS = Object.freeze({
  draft: 'Draft', in_review: 'In review', changes_requested: 'Changes requested', issued: 'Issued', withdrawn: 'Withdrawn',
});

const OUTCOMES = Object.freeze(['approve', 'approve_with_conditions', 'reject']);
const OUTCOME_LABELS = Object.freeze({
  onboarding: Object.freeze({ approve: 'Onboard', approve_with_conditions: 'Onboard with conditions', reject: 'Do not onboard' }),
  reassessment: Object.freeze({ approve: 'Continue', approve_with_conditions: 'Continue with conditions', reject: 'Exit' }),
});
const WITH_CONDITIONS = 'approve_with_conditions';
const RESIDUAL_RATINGS = Object.freeze(['low', 'medium', 'high', 'critical']);
const RESIDUAL_LABELS = placement.TIER_LABELS;
const CONDITION_OWNERS = Object.freeze(['vendor', 'client']);
const CONDITION_OWNER_LABELS = Object.freeze({ vendor: 'Third party', client: 'Client' });
const LIMITS = Object.freeze({ rationale: 10000, comment: 2000, reason: 1000, condition: 2000, conditions: 50 });

const ASSESSMENT_STAGES = Object.freeze({
  draft: 'recommendation_draft', in_review: 'recommendation_in_review', issued: 'recommendation_issued',
});
const RECOMMENDATION_STAGES = Object.freeze(Object.values(ASSESSMENT_STAGES));
const INFORMATION_REQUESTED = 'information_requested';
const NEW_VERSION_FROM = Object.freeze(['recommendation_issued', INFORMATION_REQUESTED]);

const EVENT_LABELS = Object.freeze({
  'recommendation.drafted': 'Recommendation started',
  'recommendation.saved': 'Recommendation draft saved',
  'recommendation.submitted': 'Recommendation submitted for review',
  'recommendation.changes_requested': 'Changes requested on the recommendation',
  'recommendation.issued': 'Recommendation issued',
  'recommendation.superseded': 'Earlier recommendation superseded',
  'recommendation.withdrawn': 'Recommendation withdrawn',
  'recommendation.new_version_started': 'New recommendation version started',
  'recommendation.recalled': 'Recommendation recalled to draft',
  'recommendation.reassigned': 'Recommendation handed to another consultant',
});

function outcomeLabel(type, outcome) {
  const labels = OUTCOME_LABELS[type] || OUTCOME_LABELS.onboarding;
  return outcome ? labels[outcome] || outcome : null;
}

const notFound = () => new TprmError(404, 'This recommendation does not exist, or it is not available to your account.');
const assessmentNotFound = () => new TprmError(404, 'This assessment does not exist, or it is not available to your account.');
const conflict = () => new TprmError(409,
  'Someone else changed this recommendation after you opened it. Nothing was saved: reload the page to see the latest version, then make your change again.');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

function requirePermission(actor, permission, message) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, permission)) {
    throw new TprmError(403, message || 'Your role does not allow this change.');
  }
}

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const isAuthor = (rec, user) => !!rec && !!user && Number(rec.author_id) === Number(user.id);

const REC_COLUMNS = `r.id, r.workspace_id, r.assessment_id, r.version, r.status, r.outcome, r.residual_rating, r.rationale,
  r.valid_until::text AS valid_until, r.author_id, r.submitted_at, r.reviewer_id, r.reviewed_at, r.review_comment,
  r.issued_at, r.withdrawn_by, r.withdrawn_at, r.withdraw_reason, r.superseded_by_id, r.created_at, r.updated_at, r.row_version,
  r.override_outcome, r.override_outcome_reason, r.override_outcome_by, r.override_outcome_at, r.self_issue_reason`;
const REC_NAMES = `au.name AS author_name, rv.name AS reviewer_name, wu.name AS withdrawn_by_name, ou.name AS override_outcome_by_name`;
const REC_JOINS = `LEFT JOIN users au ON au.id = r.author_id
  LEFT JOIN users rv ON rv.id = r.reviewer_id
  LEFT JOIN users wu ON wu.id = r.withdrawn_by
  LEFT JOIN users ou ON ou.id = r.override_outcome_by`;

async function assessmentOf(db, actor, thirdPartyId, assessmentId, { forUpdate = false } = {}) {
  requirePermission(actor, 'tp.view');
  const tpId = Number(thirdPartyId);
  const id = Number(assessmentId);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(tpId) || tpId < 1) throw assessmentNotFound();
  const row = await db.prepare(`SELECT a.id, a.workspace_id, a.third_party_id, a.type, a.status, a.final_tier,
      a.confirmed_at, a.client_decision_owner_id, a.row_version
    FROM tp_assessments a WHERE a.workspace_id = ? AND a.third_party_id = ? AND a.id = ?${forUpdate ? ' FOR UPDATE' : ''}`)
    .get(actor.ws.id, tpId, id);
  if (!row) throw assessmentNotFound();
  return row;
}

async function conditionsOf(db, workspaceId, recommendationIds) {
  const ids = [...new Set(recommendationIds.map(Number))];
  if (!ids.length) return new Map();
  const rows = await db.prepare(`SELECT c.id, c.recommendation_id, c.position, c.description, c.owner,
      c.due_date::text AS due_date, c.status, c.automatic, c.auto_service_id, c.finding_id
    FROM tp_conditions c WHERE c.workspace_id = ? AND c.recommendation_id IN (${ids.map(() => '?').join(',')})
    ORDER BY c.recommendation_id, c.position, c.id`).all(workspaceId, ...ids);
  const out = new Map(ids.map(id => [id, []]));
  for (const r of rows) out.get(Number(r.recommendation_id)).push(r);
  return out;
}

async function getRecommendation(db, actor, assessment, recommendationId, { forUpdate = false } = {}) {
  requirePermission(actor, 'tp.view');
  const id = Number(recommendationId);
  if (!Number.isSafeInteger(id) || id < 1) throw notFound();
  const row = forUpdate
    ? await db.prepare(`SELECT ${REC_COLUMNS} FROM tp_recommendations r
        WHERE r.workspace_id = ? AND r.assessment_id = ? AND r.id = ? FOR UPDATE`).get(actor.ws.id, assessment.id, id)
    : await db.prepare(`SELECT ${REC_COLUMNS}, ${REC_NAMES} FROM tp_recommendations r ${REC_JOINS}
        WHERE r.workspace_id = ? AND r.assessment_id = ? AND r.id = ?`).get(actor.ws.id, assessment.id, id);
  if (!row) throw notFound();
  row.conditions = (await conditionsOf(db, actor.ws.id, [row.id])).get(Number(row.id));
  return row;
}

async function listForAssessment(db, actor, assessment) {
  requirePermission(actor, 'tp.view');
  const rows = await db.prepare(`SELECT ${REC_COLUMNS}, ${REC_NAMES} FROM tp_recommendations r ${REC_JOINS}
    WHERE r.workspace_id = ? AND r.assessment_id = ? ORDER BY r.version DESC`).all(actor.ws.id, assessment.id);
  const conditions = await conditionsOf(db, actor.ws.id, rows.map(r => r.id));
  for (const r of rows) r.conditions = conditions.get(Number(r.id)) || [];
  return rows;
}

function submitProblems(rec, today) {
  const problems = [];
  if (!rec.outcome) problems.push('Choose the recommendation.');
  if (!rec.residual_rating) problems.push('Choose the residual risk rating.');
  if (!str(rec.rationale)) problems.push('Write the rationale.');
  if (!rec.valid_until) {
    if (rec.outcome !== 'reject') problems.push('Set the date the recommendation is valid until.');
  } else if (today && rec.valid_until <= today) problems.push('"Valid until" must be a date after today.');
  const conditions = rec.conditions || [];
  if (rec.outcome === WITH_CONDITIONS && !conditions.length) {
    problems.push('Add at least one condition: the recommendation is "with conditions".');
  }
  if (rec.outcome && rec.outcome !== WITH_CONDITIONS && conditions.length) {
    problems.push('Remove the conditions, or choose the "with conditions" recommendation: only that one carries conditions.');
  }
  if (rec.outcome === WITH_CONDITIONS) {
    let n = 0;
    conditions.forEach(c => {
      const name = c.automatic ? 'The automatic exit plan condition' : `Condition ${(n += 1)}`;
      if (!c.owner) problems.push(`${name}: choose who owns it (the third party or the client).`);
      if (!c.due_date) problems.push(`${name}: set a due date.`);
      else if (today && c.due_date < today) problems.push(`${name}: the due date is in the past.`);
    });
  }
  return problems;
}

async function pageData(db, actor, assessment, { lookup = null } = {}) {
  const user = actor.user;
  const versions = await listForAssessment(db, actor, assessment);
  const open = versions.find(r => OPEN_STATUSES.includes(r.status)) || null;
  const issued = versions.find(r => r.status === 'issued') || null;
  const canManage = access.can(user, actor.perms, 'tp.manage');
  const canReview = access.can(user, actor.perms, 'tp.review');
  const assessmentOpen = !['completed', 'cancelled'].includes(assessment.status);
  const canReassign = !!open && assessmentOpen && canManage && access.isManager(user);
  const questionnaire = await require('./questionnaires').recommendationGate(db, actor.ws.id, assessment.id);
  return {
    R: module.exports,
    versions,
    open,
    issued,
    earlier: versions.filter(r => r !== open && r !== issued),
    findings: await findings.listFindings(db, actor, assessment),
    findingSeverityLabels: findings.SEVERITY_LABELS,
    findingStatusLabels: findings.STATUS_LABELS,
    ownerNamed: !!assessment.client_decision_owner_id,
    owners: assessment.client_decision_owner_id ? [] : await assessments.decisionOwnerCandidates(db, actor.ws.id),
    ready: assessmentOpen && (assessment.status === 'tier_confirmed' || RECOMMENDATION_STAGES.includes(assessment.status)
      || assessment.status === INFORMATION_REQUESTED),
    assessmentOpen,
    canCreate: canManage && assessmentOpen && assessment.status === 'tier_confirmed' && !open,
    canEdit: !!open && assessmentOpen && canManage && isAuthor(open, user) && EDITABLE_STATUSES.includes(open.status),
    canWithdraw: !!open && assessmentOpen && canManage && isAuthor(open, user),
    canRecall: !!open && assessmentOpen && canManage && isAuthor(open, user) && open.status === 'in_review',
    canReassign,
    authorCandidates: canReassign && lookup
      ? (await authorCandidates(lookup, actor.ws)).filter(c => Number(c.id) !== Number(open.author_id)) : [],
    issuedEver: versions.some(r => r.issued_at),
    canReviewOpen: !!open && assessmentOpen && open.status === 'in_review' && canReview && !isAuthor(open, user),
    canSelfIssue: !!open && assessmentOpen && open.status === 'in_review' && canReview && isAuthor(open, user)
      && access.isManager(user) && (await twoPerson.settingsFor(db, actor.ws.firm_id)).selfIssueRecommendations,
    isAuthor: isAuthor(open, user),
    problems: open && EDITABLE_STATUSES.includes(open.status) ? submitProblems(open, todayFor(actor.ws)) : [],
    questionnaireBlocked: open && EDITABLE_STATUSES.includes(open.status) ? questionnaire.blocked : null,
    questionnaireNotReturned: questionnaire.notReturned,
    exitPlans: await exitPlans().recommendationPanel(db, actor, assessment, open),
    exitPlanProblems: open && EDITABLE_STATUSES.includes(open.status) ? await exitPlans().gateProblems(db, actor.ws.id, assessment.id, open) : [],
    labels: OUTCOME_LABELS[assessment.type] || OUTCOME_LABELS.onboarding,
    eventLabels: { ...EVENT_LABELS, ...exitPlans().EVENT_LABELS },
  };
}

function snapshot(rec, conditions, type) {
  return {
    recommendation_id: Number(rec.id), version: rec.version, status: rec.status,
    outcome: rec.outcome, outcome_label: outcomeLabel(type, rec.outcome), residual_rating: rec.residual_rating,
    rationale: rec.rationale, valid_until: rec.valid_until,
    conditions: (conditions || []).map(c => ({ description: c.description, owner: c.owner, due_date: c.due_date,
      ...(c.finding_id ? { finding_id: Number(c.finding_id) } : {}),
      ...(c.automatic ? { automatic: true, service_id: Number(c.auto_service_id) } : {}) })),
  };
}

async function append(db, actor, assessment, action, before, after) {
  await events.appendEvent(db, {
    workspaceId: actor.ws.id, thirdPartyId: assessment.third_party_id, assessmentId: assessment.id,
    actorId: actor.user.id, action, before, after,
  });
}

function checkVersion(row, input) {
  const rowVersion = Number(input && input.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion !== row.row_version) throw conflict();
}

function requireOpenAssessment(assessment) {
  if (['completed', 'cancelled'].includes(assessment.status)) {
    throw new TprmError(409, `This assessment is ${assessment.status}, so its recommendation cannot change.`);
  }
}

const wrongStatus = rec => new TprmError(409,
  `This recommendation is "${STATUS_LABELS[rec.status] || rec.status}", so that step is not available. Reload the page to see where it is.`);

async function setAssessmentStatus(db, actor, assessment, status) {
  if (assessment.status === status) return;
  const res = await db.prepare(`UPDATE tp_assessments SET status = ?, updated_at = now(), row_version = row_version + 1
    WHERE workspace_id = ? AND id = ?`).run(status, actor.ws.id, assessment.id);
  if (res.changes !== 1) throw conflict();
}

async function nextVersion(db, workspaceId, assessmentId) {
  const row = await db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM tp_recommendations
    WHERE workspace_id = ? AND assessment_id = ?`).get(workspaceId, assessmentId);
  return Number(row.v);
}

async function insertConditions(db, workspaceId, recommendationId, conditions, start = 0) {
  let position = start;
  for (const c of conditions.filter(x => !x.automatic)) {
    position += 1;
    await db.prepare(`INSERT INTO tp_conditions (workspace_id, recommendation_id, position, description, owner, due_date, finding_id)
      VALUES (?, ?, ?, ?, ?, ?::date, ?)`).run(workspaceId, recommendationId, position, c.description, c.owner || null, c.due_date || null,
      c.finding_id ? Number(c.finding_id) : null);
  }
}

async function insertDraft(db, actor, assessment, content = {}) {
  const version = await nextVersion(db, actor.ws.id, assessment.id);
  const row = await db.prepare(`INSERT INTO tp_recommendations
    (workspace_id, assessment_id, version, status, outcome, residual_rating, rationale, valid_until, author_id)
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?::date, ?) RETURNING id`)
    .get(actor.ws.id, assessment.id, version, content.outcome || null, content.residual_rating || null,
      content.rationale || null, content.valid_until || null, actor.user.id);
  await insertConditions(db, actor.ws.id, row.id, content.conditions || []);
  return await getRecommendation(db, actor, assessment, row.id);
}

const alreadyOpen = () => new TprmError(409,
  'This assessment already has a recommendation that is not issued yet. Continue that one, or withdraw it first.');

async function createDraft(db, actor, thirdPartyId, assessmentId, input) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow drafting a recommendation.');
  try {
    return await db.transaction(async () => {
      const assessment = await assessmentOf(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
      checkVersion(assessment, input);
      requireOpenAssessment(assessment);
      if (assessment.status !== 'tier_confirmed') {
        if (assessment.status === INFORMATION_REQUESTED) {
          throw new TprmError(409, 'The client asked for more information: start a revised recommendation instead.');
        }
        if (RECOMMENDATION_STAGES.includes(assessment.status)) {
          throw assessment.status === ASSESSMENT_STAGES.issued
            ? new TprmError(409, 'A recommendation is already issued on this assessment. A new version is started when the client asks for more information.')
            : alreadyOpen();
        }
        throw new TprmError(409, 'The tier must be confirmed by a second person before a recommendation is drafted.');
      }
      const rec = await insertDraft(db, actor, assessment, { conditions: await require('./issues').agreedFixes(db, actor.ws.id, assessment.id) });
      await setAssessmentStatus(db, actor, assessment, ASSESSMENT_STAGES.draft);
      await append(db, actor, assessment, 'recommendation.drafted', { assessment_status: assessment.status },
        { recommendation_id: Number(rec.id), version: rec.version, status: 'draft', author_id: actor.user.id,
          assessment_status: ASSESSMENT_STAGES.draft });
      const synced = await exitPlans().syncRecommendation(db, actor, assessment, rec, 'recommendation_drafted');
      return synced.changed ? await getRecommendation(db, actor, assessment, rec.id) : rec;
    })();
  } catch (err) {
    if (isUniqueViolation(err)) throw alreadyOpen();
    throw err;
  }
}

function parseDraft(input) {
  const errors = [];
  const outcome = str(input.outcome) || null;
  if (outcome && !OUTCOMES.includes(outcome)) errors.push('Choose the recommendation from the list.');
  const residual = str(input.residual_rating) || null;
  if (residual && !RESIDUAL_RATINGS.includes(residual)) errors.push('Choose the residual risk rating from the list.');
  const rationale = str(input.rationale) || null;
  if (rationale && rationale.length > LIMITS.rationale) errors.push(`The rationale must be ${LIMITS.rationale} characters or fewer.`);
  const validUntil = str(input.valid_until) || null;
  if (validUntil && !placement.isYmd(validUntil)) errors.push('"Valid until" must be a date written YYYY-MM-DD.');

  const raw = input.conditions;
  const entries = Array.isArray(raw) ? raw.map((v, i) => [i, v])
    : raw && typeof raw === 'object' ? Object.entries(raw).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]) : [];
  const conditions = [];
  for (const [, c] of entries) {
    if (!c || typeof c !== 'object' || str(c.remove)) continue;
    const description = str(c.description);
    const owner = str(c.owner) || null;
    const dueDate = str(c.due_date) || null;
    const findingRaw = str(c.finding_id);
    if (!description && !owner && !dueDate) continue;
    const n = conditions.length + 1;
    if (!description) { errors.push(`Condition ${n}: describe the condition, or tick "Remove".`); continue; }
    if (description.length > LIMITS.condition) errors.push(`Condition ${n}: the description must be ${LIMITS.condition} characters or fewer.`);
    if (owner && !CONDITION_OWNERS.includes(owner)) errors.push(`Condition ${n}: choose the owner from the list.`);
    if (dueDate && !placement.isYmd(dueDate)) errors.push(`Condition ${n}: the due date must be a date written YYYY-MM-DD.`);
    const findingId = findingRaw ? Number(findingRaw) : null;
    if (findingRaw && (!Number.isSafeInteger(findingId) || findingId < 1)) errors.push(`Condition ${n}: choose the finding it addresses from the list.`);
    conditions.push({ description, owner, due_date: dueDate, finding_id: findingId && findingId > 0 ? findingId : null });
  }
  if (conditions.length > LIMITS.conditions) errors.push(`A recommendation can carry at most ${LIMITS.conditions} conditions.`);
  const autoDue = new Map();
  const autoRaw = input.auto_conditions;
  if (autoRaw && typeof autoRaw === 'object' && !Array.isArray(autoRaw)) {
    for (const [k, v] of Object.entries(autoRaw)) {
      const id = /^c\d+$/.test(k) ? Number(k.slice(1)) : NaN;
      if (!Number.isSafeInteger(id) || id < 1 || !v || typeof v !== 'object') continue;
      const due = str(v.due_date) || null;
      if (due && !placement.isYmd(due)) { errors.push('An automatic condition\'s due date must be a date written YYYY-MM-DD.'); continue; }
      autoDue.set(id, due);
    }
  }
  if (errors.length) throw invalid(errors);
  return { outcome, residual_rating: residual, rationale, valid_until: validUntil, conditions, autoDue };
}

const CONTENT_FIELDS = ['outcome', 'residual_rating', 'rationale', 'valid_until'];
const manualOf = list => (list || []).filter(c => !c.automatic);
const conditionKey = c => [c.description, c.owner || null, c.due_date || null, c.finding_id ? Number(c.finding_id) : null];
const sameConditions = (a, b) => JSON.stringify(manualOf(a).map(conditionKey)) === JSON.stringify(manualOf(b).map(conditionKey));

async function loadForAuthor(db, actor, thirdPartyId, assessmentId, recommendationId, input, verb) {
  requirePermission(actor, 'tp.manage', `Your role does not allow you to ${verb} a recommendation.`);
  const assessment = await assessmentOf(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
  const rec = await getRecommendation(db, actor, assessment, recommendationId, { forUpdate: true });
  checkVersion(rec, input);
  requireOpenAssessment(assessment);
  if (!isAuthor(rec, actor.user)) {
    throw new TprmError(403, `Only the author of this recommendation can ${verb} it.`);
  }
  return { assessment, rec };
}

async function saveDraft(db, actor, thirdPartyId, assessmentId, recommendationId, input) {
  const values = parseDraft(input || {});
  return await db.transaction(async () => {
    const { assessment, rec } = await loadForAuthor(db, actor, thirdPartyId, assessmentId, recommendationId, input, 'edit');
    if (!EDITABLE_STATUSES.includes(rec.status)) throw wrongStatus(rec);
    if (values.outcome === 'approve' && await exitPlans().approveBarred(db, actor.ws.id, rec)) {
      throw invalid([exitPlans().OVERRIDE_KEEPS_CONDITIONS]);
    }
    const before = {};
    const after = {};
    for (const f of CONTENT_FIELDS) {
      if ((rec[f] ?? null) !== (values[f] ?? null)) { before[f] = rec[f] ?? null; after[f] = values[f] ?? null; }
    }
    const cited = [...new Set(values.conditions.map(c => c.finding_id).filter(Boolean))];
    if (cited.length) {
      const known = new Set((await db.prepare(`SELECT f.id FROM tp_findings f WHERE f.workspace_id = ? AND f.assessment_id = ?`)
        .all(actor.ws.id, assessment.id)).map(r => Number(r.id)));
      const bad = values.conditions.map((c, i) => (c.finding_id && !known.has(c.finding_id) ? i + 1 : null)).filter(Boolean);
      if (bad.length) throw invalid(bad.map(n => `Condition ${n}: choose the finding it addresses from this assessment's findings.`));
    }
    const conditionsChanged = !sameConditions(rec.conditions, values.conditions);
    if (conditionsChanged) {
      before.conditions = snapshot(rec, manualOf(rec.conditions), assessment.type).conditions;
      after.conditions = values.conditions;
    }
    const autoChanges = rec.conditions.filter(c => c.automatic && values.autoDue.has(Number(c.id))
      && (values.autoDue.get(Number(c.id)) || null) !== (c.due_date || null));
    if (autoChanges.length) {
      before.automatic_due_dates = autoChanges.map(c => ({ condition_id: Number(c.id), due_date: c.due_date || null }));
      after.automatic_due_dates = autoChanges.map(c => ({ condition_id: Number(c.id), due_date: values.autoDue.get(Number(c.id)) || null }));
    }
    let current = rec;
    if (Object.keys(after).length) {
      const res = await db.prepare(`UPDATE tp_recommendations SET outcome = ?, residual_rating = ?, rationale = ?,
          valid_until = ?::date, updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ? AND row_version = ?`)
        .run(values.outcome, values.residual_rating, values.rationale, values.valid_until, actor.ws.id, rec.id, rec.row_version);
      if (res.changes !== 1) throw conflict();
      for (const c of autoChanges) {
        await db.prepare('UPDATE tp_conditions SET due_date = ?::date, updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?')
          .run(values.autoDue.get(Number(c.id)) || null, actor.ws.id, c.id);
      }
      if (conditionsChanged) {
        await db.prepare('DELETE FROM tp_conditions WHERE workspace_id = ? AND recommendation_id = ? AND NOT automatic').run(actor.ws.id, rec.id);
        const autoMax = rec.conditions.filter(c => c.automatic).reduce((m, c) => Math.max(m, Number(c.position) || 0), 0);
        await insertConditions(db, actor.ws.id, rec.id, values.conditions, autoMax);
      }
      await append(db, actor, assessment, 'recommendation.saved',
        { recommendation_id: Number(rec.id), version: rec.version, ...before },
        { recommendation_id: Number(rec.id), version: rec.version, ...after });
      current = await getRecommendation(db, actor, assessment, rec.id, { forUpdate: true });
    }
    const synced = await exitPlans().syncRecommendation(db, actor, assessment, current, 'recommendation_saved');
    if (!Object.keys(after).length && !synced.changed) return { recommendation: rec, unchanged: true };
    return { recommendation: await getRecommendation(db, actor, assessment, rec.id), synced };
  })();
}

async function submit(db, actor, thirdPartyId, assessmentId, recommendationId, input) {
  return await db.transaction(async () => {
    const { assessment, rec } = await loadForAuthor(db, actor, thirdPartyId, assessmentId, recommendationId, input, 'submit');
    if (!EDITABLE_STATUSES.includes(rec.status)) throw wrongStatus(rec);
    const synced = await exitPlans().syncRecommendation(db, actor, assessment, rec, 'recommendation_submitted');
    if (synced.changed) {
      throw new TprmError(409, 'The automatic exit plan conditions of this draft are out of date. Save the draft, check the conditions, then submit it.');
    }
    const problems = submitProblems(rec, todayFor(actor.ws));
    const exitProblems = await exitPlans().gateProblems(db, actor.ws.id, assessment.id, rec);
    if (problems.length || exitProblems.length) throw invalid([...problems, ...exitProblems]);
    const gate = await require('./questionnaires').recommendationGate(db, actor.ws.id, assessment.id);
    if (gate.blocked) throw new TprmError(409, gate.blocked);
    const res = await db.prepare(`UPDATE tp_recommendations SET status = 'in_review', submitted_at = now(),
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(actor.ws.id, rec.id, rec.row_version);
    if (res.changes !== 1) throw conflict();
    await setAssessmentStatus(db, actor, assessment, ASSESSMENT_STAGES.in_review);
    await append(db, actor, assessment, 'recommendation.submitted', { status: rec.status },
      { ...snapshot({ ...rec, status: 'in_review' }, rec.conditions, assessment.type), assessment_status: ASSESSMENT_STAGES.in_review });
    return await getRecommendation(db, actor, assessment, rec.id);
  })();
}

async function loadForReview(db, actor, thirdPartyId, assessmentId, recommendationId, verb) {
  requirePermission(actor, 'tp.review', `Only a senior consultant or a manager can ${verb} a recommendation.`);
  const assessment = await assessmentOf(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
  const rec = await getRecommendation(db, actor, assessment, recommendationId, { forUpdate: true });
  return { assessment, rec };
}

function refuseAuthor(rec, actor, verb) {
  if (isAuthor(rec, actor.user)) {
    throw new TprmError(403, `You wrote this recommendation, so a second person must ${verb} it.`);
  }
}

async function issue(db, actor, thirdPartyId, assessmentId, recommendationId, input) {
  const comment = str(input && input.comment) || null;
  if (comment && comment.length > LIMITS.comment) throw invalid([`The comment must be ${LIMITS.comment} characters or fewer.`]);
  return await db.transaction(async () => {
    const { assessment, rec } = await loadForReview(db, actor, thirdPartyId, assessmentId, recommendationId, 'issue');
    if (rec.status === 'issued' && Number(rec.reviewer_id) === Number(actor.user.id)
        && Number(input && input.row_version) === rec.row_version - 1) {
      return { recommendation: await getRecommendation(db, actor, assessment, rec.id), alreadyIssued: true };
    }
    checkVersion(rec, input);
    requireOpenAssessment(assessment);
    const setting = (await twoPerson.settingsFor(db, actor.ws.firm_id)).selfIssueRecommendations;
    let selfIssue = null;
    if (isAuthor(rec, actor.user)) {
      if (!access.isManager(actor.user)) refuseAuthor(rec, actor, 'issue');
      if (!setting) {
        throw new TprmError(403, 'You wrote this recommendation, so a second person must issue it: your firm does not let managers issue their own recommendations.');
      }
      selfIssue = twoPerson.selfReason(input && input.self_issue_reason, 'self-issue');
    }
    if (rec.status !== 'in_review') throw wrongStatus(rec);
    const problems = submitProblems(rec, todayFor(actor.ws));
    if (problems.length) throw new TprmError(409, `This recommendation cannot be issued: ${problems.join(' ')} Request changes instead.`);
    const exitProblems = await exitPlans().gateProblems(db, actor.ws.id, assessment.id, rec);
    if (exitProblems.length) {
      throw new TprmError(409, `This recommendation cannot be issued: ${exitProblems[0].replace(/ Save the draft again so it is added\.$/, '')} Request changes so the author can update it.`);
    }

    if (!assessment.client_decision_owner_id) {
      const ownerRaw = str(input && input.client_decision_owner_id);
      const ownerId = ownerRaw ? Number(ownerRaw) : null;
      if (!ownerId) {
        throw invalid(['Name the client decision owner before issuing: the client user who records the client\'s decision.']);
      }
      const candidates = await assessments.decisionOwnerCandidates(db, actor.ws.id);
      if (!Number.isSafeInteger(ownerId) || !candidates.some(c => Number(c.id) === ownerId)) {
        throw invalid(['The client decision owner must be a client owner or ISMS manager of this client.']);
      }
      const named = await db.prepare(`UPDATE tp_assessments SET client_decision_owner_id = ?, updated_at = now(),
          row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND client_decision_owner_id IS NULL`)
        .run(ownerId, actor.ws.id, assessment.id);
      if (named.changes !== 1) throw conflict();
      await append(db, actor, assessment, 'assessment.details_updated', { client_decision_owner_id: null },
        { client_decision_owner_id: ownerId, named_at: 'issue' });
      assessment.client_decision_owner_id = ownerId;
    }
    const issuedFindings = await db.prepare(`SELECT id FROM tp_findings WHERE workspace_id = ? AND assessment_id = ? ORDER BY id`)
      .all(actor.ws.id, assessment.id);

    const previous = await db.prepare(`SELECT id, version FROM tp_recommendations
      WHERE workspace_id = ? AND assessment_id = ? AND status = 'issued' FOR UPDATE`).get(actor.ws.id, assessment.id);
    if (previous) {
      await db.prepare(`UPDATE tp_recommendations SET status = 'withdrawn', withdrawn_at = now(), superseded_by_id = ?,
          updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
        .run(rec.id, actor.ws.id, previous.id);
    }
    const res = await db.prepare(`UPDATE tp_recommendations SET status = 'issued', reviewer_id = ?, reviewed_at = now(),
        review_comment = ?, self_issue_reason = ?, issued_at = now(), updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.user.id, comment, selfIssue, actor.ws.id, rec.id, rec.row_version);
    if (res.changes !== 1) throw conflict();
    await setAssessmentStatus(db, actor, assessment, ASSESSMENT_STAGES.issued);
    const reportSnapshot = await require('./report').takeSnapshot(db, actor.ws, rec.id, { actorId: actor.user.id, afterIssue: false });
    await append(db, actor, assessment, 'recommendation.issued', { status: 'in_review' }, {
      ...snapshot({ ...rec, status: 'issued' }, rec.conditions, assessment.type),
      author_id: Number(rec.author_id), reviewer_id: actor.user.id, comment,
      self_issued: !!selfIssue, self_issue_reason: selfIssue, setting: { managers_self_issue_recommendations: setting },
      findings: { count: issuedFindings.length, ids: issuedFindings.map(f => Number(f.id)) },
      client_decision_owner_id: Number(assessment.client_decision_owner_id),
      supersedes: previous ? { recommendation_id: Number(previous.id), version: previous.version } : null,
      assessment_status: ASSESSMENT_STAGES.issued,
      report_snapshot: reportSnapshot ? { id: Number(reportSnapshot.id), sha256: reportSnapshot.content_sha256 } : null,
    });
    if (previous) {
      await append(db, actor, assessment, 'recommendation.superseded',
        { recommendation_id: Number(previous.id), version: previous.version, status: 'issued' },
        { recommendation_id: Number(previous.id), version: previous.version, status: 'withdrawn',
          superseded_by: { recommendation_id: Number(rec.id), version: rec.version } });
    }
    return { recommendation: await getRecommendation(db, actor, assessment, rec.id), alreadyIssued: false };
  })();
}

async function requestChanges(db, actor, thirdPartyId, assessmentId, recommendationId, input) {
  const comment = str(input && input.comment);
  return await db.transaction(async () => {
    const { assessment, rec } = await loadForReview(db, actor, thirdPartyId, assessmentId, recommendationId, 'review');
    checkVersion(rec, input);
    requireOpenAssessment(assessment);
    refuseAuthor(rec, actor, 'review');
    if (rec.status !== 'in_review') throw wrongStatus(rec);
    if (!comment) throw invalid(['Say what needs to change before the recommendation can be issued.']);
    if (comment.length > LIMITS.comment) throw invalid([`The comment must be ${LIMITS.comment} characters or fewer.`]);
    const res = await db.prepare(`UPDATE tp_recommendations SET status = 'changes_requested', reviewer_id = ?, reviewed_at = now(),
        review_comment = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.user.id, comment, actor.ws.id, rec.id, rec.row_version);
    if (res.changes !== 1) throw conflict();
    await setAssessmentStatus(db, actor, assessment, ASSESSMENT_STAGES.draft);
    await append(db, actor, assessment, 'recommendation.changes_requested',
      { recommendation_id: Number(rec.id), version: rec.version, status: 'in_review' },
      { recommendation_id: Number(rec.id), version: rec.version, status: 'changes_requested', comment,
        assessment_status: ASSESSMENT_STAGES.draft });
    return await getRecommendation(db, actor, assessment, rec.id);
  })();
}

async function withdraw(db, actor, thirdPartyId, assessmentId, recommendationId, input) {
  const reason = str(input && input.reason);
  return await db.transaction(async () => {
    const { assessment, rec } = await loadForAuthor(db, actor, thirdPartyId, assessmentId, recommendationId, input, 'withdraw');
    if (!OPEN_STATUSES.includes(rec.status)) throw wrongStatus(rec);
    if (!reason) throw invalid(['Give a reason for withdrawing the recommendation.']);
    if (reason.length > LIMITS.reason) throw invalid([`The reason must be ${LIMITS.reason} characters or fewer.`]);
    const res = await db.prepare(`UPDATE tp_recommendations SET status = 'withdrawn', withdrawn_by = ?, withdrawn_at = now(),
        withdraw_reason = ?, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(actor.user.id, reason, actor.ws.id, rec.id, rec.row_version);
    if (res.changes !== 1) throw conflict();
    const issued = await db.prepare(`SELECT r.id, EXISTS (SELECT 1 FROM tp_client_decisions d
        WHERE d.workspace_id = r.workspace_id AND d.recommendation_id = r.id) AS decided
      FROM tp_recommendations r WHERE r.workspace_id = ? AND r.assessment_id = ? AND r.status = 'issued'`)
      .get(actor.ws.id, assessment.id);
    const stage = issued ? (issued.decided ? INFORMATION_REQUESTED : ASSESSMENT_STAGES.issued) : 'tier_confirmed';
    await setAssessmentStatus(db, actor, assessment, stage);
    await append(db, actor, assessment, 'recommendation.withdrawn',
      { recommendation_id: Number(rec.id), version: rec.version, status: rec.status },
      { recommendation_id: Number(rec.id), version: rec.version, status: 'withdrawn', reason, assessment_status: stage });
    return await getRecommendation(db, actor, assessment, rec.id);
  })();
}

async function recall(db, actor, thirdPartyId, assessmentId, recommendationId, input) {
  return await db.transaction(async () => {
    const { assessment, rec } = await loadForAuthor(db, actor, thirdPartyId, assessmentId, recommendationId, input, 'recall');
    if (rec.status !== 'in_review') throw wrongStatus(rec);
    const res = await db.prepare(`UPDATE tp_recommendations SET status = 'draft', submitted_at = NULL,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(actor.ws.id, rec.id, rec.row_version);
    if (res.changes !== 1) throw conflict();
    await setAssessmentStatus(db, actor, assessment, ASSESSMENT_STAGES.draft);
    await append(db, actor, assessment, 'recommendation.recalled',
      { recommendation_id: Number(rec.id), version: rec.version, status: 'in_review', submitted_at: rec.submitted_at },
      { recommendation_id: Number(rec.id), version: rec.version, status: 'draft', assessment_status: ASSESSMENT_STAGES.draft });
    return await getRecommendation(db, actor, assessment, rec.id);
  })();
}

async function authorCandidates(lookup, ws) {
  const users = await lookup.db.prepare(`SELECT id, name, email, user_type, firm_id, firm_role FROM users
    WHERE user_type = 'firm' AND firm_id = ? AND active = 1 ORDER BY lower(COALESCE(name, email)), id`).all(ws.firm_id);
  const out = [];
  for (const u of users) {
    if (await access.loadFirmWorkspace(lookup, u, ws.id, { permission: 'tp.manage' })) out.push(u);
  }
  return out;
}

async function reassign(db, actor, thirdPartyId, assessmentId, recommendationId, input, { lookup } = {}) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow handing a recommendation to another consultant.');
  if (!access.isManager(actor.user)) {
    throw new TprmError(403, 'Only a manager can hand a recommendation to another consultant.');
  }
  if (!lookup) throw new TypeError('reassign needs lookup ({ db, getWorkspace, permissionsFor })');
  const raw = str(input && input.author_id);
  const newAuthorId = raw ? Number(raw) : null;
  if (!newAuthorId || !Number.isSafeInteger(newAuthorId) || newAuthorId < 1) {
    throw invalid(['Choose the consultant who takes over the recommendation.']);
  }
  const reason = str(input && input.reason) || null;
  if (reason && reason.length > LIMITS.reason) throw invalid([`The reason must be ${LIMITS.reason} characters or fewer.`]);
  return await db.transaction(async () => {
    const assessment = await assessmentOf(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
    const rec = await getRecommendation(db, actor, assessment, recommendationId, { forUpdate: true });
    checkVersion(rec, input);
    requireOpenAssessment(assessment);
    if (!OPEN_STATUSES.includes(rec.status)) throw wrongStatus(rec);
    if (Number(rec.author_id) === newAuthorId) throw invalid(['That consultant is already the author of this recommendation.']);
    const target = await db.prepare(`SELECT id, name, email, user_type, firm_id, firm_role FROM users
      WHERE id = ? AND user_type = 'firm' AND active = 1`).get(newAuthorId);
    if (!target || !(await access.loadFirmWorkspace(lookup, target, actor.ws.id, { permission: 'tp.manage' }))) {
      throw invalid(['The new author must be a consultant who can work on this client\'s third-party risk (tp.manage).']);
    }
    const resetReview = rec.reviewer_id != null && Number(rec.reviewer_id) === newAuthorId;
    const status = resetReview && rec.status === 'changes_requested' ? 'draft' : rec.status;
    const res = await db.prepare(`UPDATE tp_recommendations SET author_id = ?, status = ?,
        reviewer_id = CASE WHEN ?::boolean THEN NULL ELSE reviewer_id END,
        reviewed_at = CASE WHEN ?::boolean THEN NULL ELSE reviewed_at END,
        review_comment = CASE WHEN ?::boolean THEN NULL ELSE review_comment END,
        updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ? AND row_version = ?`)
      .run(newAuthorId, status, resetReview, resetReview, resetReview, actor.ws.id, rec.id, rec.row_version);
    if (res.changes !== 1) throw conflict();
    await append(db, actor, assessment, 'recommendation.reassigned',
      { recommendation_id: Number(rec.id), version: rec.version, status: rec.status, author_id: Number(rec.author_id),
        ...(resetReview ? { reviewer_id: Number(rec.reviewer_id), reviewed_at: rec.reviewed_at, review_comment: rec.review_comment } : {}) },
      { recommendation_id: Number(rec.id), version: rec.version, status, author_id: newAuthorId, reason,
        ...(resetReview ? { review_reset: true } : {}) });
    return await getRecommendation(db, actor, assessment, rec.id);
  })();
}

async function startNewVersion(db, actor, thirdPartyId, assessmentId, input) {
  requirePermission(actor, 'tp.manage', 'Your role does not allow starting a new recommendation version.');
  const reason = str(input && input.reason);
  if (!reason) throw invalid(['Say why a new version of the recommendation is needed.']);
  if (reason.length > LIMITS.reason) throw invalid([`The reason must be ${LIMITS.reason} characters or fewer.`]);
  try {
    return await db.transaction(async () => {
      const assessment = await assessmentOf(db, actor, thirdPartyId, assessmentId, { forUpdate: true });
      requireOpenAssessment(assessment);
      if (!NEW_VERSION_FROM.includes(assessment.status)) {
        throw new TprmError(409, 'A new version is started only after a recommendation has been issued and no other version is in progress.');
      }
      const issuedRow = await db.prepare(`SELECT id FROM tp_recommendations WHERE workspace_id = ? AND assessment_id = ? AND status = 'issued'`)
        .get(actor.ws.id, assessment.id);
      if (!issuedRow) throw new TprmError(409, 'This assessment has no issued recommendation to start a new version from.');
      const from = await getRecommendation(db, actor, assessment, issuedRow.id);
      const rec = await insertDraft(db, actor, assessment, {
        outcome: from.outcome, residual_rating: from.residual_rating, rationale: from.rationale, valid_until: from.valid_until,
        conditions: from.conditions.filter(c => !c.automatic),
      });
      await setAssessmentStatus(db, actor, assessment, ASSESSMENT_STAGES.draft);
      await append(db, actor, assessment, 'recommendation.new_version_started',
        { recommendation_id: Number(from.id), version: from.version, status: 'issued' },
        { recommendation_id: Number(rec.id), version: rec.version, status: 'draft', author_id: actor.user.id, reason,
          copied_from_version: from.version, assessment_status: ASSESSMENT_STAGES.draft });
      const synced = await exitPlans().syncRecommendation(db, actor, assessment, rec, 'new_version_started');
      return synced.changed ? await getRecommendation(db, actor, assessment, rec.id) : rec;
    })();
  } catch (err) {
    if (isUniqueViolation(err)) throw alreadyOpen();
    throw err;
  }
}

async function reviewQueue(deps, user, { readOnly = false } = {}) {
  const permission = readOnly ? 'tp.manage' : 'tp.review';
  if (!access.isFirmUser(user) || !access.firmCan(user, permission)) return [];
  const { enabled } = await access.listFirmClients(deps, user);
  const reviewable = [];
  for (const c of enabled) {
    const loaded = await access.loadFirmWorkspace(deps, user, c.id, { permission });
    if (loaded) reviewable.push({ id: Number(c.id), name: c.name });
  }
  if (!reviewable.length) return [];
  const ownAllowed = !readOnly && access.isManager(user) && (await twoPerson.settingsFor(deps.db, user.firm_id)).selfIssueRecommendations;
  const names = new Map(reviewable.map(c => [c.id, c.name]));
  const ids = reviewable.map(c => c.id);
  const rows = await deps.db.prepare(`SELECT r.id, r.workspace_id, r.assessment_id, r.version, r.outcome, r.residual_rating,
      r.author_id, r.submitted_at, a.third_party_id, a.type, a.final_tier, a.due_date::text AS due_date,
      t.name AS third_party_name, au.name AS author_name
    FROM tp_recommendations r
    JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    LEFT JOIN users au ON au.id = r.author_id
    WHERE r.status = 'in_review' AND a.status = 'recommendation_in_review'
      AND r.workspace_id IN (${ids.map(() => '?').join(',')})
      AND (?::boolean OR r.author_id <> ?::bigint)
    ORDER BY r.submitted_at ASC, r.id`).all(...ids, readOnly || ownAllowed, user.id);
  return rows.map(r => ({ ...r, client_name: names.get(Number(r.workspace_id)), outcome_label: outcomeLabel(r.type, r.outcome),
    own: Number(r.author_id) === Number(user.id) }));
}

async function draftRecord(db, workspaceId, recommendationId) {
  return await db.prepare("SELECT id, row_version FROM tp_recommendations WHERE workspace_id = ? AND id = ? AND status = 'draft'")
    .get(Number(workspaceId), Number(recommendationId)) || null;
}

module.exports = {
  STATUSES, OPEN_STATUSES, EDITABLE_STATUSES, STATUS_LABELS, OUTCOMES, OUTCOME_LABELS, WITH_CONDITIONS,
  RESIDUAL_RATINGS, RESIDUAL_LABELS, CONDITION_OWNERS, CONDITION_OWNER_LABELS, LIMITS, ASSESSMENT_STAGES,
  RECOMMENDATION_STAGES, INFORMATION_REQUESTED, NEW_VERSION_FROM, EVENT_LABELS,
  outcomeLabel, submitProblems, getRecommendation, listForAssessment, pageData,
  createDraft, saveDraft, submit, issue, requestChanges, withdraw, recall, authorCandidates, reassign, startNewVersion,
  reviewQueue, draftRecord,
};
