-- Third-party risk (TPRM) v2: a manager's override of an automatic exit plan
-- condition no longer turns the recommendation into a plain Onboard /
-- Continue (product decision, 21 Nov 2026; docs/tprm-v2-spec.md section 4j,
-- decision 2). Migrations 083-112 are applied and frozen; this one adds
-- columns, a CHECK and a separate trigger (096 / 098's and 110's
-- recommendation functions are not replaced).
--
-- Once a manager removed an automatic condition from a recommendation version
-- (tp_exit_plan_overrides), the outcome stays "approve with conditions"
-- unless a manager also changes the outcome explicitly, with a reason. The
-- manager's change is recorded on the version:
--
--   override_outcome         the outcome the manager chose ('approve' or
--                            'reject'), or NULL (none chosen)
--   override_outcome_reason  why (1,000)
--   override_outcome_by/_at  which manager, when
--
-- Rules (the domain, lib/tprm/exit-plans.js, holds the same):
--   1. The manager's change is set only while the version is a draft (or
--      changes requested), by a manager of the client's firm, on a version
--      with at least one override, together with the outcome it names; it is
--      never set on a new version (a new version starts without one).
--   2. A version with an override may have the outcome 'approve' only when a
--      manager chose 'approve' (checked when the outcome becomes 'approve' and
--      when the version moves to review or issue; never on an issued version,
--      so recommendations issued before this change can still be superseded).
--   "With conditions" with no condition left is refused by the domain at the
--   override and at submit, and by 096's trigger at issue.

ALTER TABLE tp_recommendations ADD COLUMN IF NOT EXISTS override_outcome text
  CHECK (override_outcome IN ('approve', 'reject'));
ALTER TABLE tp_recommendations ADD COLUMN IF NOT EXISTS override_outcome_reason text
  CHECK (length(override_outcome_reason) <= 1000);
ALTER TABLE tp_recommendations ADD COLUMN IF NOT EXISTS override_outcome_by bigint;
ALTER TABLE tp_recommendations ADD COLUMN IF NOT EXISTS override_outcome_at timestamptz;

ALTER TABLE tp_recommendations DROP CONSTRAINT IF EXISTS tp_recommendations_override_outcome;
ALTER TABLE tp_recommendations ADD CONSTRAINT tp_recommendations_override_outcome CHECK (
  (override_outcome IS NULL AND override_outcome_reason IS NULL AND override_outcome_by IS NULL AND override_outcome_at IS NULL)
  OR (override_outcome IS NOT NULL AND length(btrim(COALESCE(override_outcome_reason, ''))) > 0
      AND override_outcome_by IS NOT NULL AND override_outcome_at IS NOT NULL));

CREATE OR REPLACE FUNCTION tp_recommendations_override_outcome_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  has_override boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.override_outcome IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: a new version starts without a manager''s outcome change';
    END IF;
    RETURN NEW;
  END IF;
  has_override := EXISTS (SELECT 1 FROM tp_exit_plan_overrides o
    WHERE o.workspace_id = NEW.workspace_id AND o.recommendation_id = NEW.id);
  IF ROW(NEW.override_outcome, NEW.override_outcome_reason, NEW.override_outcome_by, NEW.override_outcome_at)
     IS DISTINCT FROM ROW(OLD.override_outcome, OLD.override_outcome_reason, OLD.override_outcome_by, OLD.override_outcome_at) THEN
    IF OLD.status NOT IN ('draft', 'changes_requested') OR NEW.status NOT IN ('draft', 'changes_requested') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: a manager changes the outcome after an override only while the recommendation is a draft';
    END IF;
    IF NEW.override_outcome IS NULL OR NOT has_override
       OR NEW.outcome IS DISTINCT FROM NEW.override_outcome
       OR NOT tp_condition_firm_user(NEW.workspace_id, NEW.override_outcome_by, true) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: only a manager of the firm changes the outcome after an override, to the outcome recorded, with a reason';
    END IF;
  END IF;
  IF OLD.status <> 'issued' AND NEW.outcome = 'approve' AND has_override
     AND NEW.override_outcome IS DISTINCT FROM 'approve'
     AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_recommendations: after a manager removed an automatic condition the recommendation stays "with conditions" unless a manager changes the outcome, with a reason';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_recommendations_override_outcome ON tp_recommendations;
CREATE TRIGGER tp_recommendations_override_outcome BEFORE INSERT OR UPDATE ON tp_recommendations
  FOR EACH ROW EXECUTE FUNCTION tp_recommendations_override_outcome_fn();
