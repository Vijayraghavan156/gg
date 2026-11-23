'use strict';

// Third-party risk (TPRM) v2: question bank version 2, written answers, and
// the evidence waiver from an ISO 27001 certificate or a SOC 2 Type II report
// (product decisions, 22 Nov 2026; docs/tprm-v2-spec.md section 4k).
// Migrations 083-115 are applied and frozen; this one adds objects, widens one
// CHECK and publishes one bank version.
//
// 1. The bank. data/tprm-question-bank.json now holds version 2: every
//    question carries answer_type (yes_no_na | free_text), evidence_on (yes |
//    no | answer), explain_on, report_coverage (iso | soc2 | either | both |
//    none), report_partly_supported and benchmark (firm only), with the 32
//    rewordings and the evidence flag changes. It is published here as the
//    next version unless a row already holds these exact bytes. Migration 099
//    publishes the same file as version 1 on a database created after this
//    change, so there it is a no-op: such a database has one version, with
//    answer types. Every rule keys on the pinned bank's content (a question
//    with answer_type), never on the version number. Questionnaires keep the
//    version they pinned: one prepared on a bank without answer types keeps
//    Yes / Partially / No / Not applicable exactly as before.
//
// 2. tp_answers: response 'text' is a written answer to a free_text question,
//    held in detail (the 4,000-character column). The new trigger
//    tp_answers_types (after 100's tp_answers_guard) holds the answer types
//    of the pinned bank: a yes_no_na question takes yes / no / na (never
//    partial), a free_text question takes text / na, and a question of a bank
//    without answer types never takes text. The detail rule moves into the
//    same trigger because it now depends on the question: a bank without
//    answer types needs detail for Partially, No and Not applicable as before;
//    a bank with them needs it for the question's explain_on answers (No and
//    N/A by default; PFR-02 and AIM-08: Yes and N/A) and for a written
//    answer. tp_answers_detail keeps the part that holds for every question
//    (Partially and a written answer always carry detail).
//
// 3. tp_assurance_reports: the third party's ISO 27001 certificate (with its
//    Statement of Applicability, expiry and scope) and SOC 2 Type II report
//    (with its period end and an optional bridge letter), one of each per
//    questionnaire. The files are ordinary third-party files (tp_evidence,
//    source vendor, the same upload limits and storage). The third party adds,
//    changes or removes a report only while it answers; the consultant
//    accepts or rejects it once, after submission and while the assessment is
//    not frozen, with the checks, a reason and (SOC 2, accepted) the question
//    ids affected by exceptions. A decision never changes. Closing the review
//    as "Reviewed" needs every report checked (tp_questionnaires_reports).
//
// 4. tp_evidence_waivers: a consultant's extra waiver of the evidence on one
//    further question, against an accepted SOC 2 report, with a note naming
//    the report section; withdrawn once at most, never edited. One active
//    waiver per question.
//
// 5. tp_clarifications: raised_for and report_id mark a clarification the
//    firm raised because a report was rejected or a SOC 2 exception affects
//    the question (the third party is asked for the evidence after all); set
//    at insert, never changed.
//
// Like the other TPRM guards, a delete passes once the workspace row itself
// is gone, and lib/workspace-deletion.js suspends the guards when it purges a
// client. User columns carry no foreign key (migration 086).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BANK_FILE = path.join(__dirname, '..', 'data', 'tprm-question-bank.json');

const DDL = `
-- ---- written answers and the answer types of the pinned bank ---------------

ALTER TABLE tp_answers DROP CONSTRAINT IF EXISTS tp_answers_response_check;
ALTER TABLE tp_answers ADD CONSTRAINT tp_answers_response_check
  CHECK (response IN ('yes', 'partial', 'no', 'na', 'text'));
ALTER TABLE tp_answers DROP CONSTRAINT IF EXISTS tp_answers_detail;
ALTER TABLE tp_answers ADD CONSTRAINT tp_answers_detail
  CHECK (response IS NULL OR response IN ('yes', 'no', 'na') OR length(btrim(COALESCE(detail, ''))) > 0);

-- One question of a published bank version, or NULL.
CREATE OR REPLACE FUNCTION tp_bank_question(p_bank_version_id bigint, p_question_id text) RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
  SELECT r FROM tp_question_bank_versions b, jsonb_array_elements(b.content->'questions') AS q(r)
   WHERE b.id = p_bank_version_id AND r->>'id' = p_question_id
   LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION tp_answers_types_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  bank_id bigint;
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
  SELECT bank_version_id INTO bank_id FROM tp_questionnaires WHERE workspace_id = NEW.workspace_id AND id = NEW.questionnaire_id;
  question := tp_bank_question(bank_id, NEW.question_id);
  answer_type := question->>'answer_type';
  has_detail := length(btrim(COALESCE(NEW.detail, ''))) > 0;
  IF answer_type IS NULL THEN
    IF NEW.response IN ('partial', 'no', 'na') AND NOT has_detail THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation',
        MESSAGE = 'tp_answers_detail: ' || NEW.question_id || ' needs supporting detail for Partially, No and Not applicable';
    END IF;
    IF NEW.response = 'text' THEN
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
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_answers: ' || NEW.question_id || ' has an unknown answer type in its question bank';
  END IF;
  IF answer_type IS NOT NULL AND NEW.response <> 'text' THEN
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
DROP TRIGGER IF EXISTS tp_answers_types ON tp_answers;
CREATE TRIGGER tp_answers_types BEFORE INSERT OR UPDATE OF response, detail ON tp_answers
  FOR EACH ROW EXECUTE FUNCTION tp_answers_types_fn();

-- ---- assurance reports -------------------------------------------------------

CREATE TABLE IF NOT EXISTS tp_assurance_reports (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id bigint NOT NULL,
  questionnaire_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('iso27001', 'soc2_type2')),
  evidence_id bigint NOT NULL,
  soa_evidence_id bigint,
  bridge_evidence_id bigint,
  certificate_expires_on date,
  scope text CHECK (length(scope) <= 2000),
  period_end date,
  uploaded_by_request_id bigint NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  check_status text NOT NULL DEFAULT 'pending' CHECK (check_status IN ('pending', 'accepted', 'rejected')),
  check_in_date boolean,
  check_scope boolean,
  check_opinion boolean,
  check_period boolean,
  check_reason text CHECK (length(check_reason) <= 2000),
  exception_question_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(exception_question_ids) = 'array' AND jsonb_array_length(exception_question_ids) <= 400),
  checked_by bigint,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT tp_assurance_reports_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT tp_assurance_reports_questionnaire_id_key UNIQUE (workspace_id, questionnaire_id, id),
  CONSTRAINT tp_assurance_reports_one_per_kind UNIQUE (workspace_id, questionnaire_id, kind),
  CONSTRAINT tp_assurance_reports_questionnaire_fk FOREIGN KEY (workspace_id, assessment_id, questionnaire_id)
    REFERENCES tp_questionnaires (workspace_id, assessment_id, id),
  CONSTRAINT tp_assurance_reports_evidence_fk FOREIGN KEY (workspace_id, assessment_id, evidence_id)
    REFERENCES tp_evidence (workspace_id, assessment_id, id),
  CONSTRAINT tp_assurance_reports_soa_fk FOREIGN KEY (workspace_id, assessment_id, soa_evidence_id)
    REFERENCES tp_evidence (workspace_id, assessment_id, id),
  CONSTRAINT tp_assurance_reports_bridge_fk FOREIGN KEY (workspace_id, assessment_id, bridge_evidence_id)
    REFERENCES tp_evidence (workspace_id, assessment_id, id),
  CONSTRAINT tp_assurance_reports_request_fk FOREIGN KEY (workspace_id, questionnaire_id, uploaded_by_request_id)
    REFERENCES tp_vendor_requests (workspace_id, questionnaire_id, id),
  CONSTRAINT tp_assurance_reports_fields CHECK (
    (kind = 'iso27001' AND soa_evidence_id IS NOT NULL AND certificate_expires_on IS NOT NULL
      AND length(btrim(COALESCE(scope, ''))) > 0 AND period_end IS NULL AND bridge_evidence_id IS NULL)
    OR (kind = 'soc2_type2' AND period_end IS NOT NULL AND soa_evidence_id IS NULL
      AND certificate_expires_on IS NULL AND scope IS NULL)),
  CONSTRAINT tp_assurance_reports_decision CHECK (
    (check_status = 'pending' AND checked_by IS NULL AND checked_at IS NULL AND check_reason IS NULL
      AND check_in_date IS NULL AND check_scope IS NULL AND check_opinion IS NULL AND check_period IS NULL
      AND jsonb_array_length(exception_question_ids) = 0)
    OR (check_status IN ('accepted', 'rejected') AND checked_by IS NOT NULL AND checked_at IS NOT NULL
      AND length(btrim(COALESCE(check_reason, ''))) > 0
      AND check_in_date IS NOT NULL AND check_scope IS NOT NULL
      AND ((kind = 'iso27001' AND check_opinion IS NULL AND check_period IS NULL)
        OR (kind = 'soc2_type2' AND check_opinion IS NOT NULL AND check_period IS NOT NULL)))),
  -- Accepted only when every check passed.
  CONSTRAINT tp_assurance_reports_accepted CHECK (check_status <> 'accepted'
    OR (check_in_date AND check_scope AND (kind = 'iso27001' OR (check_opinion AND check_period)))),
  -- Exceptions: an accepted SOC 2 report only.
  CONSTRAINT tp_assurance_reports_exceptions CHECK (jsonb_array_length(exception_question_ids) = 0
    OR (kind = 'soc2_type2' AND check_status = 'accepted'))
);
CREATE INDEX IF NOT EXISTS idx_tp_assurance_reports_questionnaire ON tp_assurance_reports (workspace_id, questionnaire_id);

-- Whether a file is the third party's own, uploaded through one of this
-- questionnaire's links.
CREATE OR REPLACE FUNCTION tp_vendor_file_of(p_workspace_id bigint, p_questionnaire_id bigint, p_evidence_id bigint) RETURNS boolean
LANGUAGE sql STABLE
AS $fn$
  SELECT p_evidence_id IS NULL OR EXISTS (SELECT 1 FROM tp_evidence e
    JOIN tp_vendor_requests r ON r.workspace_id = e.workspace_id AND r.id = e.vendor_request_id
    WHERE e.workspace_id = p_workspace_id AND e.id = p_evidence_id AND e.source = 'vendor' AND r.questionnaire_id = p_questionnaire_id)
$fn$;

CREATE OR REPLACE FUNCTION tp_assurance_reports_guard_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  q_status text;
  r tp_assurance_reports;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    SELECT status INTO q_status FROM tp_questionnaires WHERE workspace_id = OLD.workspace_id AND id = OLD.questionnaire_id;
    IF q_status IS NULL OR q_status NOT IN ('sent', 'in_progress') OR OLD.check_status <> 'pending'
       OR NOT tp_questionnaire_stage_ok(OLD.workspace_id, OLD.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assurance_reports: a report is removed only by the third party while it answers';
    END IF;
    RETURN OLD;
  END IF;

  r := NEW;
  SELECT status INTO q_status FROM tp_questionnaires WHERE workspace_id = r.workspace_id AND id = r.questionnaire_id;
  IF NOT (tp_vendor_file_of(r.workspace_id, r.questionnaire_id, r.evidence_id)
      AND tp_vendor_file_of(r.workspace_id, r.questionnaire_id, r.soa_evidence_id)
      AND tp_vendor_file_of(r.workspace_id, r.questionnaire_id, r.bridge_evidence_id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_assurance_reports: a report''s files are the third party''s own files on this questionnaire';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF r.check_status <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assurance_reports: a report starts unchecked';
    END IF;
    IF q_status IS NULL OR q_status NOT IN ('sent', 'in_progress') OR NOT tp_questionnaire_stage_ok(r.workspace_id, r.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assurance_reports: reports are added only while the questionnaire is being answered';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE.
  IF ROW(NEW.id, NEW.workspace_id, NEW.assessment_id, NEW.questionnaire_id, NEW.kind, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.assessment_id, OLD.questionnaire_id, OLD.kind, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_assurance_reports: the questionnaire and kind of a report never change';
  END IF;
  IF ROW(NEW.evidence_id, NEW.soa_evidence_id, NEW.bridge_evidence_id, NEW.certificate_expires_on, NEW.scope, NEW.period_end,
         NEW.uploaded_by_request_id, NEW.uploaded_at)
     IS DISTINCT FROM ROW(OLD.evidence_id, OLD.soa_evidence_id, OLD.bridge_evidence_id, OLD.certificate_expires_on, OLD.scope, OLD.period_end,
         OLD.uploaded_by_request_id, OLD.uploaded_at) THEN
    IF q_status NOT IN ('sent', 'in_progress') OR OLD.check_status <> 'pending'
       OR NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assurance_reports: a report is locked once the questionnaire is submitted';
    END IF;
  END IF;
  IF ROW(NEW.check_status, NEW.check_in_date, NEW.check_scope, NEW.check_opinion, NEW.check_period, NEW.check_reason,
         NEW.exception_question_ids, NEW.checked_by, NEW.checked_at)
     IS DISTINCT FROM ROW(OLD.check_status, OLD.check_in_date, OLD.check_scope, OLD.check_opinion, OLD.check_period, OLD.check_reason,
         OLD.exception_question_ids, OLD.checked_by, OLD.checked_at) THEN
    IF OLD.check_status <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assurance_reports: a report is checked once; the decision never changes';
    END IF;
    IF q_status NOT IN ('submitted', 'under_review') OR NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assurance_reports: a report is checked after submission, while the assessment is not frozen';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW.exception_question_ids) AS x(i)
       WHERE NOT tp_q_has_question(NEW.workspace_id, NEW.questionnaire_id, i)) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_assurance_reports: an exception names a question that is not in this questionnaire';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_assurance_reports_guard ON tp_assurance_reports;
CREATE TRIGGER tp_assurance_reports_guard BEFORE INSERT OR UPDATE OR DELETE ON tp_assurance_reports
  FOR EACH ROW EXECUTE FUNCTION tp_assurance_reports_guard_fn();

-- ---- extra waivers --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tp_evidence_waivers (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id bigint NOT NULL,
  questionnaire_id bigint NOT NULL,
  report_id bigint NOT NULL,
  question_id text NOT NULL CHECK (question_id ~ '^[A-Z]{2,6}-[0-9]{1,4}$'),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_by bigint,
  withdrawn_at timestamptz,
  withdraw_reason text CHECK (length(withdraw_reason) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT tp_evidence_waivers_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT tp_evidence_waivers_questionnaire_fk FOREIGN KEY (workspace_id, assessment_id, questionnaire_id)
    REFERENCES tp_questionnaires (workspace_id, assessment_id, id),
  CONSTRAINT tp_evidence_waivers_report_fk FOREIGN KEY (workspace_id, questionnaire_id, report_id)
    REFERENCES tp_assurance_reports (workspace_id, questionnaire_id, id),
  CONSTRAINT tp_evidence_waivers_withdrawn CHECK (
    (withdrawn_at IS NULL AND withdrawn_by IS NULL AND withdraw_reason IS NULL)
    OR (withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL AND length(btrim(COALESCE(withdraw_reason, ''))) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS tp_evidence_waivers_one_active
  ON tp_evidence_waivers (workspace_id, questionnaire_id, question_id) WHERE withdrawn_at IS NULL;

CREATE OR REPLACE FUNCTION tp_evidence_waivers_guard_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  q_status text;
  rep tp_assurance_reports;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_evidence_waivers: a waiver is never deleted (it is withdrawn instead)';
  END IF;
  SELECT status INTO q_status FROM tp_questionnaires WHERE workspace_id = NEW.workspace_id AND id = NEW.questionnaire_id;
  IF q_status IS NULL OR q_status NOT IN ('submitted', 'under_review') OR NOT tp_questionnaire_stage_ok(NEW.workspace_id, NEW.assessment_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_evidence_waivers: waivers change only during the review of the answers, while the assessment is not frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO rep FROM tp_assurance_reports WHERE workspace_id = NEW.workspace_id AND id = NEW.report_id;
    IF rep.kind IS DISTINCT FROM 'soc2_type2' OR rep.check_status IS DISTINCT FROM 'accepted' THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_evidence_waivers: an extra waiver needs an accepted SOC 2 Type II report';
    END IF;
    IF rep.exception_question_ids @> jsonb_build_array(NEW.question_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_evidence_waivers: ' || NEW.question_id || ' is affected by an exception in the SOC 2 report';
    END IF;
    IF NOT tp_q_has_question(NEW.workspace_id, NEW.questionnaire_id, NEW.question_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_evidence_waivers: ' || NEW.question_id || ' is not a question of this questionnaire';
    END IF;
    IF NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
        MESSAGE = 'tp_evidence_waivers: a waiver starts active';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.workspace_id, NEW.assessment_id, NEW.questionnaire_id, NEW.report_id, NEW.question_id, NEW.note,
         NEW.created_by, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.assessment_id, OLD.questionnaire_id, OLD.report_id, OLD.question_id, OLD.note,
         OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_evidence_waivers: a waiver is never edited (withdraw it and add a new one)';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_evidence_waivers: a withdrawn waiver cannot be changed';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_evidence_waivers_guard ON tp_evidence_waivers;
CREATE TRIGGER tp_evidence_waivers_guard BEFORE INSERT OR UPDATE OR DELETE ON tp_evidence_waivers
  FOR EACH ROW EXECUTE FUNCTION tp_evidence_waivers_guard_fn();

-- ---- clarifications raised by a report decision ----------------------------------

ALTER TABLE tp_clarifications ADD COLUMN IF NOT EXISTS raised_for text;
ALTER TABLE tp_clarifications ADD COLUMN IF NOT EXISTS report_id bigint;
ALTER TABLE tp_clarifications DROP CONSTRAINT IF EXISTS tp_clarifications_raised_for;
ALTER TABLE tp_clarifications ADD CONSTRAINT tp_clarifications_raised_for CHECK (
  (raised_for IS NULL AND report_id IS NULL)
  OR (raised_for IN ('report_rejected', 'report_exception') AND report_id IS NOT NULL));
ALTER TABLE tp_clarifications DROP CONSTRAINT IF EXISTS tp_clarifications_report_fk;
ALTER TABLE tp_clarifications ADD CONSTRAINT tp_clarifications_report_fk FOREIGN KEY (workspace_id, questionnaire_id, report_id)
  REFERENCES tp_assurance_reports (workspace_id, questionnaire_id, id);

CREATE OR REPLACE FUNCTION tp_clarifications_origin_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF ROW(NEW.raised_for, NEW.report_id) IS DISTINCT FROM ROW(OLD.raised_for, OLD.report_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_clarifications: why a clarification was raised never changes';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_clarifications_origin ON tp_clarifications;
CREATE TRIGGER tp_clarifications_origin BEFORE UPDATE ON tp_clarifications
  FOR EACH ROW EXECUTE FUNCTION tp_clarifications_origin_fn();

-- ---- closing the review needs every report checked -------------------------------

CREATE OR REPLACE FUNCTION tp_questionnaires_reports_fn() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' AND NEW.closed_reason = 'Reviewed'
     AND EXISTS (SELECT 1 FROM tp_assurance_reports r WHERE r.workspace_id = NEW.workspace_id AND r.questionnaire_id = NEW.id
       AND r.check_status = 'pending') THEN
    RAISE EXCEPTION USING ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'tp_questionnaires: check every ISO 27001 certificate and SOC 2 report before the review is closed';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS tp_questionnaires_reports ON tp_questionnaires;
CREATE TRIGGER tp_questionnaires_reports BEFORE UPDATE OF status ON tp_questionnaires
  FOR EACH ROW EXECUTE FUNCTION tp_questionnaires_reports_fn();
`;

async function up(db) {
  await db.exec(DDL);
  const raw = fs.readFileSync(BANK_FILE);
  const bank = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(bank.questions) || !bank.questions.length) throw new Error('data/tprm-question-bank.json has no questions');
  if (!bank.questions.every(q => ['yes_no_na', 'free_text'].includes(q.answer_type))) {
    throw new Error('migration 116 publishes a bank whose every question has an answer type');
  }
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  const same = await db.prepare('SELECT version FROM tp_question_bank_versions WHERE content_sha256 = ?').get(sha);
  if (same) return; // published already (a database created after this change: migration 099 read the same file)
  const last = await db.prepare('SELECT COALESCE(MAX(version), 0)::int AS v FROM tp_question_bank_versions').get();
  await db.prepare(`INSERT INTO tp_question_bank_versions (version, label, source, content, content_sha256, question_count)
    VALUES (?, ?, ?, ?::jsonb, ?, ?)`)
    .run(last.v + 1, String(bank.version || `Version ${last.v + 1}`).slice(0, 200), bank.source ? String(bank.source).slice(0, 1000) : null,
      JSON.stringify(bank), sha, bank.questions.length);
}

module.exports = { up };
