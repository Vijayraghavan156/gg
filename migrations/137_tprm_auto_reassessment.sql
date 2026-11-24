ALTER TABLE tp_client_settings ADD COLUMN IF NOT EXISTS auto_reassess_days integer CHECK (auto_reassess_days BETWEEN 1 AND 180);
