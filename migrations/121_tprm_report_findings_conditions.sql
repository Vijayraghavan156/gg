-- Third-party risk (TPRM), premium upgrade Phase 2: the recommendation report
-- (docs/tprm-v2-spec.md section 4o). Migrations 088-120 are applied and
-- frozen; this one adds two columns and replaces one function by name.
--
--   tp_findings.impact        "why it matters" to this client, printed in the
--                             report with the description (Vijay, 22 Nov 2026:
--                             finding descriptions are printed from now on).
--                             Optional, at most 2,000 characters.
--   tp_conditions.finding_id  the finding a condition addresses, or NULL.
--                             Keyed with the workspace (no cross-client link);
--                             the guard below also keeps it to a finding of
--                             the same assessment, and treats it as content:
--                             it changes only while the recommendation is a
--                             draft, like the description. Deleting a finding
--                             clears the link; the app refuses to delete a
--                             finding cited by a condition of a version past
--                             drafting.
--
-- tp_conditions_guard_fn replaces 105's: the same rules, plus finding_id in
-- the content and the same-assessment check, and a workspace delete's
-- cascade may clear the link (as 105 lets its deletes through).

ALTER TABLE tp_findings ADD COLUMN IF NOT EXISTS impact text;
ALTER TABLE tp_findings DROP CONSTRAINT IF EXISTS tp_findings_impact_length;
ALTER TABLE tp_findings ADD CONSTRAINT tp_findings_impact_length CHECK (impact IS NULL OR length(impact) BETWEEN 1 AND 2000);

ALTER TABLE tp_conditions ADD COLUMN IF NOT EXISTS finding_id bigint;
ALTER TABLE tp_conditions DROP CONSTRAINT IF EXISTS tp_conditions_finding_fk;
ALTER TABLE tp_conditions ADD CONSTRAINT tp_conditions_finding_fk FOREIGN KEY (workspace_id, finding_id)
  REFERENCES tp_findings (workspace_id, id) ON DELETE SET NULL (finding_id);
CREATE INDEX IF NOT EXISTS idx_tp_conditions_finding ON tp_conditions (workspace_id, finding_id) WHERE finding_id IS NOT NULL;

CREATE OR REPLACE FUNCTION tp_conditions_guard_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  ws bigint;
  rec_id bigint;
  rec_status text;
  content_changed boolean := true;
  tracking_changed boolean := false;
  latest record;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation', MESSAGE = 'tp_conditions: truncate rejected';
  END IF;
  IF TG_OP = 'DELETE' THEN
    ws := OLD.workspace_id; rec_id := OLD.recommendation_id;
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ws) THEN
      RETURN OLD;
    END IF;
  ELSE
    ws := NEW.workspace_id; rec_id := NEW.recommendation_id;
    IF TG_OP = 'UPDATE' AND (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.recommendation_id IS DISTINCT FROM OLD.recommendation_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_conditions: a condition never moves to another recommendation';
    END IF;
    -- 121: the cascade of a workspace delete clearing finding_id (the findings go first).
    IF TG_OP = 'UPDATE' AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ws) THEN
      RETURN NEW;
    END IF;
  END IF;
  -- 121: a condition addresses a finding of its own recommendation's assessment only.
  IF TG_OP <> 'DELETE' AND NEW.finding_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM tp_findings f JOIN tp_recommendations r ON r.workspace_id = f.workspace_id AND r.assessment_id = f.assessment_id
        WHERE f.workspace_id = NEW.workspace_id AND f.id = NEW.finding_id AND r.id = NEW.recommendation_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_conditions: a condition addresses a finding of the same assessment only';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.status <> 'open' OR NEW.verified_by IS NOT NULL OR NEW.waived_by IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_conditions: a condition starts open';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    content_changed := ROW(NEW.position, NEW.description, NEW.owner, NEW.due_date, NEW.created_at, NEW.finding_id)
      IS DISTINCT FROM ROW(OLD.position, OLD.description, OLD.owner, OLD.due_date, OLD.created_at, OLD.finding_id);
    tracking_changed := ROW(NEW.status, NEW.verified_by, NEW.verified_at, NEW.waived_by, NEW.waived_at, NEW.waive_reason, NEW.waive_until)
      IS DISTINCT FROM ROW(OLD.status, OLD.verified_by, OLD.verified_at, OLD.waived_by, OLD.waived_at, OLD.waive_reason, OLD.waive_until);
  END IF;
  SELECT status INTO rec_status FROM tp_recommendations WHERE workspace_id = ws AND id = rec_id;
  IF content_changed AND rec_status IS NOT NULL AND rec_status NOT IN ('draft', 'changes_requested') THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_conditions: conditions change only while their recommendation is a draft (' || rec_status || ')';
  END IF;
  IF tracking_changed THEN
    IF NOT tp_condition_trackable(ws, rec_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_conditions: a condition is tracked only after the client decided on its recommendation with conditions';
    END IF;
    IF NOT (
         (OLD.status IN ('open', 'changes_requested') AND NEW.status IN ('proof_submitted', 'waived'))
      OR (OLD.status = 'proof_submitted' AND NEW.status IN ('verified', 'changes_requested'))
      OR (OLD.status = 'waived' AND OLD.waive_until IS NOT NULL AND NEW.status IN ('proof_submitted', 'waived'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_conditions: ' || OLD.status || ' cannot become ' || NEW.status;
    END IF;
    SELECT p.id, p.submitted_by, p.review_status, p.reviewed_by INTO latest FROM tp_condition_proofs p
     WHERE p.workspace_id = ws AND p.condition_id = NEW.id ORDER BY p.id DESC LIMIT 1;
    IF NEW.status = 'proof_submitted' AND (latest.id IS NULL OR latest.review_status <> 'pending') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_conditions: proof_submitted needs a submitted proof waiting for review';
    END IF;
    IF NEW.status IN ('verified', 'changes_requested')
       AND (latest.id IS NULL OR latest.review_status <> NEW.status) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_conditions: the latest proof must be reviewed as ' || NEW.status;
    END IF;
    IF NEW.status = 'verified' AND (NEW.verified_by IS NOT DISTINCT FROM latest.submitted_by
       OR NEW.verified_by IS DISTINCT FROM latest.reviewed_by OR NOT tp_condition_firm_user(ws, NEW.verified_by, false)) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_conditions: a condition is verified by a firm user who did not submit the proof';
    END IF;
    IF NEW.status = 'waived' AND NOT tp_condition_firm_user(ws, NEW.waived_by, true) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_conditions: only a manager of the firm waives a condition';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fn$;
