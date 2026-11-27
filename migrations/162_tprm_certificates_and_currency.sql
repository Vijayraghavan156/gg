ALTER TABLE tp_evidence ADD COLUMN IF NOT EXISTS document_kind text;
ALTER TABLE tp_evidence ADD COLUMN IF NOT EXISTS expires_on date;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_evidence_document_kind_ok') THEN
    ALTER TABLE tp_evidence ADD CONSTRAINT tp_evidence_document_kind_ok CHECK (document_kind IS NULL OR document_kind IN ('iso27001_certificate', 'soc2_report'));
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_tp_evidence_certificates ON tp_evidence (workspace_id, expires_on) WHERE document_kind IS NOT NULL;

ALTER TABLE tp_services ADD COLUMN IF NOT EXISTS spend_currency text;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_services_spend_currency_ok') THEN
    ALTER TABLE tp_services ADD CONSTRAINT tp_services_spend_currency_ok CHECK (spend_currency IS NULL OR spend_currency ~ '^[A-Z]{3}$');
  END IF;
END $do$;
