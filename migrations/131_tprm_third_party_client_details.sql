ALTER TABLE tp_third_parties ADD COLUMN IF NOT EXISTS client_owner_user_id bigint;
ALTER TABLE tp_third_parties ADD COLUMN IF NOT EXISTS business_unit text CHECK (length(business_unit) <= 100);
ALTER TABLE tp_third_parties ADD COLUMN IF NOT EXISTS service_volume text CHECK (length(service_volume) <= 200);
