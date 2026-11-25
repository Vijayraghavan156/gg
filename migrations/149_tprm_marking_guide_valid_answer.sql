ALTER TABLE tp_marking_guides ADD COLUMN IF NOT EXISTS valid_answer text;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_marking_guides_valid_answer_len') THEN
    ALTER TABLE tp_marking_guides ADD CONSTRAINT tp_marking_guides_valid_answer_len CHECK (valid_answer IS NULL OR length(valid_answer) <= 1500);
  END IF;
END $do$;
