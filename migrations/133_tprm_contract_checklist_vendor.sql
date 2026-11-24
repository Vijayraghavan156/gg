ALTER TABLE tp_contract_reviews ADD COLUMN IF NOT EXISTS vendor_status text CHECK (vendor_status IN ('in_contract', 'partly', 'not_in_contract', 'no_contract_yet'));
ALTER TABLE tp_contract_reviews ADD COLUMN IF NOT EXISTS vendor_reference text CHECK (length(vendor_reference) <= 300);
ALTER TABLE tp_contract_reviews ADD COLUMN IF NOT EXISTS vendor_saved_at timestamptz;
ALTER TABLE tp_contract_reviews ADD COLUMN IF NOT EXISTS vendor_request_id bigint;
ALTER TABLE tp_contract_reviews ADD COLUMN IF NOT EXISTS vendor_person_id bigint;
