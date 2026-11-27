ALTER TABLE tp_client_decisions DROP CONSTRAINT IF EXISTS tp_client_decisions_divergence_accepted;
ALTER TABLE tp_client_decisions ADD CONSTRAINT tp_client_decisions_divergence_accepted CHECK (
  NOT diverges OR length(btrim(COALESCE(rationale, ''))) > 0);

CREATE OR REPLACE FUNCTION tp_client_decisions_insert_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  a record;
  r record;
  less_cautious boolean := false;
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
  IF NEW.diverges IS DISTINCT FROM (NEW.outcome <> 'request_more_information' AND NEW.outcome <> r.outcome) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_client_decisions: diverges must say whether the outcome differs from the recommendation';
  END IF;
  IF NEW.outcome <> 'request_more_information' THEN
    less_cautious := COALESCE(array_position(ARRAY['reject', 'approve_with_conditions', 'approve'], NEW.outcome)
      > array_position(ARRAY['reject', 'approve_with_conditions', 'approve'], r.outcome), false);
  END IF;
  IF less_cautious AND NEW.risk_acceptance_until IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_client_decisions: a decision less cautious than the recommendation needs a risk-acceptance expiry';
  END IF;
  IF NOT less_cautious AND NEW.risk_acceptance_until IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_client_decisions: risk acceptance is recorded only for a decision less cautious than the recommendation';
  END IF;
  RETURN NEW;
END;
$fn$;
