ALTER TABLE users ADD COLUMN IF NOT EXISTS tprm_email_notify text NOT NULL DEFAULT 'on';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tprm_email_notify_check;
ALTER TABLE users ADD CONSTRAINT users_tprm_email_notify_check CHECK (tprm_email_notify IN ('on', 'off'));
