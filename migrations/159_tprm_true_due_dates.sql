DO $do$
DECLARE
  r record;
  latest text;
BEGIN
  FOR r IN
    SELECT t.id, t.workspace_id, t.next_due_date AS old_due,
      CASE WHEN t.last_assessment_date IS NULL OR t.current_tier IS NULL THEN NULL
        ELSE (t.last_assessment_date + make_interval(months => COALESCE(
          CASE t.current_tier WHEN 'critical' THEN cs.interval_months_critical WHEN 'high' THEN cs.interval_months_high
            WHEN 'medium' THEN cs.interval_months_medium ELSE cs.interval_months_low END,
          CASE t.current_tier WHEN 'critical' THEN m.interval_months_critical WHEN 'high' THEN m.interval_months_high
            WHEN 'medium' THEN m.interval_months_medium ELSE m.interval_months_low END,
          CASE t.current_tier WHEN 'critical' THEN 12 WHEN 'high' THEN 12 WHEN 'medium' THEN 24 ELSE 36 END)))::date
      END AS new_due
    FROM tp_third_parties t
    JOIN workspaces w ON w.id = t.workspace_id
    LEFT JOIN tp_client_settings cs ON cs.workspace_id = t.workspace_id
    LEFT JOIN tp_criticality_models m ON m.firm_id = w.firm_id AND m.status = 'active'
    WHERE t.status = 'in_use' AND t.next_due_date IS NOT NULL
      AND (t.tier_source IS NULL OR t.tier_source = 'provisional_from_client_label')
      AND NOT EXISTS (SELECT 1 FROM tp_trigger_events g WHERE g.workspace_id = t.workspace_id AND g.third_party_id = t.id)
    ORDER BY t.id
  LOOP
    IF r.new_due IS NOT DISTINCT FROM r.old_due THEN CONTINUE; END IF;
    UPDATE tp_third_parties SET next_due_date = r.new_due, updated_at = now(), row_version = row_version + 1
      WHERE workspace_id = r.workspace_id AND id = r.id;
    SELECT e.hash INTO latest FROM tp_events e
      WHERE e.workspace_id = r.workspace_id AND e.chain_type = 'third_party' AND e.chain_id = r.id
      ORDER BY e.chain_seq DESC LIMIT 1;
    INSERT INTO tp_events (workspace_id, chain_type, chain_id, third_party_id, actor_user_id, action, before_state, after_state, prev_hash)
      VALUES (r.workspace_id, 'third_party', r.id, r.id, NULL, 'third_party.due_date_corrected',
        jsonb_build_object('next_due_date', r.old_due::text),
        jsonb_build_object('next_due_date', r.new_due::text),
        COALESCE(latest, repeat('0', 64)));
  END LOOP;
END $do$;
