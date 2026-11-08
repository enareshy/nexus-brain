-- 0026: each person's own work graph (FR-RET-09). Links between the person ('me') and items they
-- opened or found helpful, and between items cited together in an answer they rated up. Built only
-- from that person's own activity and readable only by them, so it can never show anyone that a
-- document exists. It holds ids only (service and item id), never titles or text, and is used to
-- reorder results the person's own search already returned, never to add any.
CREATE TABLE work_graph_edges (
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  -- 'me', or an item as '<service>:<item id>'.
  -- Ids come from connected services, so control characters are refused.
  source_key   text NOT NULL CHECK (source_key = 'me' OR source_key ~ '^[a-z0-9-]{1,40}:[^[:cntrl:]]{1,200}$'),
  target_key   text NOT NULL CHECK (target_key ~ '^[a-z0-9-]{1,40}:[^[:cntrl:]]{1,200}$'),
  kind         text NOT NULL CHECK (kind IN ('opened', 'cited_up', 'co_cited')),
  -- How many times it happened, bounded so a habit cannot outweigh everything else.
  weight       integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 20),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, source_key, target_key, kind),
  CHECK (source_key <> target_key),
  -- Only links from the person are 'opened' or 'cited_up'; only links between items are 'co_cited'.
  CHECK ((source_key = 'me') = (kind <> 'co_cited')),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX work_graph_edges_target_idx ON work_graph_edges (tenant_id, user_id, target_key);
CREATE INDEX work_graph_edges_age_idx ON work_graph_edges (tenant_id, user_id, last_seen_at);

ALTER TABLE work_graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_graph_edges FORCE  ROW LEVEL SECURITY;
CREATE POLICY own_graph ON work_graph_edges
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
GRANT SELECT, INSERT, DELETE ON work_graph_edges TO brain_app;
GRANT UPDATE (weight, last_seen_at) ON work_graph_edges TO brain_app;

CREATE TRIGGER require_active_user BEFORE INSERT ON work_graph_edges
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();

-- Erasing someone (app_erase_person, 0021) marks them erased. Tables added since then are cleared
-- here when that happens, so an erasure leaves nothing of theirs behind.
GRANT SELECT (tenant_id, user_id), DELETE ON work_graph_edges, rate_limit_uses TO brain_data_keeper;
CREATE POLICY data_keeper_delete ON work_graph_edges FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_select ON work_graph_edges FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON rate_limit_uses FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_select ON rate_limit_uses FOR SELECT TO brain_data_keeper USING (true);

-- Runs with the rights of whoever set erased_at, not its owner's. Erasing runs as the data keeper
-- (app_erase_person), whose policies above reach the person's rows; the app's own role, should it
-- ever set erased_at itself, stays limited to its own rows, so it cannot clear a colleague's.
CREATE FUNCTION app_forget_erased_person() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM work_graph_edges x WHERE x.tenant_id = NEW.tenant_id AND x.user_id = NEW.id;
  DELETE FROM rate_limit_uses x WHERE x.tenant_id = NEW.tenant_id AND x.user_id = NEW.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_forget_erased_person() FROM PUBLIC;

CREATE TRIGGER forget_erased_person AFTER UPDATE OF erased_at ON users
  FOR EACH ROW WHEN (OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL)
  EXECUTE FUNCTION app_forget_erased_person();
