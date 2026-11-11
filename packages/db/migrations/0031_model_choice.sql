-- 0031: people may choose their own model when their company allows it (FR-LLM-07). The admin's
-- model stays the company default; with people_choose_model on, a person's own choice is used for
-- their answers and agents instead. Off, any choice they made is kept but not used.
ALTER TABLE tenant_ai_settings ADD COLUMN people_choose_model boolean NOT NULL DEFAULT false;

-- agent_preferences (0030) now holds each person's own AI choices. NULL: the company's model.
ALTER TABLE agent_preferences ADD COLUMN model_choice text CHECK (model_choice IN ('premium', 'standard'));
ALTER TABLE agent_preferences ALTER COLUMN read_only SET DEFAULT false;
GRANT UPDATE (model_choice) ON agent_preferences TO brain_app;
