-- Third-party risk (TPRM) v2, Phase 2 slice 6: the client's decision.
-- See docs/tprm-v2-spec.md sections 1, 3, 4 and 6.
--
-- tp_client_decisions: the client decision owner's decision on one issued
-- recommendation version. outcome is approve / approve_with_conditions /
-- reject (labels by assessment type, as for the recommendation) or
-- request_more_information. diverges is computed in the domain layer
-- (lib/tprm/decisions.diverges): the outcome differs from the recommendation's
-- outcome; request_more_information never diverges. The insert trigger below
-- refuses a row whose diverges disagrees with that rule, so a decision cannot
-- be stored as "not diverging" to skip the risk acceptance. A diverging
-- decision carries a rationale and a risk-acceptance expiry (CHECK).
--
-- Rules held here as well as in the domain layer:
--   - one decision per recommendation version (unique), on the live issued
--     version only, while the assessment is at recommendation_issued;
--   - decided_by is the assessment's named client decision owner, a client
--     user of this workspace with the client owner or ISMS manager role:
--     firm users, managers included, can never record a client decision;
--   - insert-only: no update, delete or truncate, except with the whole
--     workspace (the guard lets a delete through once the workspace row is
--     gone; lib/workspace-deletion.js suspends guards generically).
--
-- The recommendation the decision is on belongs to the decision's assessment:
-- the composite key (workspace_id, assessment_id, recommendation_id) refers to
-- tp_recommendations, which gains that unique key here.
--
-- tp_assessments gains information_requested (the client asked for more
-- information; the firm starts a revised recommendation version from there)
-- in its named status CHECK and in the "recommendation stages need a
-- confirmed tier" CHECK; the recommendation insert trigger (096) accepts a new
-- version from it. completed is now reached: a positive decision or a reject.
--
-- decided_by carries no foreign key, as elsewhere in TPRM: the record
-- outlives the user.

ALTER TABLE tp_assessments DROP CONSTRAINT IF EXISTS tp_assessments_status_check;
ALTER TABLE tp_assessments ADD CONSTRAINT tp_assessments_status_check
  CHECK (status IN ('scoping', 'tier_proposed', 'tier_confirmed',
    'recommendation_draft', 'recommendation_in_review', 'recommendation_issued', 'information_requested',
    'completed', 'cancelled'));
ALTER TABLE tp_assessments DROP CONSTRAINT IF EXISTS tp_assessments_recommendation_after_tier;
ALTER TABLE tp_assessments ADD CONSTRAINT tp_assessments_recommendation_after_tier
  CHECK (status NOT IN ('recommendation_draft', 'recommendation_in_review', 'recommendation_issued', 'information_requested')
    OR (final_tier IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL));

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_recommendations_ws_assessment_id_key') THEN
    ALTER TABLE tp_recommendations ADD CONSTRAINT tp_recommendations_ws_assessment_id_key UNIQUE (workspace_id, assessment_id, id);
  END IF;
END
$do$;

-- 096's recommendation trigger, with information_requested accepted for a
-- new version's insert. Everything else is unchanged.
CREATE OR REPLACE FUNCTION tp_recommendations_check_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  a record;
  n_conditions integer;
  n_incomplete integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, confirmed_at INTO a FROM tp_assessments
     WHERE workspace_id = NEW.workspace_id AND id = NEW.assessment_id;
    IF NOT FOUND OR a.confirmed_at IS NULL
       OR a.status NOT IN ('tier_confirmed', 'recommendation_draft', 'recommendation_in_review', 'recommendation_issued',
                           'information_requested') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: a recommendation needs an open assessment with a confirmed tier';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: a recommendation starts as a draft';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE.
  IF OLD.status = 'withdrawn' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_recommendations: a withdrawn recommendation cannot be changed';
  END IF;
  IF ROW(NEW.workspace_id, NEW.assessment_id, NEW.version, NEW.author_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.workspace_id, OLD.assessment_id, OLD.version, OLD.author_id, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_recommendations: the assessment, version and author of a recommendation never change';
  END IF;
  IF OLD.status NOT IN ('draft', 'changes_requested')
     AND ROW(NEW.outcome, NEW.residual_rating, NEW.rationale, NEW.valid_until)
         IS DISTINCT FROM ROW(OLD.outcome, OLD.residual_rating, OLD.rationale, OLD.valid_until) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_recommendations: only a draft can be edited (' || OLD.status || ' rejected)';
  END IF;
  IF OLD.status = 'issued' THEN
    IF NEW.status <> 'withdrawn' OR NEW.superseded_by_id IS NULL
       OR ROW(NEW.submitted_at, NEW.reviewer_id, NEW.reviewed_at, NEW.review_comment, NEW.issued_at, NEW.withdrawn_by, NEW.withdraw_reason)
          IS DISTINCT FROM ROW(OLD.submitted_at, OLD.reviewer_id, OLD.reviewed_at, OLD.review_comment, OLD.issued_at, NULL::bigint, NULL::text) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: an issued recommendation is immutable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM tp_recommendations r
       WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.superseded_by_id
         AND r.assessment_id = NEW.assessment_id AND r.version > NEW.version) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: an issued recommendation is only superseded by a later version of the same assessment';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('in_review', 'withdrawn'))
    OR (OLD.status = 'changes_requested' AND NEW.status IN ('in_review', 'withdrawn'))
    OR (OLD.status = 'in_review' AND NEW.status IN ('issued', 'changes_requested', 'withdrawn'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_recommendations: ' || OLD.status || ' cannot become ' || NEW.status;
  END IF;

  IF NEW.status = 'issued' THEN
    SELECT count(*), count(*) FILTER (WHERE owner IS NULL OR due_date IS NULL)
      INTO n_conditions, n_incomplete
      FROM tp_conditions WHERE workspace_id = NEW.workspace_id AND recommendation_id = NEW.id;
    IF NEW.outcome = 'approve_with_conditions' AND n_conditions = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: approve_with_conditions needs at least one condition';
    END IF;
    IF NEW.outcome <> 'approve_with_conditions' AND n_conditions > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: only approve_with_conditions carries conditions';
    END IF;
    IF n_incomplete > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: every condition needs an owner and a due date at issue';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TABLE IF NOT EXISTS tp_client_decisions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id bigint NOT NULL,
  recommendation_id bigint NOT NULL,
  outcome text NOT NULL
    CHECK (outcome IN ('approve', 'approve_with_conditions', 'reject', 'request_more_information')),
  rationale text CHECK (length(rationale) <= 10000),
  diverges boolean NOT NULL,
  risk_acceptance_until date,
  decided_by bigint NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tp_client_decisions_workspace_id_id_key UNIQUE (workspace_id, id),
  -- One decision per recommendation version.
  CONSTRAINT tp_client_decisions_one_per_version UNIQUE (workspace_id, recommendation_id),
  CONSTRAINT tp_client_decisions_assessment_fk FOREIGN KEY (workspace_id, assessment_id)
    REFERENCES tp_assessments (workspace_id, id),
  CONSTRAINT tp_client_decisions_recommendation_fk FOREIGN KEY (workspace_id, assessment_id, recommendation_id)
    REFERENCES tp_recommendations (workspace_id, assessment_id, id),
  CONSTRAINT tp_client_decisions_more_information_never_diverges CHECK (
    outcome <> 'request_more_information' OR NOT diverges),
  CONSTRAINT tp_client_decisions_divergence_accepted CHECK (
    NOT diverges OR (length(btrim(COALESCE(rationale, ''))) > 0 AND risk_acceptance_until IS NOT NULL)),
  CONSTRAINT tp_client_decisions_risk_acceptance_only_when_diverging CHECK (
    diverges OR risk_acceptance_until IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_tp_client_decisions_assessment ON tp_client_decisions (workspace_id, assessment_id, decided_at);

-- Who may decide, on what, and that diverges follows the rule.
CREATE OR REPLACE FUNCTION tp_client_decisions_insert_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  a record;
  r record;
BEGIN
  SELECT status, client_decision_owner_id INTO a FROM tp_assessments
   WHERE workspace_id = NEW.workspace_id AND id = NEW.assessment_id FOR UPDATE;
  IF NOT FOUND OR a.status <> 'recommendation_issued' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_client_decisions: a decision is recorded only while the assessment waits for it (recommendation issued)';
  END IF;
  SELECT status, outcome INTO r FROM tp_recommendations
   WHERE workspace_id = NEW.workspace_id AND assessment_id = NEW.assessment_id AND id = NEW.recommendation_id;
  IF NOT FOUND OR r.status <> 'issued' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_client_decisions: a decision is recorded on the live issued recommendation only';
  END IF;
  IF a.client_decision_owner_id IS NULL OR NEW.decided_by IS DISTINCT FROM a.client_decision_owner_id THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_client_decisions: only the assessment''s named client decision owner records the decision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u JOIN workspace_members m ON m.user_id = u.id
     WHERE u.id = NEW.decided_by AND u.user_type = 'client' AND u.active = 1
       AND m.workspace_id = NEW.workspace_id
       AND m.role IN ('client_owner', 'client_admin', 'isms_manager')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_client_decisions: the decision is recorded by a client owner or ISMS manager of this client, never a firm user';
  END IF;
  -- Mirrors lib/tprm/decisions.diverges (the definition).
  IF NEW.diverges IS DISTINCT FROM (NEW.outcome <> 'request_more_information' AND NEW.outcome <> r.outcome) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_client_decisions: diverges must say whether the outcome differs from the recommendation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_client_decisions_insert ON tp_client_decisions;
CREATE TRIGGER tp_client_decisions_insert BEFORE INSERT ON tp_client_decisions
  FOR EACH ROW EXECUTE FUNCTION tp_client_decisions_insert_fn();

CREATE OR REPLACE FUNCTION tp_client_decisions_immutable_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
    MESSAGE = 'tp_client_decisions are insert-only (' || lower(TG_OP) || ' rejected)';
END;
$fn$;
DROP TRIGGER IF EXISTS tp_client_decisions_immutable ON tp_client_decisions;
CREATE TRIGGER tp_client_decisions_immutable BEFORE UPDATE OR DELETE ON tp_client_decisions
  FOR EACH ROW EXECUTE FUNCTION tp_client_decisions_immutable_fn();
DROP TRIGGER IF EXISTS tp_client_decisions_no_truncate ON tp_client_decisions;
CREATE TRIGGER tp_client_decisions_no_truncate BEFORE TRUNCATE ON tp_client_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION tp_client_decisions_immutable_fn();
