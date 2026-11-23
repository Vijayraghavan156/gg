CREATE TABLE IF NOT EXISTS tp_vendor_people (
  id bigserial PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  third_party_id bigint NOT NULL,
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 200 AND position('@' IN email) > 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  job_title text CHECK (length(job_title) <= 200),
  phone text CHECK (length(phone) <= 60),
  role text NOT NULL DEFAULT 'colleague' CHECK (role IN ('main', 'colleague')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  added_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  added_by_person_id bigint REFERENCES tp_vendor_people(id) ON DELETE SET NULL,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT tp_vendor_people_tp_fk FOREIGN KEY (workspace_id, third_party_id) REFERENCES tp_third_parties(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT tp_vendor_people_removed CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS tp_vendor_people_email ON tp_vendor_people (workspace_id, third_party_id, email) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS tp_vendor_people_main ON tp_vendor_people (workspace_id, third_party_id) WHERE status = 'active' AND role = 'main';
CREATE INDEX IF NOT EXISTS tp_vendor_people_by_email ON tp_vendor_people (email) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS tp_vendor_codes (
  id bigserial PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 200),
  code_hash text NOT NULL CHECK (length(code_hash) = 64),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tp_vendor_codes_email ON tp_vendor_codes (email, created_at DESC);

CREATE TABLE IF NOT EXISTS tp_vendor_sessions (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  firm_id bigint NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 200),
  person_id bigint REFERENCES tp_vendor_people(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS tp_vendor_sessions_email ON tp_vendor_sessions (firm_id, email) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS tp_vendor_assignments (
  id bigserial PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id bigint NOT NULL,
  section_title text NOT NULL CHECK (length(section_title) BETWEEN 1 AND 300),
  person_id bigint NOT NULL REFERENCES tp_vendor_people(id) ON DELETE CASCADE,
  assigned_by_person_id bigint REFERENCES tp_vendor_people(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tp_vendor_assignments_assessment_fk FOREIGN KEY (workspace_id, assessment_id) REFERENCES tp_assessments(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT tp_vendor_assignments_one UNIQUE (workspace_id, assessment_id, section_title)
);

ALTER TABLE tp_answers ADD COLUMN IF NOT EXISTS saved_by_person_id bigint REFERENCES tp_vendor_people(id) ON DELETE SET NULL;
ALTER TABLE tp_clarifications ADD COLUMN IF NOT EXISTS responded_by_person_id bigint REFERENCES tp_vendor_people(id) ON DELETE SET NULL;
ALTER TABLE tp_issue_messages ADD COLUMN IF NOT EXISTS author_person_id bigint REFERENCES tp_vendor_people(id) ON DELETE SET NULL;
ALTER TABLE tp_condition_proofs ADD COLUMN IF NOT EXISTS submitted_by_person_id bigint REFERENCES tp_vendor_people(id) ON DELETE SET NULL;

INSERT INTO tp_vendor_people (workspace_id, third_party_id, email, name, role)
SELECT DISTINCT ON (src.workspace_id, src.third_party_id) src.workspace_id, src.third_party_id, src.email, src.name, 'main'
FROM (
  SELECT t.workspace_id, t.id AS third_party_id, lower(trim(t.primary_contact_email)) AS email,
    COALESCE(NULLIF(trim(t.primary_contact_name), ''), lower(trim(t.primary_contact_email))) AS name, 0 AS pref, now() AS at
  FROM tp_third_parties t
  WHERE t.primary_contact_email IS NOT NULL AND position('@' IN trim(t.primary_contact_email)) > 1
  UNION ALL
  SELECT r.workspace_id, a.third_party_id, lower(trim(r.recipient_email)), COALESCE(NULLIF(trim(r.recipient_name), ''), lower(trim(r.recipient_email))), 1, r.created_at
  FROM tp_vendor_requests r
  JOIN tp_assessments a ON a.workspace_id = r.workspace_id AND a.id = r.assessment_id
  WHERE r.recipient_email IS NOT NULL AND position('@' IN trim(r.recipient_email)) > 1
) src
WHERE length(src.email) <= 200 AND length(src.name) <= 200
  AND NOT EXISTS (SELECT 1 FROM tp_vendor_people p WHERE p.workspace_id = src.workspace_id AND p.third_party_id = src.third_party_id AND p.status = 'active')
ORDER BY src.workspace_id, src.third_party_id, src.pref, src.at DESC;
