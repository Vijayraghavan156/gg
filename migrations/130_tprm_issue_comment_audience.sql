ALTER TABLE tp_issue_messages DROP CONSTRAINT IF EXISTS tp_issue_messages_author_kind_check;
ALTER TABLE tp_issue_messages ADD CONSTRAINT tp_issue_messages_author_kind_check CHECK (author_kind IN ('firm', 'third_party', 'client'));
ALTER TABLE tp_issue_messages ADD COLUMN IF NOT EXISTS internal boolean NOT NULL DEFAULT false;
ALTER TABLE tp_issue_messages ADD COLUMN IF NOT EXISTS client_visible boolean NOT NULL DEFAULT false;
ALTER TABLE tp_issue_messages ALTER COLUMN client_visible SET DEFAULT true;
ALTER TABLE tp_issue_messages DROP CONSTRAINT IF EXISTS tp_issue_messages_internal_firm;
ALTER TABLE tp_issue_messages ADD CONSTRAINT tp_issue_messages_internal_firm CHECK (NOT internal OR (author_kind = 'firm' AND NOT client_visible));
ALTER TABLE tp_issue_messages DROP CONSTRAINT IF EXISTS tp_issue_messages_client_author;
ALTER TABLE tp_issue_messages ADD CONSTRAINT tp_issue_messages_client_author CHECK (author_kind <> 'client' OR (author_user_id IS NOT NULL AND client_visible));
