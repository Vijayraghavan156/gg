-- Third-party risk (TPRM) v2: closing the questionnaire before the
-- recommendation, "not returned", and links on a completed assessment
-- (docs/tprm-v2-spec.md section 2a items 17 and 18, sections 4b and 4c).
-- Migrations 083-101 are applied and frozen; this one adds columns, a CHECK
-- and three triggers, and replaces no function of an earlier migration.
--
-- 1. tp_questionnaires.not_returned / not_returned_reason: the firm closed a
--    sent questionnaire the third party never submitted ("Close as not
--    returned", lib/tprm/questionnaires.closeNotReturned). Set once, with the
--    move from sent or in progress to closed (closed_reason 'Not returned by
--    the third party'), only once no link is active, and with a reason. The
--    existing guard (migration 100) already keeps a closed questionnaire
--    unchanged, so the flag and reason never change afterwards.
-- 2. An assessment moves into recommendation_in_review (the recommendation is
--    submitted for review) only when its questionnaire, if any, is a draft
--    (never sent) or closed: reviewed, not returned or, for a cancelled
--    assessment, closed with it. A sent questionnaire under way, submitted or
--    under review blocks the submission (lib/tprm/recommendations.submit says
--    why, 409).
-- 3. An assessment is completed (the client's decision) only once its links
--    are revoked, as migration 099 holds for a cancel: the decision revokes
--    an active link in its own transaction ("Assessment completed").
--
-- Every rule reads rows of the same workspace only. A whole-workspace delete
-- is unaffected (no DELETE triggers here).

ALTER TABLE tp_questionnaires ADD COLUMN IF NOT EXISTS not_returned boolean NOT NULL DEFAULT false;
ALTER TABLE tp_questionnaires ADD COLUMN IF NOT EXISTS not_returned_reason text;
ALTER TABLE tp_questionnaires DROP CONSTRAINT IF EXISTS tp_questionnaires_not_returned;
ALTER TABLE tp_questionnaires ADD CONSTRAINT tp_questionnaires_not_returned CHECK (
  (not_returned AND status = 'closed' AND submitted_at IS NULL
     AND length(btrim(COALESCE(not_returned_reason, ''))) BETWEEN 1 AND 1000)
  OR (NOT not_returned AND not_returned_reason IS NULL));

CREATE OR REPLACE FUNCTION tp_questionnaires_not_returned_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF ROW(NEW.not_returned, NEW.not_returned_reason) IS NOT DISTINCT FROM ROW(OLD.not_returned, OLD.not_returned_reason) THEN
    RETURN NEW;
  END IF;
  IF OLD.not_returned OR NOT NEW.not_returned THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: "not returned" is recorded once and never changes';
  END IF;
  IF OLD.status NOT IN ('sent', 'in_progress') OR NEW.status <> 'closed'
     OR NEW.closed_reason IS DISTINCT FROM 'Not returned by the third party' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: only a sent questionnaire the third party has not submitted is closed as not returned';
  END IF;
  IF EXISTS (SELECT 1 FROM tp_vendor_requests r
     WHERE r.workspace_id = NEW.workspace_id AND r.questionnaire_id = NEW.id AND r.status = 'active') THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: revoke the third party''s link before closing the questionnaire as not returned';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_questionnaires_not_returned ON tp_questionnaires;
CREATE TRIGGER tp_questionnaires_not_returned BEFORE UPDATE ON tp_questionnaires
  FOR EACH ROW EXECUTE FUNCTION tp_questionnaires_not_returned_fn();

-- A recommendation goes to review only with the questionnaire closed (or never sent).
CREATE OR REPLACE FUNCTION tp_assessments_review_questionnaire_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM tp_questionnaires q
     WHERE q.workspace_id = NEW.workspace_id AND q.assessment_id = NEW.id
       AND q.status IN ('sent', 'in_progress', 'submitted', 'under_review')) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_assessments: close the questionnaire review (or close the questionnaire as not returned) before the recommendation is submitted for review';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_assessments_review_questionnaire ON tp_assessments;
CREATE TRIGGER tp_assessments_review_questionnaire AFTER UPDATE OF status ON tp_assessments
  FOR EACH ROW WHEN (NEW.status = 'recommendation_in_review' AND OLD.status IS DISTINCT FROM 'recommendation_in_review')
  EXECUTE FUNCTION tp_assessments_review_questionnaire_fn();

-- An assessment is completed only once its links are revoked.
CREATE OR REPLACE FUNCTION tp_assessments_complete_links_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM tp_vendor_requests
     WHERE workspace_id = NEW.workspace_id AND assessment_id = NEW.id AND status = 'active') THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_assessments: revoke the third party''s questionnaire link before completing the assessment';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_assessments_complete_links ON tp_assessments;
CREATE TRIGGER tp_assessments_complete_links AFTER UPDATE OF status ON tp_assessments
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION tp_assessments_complete_links_fn();
