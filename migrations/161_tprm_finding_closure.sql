ALTER TABLE tp_findings ADD COLUMN IF NOT EXISTS close_reason text;
ALTER TABLE tp_findings ADD COLUMN IF NOT EXISTS closed_by bigint;
ALTER TABLE tp_findings ADD COLUMN IF NOT EXISTS closed_at timestamptz;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_findings_close_reason_len') THEN
    ALTER TABLE tp_findings ADD CONSTRAINT tp_findings_close_reason_len CHECK (close_reason IS NULL OR length(close_reason) <= 1000);
  END IF;
END $do$;
