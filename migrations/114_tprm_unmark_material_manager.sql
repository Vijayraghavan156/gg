-- Third-party risk (TPRM) v2: only a manager marks a material service not
-- material (product decision, 21 Nov 2026; docs/tprm-v2-spec.md section 4j,
-- decision 3). Migrations 083-113 are applied and frozen; this one adds a
-- trigger only.
--
-- Marking a service material stays with tp.manage (consultants included).
-- The change from material to not material is the one that can make an
-- automatic exit plan condition go away, so it needs a manager of the
-- client's firm (firm role manager or firm owner, active), recorded as
-- material_by in the same UPDATE, with a reason. Checked on that transition
-- only, so later updates of the service never fail because that manager left.

CREATE OR REPLACE FUNCTION tp_services_unmark_material_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.material AND NOT NEW.material THEN
    IF NEW.material_at IS NOT DISTINCT FROM OLD.material_at
       OR length(btrim(COALESCE(NEW.material_reason, ''))) = 0
       OR NOT tp_condition_firm_user(NEW.workspace_id, NEW.material_by, true) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_services: only a manager of the firm marks a material service not material, with a reason';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_services_unmark_material ON tp_services;
CREATE TRIGGER tp_services_unmark_material BEFORE UPDATE OF material ON tp_services
  FOR EACH ROW EXECUTE FUNCTION tp_services_unmark_material_fn();
