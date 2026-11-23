-- Third-party risk (TPRM) v2, Phase 4 follow-up: the AI review sends files as
-- files, a TPRM-specific model with refusal fallbacks, a rerun limit and
-- suggested reviewer conclusions (docs/tprm-v2-spec.md section 4d, section 2a
-- items 23-26). Migrations 083-103 are applied and frozen; this one adds
-- columns and constraints, adds one trigger and replaces one function of 103
-- (tp_ai_suggestions_guard_fn, so a suggested conclusion can be accepted).
--
-- tp_ai_reviews, new columns (none holds the vendor's text or file contents):
--   served_model        the model that actually answered (the provider's
--                       response "model"; differs from model when a refusal
--                       fallback served the request).
--   retry_input_sha256  sha256 of the exact second request body, when the
--                       model returned no tool call and the run asked once
--                       more with a reminder. Set once, after input_sha256.
--   refusal_category    the provider's refusal category only (a short code,
--                       e.g. "cyber"), on a run that failed on a refusal.
--   override_reason     a manager's reason for running past the limit of 3
--                       runs per assessment in 24 hours. Manual runs only;
--                       never changes.
--   conclusions         the validated suggested conclusions of a succeeded
--                       run (a JSON array, one per answer at most).
-- The limit: a run is queued only while fewer than 3 runs of the assessment
-- (automatic ones included, "not set up" records excluded: nothing was sent)
-- were created in the last 24 hours, unless it carries override_reason (the
-- app lets only a firm manager give one).
--
-- tp_ai_suggestions: kind conclusion is now produced. A conclusion suggestion
-- is about one answer (answer_id set), carries conclusion (satisfactory,
-- partially_satisfactory or unsatisfactory) and no severity, and is accepted
-- or rejected only (never edited and accepted, never a finding). Accepting it
-- records the same conclusion on the answer in the same transaction
-- (lib/tprm/questionnaire-review.js setConclusion); the guard checks it.

ALTER TABLE tp_ai_reviews ADD COLUMN IF NOT EXISTS served_model text;
ALTER TABLE tp_ai_reviews ADD COLUMN IF NOT EXISTS retry_input_sha256 text;
ALTER TABLE tp_ai_reviews ADD COLUMN IF NOT EXISTS refusal_category text;
ALTER TABLE tp_ai_reviews ADD COLUMN IF NOT EXISTS override_reason text;
ALTER TABLE tp_ai_reviews ADD COLUMN IF NOT EXISTS conclusions jsonb;

ALTER TABLE tp_ai_reviews DROP CONSTRAINT IF EXISTS tp_ai_reviews_served_model;
ALTER TABLE tp_ai_reviews ADD CONSTRAINT tp_ai_reviews_served_model CHECK (
  served_model IS NULL OR (length(served_model) BETWEEN 1 AND 200 AND status IN ('succeeded', 'failed')));
ALTER TABLE tp_ai_reviews DROP CONSTRAINT IF EXISTS tp_ai_reviews_retry_hash;
ALTER TABLE tp_ai_reviews ADD CONSTRAINT tp_ai_reviews_retry_hash CHECK (
  retry_input_sha256 IS NULL OR (retry_input_sha256 ~ '^[0-9a-f]{64}$' AND input_sha256 IS NOT NULL));
ALTER TABLE tp_ai_reviews DROP CONSTRAINT IF EXISTS tp_ai_reviews_refusal_category;
ALTER TABLE tp_ai_reviews ADD CONSTRAINT tp_ai_reviews_refusal_category CHECK (
  refusal_category IS NULL OR (refusal_category ~ '^[a-z][a-z0-9_]{0,39}$' AND status = 'failed'));
ALTER TABLE tp_ai_reviews DROP CONSTRAINT IF EXISTS tp_ai_reviews_override_reason;
ALTER TABLE tp_ai_reviews ADD CONSTRAINT tp_ai_reviews_override_reason CHECK (
  override_reason IS NULL OR (length(btrim(override_reason)) BETWEEN 1 AND 1000 AND run_trigger = 'manual'));
ALTER TABLE tp_ai_reviews DROP CONSTRAINT IF EXISTS tp_ai_reviews_conclusions;
ALTER TABLE tp_ai_reviews ADD CONSTRAINT tp_ai_reviews_conclusions CHECK (
  conclusions IS NULL OR (status = 'succeeded' AND jsonb_typeof(conclusions) = 'array' AND jsonb_array_length(conclusions) <= 500));

-- The rerun limit, and the new columns' write-once rules. 103's guard
-- (tp_ai_reviews_guard, which fires first) still holds the stages.
CREATE OR REPLACE FUNCTION tp_ai_reviews_limit_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  recent integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'queued' AND NEW.override_reason IS NULL THEN
      SELECT COUNT(*) INTO recent FROM tp_ai_reviews
       WHERE workspace_id = NEW.workspace_id AND assessment_id = NEW.assessment_id
         AND status <> 'not_configured' AND created_at > now() - interval '24 hours';
      IF recent >= 3 THEN
        RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
          MESSAGE = 'tp_ai_reviews: at most 3 runs per assessment in 24 hours, unless a manager gives a reason';
      END IF;
    END IF;
    IF NEW.served_model IS NOT NULL OR NEW.retry_input_sha256 IS NOT NULL OR NEW.refusal_category IS NOT NULL OR NEW.conclusions IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_ai_reviews: what a run sent and got back is recorded by the run';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.override_reason IS DISTINCT FROM OLD.override_reason THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_ai_reviews: the reason for running past the limit cannot change';
  END IF;
  IF OLD.retry_input_sha256 IS NOT NULL AND NEW.retry_input_sha256 IS DISTINCT FROM OLD.retry_input_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_ai_reviews: the retry hash is set once';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_ai_reviews_limit ON tp_ai_reviews;
CREATE TRIGGER tp_ai_reviews_limit BEFORE INSERT OR UPDATE ON tp_ai_reviews
  FOR EACH ROW EXECUTE FUNCTION tp_ai_reviews_limit_fn();

ALTER TABLE tp_ai_suggestions ADD COLUMN IF NOT EXISTS conclusion text;
ALTER TABLE tp_ai_suggestions ALTER COLUMN severity DROP NOT NULL;
ALTER TABLE tp_ai_suggestions DROP CONSTRAINT IF EXISTS tp_ai_suggestions_kind_shape;
ALTER TABLE tp_ai_suggestions ADD CONSTRAINT tp_ai_suggestions_kind_shape CHECK (
  (kind = 'finding' AND severity IS NOT NULL AND conclusion IS NULL)
  OR (kind = 'conclusion' AND severity IS NULL AND answer_id IS NOT NULL
      AND conclusion IN ('satisfactory', 'partially_satisfactory', 'unsatisfactory')
      AND status IN ('pending', 'accepted', 'rejected') AND finding_id IS NULL));

-- Replaces 103's guard: the conclusion is part of what the AI wrote (never
-- changes), and an accepted conclusion is the answer's reviewer conclusion
-- instead of a finding. Everything else as in 103.
CREATE OR REPLACE FUNCTION tp_ai_suggestions_guard_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  r_status text;
  f_source text;
  a_conclusion text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_ai_suggestions: an AI suggestion is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO r_status FROM tp_ai_reviews WHERE workspace_id = NEW.workspace_id AND id = NEW.review_id;
    IF r_status IS DISTINCT FROM 'running' OR NEW.status <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_ai_suggestions: suggestions are written, pending, by the run that produced them';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.workspace_id, NEW.assessment_id, NEW.review_id, NEW.answer_id, NEW.question_id, NEW.kind, NEW.control_ref,
         NEW.severity, NEW.title, NEW.description, NEW.rationale, NEW.conclusion, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.assessment_id, OLD.review_id, OLD.answer_id, OLD.question_id, OLD.kind,
         OLD.control_ref, OLD.severity, OLD.title, OLD.description, OLD.rationale, OLD.conclusion, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_ai_suggestions: what the AI suggested cannot change';
  END IF;
  -- The finding created on acceptance was removed later (ON DELETE SET NULL).
  IF OLD.status IN ('accepted', 'edited_accepted') AND NEW.finding_id IS NULL AND OLD.finding_id IS NOT NULL
     AND ROW(NEW.status, NEW.decided_by, NEW.decided_at, NEW.reject_reason)
         IS NOT DISTINCT FROM ROW(OLD.status, OLD.decided_by, OLD.decided_at, OLD.reject_reason) THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_ai_suggestions: a decision on a suggestion is final';
  END IF;
  IF NEW.status IN ('accepted', 'edited_accepted') AND NEW.kind = 'finding' THEN
    SELECT source INTO f_source FROM tp_findings
     WHERE workspace_id = NEW.workspace_id AND assessment_id = NEW.assessment_id AND id = NEW.finding_id;
    IF f_source IS DISTINCT FROM 'ai_accepted' THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_ai_suggestions: an accepted suggestion records the ai_accepted finding it created';
    END IF;
  END IF;
  IF NEW.status = 'accepted' AND NEW.kind = 'conclusion' THEN
    SELECT review_conclusion INTO a_conclusion FROM tp_answers
     WHERE workspace_id = NEW.workspace_id AND assessment_id = NEW.assessment_id AND id = NEW.answer_id;
    IF a_conclusion IS DISTINCT FROM NEW.conclusion THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_ai_suggestions: an accepted conclusion is the answer''s reviewer conclusion';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
