-- Third-party risk (TPRM) v2: starter criticality questions say "third
-- party", not "vendor" (docs/tprm-v2-spec.md section 5). Only wording
-- changes; question and answer ids (e.g. vendor_hosted) are kept, so answers
-- recorded against them stay valid. lib/tprm/criticality.js STARTER_QUESTIONS
-- is changed to match (a test keeps the two identical).
--
-- 1. New firms: the seed function now inserts the new wording.
-- 2. Existing firms whose model is still the untouched starter (exactly one
--    version, version 1, active, questions identical to the 092 starter) get
--    the new wording on that version. Active versions are immutable, so the
--    guard trigger is disabled for this one statement and enabled again in
--    the same transaction (migrations/run.js runs each file in one
--    transaction). A firm that created any other version, or whose version 1
--    differs in any way, is left exactly as it is.

CREATE OR REPLACE FUNCTION tp_seed_starter_criticality_model(p_firm_id bigint) RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM tp_criticality_models WHERE firm_id = p_firm_id) THEN
    RETURN;
  END IF;
  INSERT INTO tp_criticality_models (firm_id, version, status, questions, activated_at)
  VALUES (p_firm_id, 1, 'active', $json$[
    {"id": "data_handled", "kind": "criticality", "text": "What data will the third party handle?", "answers": [
      {"id": "none", "label": "None", "tier": "Low"},
      {"id": "internal", "label": "Internal", "tier": "Medium"},
      {"id": "confidential", "label": "Confidential business data", "tier": "High"},
      {"id": "personal", "label": "Personal data", "tier": "High"},
      {"id": "special_financial", "label": "Special-category, financial or payment data", "tier": "Critical"}]},
    {"id": "service_stops", "kind": "criticality", "text": "What happens to the client if the service stops?", "answers": [
      {"id": "minor", "label": "Minor inconvenience", "tier": "Low"},
      {"id": "slows", "label": "A process slows down", "tier": "Medium"},
      {"id": "key_process_stops", "label": "A key process stops", "tier": "Critical"}]},
    {"id": "system_access", "kind": "criticality", "text": "What access will it have to the client's systems?", "answers": [
      {"id": "none", "label": "None", "tier": "Low"},
      {"id": "user", "label": "User-level", "tier": "Medium"},
      {"id": "privileged", "label": "Privileged, admin or network-connected", "tier": "High"}]},
    {"id": "regulated", "kind": "criticality", "text": "Is the service subject to regulation (e.g. RBI, SEBI, IRDAI, DPDP, GDPR)?", "answers": [
      {"id": "no", "label": "No", "tier": "Low"},
      {"id": "yes", "label": "Yes", "tier": "High"}]},
    {"id": "replaceability", "kind": "criticality", "text": "How easily could the client replace it?", "answers": [
      {"id": "easily", "label": "Easily", "tier": "Low"},
      {"id": "with_effort", "label": "With effort", "tier": "Medium"},
      {"id": "sole_source", "label": "Sole source", "tier": "High"}]},
    {"id": "delivery_model", "kind": "service_description", "text": "How is the service delivered?", "answers": [
      {"id": "vendor_hosted", "label": "Hosted or managed by the third party", "tier": "Low"},
      {"id": "installed", "label": "Software installed in the client's environment", "tier": "Low"},
      {"id": "non_technology", "label": "Non-technology service", "tier": "Low"},
      {"id": "staff_onsite", "label": "Third-party staff work inside the client's environment", "tier": "Low"}]},
    {"id": "payments_records", "kind": "service_description", "text": "Can the service create or change payments, trades, holdings or client-asset records?", "answers": [
      {"id": "no", "label": "No", "tier": "Low"},
      {"id": "yes", "label": "Yes", "tier": "Low"}]},
    {"id": "sites_data", "kind": "service_description", "text": "Will the third party's staff work at client sites, or will it hold client data at its own sites?", "answers": [
      {"id": "no", "label": "No", "tier": "Low"},
      {"id": "yes", "label": "Yes", "tier": "Low"}]}
  ]$json$::jsonb, now());
END;
$fn$;

ALTER TABLE tp_criticality_models DISABLE TRIGGER tp_criticality_models_guard;

UPDATE tp_criticality_models m
   SET questions = $json$[
    {"id": "data_handled", "kind": "criticality", "text": "What data will the third party handle?", "answers": [
      {"id": "none", "label": "None", "tier": "Low"},
      {"id": "internal", "label": "Internal", "tier": "Medium"},
      {"id": "confidential", "label": "Confidential business data", "tier": "High"},
      {"id": "personal", "label": "Personal data", "tier": "High"},
      {"id": "special_financial", "label": "Special-category, financial or payment data", "tier": "Critical"}]},
    {"id": "service_stops", "kind": "criticality", "text": "What happens to the client if the service stops?", "answers": [
      {"id": "minor", "label": "Minor inconvenience", "tier": "Low"},
      {"id": "slows", "label": "A process slows down", "tier": "Medium"},
      {"id": "key_process_stops", "label": "A key process stops", "tier": "Critical"}]},
    {"id": "system_access", "kind": "criticality", "text": "What access will it have to the client's systems?", "answers": [
      {"id": "none", "label": "None", "tier": "Low"},
      {"id": "user", "label": "User-level", "tier": "Medium"},
      {"id": "privileged", "label": "Privileged, admin or network-connected", "tier": "High"}]},
    {"id": "regulated", "kind": "criticality", "text": "Is the service subject to regulation (e.g. RBI, SEBI, IRDAI, DPDP, GDPR)?", "answers": [
      {"id": "no", "label": "No", "tier": "Low"},
      {"id": "yes", "label": "Yes", "tier": "High"}]},
    {"id": "replaceability", "kind": "criticality", "text": "How easily could the client replace it?", "answers": [
      {"id": "easily", "label": "Easily", "tier": "Low"},
      {"id": "with_effort", "label": "With effort", "tier": "Medium"},
      {"id": "sole_source", "label": "Sole source", "tier": "High"}]},
    {"id": "delivery_model", "kind": "service_description", "text": "How is the service delivered?", "answers": [
      {"id": "vendor_hosted", "label": "Hosted or managed by the third party", "tier": "Low"},
      {"id": "installed", "label": "Software installed in the client's environment", "tier": "Low"},
      {"id": "non_technology", "label": "Non-technology service", "tier": "Low"},
      {"id": "staff_onsite", "label": "Third-party staff work inside the client's environment", "tier": "Low"}]},
    {"id": "payments_records", "kind": "service_description", "text": "Can the service create or change payments, trades, holdings or client-asset records?", "answers": [
      {"id": "no", "label": "No", "tier": "Low"},
      {"id": "yes", "label": "Yes", "tier": "Low"}]},
    {"id": "sites_data", "kind": "service_description", "text": "Will the third party's staff work at client sites, or will it hold client data at its own sites?", "answers": [
      {"id": "no", "label": "No", "tier": "Low"},
      {"id": "yes", "label": "Yes", "tier": "Low"}]}
  ]$json$::jsonb,
       updated_at = now(),
       row_version = m.row_version + 1
 WHERE m.version = 1
   AND m.status = 'active'
   AND m.questions = $json$[
    {"id": "data_handled", "kind": "criticality", "text": "What data will the third party handle?", "answers": [
      {"id": "none", "label": "None", "tier": "Low"},
      {"id": "internal", "label": "Internal", "tier": "Medium"},
      {"id": "confidential", "label": "Confidential business data", "tier": "High"},
      {"id": "personal", "label": "Personal data", "tier": "High"},
      {"id": "special_financial", "label": "Special-category, financial or payment data", "tier": "Critical"}]},
    {"id": "service_stops", "kind": "criticality", "text": "What happens to the client if the service stops?", "answers": [
      {"id": "minor", "label": "Minor inconvenience", "tier": "Low"},
      {"id": "slows", "label": "A process slows down", "tier": "Medium"},
      {"id": "key_process_stops", "label": "A key process stops", "tier": "Critical"}]},
    {"id": "system_access", "kind": "criticality", "text": "What access will it have to the client's systems?", "answers": [
      {"id": "none", "label": "None", "tier": "Low"},
      {"id": "user", "label": "User-level", "tier": "Medium"},
      {"id": "privileged", "label": "Privileged, admin or network-connected", "tier": "High"}]},
    {"id": "regulated", "kind": "criticality", "text": "Is the service subject to regulation (e.g. RBI, SEBI, IRDAI, DPDP, GDPR)?", "answers": [
      {"id": "no", "label": "No", "tier": "Low"},
      {"id": "yes", "label": "Yes", "tier": "High"}]},
    {"id": "replaceability", "kind": "criticality", "text": "How easily could the client replace it?", "answers": [
      {"id": "easily", "label": "Easily", "tier": "Low"},
      {"id": "with_effort", "label": "With effort", "tier": "Medium"},
      {"id": "sole_source", "label": "Sole source", "tier": "High"}]},
    {"id": "delivery_model", "kind": "service_description", "text": "How is the service delivered?", "answers": [
      {"id": "vendor_hosted", "label": "Vendor-hosted or managed service", "tier": "Low"},
      {"id": "installed", "label": "Software installed in the client's environment", "tier": "Low"},
      {"id": "non_technology", "label": "Non-technology service", "tier": "Low"},
      {"id": "staff_onsite", "label": "Vendor staff work inside the client's environment", "tier": "Low"}]},
    {"id": "payments_records", "kind": "service_description", "text": "Can the service create or change payments, trades, holdings or client-asset records?", "answers": [
      {"id": "no", "label": "No", "tier": "Low"},
      {"id": "yes", "label": "Yes", "tier": "Low"}]},
    {"id": "sites_data", "kind": "service_description", "text": "Will the vendor's staff work at client sites or hold client data at vendor sites?", "answers": [
      {"id": "no", "label": "No", "tier": "Low"},
      {"id": "yes", "label": "Yes", "tier": "Low"}]}
  ]$json$::jsonb
   AND NOT EXISTS (SELECT 1 FROM tp_criticality_models o WHERE o.firm_id = m.firm_id AND o.id <> m.id);

ALTER TABLE tp_criticality_models ENABLE TRIGGER tp_criticality_models_guard;
