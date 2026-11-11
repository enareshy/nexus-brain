-- 0030: whether Brain's agents may propose changes (FR-AGT-04). Agents never change anything themselves;
-- they propose, and a person approves. Here a company can stop agents proposing at all, and each
-- person can choose "read only" for their own agents. Approval stays required for every change, as
-- agents always read outside content (FR-WR-04), so there is no "without asking" mode.
ALTER TABLE tenant_ai_settings ADD COLUMN agent_changes_allowed boolean NOT NULL DEFAULT true;

CREATE TABLE agent_preferences (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  -- True: the person's agents only search and answer, and are never offered a way to propose changes.
  read_only  boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE agent_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_preferences FORCE  ROW LEVEL SECURITY;
CREATE POLICY own_preferences ON agent_preferences
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
-- DELETE too, as the erase trigger runs with the rights of whoever erases (see 0026); row-level
-- security still limits the app to the person's own row.
GRANT SELECT, INSERT, DELETE ON agent_preferences TO brain_app;
GRANT UPDATE (read_only, updated_at) ON agent_preferences TO brain_app;

-- Someone turned off or erased cannot set it again from a session still open.
CREATE TRIGGER require_active_user BEFORE INSERT ON agent_preferences
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();

-- Erasing someone clears this too (see 0026).
GRANT SELECT (tenant_id, user_id), DELETE ON agent_preferences TO brain_data_keeper;
CREATE POLICY data_keeper_delete ON agent_preferences FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_select ON agent_preferences FOR SELECT TO brain_data_keeper USING (true);

CREATE OR REPLACE FUNCTION app_forget_erased_person() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM work_graph_edges x WHERE x.tenant_id = NEW.tenant_id AND x.user_id = NEW.id;
  DELETE FROM rate_limit_uses x WHERE x.tenant_id = NEW.tenant_id AND x.user_id = NEW.id;
  DELETE FROM agent_preferences x WHERE x.tenant_id = NEW.tenant_id AND x.user_id = NEW.id;
  RETURN NEW;
END $$;
