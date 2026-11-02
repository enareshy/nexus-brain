-- 0015: things a person asked Brain to remember about them (FR-AST-07). Private to that person, like
-- their conversations. Only text the person typed is stored, sealed with the app's key. Deleting a row
-- deletes the memory: it is read fresh for each request and never copied anywhere else.
CREATE TABLE memories (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  text_ciphertext text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX memories_owner_idx ON memories (tenant_id, user_id, created_at);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON memories
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO brain_app;

CREATE TRIGGER require_active_user BEFORE INSERT ON memories
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
