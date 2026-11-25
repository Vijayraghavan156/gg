ALTER TABLE tp_assurance_reports ADD COLUMN IF NOT EXISTS confirmed_expires_on date;
ALTER TABLE tp_assurance_reports ADD COLUMN IF NOT EXISTS confirmed_period_end date;
ALTER TABLE tp_assurance_reports DROP CONSTRAINT IF EXISTS tp_assurance_reports_confirmed_dates;
ALTER TABLE tp_assurance_reports ADD CONSTRAINT tp_assurance_reports_confirmed_dates CHECK (
  (confirmed_expires_on IS NULL OR (kind = 'iso27001' AND check_status = 'accepted'))
  AND (confirmed_period_end IS NULL OR (kind = 'soc2_type2' AND check_status = 'accepted')));
