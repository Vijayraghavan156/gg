CREATE TABLE IF NOT EXISTS tp_answer_comments (
  id bigserial PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  questionnaire_id bigint NOT NULL,
  question_id text NOT NULL CHECK (question_id ~ '^[A-Z]{2,6}-[0-9]{1,4}$'),
  author_kind text NOT NULL CHECK (author_kind IN ('third_party', 'firm')),
  person_id bigint REFERENCES tp_vendor_people(id),
  request_id bigint,
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  author_name text CHECK (length(author_name) <= 200),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tp_answer_comments_questionnaire_fk FOREIGN KEY (workspace_id, questionnaire_id) REFERENCES tp_questionnaires(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tp_answer_comments_question ON tp_answer_comments (workspace_id, questionnaire_id, question_id, id);
