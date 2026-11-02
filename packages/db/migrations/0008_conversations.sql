-- 0008: private chat history and answer feedback (FR-AST-03, FR-AST-04). Each row is visible only to
-- its owner, so admins cannot read them through the app. Text is stored only as AES-GCM ciphertext.
CREATE TABLE conversations (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  title_ciphertext  text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX conversations_owner_time_idx ON conversations (tenant_id, user_id, updated_at DESC);

CREATE TABLE conversation_messages (
  id                  uuid PRIMARY KEY,
  conversation_id     uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL,
  user_id             uuid NOT NULL,
  role                text NOT NULL CHECK (role IN ('user', 'assistant')),
  payload_ciphertext  text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_messages_order_idx ON conversation_messages (conversation_id, created_at);

CREATE TABLE message_feedback (
  message_id         uuid PRIMARY KEY REFERENCES conversation_messages (id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL,
  user_id            uuid NOT NULL,
  rating             text NOT NULL CHECK (rating IN ('up', 'down')),
  reason_ciphertext  text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON conversations
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());

ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON conversation_messages
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());

ALTER TABLE message_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_feedback FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON message_feedback
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());

GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO brain_app;
GRANT SELECT, INSERT, DELETE ON conversation_messages TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON message_feedback TO brain_app;
