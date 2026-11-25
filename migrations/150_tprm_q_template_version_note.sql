ALTER TABLE tp_q_template_versions ADD COLUMN IF NOT EXISTS note text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_q_template_versions_note_len') THEN
    ALTER TABLE tp_q_template_versions ADD CONSTRAINT tp_q_template_versions_note_len CHECK (note IS NULL OR length(note) <= 300);
  END IF;
END $$;
