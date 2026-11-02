-- 0009: makes the database itself refuse a message or feedback row whose owner differs from its parent's.
-- Foreign key checks skip RLS, so a bug elsewhere could otherwise put one person's row in another's history.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_owner_key UNIQUE (id, tenant_id, user_id);
ALTER TABLE conversation_messages
  ADD CONSTRAINT conversation_messages_owner_key UNIQUE (id, tenant_id, user_id);

ALTER TABLE conversation_messages
  DROP CONSTRAINT conversation_messages_conversation_id_fkey,
  ADD CONSTRAINT conversation_messages_owner_fkey
    FOREIGN KEY (conversation_id, tenant_id, user_id)
    REFERENCES conversations (id, tenant_id, user_id) ON DELETE CASCADE;

ALTER TABLE message_feedback
  DROP CONSTRAINT message_feedback_message_id_fkey,
  ADD CONSTRAINT message_feedback_owner_fkey
    FOREIGN KEY (message_id, tenant_id, user_id)
    REFERENCES conversation_messages (id, tenant_id, user_id) ON DELETE CASCADE;
