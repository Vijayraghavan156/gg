-- Third-party risk (TPRM) v2: product decisions after slice 6 (21 Nov 2026).
-- See docs/tprm-v2-spec.md section 2a, items 9-15. Migrations 083-097 are
-- applied and frozen; everything here replaces their objects by name.
--
-- 1. Evidence and findings freeze once the recommendation is submitted for
--    review: while the assessment is recommendation_in_review,
--    recommendation_issued, information_requested (until a revised version is
--    started) or completed, no file is added or deleted and no finding (or its
--    links to files) is added, changed or removed. Releasing a file to the
--    client stays allowed while frozen, and is refused on a cancelled
--    assessment. Mirrors lib/tprm/assessments.FROZEN_STATUSES. Like the other
--    TPRM guards, a delete passes once the workspace row itself is gone (a
--    direct workspace delete cascades), and lib/workspace-deletion.js
--    suspends the guard when it purges a client.
-- 2. A manager hands a recommendation that is not issued (draft, changes
--    requested, in review) to another consultant: author_id may now change
--    while the row is in one of those statuses, never once issued or
--    withdrawn. The maker-checker CHECK (reviewer <> author) still holds; when
--    the reviewer becomes the author the review is reset, so changes_requested
--    may now become draft.
-- 3. The author recalls an in-review recommendation to draft before any
--    review action: in_review may now become draft.
-- 4. An assessment is not cancelled once a recommendation has been issued on
--    it, and is cancelled only after its unissued recommendation is withdrawn
--    (the domain withdraws it in the same transaction, reason "Assessment
--    cancelled").
-- 5. "Valid until" is required at submit and issue only for approve and
--    approve_with_conditions; a reject (Do not onboard / Exit) may leave it
--    blank.

-- ---- 5. valid until optional for reject ------------------------------------

ALTER TABLE tp_recommendations DROP CONSTRAINT IF EXISTS tp_recommendations_complete;
ALTER TABLE tp_recommendations ADD CONSTRAINT tp_recommendations_complete CHECK (
  (status NOT IN ('in_review', 'issued') AND issued_at IS NULL)
  OR (outcome IS NOT NULL AND residual_rating IS NOT NULL AND length(btrim(COALESCE(rationale, ''))) > 0
      AND (valid_until IS NOT NULL OR outcome = 'reject') AND submitted_at IS NOT NULL));

-- ---- 2 and 3. the recommendation trigger -----------------------------------
-- 097's function, with: author_id changeable before issue (item 2), and
-- in_review -> draft (recall, item 3) and changes_requested -> draft (review
-- reset on a hand-over, item 2) added to the transitions. Everything else is
-- unchanged.
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
  IF ROW(NEW.workspace_id, NEW.assessment_id, NEW.version, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.workspace_id, OLD.assessment_id, OLD.version, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_recommendations: the assessment and version of a recommendation never change';
  END IF;
  IF NEW.author_id IS DISTINCT FROM OLD.author_id
     AND (OLD.status NOT IN ('draft', 'changes_requested', 'in_review')
          OR NEW.status NOT IN ('draft', 'changes_requested', 'in_review')) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_recommendations: the author changes only before issue (' || OLD.status || ' rejected)';
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
    OR (OLD.status = 'changes_requested' AND NEW.status IN ('in_review', 'withdrawn', 'draft'))
    OR (OLD.status = 'in_review' AND NEW.status IN ('issued', 'changes_requested', 'withdrawn', 'draft'))) THEN
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

-- ---- 1. evidence and findings freeze ----------------------------------------

-- The assessment's status, or NULL when it (or its workspace) is gone.
CREATE OR REPLACE FUNCTION tp_assessment_status_of(p_workspace_id bigint, p_assessment_id bigint) RETURNS text
LANGUAGE sql STABLE
AS $fn$
  SELECT status FROM tp_assessments WHERE workspace_id = p_workspace_id AND id = p_assessment_id
$fn$;

CREATE OR REPLACE FUNCTION tp_evidence_findings_freeze_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  ws bigint;
  aid bigint;
  st text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    ws := OLD.workspace_id; aid := OLD.assessment_id;
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ws) THEN
      RETURN OLD;
    END IF;
  ELSE
    ws := NEW.workspace_id; aid := NEW.assessment_id;
  END IF;
  st := tp_assessment_status_of(ws, aid);
  IF TG_TABLE_NAME = 'tp_evidence' AND TG_OP = 'UPDATE' THEN
    -- Releasing a file to the client is the one change a frozen assessment
    -- allows; a cancelled assessment allows none.
    IF st = 'cancelled' AND NEW.released_to_client AND NOT OLD.released_to_client THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_evidence: files of a cancelled assessment are not released to the client';
    END IF;
    RETURN NEW;
  END IF;
  IF st IN ('recommendation_in_review', 'recommendation_issued', 'information_requested', 'completed', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = TG_TABLE_NAME || ': evidence and findings are frozen while the assessment is ' || st
        || ' (' || lower(TG_OP) || ' rejected)';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tp_evidence_freeze ON tp_evidence;
CREATE TRIGGER tp_evidence_freeze BEFORE INSERT OR UPDATE OR DELETE ON tp_evidence
  FOR EACH ROW EXECUTE FUNCTION tp_evidence_findings_freeze_fn();
DROP TRIGGER IF EXISTS tp_findings_freeze ON tp_findings;
CREATE TRIGGER tp_findings_freeze BEFORE INSERT OR UPDATE OR DELETE ON tp_findings
  FOR EACH ROW EXECUTE FUNCTION tp_evidence_findings_freeze_fn();
DROP TRIGGER IF EXISTS tp_finding_evidence_freeze ON tp_finding_evidence;
CREATE TRIGGER tp_finding_evidence_freeze BEFORE INSERT OR UPDATE OR DELETE ON tp_finding_evidence
  FOR EACH ROW EXECUTE FUNCTION tp_evidence_findings_freeze_fn();

-- ---- 4. cancelling an assessment -------------------------------------------

CREATE OR REPLACE FUNCTION tp_assessments_cancel_guard_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    IF EXISTS (SELECT 1 FROM tp_recommendations r
        WHERE r.workspace_id = NEW.workspace_id AND r.assessment_id = NEW.id AND r.issued_at IS NOT NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assessments: an assessment whose recommendation has been issued cannot be cancelled';
    END IF;
    IF EXISTS (SELECT 1 FROM tp_recommendations r
        WHERE r.workspace_id = NEW.workspace_id AND r.assessment_id = NEW.id
          AND r.status IN ('draft', 'in_review', 'changes_requested')) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assessments: withdraw the recommendation that is not issued yet before cancelling the assessment';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_assessments_cancel_guard ON tp_assessments;
CREATE TRIGGER tp_assessments_cancel_guard BEFORE UPDATE OF status ON tp_assessments
  FOR EACH ROW EXECUTE FUNCTION tp_assessments_cancel_guard_fn();
