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
    IF st = 'cancelled' AND NEW.released_to_client AND NOT OLD.released_to_client THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_evidence: files of a cancelled assessment are not released to the client';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'tp_findings' AND TG_OP = 'UPDATE' AND st = 'completed' THEN
    IF to_jsonb(OLD)->>'status' = 'open' AND to_jsonb(NEW)->>'status' = 'closed'
      AND length(btrim(coalesce(to_jsonb(NEW)->>'close_reason', ''))) > 0
      AND (to_jsonb(NEW) - ARRAY['status', 'close_reason', 'closed_by', 'closed_at', 'updated_by', 'updated_at', 'row_version'])
        = (to_jsonb(OLD) - ARRAY['status', 'close_reason', 'closed_by', 'closed_at', 'updated_by', 'updated_at', 'row_version']) THEN
      RETURN NEW;
    END IF;
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
