-- Third-party risk (TPRM), premium upgrade Phase 7 follow-up (Vijay, 23 Nov 2026: reminders carry the same link).
-- Migrations 088-123 are applied and frozen; this one adds one column and one trigger.
--
--   tp_vendor_requests.token_sealed  the link's token, encrypted with the client's key (lib/encryption.js), so a
--                                    reminder or a clarification email can carry the same link. Kept only while
--                                    the link is active: the trigger below clears it when the link is revoked or
--                                    used up by the submission. The hash stays the only way a link is found.
ALTER TABLE tp_vendor_requests ADD COLUMN IF NOT EXISTS token_sealed text;

CREATE OR REPLACE FUNCTION tp_vendor_requests_unseal_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.status <> 'active' THEN
    NEW.token_sealed := NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tp_vendor_requests_unseal ON tp_vendor_requests;
CREATE TRIGGER tp_vendor_requests_unseal BEFORE UPDATE ON tp_vendor_requests
  FOR EACH ROW EXECUTE FUNCTION tp_vendor_requests_unseal_fn();
