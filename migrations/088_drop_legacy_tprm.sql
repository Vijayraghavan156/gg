-- Phase 1 of the third-party risk (TPRM) rebuild: drop the legacy module.
--
-- The product owner confirmed there is no data to keep. This removes the 61
-- legacy tables (suppliers, supplier_*, tprm_*) together with their indexes,
-- triggers and identity sequences (DROP TABLE ... CASCADE also drops the
-- foreign keys that surviving tables held into them:
-- assurance_report_runs.supplier_id, external_assessment_tokens.questionnaire_id
-- and questionnaire_attachments.questionnaire_id keep their columns), then the
-- trigger functions those triggers used, and finally data in surviving tables
-- that only made sense for the old module. Every statement is idempotent.
-- The new module (Phase 2) uses tp_* tables and is not touched here.

DROP TABLE IF EXISTS
  supplier_clauses,
  supplier_contract_review_items,
  supplier_contract_reviews,
  supplier_controls,
  supplier_ddq_assessments,
  supplier_ddq_evidence,
  supplier_ddq_responses,
  supplier_decisions,
  supplier_documents,
  supplier_finding_links,
  supplier_inherent_assessments,
  supplier_inherent_responses,
  supplier_monitoring,
  supplier_notes,
  supplier_questionnaire_responses,
  supplier_questionnaires,
  supplier_reviews,
  supplier_risk_methodologies,
  supplier_risk_snapshots,
  supplier_subprocessors,
  supplier_termination_items,
  suppliers,
  tprm_assessment_cycles,
  tprm_business_services,
  tprm_clarifications,
  tprm_client_decisions,
  tprm_condition_events,
  tprm_condition_evidence_links,
  tprm_conditions,
  tprm_connector_supplier_mappings,
  tprm_cycle_relationship_scopes,
  tprm_dependency_edges,
  tprm_dependency_entities,
  tprm_evidence_release_withdrawals,
  tprm_evidence_releases,
  tprm_legal_entities,
  tprm_lifecycle_events,
  tprm_module_closure_records,
  tprm_modules,
  tprm_monitoring_connector_audit,
  tprm_monitoring_connector_runs,
  tprm_monitoring_connector_state,
  tprm_monitoring_connectors,
  tprm_monitoring_processing_attempts,
  tprm_monitoring_received_events,
  tprm_monitoring_rule_evaluations,
  tprm_monitoring_rules,
  tprm_monitoring_signals,
  tprm_reassessment_queue,
  tprm_recommendation_draft_events,
  tprm_recommendation_draft_revisions,
  tprm_recommendation_drafts,
  tprm_recommendations,
  tprm_relationship_business_dependencies,
  tprm_relationship_contracts,
  tprm_relationship_events,
  tprm_relationship_locations,
  tprm_review_schedule_closures,
  tprm_review_schedules,
  tprm_service_relationships,
  tprm_webhook_ingress_buckets
CASCADE;

DROP FUNCTION IF EXISTS trg_supplier_decision_governed_insert_fn();
DROP FUNCTION IF EXISTS trg_tprm_client_decision_actor_fn();
DROP FUNCTION IF EXISTS trg_tprm_client_decision_divergence_fn();
DROP FUNCTION IF EXISTS trg_tprm_client_decision_lineage_fn();
DROP FUNCTION IF EXISTS trg_tprm_client_decision_recommendation_fn();
DROP FUNCTION IF EXISTS trg_tprm_condition_event_actor_fn();
DROP FUNCTION IF EXISTS trg_tprm_condition_event_hash_chain_fn();
DROP FUNCTION IF EXISTS trg_tprm_condition_event_scope_and_version_fn();
DROP FUNCTION IF EXISTS trg_tprm_condition_evidence_scope_fn();
DROP FUNCTION IF EXISTS trg_tprm_condition_owner_tenant_fn();
DROP FUNCTION IF EXISTS trg_tprm_condition_status_requires_event_fn();
DROP FUNCTION IF EXISTS trg_tprm_condition_supplier_finding_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_active_module_insert_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_active_module_update_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_actor_insert_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_actor_update_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_audit_actor_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_audit_chain_predecessor_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_mapping_actor_insert_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_mapping_actor_retire_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_no_secret_config_insert_fn();
DROP FUNCTION IF EXISTS trg_tprm_connector_no_secret_config_update_fn();
DROP FUNCTION IF EXISTS trg_tprm_contract_lineage_fn();
DROP FUNCTION IF EXISTS trg_tprm_cycle_authority_insert_fn();
DROP FUNCTION IF EXISTS trg_tprm_cycle_authority_update_fn();
DROP FUNCTION IF EXISTS trg_tprm_evidence_release_actor_fn();
DROP FUNCTION IF EXISTS trg_tprm_evidence_release_ddq_scope_fn();
DROP FUNCTION IF EXISTS trg_tprm_evidence_withdrawal_actor_fn();
DROP FUNCTION IF EXISTS trg_tprm_lifecycle_event_chain_predecessor_fn();
DROP FUNCTION IF EXISTS trg_tprm_location_lineage_fn();
DROP FUNCTION IF EXISTS trg_tprm_module_closure_actor_fn();
DROP FUNCTION IF EXISTS trg_tprm_monitoring_rule_actor_disable_fn();
DROP FUNCTION IF EXISTS trg_tprm_monitoring_rule_actor_insert_fn();
DROP FUNCTION IF EXISTS trg_tprm_received_event_chain_predecessor_fn();
DROP FUNCTION IF EXISTS trg_tprm_recommendation_actor_governance_fn();
DROP FUNCTION IF EXISTS trg_tprm_recommendation_draft_actor_insert_fn();
DROP FUNCTION IF EXISTS trg_tprm_recommendation_draft_event_actor_fn();
DROP FUNCTION IF EXISTS trg_tprm_recommendation_draft_event_chain_predecessor_fn();
DROP FUNCTION IF EXISTS trg_tprm_recommendation_draft_reviewer_fn();
DROP FUNCTION IF EXISTS trg_tprm_recommendation_lineage_fn();
DROP FUNCTION IF EXISTS trg_tprm_recommendation_revision_scope_fn();
DROP FUNCTION IF EXISTS trg_tprm_relationship_event_chain_predecessor_fn();
DROP FUNCTION IF EXISTS trg_tprm_review_schedule_closure_client_actor_fn();
DROP FUNCTION IF EXISTS trg_tprm_review_schedule_closure_negative_decision_fn();
DROP FUNCTION IF EXISTS trg_tprm_review_schedule_positive_decision_fn();

-- Permission grants and templates naming the removed tprm.* / supplier.* permissions.
DELETE FROM workspace_role_overrides WHERE permission ~ '^(tprm|supplier)\.';

DO $tprm_088$
DECLARE
  tpl record;
BEGIN
  FOR tpl IN SELECT id, permissions FROM permission_templates
    WHERE permissions LIKE '%tprm.%' OR permissions LIKE '%supplier.%'
  LOOP
    BEGIN
      UPDATE permission_templates SET permissions = (
        SELECT COALESCE(json_agg(p ORDER BY ord), '[]'::json)::text
        FROM json_array_elements_text(tpl.permissions::json) WITH ORDINALITY AS t(p, ord)
        WHERE p !~ '^(tprm|supplier)\.')
      WHERE id = tpl.id;
    EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN
      RAISE NOTICE '088: permission_templates % is not a JSON array; left unchanged', tpl.id;
    END;
  END LOOP;
END
$tprm_088$;

-- The seeded continuous-monitoring rule that counted rows in suppliers (its results cascade).
DELETE FROM ccm_rules WHERE rule_config LIKE '%FROM suppliers%';

-- Search documents for supplier records.
DELETE FROM search_index WHERE entity_type = 'supplier';

-- Organisational entities of type supplier. Rows still referenced through a
-- foreign key that neither cascades nor nulls are kept and reported, rather
-- than deleting or orphaning the referencing records.
DO $tprm_088$
DECLARE
  fk record;
  blocked bigint := 0;
  n bigint;
BEGIN
  CREATE TEMP TABLE tprm_088_supplier_entities ON COMMIT DROP AS
    SELECT id FROM entities WHERE entity_type = 'supplier';
  FOR fk IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.confrelid = 'entities'::regclass
      AND c.confdeltype IN ('a', 'r') AND array_length(c.conkey, 1) = 1
  LOOP
    EXECUTE format('DELETE FROM tprm_088_supplier_entities e WHERE EXISTS (SELECT 1 FROM %s r WHERE r.%I = e.id)', fk.tbl, fk.col);
    GET DIAGNOSTICS n = ROW_COUNT;
    blocked := blocked + n;
  END LOOP;
  DELETE FROM entities WHERE id IN (SELECT id FROM tprm_088_supplier_entities);
  IF blocked > 0 THEN
    RAISE NOTICE '088: % supplier entit(ies) are still referenced and were kept', blocked;
  END IF;
END
$tprm_088$;
