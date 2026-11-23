-- Third-party risk (TPRM) v2, Phase 3 part B: the third party's answers, its
-- files, submission, the firm's review and clarifications. See
-- docs/tprm-v2-spec.md section 4c. Migrations 083-099 are applied and frozen;
-- this one adds objects and replaces tp_questionnaires_guard_fn by name.
--
-- tp_questionnaires: submitted_at (the third party submitted), review_started_at
-- and closed_by. The guard is 099's with three changes:
--   1. After the questionnaire is sent, its questions change only for the
--      dynamic AI Services module: added when the third party answers AIS-01
--      Yes, removed when it answers No before it answered any AI question.
--      Every other module, section and setting must stay exactly as it was,
--      the AI Services entry must carry source third_party_answer (a module the
--      consultant added by hand is never touched), the section may hold only
--      the bank's AI Services rows, and the count must match the sections.
--   2. Status only moves forward: submitted -> under_review -> closed. Entering
--      submitted needs submitted_at and every question answered (a response,
--      locked with the questionnaire, and a confirmed answer where it was
--      prefilled from last time).
--   3. Closing as reviewed (closed_reason 'Reviewed') needs every answer to
--      carry a reviewer conclusion and no clarification left open or
--      answered-but-not-closed. Closing for a cancelled assessment is unchanged.
--
-- tp_answers: one row per questionnaire and question id (composite foreign
-- keys; the question id must be one of the questionnaire's sections, checked
-- by the guard). The third party's fields (response, detail, evidence
-- reference and date, saved_at, the prefill confirmation) change only while
-- the questionnaire is sent or in progress, the assessment is not frozen and
-- the row is not submitted; submitted_at is set once, at submission. The
-- reviewer's fields (conclusion, comment, reviewed by / at) change only after
-- submission, while the assessment is not frozen. Detail is required for
-- Partially, No and Not applicable. A row the third party never saved (a
-- prefilled answer it did not confirm) may be deleted while answering, when the
-- AI Services module is removed again; nothing else is ever deleted.
--
-- tp_answer_evidence: the third party's files cited by an answer. Both keys
-- carry assessment_id (as tp_finding_evidence), so an answer cites only files
-- of its own assessment; only files with source vendor; changed only while
-- the answer can change.
--
-- tp_evidence.vendor_request_id: the link a third-party file came through
-- (source vendor, uploaded_by NULL), fixed once written. The page of a
-- questionnaire's link lists only files that came through that questionnaire's
-- links.
--
-- tp_clarifications: a question the firm asks about one answer after
-- submission (open), the third party's response (answered), the firm closing
-- it (closed, final). The question text never changes; the response is
-- written once.
--
-- Like the other TPRM guards, a delete passes once the workspace row itself
-- is gone (a direct workspace delete cascades), and lib/workspace-deletion.js
-- suspends the guards when it purges a client. User columns carry no foreign
-- key, as for the audit log (migration 086).

ALTER TABLE tp_questionnaires ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE tp_questionnaires ADD COLUMN IF NOT EXISTS review_started_at timestamptz;
ALTER TABLE tp_questionnaires ADD COLUMN IF NOT EXISTS closed_by bigint;
ALTER TABLE tp_questionnaires DROP CONSTRAINT IF EXISTS tp_questionnaires_submitted;
ALTER TABLE tp_questionnaires ADD CONSTRAINT tp_questionnaires_submitted
  CHECK (status NOT IN ('submitted', 'under_review') OR submitted_at IS NOT NULL);
ALTER TABLE tp_questionnaires DROP CONSTRAINT IF EXISTS tp_questionnaires_review_started;
ALTER TABLE tp_questionnaires ADD CONSTRAINT tp_questionnaires_review_started
  CHECK (status <> 'under_review' OR review_started_at IS NOT NULL);

ALTER TABLE tp_vendor_requests DROP CONSTRAINT IF EXISTS tp_vendor_requests_questionnaire_id_key;
ALTER TABLE tp_vendor_requests ADD CONSTRAINT tp_vendor_requests_questionnaire_id_key UNIQUE (workspace_id, questionnaire_id, id);
ALTER TABLE tp_vendor_requests DROP CONSTRAINT IF EXISTS tp_vendor_requests_assessment_id_key;
ALTER TABLE tp_vendor_requests ADD CONSTRAINT tp_vendor_requests_assessment_id_key UNIQUE (workspace_id, assessment_id, id);

-- ---- third-party files ------------------------------------------------------

ALTER TABLE tp_evidence ADD COLUMN IF NOT EXISTS vendor_request_id bigint;
ALTER TABLE tp_evidence DROP CONSTRAINT IF EXISTS tp_evidence_vendor_request_fk;
ALTER TABLE tp_evidence ADD CONSTRAINT tp_evidence_vendor_request_fk FOREIGN KEY (workspace_id, assessment_id, vendor_request_id)
  REFERENCES tp_vendor_requests (workspace_id, assessment_id, id);
ALTER TABLE tp_evidence DROP CONSTRAINT IF EXISTS tp_evidence_vendor_source;
ALTER TABLE tp_evidence ADD CONSTRAINT tp_evidence_vendor_source CHECK (
  (source = 'vendor' AND vendor_request_id IS NOT NULL AND uploaded_by IS NULL)
  OR (source <> 'vendor' AND vendor_request_id IS NULL));

CREATE OR REPLACE FUNCTION tp_evidence_vendor_fixed_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.vendor_request_id IS DISTINCT FROM OLD.vendor_request_id THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_evidence: the link a third-party file came through cannot be changed';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_evidence_vendor_fixed ON tp_evidence;
CREATE TRIGGER tp_evidence_vendor_fixed BEFORE UPDATE ON tp_evidence
  FOR EACH ROW EXECUTE FUNCTION tp_evidence_vendor_fixed_fn();

-- ---- helpers ------------------------------------------------------------------

-- sections without the named module's section, in order.
CREATE OR REPLACE FUNCTION tp_q_sections_without(p_sections jsonb, p_module text) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT COALESCE(jsonb_agg(e ORDER BY o), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_sections, '[]'::jsonb)) WITH ORDINALITY AS t(e, o)
  WHERE NOT (e->>'kind' = 'module' AND e->>'title' = p_module)
$fn$;

-- module (or dynamic module) entries without the named module, in order.
CREATE OR REPLACE FUNCTION tp_q_modules_without(p_modules jsonb, p_module text) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT COALESCE(jsonb_agg(e ORDER BY o), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_modules, '[]'::jsonb)) WITH ORDINALITY AS t(e, o)
  WHERE e->>'module' IS DISTINCT FROM p_module
$fn$;

CREATE OR REPLACE FUNCTION tp_q_module_entry(p_modules jsonb, p_module text) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT e FROM jsonb_array_elements(COALESCE(p_modules, '[]'::jsonb)) AS t(e) WHERE e->>'module' = p_module LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION tp_q_section_ids(p_sections jsonb) RETURNS SETOF text
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT i FROM jsonb_array_elements(COALESCE(p_sections, '[]'::jsonb)) AS s(e), jsonb_array_elements_text(e->'ids') AS x(i)
$fn$;

-- Whether a question id is one of the questionnaire's questions.
CREATE OR REPLACE FUNCTION tp_q_has_question(p_workspace_id bigint, p_questionnaire_id bigint, p_question_id text) RETURNS boolean
LANGUAGE sql STABLE
AS $fn$
  SELECT EXISTS (SELECT 1 FROM tp_questionnaires q, tp_q_section_ids(q.sections) AS i
    WHERE q.workspace_id = p_workspace_id AND q.id = p_questionnaire_id AND i = p_question_id)
$fn$;

-- ---- answers ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tp_answers (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id bigint NOT NULL,
  questionnaire_id bigint NOT NULL,
  question_id text NOT NULL CHECK (question_id ~ '^[A-Z]{2,6}-[0-9]{1,4}$'),
  response text CHECK (response IN ('yes', 'partial', 'no', 'na')),
  detail text CHECK (length(detail) <= 4000),
  evidence_ref text CHECK (length(evidence_ref) <= 1000),
  evidence_date date,
  saved_at timestamptz,
  saved_by_request_id bigint,
  prefilled_from_answer_id bigint,
  prefill_confirmed_at timestamptz,
  submitted_at timestamptz,
  review_conclusion text NOT NULL DEFAULT 'not_reviewed'
    CHECK (review_conclusion IN ('not_reviewed', 'satisfactory', 'partially_satisfactory', 'unsatisfactory')),
  review_comment text CHECK (length(review_comment) <= 2000),
  reviewed_by bigint,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT tp_answers_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT tp_answers_assessment_id_key UNIQUE (workspace_id, assessment_id, id),
  CONSTRAINT tp_answers_one_per_question UNIQUE (workspace_id, questionnaire_id, question_id),
  CONSTRAINT tp_answers_questionnaire_fk FOREIGN KEY (workspace_id, assessment_id, questionnaire_id)
    REFERENCES tp_questionnaires (workspace_id, assessment_id, id),
  CONSTRAINT tp_answers_request_fk FOREIGN KEY (workspace_id, questionnaire_id, saved_by_request_id)
    REFERENCES tp_vendor_requests (workspace_id, questionnaire_id, id),
  CONSTRAINT tp_answers_prefill_fk FOREIGN KEY (workspace_id, prefilled_from_answer_id)
    REFERENCES tp_answers (workspace_id, id),
  CONSTRAINT tp_answers_detail CHECK (response IS NULL OR response = 'yes' OR length(btrim(COALESCE(detail, ''))) > 0),
  CONSTRAINT tp_answers_submitted CHECK (submitted_at IS NULL OR response IS NOT NULL),
  CONSTRAINT tp_answers_reviewed CHECK (review_conclusion = 'not_reviewed' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tp_answers_questionnaire ON tp_answers (workspace_id, questionnaire_id, id);

CREATE OR REPLACE FUNCTION tp_answers_guard_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  q_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    SELECT status INTO q_status FROM tp_questionnaires WHERE workspace_id = OLD.workspace_id AND id = OLD.questionnaire_id;
    IF OLD.saved_at IS NOT NULL OR OLD.submitted_at IS NOT NULL OR q_status IS NULL
       OR q_status NOT IN ('draft', 'sent', 'in_progress') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: an answer the third party saved is never deleted';
    END IF;
    RETURN OLD;
  END IF;

  SELECT status INTO q_status FROM tp_questionnaires WHERE workspace_id = NEW.workspace_id AND id = NEW.questionnaire_id;

  IF TG_OP = 'INSERT' THEN
    IF q_status IS NULL OR q_status NOT IN ('draft', 'sent', 'in_progress') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: answers are added only while the questionnaire is being answered';
    END IF;
    IF NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: the assessment is frozen, so the answers cannot change';
    END IF;
    IF NOT tp_q_has_question(NEW.workspace_id, NEW.questionnaire_id, NEW.question_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: ' || NEW.question_id || ' is not a question of this questionnaire';
    END IF;
    IF NEW.submitted_at IS NOT NULL OR NEW.review_conclusion <> 'not_reviewed' OR NEW.review_comment IS NOT NULL
       OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: an answer starts unsubmitted and not reviewed';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE.
  IF ROW(NEW.id, NEW.workspace_id, NEW.assessment_id, NEW.questionnaire_id, NEW.question_id, NEW.prefilled_from_answer_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.assessment_id, OLD.questionnaire_id, OLD.question_id, OLD.prefilled_from_answer_id, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_answers: the questionnaire and question of an answer never change';
  END IF;
  IF ROW(NEW.response, NEW.detail, NEW.evidence_ref, NEW.evidence_date, NEW.saved_at, NEW.saved_by_request_id, NEW.prefill_confirmed_at)
     IS DISTINCT FROM ROW(OLD.response, OLD.detail, OLD.evidence_ref, OLD.evidence_date, OLD.saved_at, OLD.saved_by_request_id, OLD.prefill_confirmed_at)
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    IF OLD.submitted_at IS NOT NULL OR q_status NOT IN ('sent', 'in_progress') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: answers are locked once the questionnaire is submitted';
    END IF;
    IF NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: the assessment is frozen, so the answers cannot change';
    END IF;
  END IF;
  IF ROW(NEW.review_conclusion, NEW.review_comment, NEW.reviewed_by, NEW.reviewed_at)
     IS DISTINCT FROM ROW(OLD.review_conclusion, OLD.review_comment, OLD.reviewed_by, OLD.reviewed_at) THEN
    IF OLD.submitted_at IS NULL OR q_status NOT IN ('submitted', 'under_review') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: an answer is reviewed only after the questionnaire is submitted, until the review is closed';
    END IF;
    IF NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_answers: the assessment is frozen, so the review cannot change';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_answers_guard ON tp_answers;
CREATE TRIGGER tp_answers_guard BEFORE INSERT OR UPDATE OR DELETE ON tp_answers
  FOR EACH ROW EXECUTE FUNCTION tp_answers_guard_fn();

CREATE TABLE IF NOT EXISTS tp_answer_evidence (
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id bigint NOT NULL,
  answer_id bigint NOT NULL,
  evidence_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, answer_id, evidence_id),
  CONSTRAINT tp_answer_evidence_answer_fk FOREIGN KEY (workspace_id, assessment_id, answer_id)
    REFERENCES tp_answers (workspace_id, assessment_id, id) ON DELETE CASCADE,
  CONSTRAINT tp_answer_evidence_evidence_fk FOREIGN KEY (workspace_id, assessment_id, evidence_id)
    REFERENCES tp_evidence (workspace_id, assessment_id, id)
);
CREATE INDEX IF NOT EXISTS idx_tp_answer_evidence_evidence ON tp_answer_evidence (workspace_id, evidence_id);

CREATE OR REPLACE FUNCTION tp_answer_evidence_guard_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  ws bigint;
  ans bigint;
  ev bigint;
  a_submitted timestamptz;
  q_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_answer_evidence: a link between an answer and a file is added or removed, never changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    ws := OLD.workspace_id; ans := OLD.answer_id; ev := OLD.evidence_id;
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ws) THEN
      RETURN OLD;
    END IF;
  ELSE
    ws := NEW.workspace_id; ans := NEW.answer_id; ev := NEW.evidence_id;
  END IF;
  SELECT a.submitted_at, q.status INTO a_submitted, q_status
    FROM tp_answers a JOIN tp_questionnaires q ON q.workspace_id = a.workspace_id AND q.id = a.questionnaire_id
   WHERE a.workspace_id = ws AND a.id = ans;
  IF FOUND AND (a_submitted IS NOT NULL OR q_status NOT IN ('sent', 'in_progress')) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_answer_evidence: answers are locked once the questionnaire is submitted';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM tp_evidence WHERE workspace_id = ws AND id = ev AND source = 'vendor') THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_answer_evidence: an answer cites only files the third party uploaded';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_answer_evidence_guard ON tp_answer_evidence;
CREATE TRIGGER tp_answer_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON tp_answer_evidence
  FOR EACH ROW EXECUTE FUNCTION tp_answer_evidence_guard_fn();

-- ---- clarifications -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tp_clarifications (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id bigint NOT NULL,
  questionnaire_id bigint NOT NULL,
  question_id text NOT NULL CHECK (question_id ~ '^[A-Z]{2,6}-[0-9]{1,4}$'),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  asked_by bigint,
  asked_at timestamptz NOT NULL DEFAULT now(),
  response text CHECK (length(response) <= 4000),
  response_evidence_id bigint,
  responded_at timestamptz,
  responded_by_request_id bigint,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  closed_by bigint,
  closed_at timestamptz,
  close_note text CHECK (length(close_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT tp_clarifications_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT tp_clarifications_questionnaire_fk FOREIGN KEY (workspace_id, assessment_id, questionnaire_id)
    REFERENCES tp_questionnaires (workspace_id, assessment_id, id),
  CONSTRAINT tp_clarifications_evidence_fk FOREIGN KEY (workspace_id, assessment_id, response_evidence_id)
    REFERENCES tp_evidence (workspace_id, assessment_id, id),
  CONSTRAINT tp_clarifications_request_fk FOREIGN KEY (workspace_id, questionnaire_id, responded_by_request_id)
    REFERENCES tp_vendor_requests (workspace_id, questionnaire_id, id),
  CONSTRAINT tp_clarifications_response CHECK (
    (response IS NULL AND responded_at IS NULL AND response_evidence_id IS NULL AND responded_by_request_id IS NULL)
    OR (length(btrim(COALESCE(response, ''))) > 0 AND responded_at IS NOT NULL)),
  CONSTRAINT tp_clarifications_state CHECK (
    (status = 'open' AND responded_at IS NULL AND closed_at IS NULL)
    OR (status = 'answered' AND responded_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tp_clarifications_questionnaire ON tp_clarifications (workspace_id, questionnaire_id, id);

CREATE OR REPLACE FUNCTION tp_clarifications_guard_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  q_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_clarifications: a clarification is never deleted (it is closed instead)';
  END IF;
  SELECT status INTO q_status FROM tp_questionnaires WHERE workspace_id = NEW.workspace_id AND id = NEW.questionnaire_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_clarifications: a clarification starts open';
    END IF;
    IF q_status IS NULL OR q_status NOT IN ('submitted', 'under_review') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_clarifications: clarifications are asked once the questionnaire is submitted, until the review is closed';
    END IF;
    IF NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_clarifications: the assessment is frozen, so no clarification can be asked';
    END IF;
    IF NOT tp_q_has_question(NEW.workspace_id, NEW.questionnaire_id, NEW.question_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_clarifications: ' || NEW.question_id || ' is not a question of this questionnaire';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE.
  IF ROW(NEW.id, NEW.workspace_id, NEW.assessment_id, NEW.questionnaire_id, NEW.question_id, NEW.body, NEW.asked_by, NEW.asked_at, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.assessment_id, OLD.questionnaire_id, OLD.question_id, OLD.body, OLD.asked_by, OLD.asked_at, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_clarifications: the question asked never changes';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_clarifications: a closed clarification cannot be changed';
  END IF;
  IF ROW(NEW.response, NEW.response_evidence_id, NEW.responded_at, NEW.responded_by_request_id)
     IS DISTINCT FROM ROW(OLD.response, OLD.response_evidence_id, OLD.responded_at, OLD.responded_by_request_id) THEN
    IF OLD.status <> 'open' OR NEW.status <> 'answered' THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_clarifications: the third party answers an open clarification once';
    END IF;
    IF q_status NOT IN ('submitted', 'under_review') OR NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_clarifications: this clarification can no longer be answered';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('answered', 'closed'))
    OR (OLD.status = 'answered' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_clarifications: ' || OLD.status || ' cannot become ' || NEW.status;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_clarifications_guard ON tp_clarifications;
CREATE TRIGGER tp_clarifications_guard BEFORE INSERT OR UPDATE OR DELETE ON tp_clarifications
  FOR EACH ROW EXECUTE FUNCTION tp_clarifications_guard_fn();

-- ---- the questionnaire guard (replaces 099's) ---------------------------------

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

  -- UPDATE.
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

  -- Submission: from sent or in progress, every question answered.
  IF NEW.status = 'submitted' AND OLD.status <> 'submitted' THEN
    IF OLD.status NOT IN ('sent', 'in_progress') OR NEW.submitted_at IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: only a questionnaire being answered is submitted';
    END IF;
    IF EXISTS (SELECT 1 FROM tp_q_section_ids(NEW.sections) AS i
       WHERE NOT EXISTS (SELECT 1 FROM tp_answers a
         WHERE a.workspace_id = NEW.workspace_id AND a.questionnaire_id = NEW.id AND a.question_id = i
           AND a.response IS NOT NULL AND a.submitted_at IS NOT NULL
           AND (a.prefilled_from_answer_id IS NULL OR a.prefill_confirmed_at IS NOT NULL))) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: every question must be answered before the questionnaire is submitted';
    END IF;
  END IF;

  -- Closing as reviewed: every answer concluded, no clarification left open.
  IF NEW.status = 'closed' AND NEW.closed_reason = 'Reviewed' THEN
    IF OLD.status NOT IN ('submitted', 'under_review') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: only a submitted questionnaire is closed as reviewed';
    END IF;
    IF EXISTS (SELECT 1 FROM tp_answers a WHERE a.workspace_id = NEW.workspace_id AND a.questionnaire_id = NEW.id
         AND a.review_conclusion = 'not_reviewed') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: every answer needs a reviewer conclusion before the review is closed';
    END IF;
    IF EXISTS (SELECT 1 FROM tp_clarifications c WHERE c.workspace_id = NEW.workspace_id AND c.questionnaire_id = NEW.id
         AND c.status <> 'closed') THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_questionnaires: close every clarification before the review is closed';
    END IF;
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
      -- The one change allowed after send: the dynamic AI Services module.
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
