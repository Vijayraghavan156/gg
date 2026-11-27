ALTER TABLE tp_third_parties ADD COLUMN IF NOT EXISTS exit_date date;
ALTER TABLE tp_third_parties ADD COLUMN IF NOT EXISTS exit_reason text;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_third_parties_exit_reason_len') THEN
    ALTER TABLE tp_third_parties ADD CONSTRAINT tp_third_parties_exit_reason_len CHECK (exit_reason IS NULL OR length(exit_reason) <= 900);
  END IF;
END $do$;
