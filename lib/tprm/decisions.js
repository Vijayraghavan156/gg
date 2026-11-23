'use strict';

const access = require('./access');
const events = require('./events');
const placement = require('./placement');
const clientSettings = require('./client-settings');
const tpSettings = require('./settings');
const { TprmError } = require('./errors');
const { isUniqueViolation } = require('../pg');
const { todayFor } = require('../dates');

const MORE_INFORMATION = 'request_more_information';
const OUTCOMES = Object.freeze(['approve', 'approve_with_conditions', 'reject', MORE_INFORMATION]);
const POSITIVE = Object.freeze(['approve', 'approve_with_conditions']);
const FINAL = Object.freeze(['approve', 'approve_with_conditions', 'reject']);
const OUTCOME_LABELS = Object.freeze({
  onboarding: Object.freeze({
    approve: 'Onboard', approve_with_conditions: 'Onboard with conditions', reject: 'Do not onboard',
    request_more_information: 'Need more information',
  }),
  reassessment: Object.freeze({
    approve: 'Continue', approve_with_conditions: 'Continue with conditions', reject: 'Exit',
    request_more_information: 'Need more information',
  }),
});
const LIMITS = Object.freeze({ rationale: 10000 });

const INFORMATION_REQUESTED = 'information_requested';

const EVENT_LABELS = Object.freeze({
  'client_decision.recorded': 'Client decision recorded',
  'third_party.client_decision': 'Client decision recorded',
});

function outcomeLabel(type, outcome) {
  const labels = OUTCOME_LABELS[type] || OUTCOME_LABELS.onboarding;
  return outcome ? labels[outcome] || outcome : null;
}

function diverges(decisionOutcome, recommendationOutcome) {
  if (!OUTCOMES.includes(decisionOutcome)) throw new TypeError(`Not a client decision outcome: ${decisionOutcome}`);
  if (decisionOutcome === MORE_INFORMATION) return false;
  return decisionOutcome !== recommendationOutcome;
}

const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const invalid = errors => new TprmError(400, errors.join(' '), { errors });

function validate(input, { recommendation, today }) {
  const errors = [];
  const outcome = str(input && input.outcome);
  const rationale = str(input && input.rationale) || null;
  const until = str(input && input.risk_acceptance_until) || null;
  if (!OUTCOMES.includes(outcome)) {
    errors.push('Choose your decision.');
    return { values: null, errors };
  }
  const divergent = diverges(outcome, recommendation.outcome);
  if (rationale && rationale.length > LIMITS.rationale) errors.push(`The rationale must be ${LIMITS.rationale} characters or fewer.`);
  if (outcome === MORE_INFORMATION && !rationale) errors.push('Say what more information you need.');
  if (divergent) {
    if (!rationale) errors.push('Your decision differs from the recommendation: give your rationale.');
    if (!until) errors.push('Your decision differs from the recommendation: set the date your risk acceptance expires.');
    else if (!placement.isYmd(until)) errors.push('The risk acceptance expiry must be a date written YYYY-MM-DD.');
    else if (today && until <= today) errors.push('The risk acceptance expiry must be a date after today.');
  }
  if (POSITIVE.includes(outcome) && today && recommendation.valid_until && recommendation.valid_until < today) {
    errors.push(`This recommendation was valid until ${require('./format').day(recommendation.valid_until)}, so it can no longer be approved. Choose "Need more information" to ask for a revised one.`);
  }
  return {
    values: { outcome, rationale, diverges: divergent, risk_acceptance_until: divergent ? until : null },
    errors,
  };
}

const labels = require('./labels');
const APPROVAL_LABELS = labels.APPROVAL;
const PENDING_LABELS = labels.PENDING;

function approvalState({ thirdParty, finalDecision = null, openAssessment = null, today }) {
  let state;
  let until = null;
  if (thirdParty && thirdParty.status === 'exited') {
    state = 'exited';
  } else if (finalDecision && POSITIVE.includes(finalDecision.outcome)) {
    until = finalDecision.valid_until || null;
    if (finalDecision.diverges && finalDecision.risk_acceptance_until
        && (!until || finalDecision.risk_acceptance_until < until)) until = finalDecision.risk_acceptance_until;
    state = until && today <= until ? 'approved' : 'expired';
  } else if (finalDecision && finalDecision.outcome === 'reject') {
    state = 'not_approved';
  } else {
    state = thirdParty && thirdParty.status === 'in_use' ? 'not_yet_assessed' : 'awaiting_approval';
  }
  let pending = null;
  if (openAssessment) {
    pending = openAssessment.status === 'recommendation_issued' ? 'decision_needed'
      : openAssessment.status === INFORMATION_REQUESTED ? 'information_requested' : 'in_progress';
  }
  const label = labels.approval(state, until);
  return { state, approved: state === 'approved', until, label, tone: labels.approvalTone(state),
    pending, pendingLabel: pending ? labels.pending(pending) : null, pendingTone: pending ? labels.pendingTone(pending) : null };
}

const wsIdOf = ws => Number(ws && typeof ws === 'object' ? ws.id : ws);

async function approvals(db, ws, ids = null, { today = null } = {}) {
  const workspaceId = wsIdOf(ws);
  const day = today || todayFor(typeof ws === 'object' ? ws : { id: workspaceId });
  const list = ids == null ? null : [...new Set(ids.map(Number))].filter(Number.isSafeInteger);
  if (list && !list.length) return new Map();
  const inList = col => (list ? ` AND ${col} IN (${list.map(() => '?').join(',')})` : '');
  const args = list || [];
  const parties = await db.prepare(`SELECT t.id, t.status FROM tp_third_parties t WHERE t.workspace_id = ?${inList('t.id')}`)
    .all(workspaceId, ...args);
  const finals = await db.prepare(`SELECT DISTINCT ON (a.third_party_id) a.third_party_id, a.type, d.id, d.assessment_id,
      d.recommendation_id, d.outcome, d.diverges, d.risk_acceptance_until::text AS risk_acceptance_until, d.decided_at,
      r.version, r.valid_until::text AS valid_until
    FROM tp_client_decisions d
    JOIN tp_assessments a ON a.workspace_id = d.workspace_id AND a.id = d.assessment_id
    JOIN tp_recommendations r ON r.workspace_id = d.workspace_id AND r.id = d.recommendation_id
    WHERE d.workspace_id = ? AND d.outcome <> 'request_more_information'${inList('a.third_party_id')}
    ORDER BY a.third_party_id, d.decided_at DESC, d.id DESC`).all(workspaceId, ...args);
  const open = await db.prepare(`SELECT a.id, a.third_party_id, a.status, a.type FROM tp_assessments a
    WHERE a.workspace_id = ? AND a.status NOT IN ('completed', 'cancelled')${inList('a.third_party_id')}`).all(workspaceId, ...args);
  const finalBy = new Map(finals.map(f => [Number(f.third_party_id), f]));
  const openBy = new Map(open.map(o => [Number(o.third_party_id), o]));
  const out = new Map();
  for (const t of parties) {
    const id = Number(t.id);
    const finalDecision = finalBy.get(id) || null;
    const state = approvalState({ thirdParty: t, finalDecision, openAssessment: openBy.get(id) || null, today: day });
    out.set(id, { ...state, decision: finalDecision, openAssessment: openBy.get(id) || null });
  }
  await require('./conditions').attachStates(db, workspaceId, out, day);
  return out;
}

async function currentApproval(db, ws, thirdPartyId, { today = null } = {}) {
  const id = Number(thirdPartyId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return (await approvals(db, ws, [id], { today })).get(id) || null;
}

const DECISION_COLUMNS = `d.id, d.workspace_id, d.assessment_id, d.recommendation_id, d.outcome, d.rationale, d.diverges,
  d.risk_acceptance_until::text AS risk_acceptance_until, d.decided_by, d.decided_at`;

async function listForAssessment(db, workspaceId, assessmentId) {
  return await db.prepare(`SELECT ${DECISION_COLUMNS}, r.version, r.outcome AS recommended_outcome,
      r.valid_until::text AS valid_until, u.name AS decided_by_name
    FROM tp_client_decisions d
    JOIN tp_recommendations r ON r.workspace_id = d.workspace_id AND r.id = d.recommendation_id
    LEFT JOIN users u ON u.id = d.decided_by
    WHERE d.workspace_id = ? AND d.assessment_id = ? ORDER BY d.decided_at DESC, d.id DESC`).all(workspaceId, assessmentId);
}

async function firmPanel(db, actor, assessment) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, 'tp.view')) throw new TprmError(403, 'Your role does not allow this.');
  const list = await listForAssessment(db, actor.ws.id, assessment.id);
  const latest = list[0] || null;
  return {
    decisions: list,
    informationRequest: assessment.status === INFORMATION_REQUESTED && latest && latest.outcome === MORE_INFORMATION ? latest : null,
    canStartRevision: assessment.status === INFORMATION_REQUESTED && access.can(actor.user, actor.perms, 'tp.manage'),
    approval: await currentApproval(db, actor.ws, assessment.third_party_id),
    labels: OUTCOME_LABELS[assessment.type] || OUTCOME_LABELS.onboarding,
    conditions: await require('./conditions').firmPanel(db, actor, assessment),
  };
}

async function informationRequestQueue(deps, user) {
  if (!access.isFirmUser(user) || !access.firmCan(user, 'tp.review')) return [];
  const { enabled } = await access.listFirmClients(deps, user);
  const reachable = [];
  for (const c of enabled) {
    const loaded = await access.loadFirmWorkspace(deps, user, c.id, { permission: 'tp.review' });
    if (loaded) reachable.push({ id: Number(c.id), name: c.name });
  }
  if (!reachable.length) return [];
  const names = new Map(reachable.map(c => [c.id, c.name]));
  const rows = await deps.db.prepare(`SELECT DISTINCT ON (a.id) a.id AS assessment_id, a.workspace_id, a.third_party_id, a.type,
      a.due_date::text AS due_date, t.name AS third_party_name, d.rationale, d.decided_at, r.version, u.name AS decided_by_name
    FROM tp_assessments a
    JOIN tp_third_parties t ON t.workspace_id = a.workspace_id AND t.id = a.third_party_id
    JOIN tp_client_decisions d ON d.workspace_id = a.workspace_id AND d.assessment_id = a.id AND d.outcome = 'request_more_information'
    JOIN tp_recommendations r ON r.workspace_id = d.workspace_id AND r.id = d.recommendation_id
    LEFT JOIN users u ON u.id = d.decided_by
    WHERE a.status = 'information_requested' AND a.workspace_id IN (${reachable.map(() => '?').join(',')})
    ORDER BY a.id, d.decided_at DESC`).all(...reachable.map(c => c.id));
  return rows.sort((x, y) => new Date(x.decided_at) - new Date(y.decided_at))
    .map(r => ({ ...r, client_name: names.get(Number(r.workspace_id)) }));
}

const notFound = () => new TprmError(404, 'This recommendation does not exist, or it is not available to your account.');
const FIRM_REFUSED = 'Firm users, managers included, cannot record a client decision. Only the client decision owner named on the assessment records it, in the client portal.';

async function recordDecision(db, actor, recommendationId, input = {}) {
  if (!actor || !actor.ws || !actor.user) throw new TprmError(403, FIRM_REFUSED);
  if (!access.isClientUser(actor.user)) throw new TprmError(403, FIRM_REFUSED);
  if (!access.can(actor.user, actor.perms, 'tp.client_decide')) {
    throw new TprmError(403, 'Only the client decision owner named on the assessment can record this decision.');
  }
  if (!(await tpSettings.isEnabled(db, actor.ws.id))) throw notFound();
  const rid = Number(recommendationId);
  if (!Number.isSafeInteger(rid) || rid < 1) throw notFound();
  const today = todayFor(actor.ws);
  try {
    return await db.transaction(async () => {
      const head = await db.prepare(`SELECT r.assessment_id, a.third_party_id FROM tp_recommendations r
        JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
        WHERE r.workspace_id = ? AND r.id = ? AND r.issued_at IS NOT NULL`).get(actor.ws.id, rid);
      if (!head) throw notFound();
      const tp = await db.prepare(`SELECT id, status, current_tier, tier_source, last_assessment_date::text AS last_assessment_date,
          next_due_date::text AS next_due_date, row_version FROM tp_third_parties WHERE workspace_id = ? AND id = ? FOR UPDATE`)
        .get(actor.ws.id, head.third_party_id);
      const assessment = await db.prepare(`SELECT id, third_party_id, type, status, final_tier, client_decision_owner_id, row_version
        FROM tp_assessments WHERE workspace_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, head.assessment_id);
      const rec = await db.prepare(`SELECT id, version, status, outcome, valid_until::text AS valid_until FROM tp_recommendations
        WHERE workspace_id = ? AND assessment_id = ? AND id = ? FOR UPDATE`).get(actor.ws.id, assessment.id, rid);
      if (!tp || !rec) throw notFound();
      if (Number(assessment.client_decision_owner_id) !== Number(actor.user.id)) {
        throw new TprmError(403, 'Only the client decision owner named on this assessment can record the decision.');
      }
      const existing = await db.prepare('SELECT id FROM tp_client_decisions WHERE workspace_id = ? AND recommendation_id = ?')
        .get(actor.ws.id, rec.id);
      if (existing) throw new TprmError(409, `A decision has already been recorded on version ${rec.version} of this recommendation.`);
      if (rec.status !== 'issued') {
        throw new TprmError(409, `Version ${rec.version} of this recommendation has been replaced by a later version. Open the latest one.`);
      }
      if (assessment.status !== 'recommendation_issued') {
        throw new TprmError(409, 'Your consultants are revising this recommendation, so no decision can be recorded on it now.');
      }
      const { values, errors } = validate(input, { recommendation: rec, today });
      if (errors.length) throw invalid(errors);

      const decision = await db.prepare(`INSERT INTO tp_client_decisions
        (workspace_id, assessment_id, recommendation_id, outcome, rationale, diverges, risk_acceptance_until, decided_by)
        VALUES (?, ?, ?, ?, ?, ?, ?::date, ?) RETURNING ${DECISION_COLUMNS.replace(/d\./g, '')}`)
        .get(actor.ws.id, assessment.id, rec.id, values.outcome, values.rationale, values.diverges,
          values.risk_acceptance_until, actor.user.id);

      const positive = POSITIVE.includes(values.outcome);
      const nextStatus = values.outcome === MORE_INFORMATION ? INFORMATION_REQUESTED : 'completed';
      const tpAfter = { status: tp.status, current_tier: tp.current_tier, tier_source: tp.tier_source,
        last_assessment_date: tp.last_assessment_date, next_due_date: tp.next_due_date };
      let interval = null;
      if (positive) {
        interval = (await clientSettings.intervals(db, actor.ws)).effective[assessment.final_tier];
        if (assessment.type === 'onboarding' && tp.status === 'proposed') tpAfter.status = 'in_use';
        tpAfter.current_tier = assessment.final_tier;
        tpAfter.tier_source = 'assessed';
        tpAfter.last_assessment_date = today;
        tpAfter.next_due_date = placement.addMonths(today, interval);
      } else if (values.outcome === 'reject' && assessment.type === 'reassessment') {
        tpAfter.status = 'exited';
        tpAfter.next_due_date = null;
      }
      const tpBefore = {};
      const tpChanged = {};
      for (const [k, v] of Object.entries(tpAfter)) {
        if ((tp[k] ?? null) !== (v ?? null)) { tpBefore[k] = tp[k] ?? null; tpChanged[k] = v ?? null; }
      }
      let revokedLinks = [];
      if (nextStatus === 'completed') {
        const questionnaires = require('./questionnaires');
        const questionnaire = await questionnaires.getQuestionnaire(db, actor, assessment, { forUpdate: true });
        if (questionnaire) {
          revokedLinks = await questionnaires.revokeActive(db, actor, assessment, questionnaire, questionnaires.REVOKE_REASONS.completed);
        }
      }
      const res = await db.prepare(`UPDATE tp_assessments SET status = ?, updated_at = now(), row_version = row_version + 1
        WHERE workspace_id = ? AND id = ? AND row_version = ?`).run(nextStatus, actor.ws.id, assessment.id, assessment.row_version);
      if (res.changes !== 1) throw new TprmError(409, 'This assessment changed while you were deciding. Reload the page and decide again.');
      if (Object.keys(tpChanged).length) {
        await db.prepare(`UPDATE tp_third_parties SET status = ?, current_tier = ?, tier_source = ?, last_assessment_date = ?::date,
            next_due_date = ?::date, updated_at = now(), row_version = row_version + 1 WHERE workspace_id = ? AND id = ?`)
          .run(tpAfter.status, tpAfter.current_tier, tpAfter.tier_source, tpAfter.last_assessment_date, tpAfter.next_due_date,
            actor.ws.id, tp.id);
      }
      const summary = {
        decision_id: Number(decision.id), recommendation_id: Number(rec.id), version: rec.version,
        outcome: values.outcome, outcome_label: outcomeLabel(assessment.type, values.outcome),
        recommended_outcome: rec.outcome, diverges: values.diverges, rationale: values.rationale,
        risk_acceptance_until: values.risk_acceptance_until, decided_by: Number(actor.user.id), decision_date: today,
      };
      await events.appendEvent(db, {
        workspaceId: actor.ws.id, thirdPartyId: tp.id, assessmentId: assessment.id, actorId: actor.user.id,
        action: 'client_decision.recorded', before: { assessment_status: assessment.status },
        after: { ...summary, assessment_status: nextStatus, ...(revokedLinks.length ? { revoked_request_ids: revokedLinks } : {}) },
      });
      await events.appendEvent(db, {
        workspaceId: actor.ws.id, thirdPartyId: tp.id, actorId: actor.user.id, action: 'third_party.client_decision',
        before: tpBefore,
        after: { ...tpChanged, assessment_id: Number(assessment.id), assessment_type: assessment.type, decision_id: Number(decision.id),
          outcome: values.outcome, outcome_label: summary.outcome_label, diverges: values.diverges,
          ...(interval ? { interval_months: interval, final_tier: assessment.final_tier } : {}) },
      });
      return { decision, assessmentStatus: nextStatus, thirdParty: { before: tpBefore, after: tpChanged } };
    })();
  } catch (err) {
    if (isUniqueViolation(err)) throw new TprmError(409, 'A decision has already been recorded on this version of the recommendation.');
    throw err;
  }
}

const isOwner = (user, assessment) => !!user && !!assessment
  && Number(assessment.client_decision_owner_id) === Number(user.id) && access.isClientUser(user);

async function portalOverview(db, ws) {
  const today = todayFor(ws);
  const rows = await db.prepare(`SELECT t.id, t.name, t.status, t.current_tier, t.tier_source, t.next_due_date::text AS next_due_date,
      t.last_assessment_date::text AS last_assessment_date
    FROM tp_third_parties t WHERE t.workspace_id = ? ORDER BY lower(t.name), t.id`).all(ws.id);
  const states = await approvals(db, ws, null, { today });
  const live = await db.prepare(`SELECT DISTINCT ON (a.third_party_id) a.third_party_id, r.id AS recommendation_id, r.version
    FROM tp_recommendations r JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
    WHERE r.workspace_id = ? AND r.status = 'issued' AND a.status <> 'cancelled'
    ORDER BY a.third_party_id, r.issued_at DESC, r.id DESC`).all(ws.id);
  const liveBy = new Map(live.map(r => [Number(r.third_party_id), r]));
  const list = rows.map(r => ({ ...r, approval: states.get(Number(r.id)), recommendation: liveBy.get(Number(r.id)) || null }));
  const rank = r => (r.approval.pending === 'decision_needed' ? 0 : r.status === 'exited' ? 2 : 1);
  return { today, rows: list.sort((a, b) => rank(a) - rank(b)), decisionsNeeded: list.filter(r => r.approval.pending === 'decision_needed').length };
}

async function portalRecommendation(db, ws, recommendationId, user = null) {
  const rid = Number(recommendationId);
  if (!Number.isSafeInteger(rid) || rid < 1) return null;
  const rec = await db.prepare(`SELECT r.id, r.assessment_id, r.version, r.status, r.outcome, r.residual_rating, r.rationale,
      r.valid_until::text AS valid_until, r.issued_at, r.superseded_by_id, s.version AS superseded_by_version
    FROM tp_recommendations r LEFT JOIN tp_recommendations s ON s.workspace_id = r.workspace_id AND s.id = r.superseded_by_id
    WHERE r.workspace_id = ? AND r.id = ? AND r.issued_at IS NOT NULL`).get(ws.id, rid);
  if (!rec) return null;
  const assessment = await db.prepare(`SELECT a.id, a.third_party_id, a.type, a.status, a.scored_tier, a.final_tier,
      a.tier_explanation, a.override_direction, a.override_reason, a.client_decision_owner_id, ou.name AS client_decision_owner_name
    FROM tp_assessments a LEFT JOIN users ou ON ou.id = a.client_decision_owner_id
    WHERE a.workspace_id = ? AND a.id = ?`).get(ws.id, rec.assessment_id);
  const thirdParty = await db.prepare(`SELECT t.id, t.name, t.status, t.current_tier, t.next_due_date::text AS next_due_date
    FROM tp_third_parties t WHERE t.workspace_id = ? AND t.id = ?`).get(ws.id, assessment.third_party_id);
  const conditions = await db.prepare(`SELECT c.position, c.description, c.owner, c.due_date::text AS due_date, c.status
    FROM tp_conditions c WHERE c.workspace_id = ? AND c.recommendation_id = ? ORDER BY c.position, c.id`).all(ws.id, rec.id);
  const findings = await db.prepare(`SELECT f.id, f.control_ref, f.severity, f.title, f.status, f.description, f.impact FROM tp_findings f
    WHERE f.workspace_id = ? AND f.assessment_id = ?
    ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, f.id`).all(ws.id, assessment.id);
  const evidence = await require('./evidence').listReleasedEvidence(db, ws, assessment.id);
  const decisions = await db.prepare(`SELECT d.id, d.recommendation_id, d.outcome, d.rationale, d.diverges,
      d.risk_acceptance_until::text AS risk_acceptance_until, d.decided_at, r.version, u.name AS decided_by_name
    FROM tp_client_decisions d
    JOIN tp_recommendations r ON r.workspace_id = d.workspace_id AND r.id = d.recommendation_id
    LEFT JOIN users u ON u.id = d.decided_by
    WHERE d.workspace_id = ? AND d.assessment_id = ? ORDER BY d.decided_at DESC, d.id DESC`).all(ws.id, assessment.id);
  const decision = decisions.find(d => Number(d.recommendation_id) === Number(rec.id)) || null;
  const otherVersions = await db.prepare(`SELECT r.id, r.version, r.status, r.outcome, r.issued_at FROM tp_recommendations r
    WHERE r.workspace_id = ? AND r.assessment_id = ? AND r.issued_at IS NOT NULL AND r.id <> ? ORDER BY r.version DESC`)
    .all(ws.id, assessment.id, rec.id);
  const waiting = rec.status === 'issued' && !decision && assessment.status === 'recommendation_issued';
  const notReturned = await db.prepare(`SELECT 1 FROM tp_questionnaires q
    WHERE q.workspace_id = ? AND q.assessment_id = ? AND q.not_returned`).get(ws.id, assessment.id);
  return {
    recommendation: { ...rec, conditions, outcome_label: outcomeLabel(assessment.type, rec.outcome) },
    assessment, thirdParty, findings, evidence, decision, decisions, otherVersions,
    questionnaireNotReturned: !!notReturned,
    approval: await currentApproval(db, ws, thirdParty.id),
    labels: OUTCOME_LABELS[assessment.type] || OUTCOME_LABELS.onboarding,
    waiting,
    ownerNamed: !!assessment.client_decision_owner_id,
    canDecide: waiting && isOwner(user, assessment),
    revising: rec.status === 'issued' && !decision && assessment.status !== 'recommendation_issued'
      && !['completed', 'cancelled'].includes(assessment.status),
    conditionTracking: await require('./conditions').portalTracking(db, ws, rec.id, user),
  };
}

async function portalEvidenceFile(db, ws, recommendationId, evidenceId) {
  const rid = Number(recommendationId);
  if (!Number.isSafeInteger(rid) || rid < 1) return null;
  const rec = await db.prepare(`SELECT r.assessment_id FROM tp_recommendations r
    WHERE r.workspace_id = ? AND r.id = ? AND r.issued_at IS NOT NULL`).get(ws.id, rid);
  if (!rec) return null;
  return await require('./evidence').releasedEvidenceFile(db, ws, rec.assessment_id, evidenceId);
}

module.exports = {
  MORE_INFORMATION, OUTCOMES, POSITIVE, FINAL, OUTCOME_LABELS, LIMITS, INFORMATION_REQUESTED, EVENT_LABELS,
  APPROVAL_LABELS, PENDING_LABELS,
  outcomeLabel, diverges, validate, approvalState, approvals, currentApproval,
  listForAssessment, firmPanel, informationRequestQueue, recordDecision, isOwner,
  portalOverview, portalRecommendation, portalEvidenceFile,
};
