-- Third-party risk (TPRM) v2: two firm settings that let a MANAGER act as the
-- second person on their own work (product decisions, 21 Nov 2026;
-- docs/tprm-v2-spec.md sections 2a and 4j, decision 4). Migrations 083-114
-- are applied and frozen; this one adds columns, replaces two CHECK
-- constraints by name (094's tp_assessments_maker_checker and 096's
-- tp_recommendations_maker_checker, same names, relaxed) and adds triggers.
--
-- tp_firm_settings (103; no row means the defaults):
--   managers_self_approve_tiers      default ON: a manager (firm role) may
--                                    confirm a tier they proposed, with a
--                                    written self-approval reason.
--   managers_self_issue_recommendations  default OFF: a manager who wrote a
--                                    recommendation may approve and issue it
--                                    themselves, with a written reason.
-- Consultants and senior consultants always need a different person; with a
-- setting off, everyone does.
--
-- tp_assessments.self_approval_reason (1,000): set only when the confirmer is
-- the proposer. tp_recommendations.self_issue_reason (1,000): set only when
-- the reviewer is the author, at issue, and never changes afterwards.
--
-- The CHECKs now allow the same person only with a reason; the triggers check,
-- on the transition only (confirming, issuing), that the person is an active
-- manager of the client's firm and that the firm's setting allows it at that
-- moment, so a later change of the setting or of the manager's role never
-- makes an earlier row fail.

ALTER TABLE tp_firm_settings ADD COLUMN IF NOT EXISTS managers_self_approve_tiers boolean NOT NULL DEFAULT true;
ALTER TABLE tp_firm_settings ADD COLUMN IF NOT EXISTS managers_self_issue_recommendations boolean NOT NULL DEFAULT false;

-- The firm's setting, or its default when the firm has no row.
CREATE OR REPLACE FUNCTION tp_firm_self_approval(p_firm_id bigint, p_kind text) RETURNS boolean
LANGUAGE sql STABLE
AS $fn$
  SELECT CASE p_kind
    WHEN 'tiers' THEN COALESCE((SELECT s.managers_self_approve_tiers FROM tp_firm_settings s WHERE s.firm_id = p_firm_id), true)
    WHEN 'recommendations' THEN COALESCE((SELECT s.managers_self_issue_recommendations FROM tp_firm_settings s WHERE s.firm_id = p_firm_id), false)
    ELSE false END
$fn$;

-- ---- tiers -----------------------------------------------------------------------

ALTER TABLE tp_assessments ADD COLUMN IF NOT EXISTS self_approval_reason text CHECK (length(self_approval_reason) <= 1000);

ALTER TABLE tp_assessments DROP CONSTRAINT IF EXISTS tp_assessments_maker_checker;
ALTER TABLE tp_assessments ADD CONSTRAINT tp_assessments_maker_checker CHECK (
  confirmed_by IS NULL OR proposed_by IS NULL OR confirmed_by <> proposed_by
  OR length(btrim(COALESCE(self_approval_reason, ''))) > 0);
ALTER TABLE tp_assessments DROP CONSTRAINT IF EXISTS tp_assessments_self_approval;
ALTER TABLE tp_assessments ADD CONSTRAINT tp_assessments_self_approval CHECK (
  self_approval_reason IS NULL OR (confirmed_by IS NOT NULL AND confirmed_by = proposed_by));

CREATE OR REPLACE FUNCTION tp_assessments_self_approval_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  firm bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.self_approval_reason IS DISTINCT FROM OLD.self_approval_reason
     AND NEW.confirmed_by IS NOT DISTINCT FROM OLD.confirmed_by THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_assessments: the self-approval reason is recorded with the confirmation and never changes';
  END IF;
  -- Without a reason the CHECK tp_assessments_maker_checker refuses it.
  IF NEW.confirmed_by IS NOT NULL AND NEW.confirmed_by = NEW.proposed_by
     AND length(btrim(COALESCE(NEW.self_approval_reason, ''))) > 0
     AND (TG_OP = 'INSERT' OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by) THEN
    SELECT w.firm_id INTO firm FROM workspaces w WHERE w.id = NEW.workspace_id;
    IF NOT tp_condition_firm_user(NEW.workspace_id, NEW.confirmed_by, true)
       OR NOT tp_firm_self_approval(firm, 'tiers') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assessments: the proposer confirms a tier only as a manager of the firm, with a reason, when the firm allows managers to self-approve';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_assessments_self_approval ON tp_assessments;
CREATE TRIGGER tp_assessments_self_approval BEFORE INSERT OR UPDATE ON tp_assessments
  FOR EACH ROW EXECUTE FUNCTION tp_assessments_self_approval_fn();

-- ---- recommendations ---------------------------------------------------------------

ALTER TABLE tp_recommendations ADD COLUMN IF NOT EXISTS self_issue_reason text CHECK (length(self_issue_reason) <= 1000);

ALTER TABLE tp_recommendations DROP CONSTRAINT IF EXISTS tp_recommendations_maker_checker;
ALTER TABLE tp_recommendations ADD CONSTRAINT tp_recommendations_maker_checker CHECK (
  reviewer_id IS NULL OR reviewer_id <> author_id OR length(btrim(COALESCE(self_issue_reason, ''))) > 0);
ALTER TABLE tp_recommendations DROP CONSTRAINT IF EXISTS tp_recommendations_self_issue;
ALTER TABLE tp_recommendations ADD CONSTRAINT tp_recommendations_self_issue CHECK (
  self_issue_reason IS NULL OR (reviewer_id IS NOT NULL AND reviewer_id = author_id AND status IN ('issued', 'withdrawn')));

CREATE OR REPLACE FUNCTION tp_recommendations_self_issue_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  firm bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.self_issue_reason IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: a recommendation starts without a self-issue reason';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.self_issue_reason IS DISTINCT FROM OLD.self_issue_reason
     AND NOT (OLD.status = 'in_review' AND NEW.status = 'issued') THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_recommendations: the self-issue reason is recorded at issue and never changes';
  END IF;
  -- Without a reason the CHECK tp_recommendations_maker_checker refuses it.
  IF NEW.reviewer_id IS NOT NULL AND NEW.reviewer_id = NEW.author_id AND OLD.status <> 'issued'
     AND length(btrim(COALESCE(NEW.self_issue_reason, ''))) > 0
     AND (NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id OR NEW.status IS DISTINCT FROM OLD.status) THEN
    SELECT w.firm_id INTO firm FROM workspaces w WHERE w.id = NEW.workspace_id;
    IF NEW.status <> 'issued' OR OLD.status <> 'in_review'
       OR NOT tp_condition_firm_user(NEW.workspace_id, NEW.reviewer_id, true)
       OR NOT tp_firm_self_approval(firm, 'recommendations') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_recommendations: the author issues a recommendation only as a manager of the firm, with a reason, when the firm allows managers to issue their own';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_recommendations_self_issue ON tp_recommendations;
CREATE TRIGGER tp_recommendations_self_issue BEFORE INSERT OR UPDATE ON tp_recommendations
  FOR EACH ROW EXECUTE FUNCTION tp_recommendations_self_issue_fn();
