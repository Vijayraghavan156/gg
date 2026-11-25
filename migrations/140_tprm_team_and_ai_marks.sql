ALTER TABLE tp_third_parties ADD COLUMN IF NOT EXISTS team_owner_id bigint REFERENCES users(id);
ALTER TABLE tp_third_parties ADD COLUMN IF NOT EXISTS team_reviewer_id bigint REFERENCES users(id);
ALTER TABLE tp_third_parties DROP CONSTRAINT IF EXISTS tp_third_parties_team_two_people;
ALTER TABLE tp_third_parties ADD CONSTRAINT tp_third_parties_team_two_people
  CHECK (team_owner_id IS NULL OR team_reviewer_id IS NULL OR team_owner_id <> team_reviewer_id);
ALTER TABLE tp_ai_reviews ADD COLUMN IF NOT EXISTS documents jsonb;
ALTER TABLE tp_ai_reviews DROP CONSTRAINT IF EXISTS tp_ai_reviews_documents_shape;
ALTER TABLE tp_ai_reviews ADD CONSTRAINT tp_ai_reviews_documents_shape
  CHECK (documents IS NULL OR jsonb_typeof(documents) = 'array');
