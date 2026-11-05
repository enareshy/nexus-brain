-- 0018: skills, named instructions with a set of agent tools that a person can reuse (FR-AST-08).
-- A skill belongs to the person who wrote it, who alone can change or delete it. Shared, it can be
-- used by anyone in the same company, never by another company. The name and instructions are
-- sealed with the app's key; the tools are names from the agent's fixed list.
CREATE TABLE skills (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL,
  user_id                 uuid NOT NULL,
  name_ciphertext         text NOT NULL,
  instructions_ciphertext text NOT NULL,
  tools                   text[] NOT NULL CHECK (cardinality(tools) BETWEEN 1 AND 10),
  shared                  boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX skills_tenant_idx ON skills (tenant_id, user_id, created_at);

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills FORCE  ROW LEVEL SECURITY;
-- Seen by its owner, and by colleagues once shared.
CREATE POLICY read_own_or_shared ON skills FOR SELECT
  USING (tenant_id = app_current_tenant() AND (user_id = app_current_user() OR shared));
CREATE POLICY owner_insert ON skills FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
CREATE POLICY owner_update ON skills FOR UPDATE
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
CREATE POLICY owner_delete ON skills FOR DELETE
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON skills TO brain_app;

CREATE TRIGGER require_active_user BEFORE INSERT ON skills
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
