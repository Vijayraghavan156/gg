ALTER TABLE tp_answers DROP CONSTRAINT IF EXISTS tp_answers_response_check;
ALTER TABLE tp_answers ADD CONSTRAINT tp_answers_response_check
  CHECK (response IN ('yes', 'partial', 'no', 'na', 'text', 'value'));

ALTER TABLE tp_questionnaires ADD COLUMN IF NOT EXISTS custom_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tp_questionnaires ADD COLUMN IF NOT EXISTS template jsonb;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tp_questionnaires_custom_questions_array') THEN
    ALTER TABLE tp_questionnaires ADD CONSTRAINT tp_questionnaires_custom_questions_array CHECK (jsonb_typeof(custom_questions) = 'array');
  END IF;
END $do$;

CREATE OR REPLACE FUNCTION tp_q_question(p_workspace_id bigint, p_questionnaire_id bigint, p_question_id text) RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
  SELECT COALESCE(
    (SELECT r FROM tp_questionnaires q, jsonb_array_elements(q.custom_questions) AS c(r)
      WHERE q.workspace_id = p_workspace_id AND q.id = p_questionnaire_id AND r->>'id' = p_question_id LIMIT 1),
    (SELECT tp_bank_question(q.bank_version_id, p_question_id) FROM tp_questionnaires q
      WHERE q.workspace_id = p_workspace_id AND q.id = p_questionnaire_id))
$fn$;

CREATE OR REPLACE FUNCTION tp_q_required_ids(p_sections jsonb) RETURNS SETOF text
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT i FROM jsonb_array_elements(COALESCE(p_sections, '[]'::jsonb)) AS s(e), jsonb_array_elements_text(COALESCE(e->'ids', '[]'::jsonb)) AS x(i)
   WHERE NOT (COALESCE(e->'optional', '[]'::jsonb) ? i)
$fn$;

CREATE OR REPLACE FUNCTION tp_answers_types_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  question jsonb;
  answer_type text;
  explain_on jsonb;
  has_detail boolean;
BEGIN
  IF NEW.response IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.response, NEW.detail) IS NOT DISTINCT FROM ROW(OLD.response, OLD.detail) THEN
    RETURN NEW;
  END IF;
  question := tp_q_question(NEW.workspace_id, NEW.questionnaire_id, NEW.question_id);
  answer_type := question->>'answer_type';
  has_detail := length(btrim(COALESCE(NEW.detail, ''))) > 0;
  IF answer_type IS NULL THEN
    IF NEW.response IN ('partial', 'no', 'na') AND NOT has_detail THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'tp_answers_detail: ' || NEW.question_id || ' needs supporting detail for Partially, No and Not applicable';
    END IF;
    IF NEW.response IN ('text', 'value') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: ' || NEW.question_id || ' is answered Yes, Partially, No or Not applicable (this questionnaire''s bank has no written answers)';
    END IF;
  ELSIF answer_type = 'yes_no_na' THEN
    IF NEW.response NOT IN ('yes', 'no', 'na') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: ' || NEW.question_id || ' is answered Yes, No or Not applicable (no Partially on this question bank)';
    END IF;
  ELSIF answer_type = 'free_text' THEN
    IF NEW.response NOT IN ('text', 'na') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: ' || NEW.question_id || ' takes a written answer or Not applicable';
    END IF;
  ELSIF answer_type IN ('single_choice', 'multiple_choice', 'date', 'number', 'url', 'file') THEN
    IF NOT (NEW.response = 'value' OR (NEW.response = 'na' AND COALESCE((question->>'allow_na')::boolean, false))) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: ' || NEW.question_id || ' takes an answer of its own type' || CASE WHEN COALESCE((question->>'allow_na')::boolean, false) THEN ' or Not applicable' ELSE '' END;
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_answers: ' || NEW.question_id || ' has an unknown answer type in its question bank';
  END IF;
  IF answer_type IN ('yes_no_na', 'free_text') AND NEW.response <> 'text' THEN
    explain_on := CASE WHEN answer_type = 'free_text' THEN '["na"]'::jsonb
      WHEN jsonb_typeof(question->'explain_on') = 'array' THEN question->'explain_on' ELSE '["no", "na"]'::jsonb END;
    IF explain_on @> jsonb_build_array(NEW.response) AND NOT has_detail THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'tp_answers_detail: ' || NEW.question_id || ' needs an explanation for this answer';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION tp_q_has_question(p_workspace_id bigint, p_questionnaire_id bigint, p_question_id text) RETURNS boolean
LANGUAGE sql STABLE
AS $fn$
  SELECT EXISTS (SELECT 1 FROM tp_questionnaires q, tp_q_section_ids(q.sections) AS i
    WHERE q.workspace_id = p_workspace_id AND q.id = p_questionnaire_id AND i = p_question_id)
  OR EXISTS (SELECT 1 FROM tp_questionnaires q, jsonb_array_elements(COALESCE(q.sections, '[]'::jsonb)) AS s(e),
      jsonb_array_elements(COALESCE(e->'followups', '[]'::jsonb)) AS f(x)
    WHERE q.workspace_id = p_workspace_id AND q.id = p_questionnaire_id AND f.x->>'id' = p_question_id)
$fn$;

CREATE OR REPLACE FUNCTION tp_questionnaires_guard_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  ai constant text := 'AI Services';
  content_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: a questionnaire is never deleted (it is closed instead)';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: a questionnaire starts as a draft';
    END IF;
    IF NEW.submitted_at IS NOT NULL OR NEW.review_started_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: a new questionnaire is not submitted';
    END IF;
    IF NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: a questionnaire needs an assessment with a confirmed tier that is not frozen';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.workspace_id, NEW.assessment_id, NEW.bank_version_id, NEW.bank_version, NEW.prepared_by, NEW.prepared_at, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.assessment_id, OLD.bank_version_id, OLD.bank_version, OLD.prepared_by, OLD.prepared_at, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: the assessment and the pinned question bank version never change';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: a closed questionnaire cannot be changed';
  END IF;
  IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: a sent questionnaire never goes back to draft';
  END IF;
  IF OLD.status IN ('submitted', 'under_review') AND NEW.status NOT IN ('submitted', 'under_review', 'closed') THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: a submitted questionnaire never goes back to the third party for answers';
  END IF;
  IF OLD.status = 'under_review' AND NEW.status = 'submitted' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: a questionnaire under review never goes back to submitted';
  END IF;
  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: the submission date never changes';
  END IF;
  IF OLD.review_started_at IS NOT NULL AND NEW.review_started_at IS DISTINCT FROM OLD.review_started_at THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: the review start date never changes';
  END IF;

  IF NEW.status = 'submitted' AND OLD.status <> 'submitted' THEN
    IF OLD.status NOT IN ('sent', 'in_progress') OR NEW.submitted_at IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: only a questionnaire being answered is submitted';
    END IF;
    IF EXISTS (SELECT 1 FROM tp_q_required_ids(NEW.sections) AS i
       WHERE NOT EXISTS (SELECT 1 FROM tp_answers a
         WHERE a.workspace_id = NEW.workspace_id AND a.questionnaire_id = NEW.id AND a.question_id = i
           AND a.response IS NOT NULL AND a.submitted_at IS NOT NULL
           AND (a.prefilled_from_answer_id IS NULL OR a.prefill_confirmed_at IS NOT NULL))) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: every question must be answered before the questionnaire is submitted';
    END IF;
  END IF;

  IF NEW.status = 'closed' AND NEW.closed_reason = 'Reviewed' THEN
    IF OLD.status NOT IN ('submitted', 'under_review') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: only a submitted questionnaire is closed as reviewed';
    END IF;
    IF EXISTS (SELECT 1 FROM tp_answers a WHERE a.workspace_id = NEW.workspace_id AND a.questionnaire_id = NEW.id
         AND a.review_conclusion = 'not_reviewed' AND a.response IS NOT NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: every answer needs a reviewer conclusion before the review is closed';
    END IF;
    IF EXISTS (SELECT 1 FROM tp_clarifications c WHERE c.workspace_id = NEW.workspace_id AND c.questionnaire_id = NEW.id
         AND c.status <> 'closed') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: close every clarification before the review is closed';
    END IF;
  END IF;

  IF ROW(NEW.custom_questions, NEW.template) IS DISTINCT FROM ROW(OLD.custom_questions, OLD.template) AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: the firm questionnaire of a sent questionnaire never changes';
  END IF;
  content_changed := ROW(NEW.tier, NEW.delivery_model, NEW.delivery_model_source, NEW.modules, NEW.dynamic_modules, NEW.sections,
         NEW.consultant_check_ids, NEW.vendor_question_count)
     IS DISTINCT FROM ROW(OLD.tier, OLD.delivery_model, OLD.delivery_model_source, OLD.modules, OLD.dynamic_modules, OLD.sections,
         OLD.consultant_check_ids, OLD.vendor_question_count);
  IF content_changed THEN
    IF NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: the assessment is frozen, so the questionnaire cannot change';
    END IF;
    IF OLD.status <> 'draft' THEN
      IF NOT (OLD.status IN ('sent', 'in_progress') AND NEW.status IN ('sent', 'in_progress')
         AND ROW(NEW.tier, NEW.delivery_model, NEW.delivery_model_source, NEW.consultant_check_ids)
             IS NOT DISTINCT FROM ROW(OLD.tier, OLD.delivery_model, OLD.delivery_model_source, OLD.consultant_check_ids)
         AND tp_q_sections_without(NEW.sections, ai) = tp_q_sections_without(OLD.sections, ai)
         AND tp_q_modules_without(NEW.modules, ai) = tp_q_modules_without(OLD.modules, ai)
         AND tp_q_modules_without(NEW.dynamic_modules, ai) = tp_q_modules_without(OLD.dynamic_modules, ai)
         AND COALESCE(tp_q_module_entry(OLD.modules, ai)->>'source', 'third_party_answer') = 'third_party_answer'
         AND COALESCE(tp_q_module_entry(NEW.modules, ai)->>'source', 'third_party_answer') = 'third_party_answer'
         AND NEW.vendor_question_count = (SELECT count(*) FROM tp_q_section_ids(NEW.sections))
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(NEW.sections) AS s(e), jsonb_array_elements_text(e->'ids') AS x(i)
            WHERE e->>'kind' = 'module' AND e->>'title' = ai
              AND NOT EXISTS (SELECT 1 FROM tp_question_bank_versions b, jsonb_array_elements(b.content->'questions') AS bq(r)
                WHERE b.id = NEW.bank_version_id AND r->>'id' = i AND r->>'set' = 'Module' AND r->>'pack' = ai
                  AND r->>'answered_by' IS DISTINCT FROM 'Consultant'))) THEN
        RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
          MESSAGE = 'tp_questionnaires: only a draft questionnaire can change its questions (the AI Services module added by the third party''s answer excepted)';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
