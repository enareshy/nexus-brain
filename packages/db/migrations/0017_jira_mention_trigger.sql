-- 0017: @Brain mentions (FR-AST-05). A trigger that starts a run when the person writes "@Brain ..."
-- in one of their own Jira comments. One per person, like the Jira assignment trigger.
ALTER TABLE agent_triggers DROP CONSTRAINT agent_triggers_kind_check;
ALTER TABLE agent_triggers ADD CONSTRAINT agent_triggers_kind_check CHECK (kind IN ('schedule', 'jira_assigned', 'jira_mention'));
