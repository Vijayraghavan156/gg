-- Unlink ISO 27001 from third-party risk.
--
-- The ISO side no longer offers a supplier report. Remove the seeded assurance
-- report definition 'supplier_due_diligence' and every run generated from it
-- (their sources, events and artifacts cascade), and the seeded system report
-- template 'Supplier risk dashboard', whose placeholders no longer resolve.
-- assurance_report_runs.supplier_id is left in place (unused).
-- Every statement is idempotent.

DELETE FROM assurance_report_runs
WHERE definition_id IN (
  SELECT id FROM assurance_report_definitions WHERE report_key = 'supplier_due_diligence'
);

DELETE FROM assurance_report_definitions WHERE report_key = 'supplier_due_diligence';

DELETE FROM report_templates
WHERE is_system = 1 AND workspace_id IS NULL AND firm_id IS NULL
  AND name = 'Supplier risk dashboard';
