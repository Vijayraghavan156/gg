ALTER TABLE tp_client_requests ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'new_supplier';
ALTER TABLE tp_client_requests ADD COLUMN IF NOT EXISTS preferred_date date;
ALTER TABLE tp_client_requests ADD COLUMN IF NOT EXISTS assessment_id bigint;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_client_requests_kind_ok') THEN
    ALTER TABLE tp_client_requests ADD CONSTRAINT tp_client_requests_kind_ok CHECK (kind IN ('new_supplier', 'reassessment'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_client_requests_assessment_fk') THEN
    ALTER TABLE tp_client_requests ADD CONSTRAINT tp_client_requests_assessment_fk FOREIGN KEY (workspace_id, assessment_id)
      REFERENCES tp_assessments (workspace_id, id) ON DELETE SET NULL (assessment_id);
  END IF;
END $do$;
ALTER TABLE tp_client_requests DROP CONSTRAINT IF EXISTS tp_client_requests_link;
ALTER TABLE tp_client_requests ADD CONSTRAINT tp_client_requests_link CHECK (status = 'accepted' OR kind = 'reassessment' OR third_party_id IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tp_client_requests_open_reassessment ON tp_client_requests (workspace_id, third_party_id)
  WHERE kind = 'reassessment' AND status = 'submitted';
