-- 0014: people an admin has turned off (FR-CON-02 offboarding, FR-ADM-01). A turned-off person
-- cannot sign in, and nothing runs or is created for them, even by work that was already in flight.
ALTER TABLE users ADD COLUMN deactivated_at timestamptz;

-- Refuses work for someone turned off. FOR SHARE waits for a deactivation that is in progress
-- (which holds the row FOR NO KEY UPDATE), so the two happen one after the other, never together.
-- Runs as the caller, under RLS. BR403 means turned off; a person who cannot be seen at all is a
-- scoping bug and fails differently.
CREATE FUNCTION app_require_active_user() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  turned_off_at timestamptz;
BEGIN
  SELECT u.deactivated_at INTO turned_off_at FROM users u
   WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.user_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'person not visible in this scope' USING ERRCODE = 'BR500';
  END IF;
  IF turned_off_at IS NOT NULL THEN
    RAISE EXCEPTION 'user is turned off' USING ERRCODE = 'BR403';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_require_active_user() FROM PUBLIC;

CREATE TRIGGER require_active_user BEFORE INSERT ON mcp_connections
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
CREATE TRIGGER require_active_user BEFORE INSERT ON oauth_states
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
CREATE TRIGGER require_active_user BEFORE INSERT ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
CREATE TRIGGER require_active_user BEFORE INSERT ON agent_steps
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
CREATE TRIGGER require_active_user BEFORE INSERT ON agent_triggers
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
CREATE TRIGGER require_active_user BEFORE INSERT ON agent_trigger_events
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
CREATE TRIGGER require_active_user BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
CREATE TRIGGER require_active_user BEFORE INSERT ON write_proposals
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
-- Approving a change moves it from pending to executing, so an approval and a deactivation are ordered too.
CREATE TRIGGER require_active_approver BEFORE UPDATE OF status ON write_proposals
  FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status = 'executing')
  EXECUTE FUNCTION app_require_active_user();

-- The work finder must skip people who are turned off. It may read only whether someone is active.
GRANT SELECT (tenant_id, id, deactivated_at) ON users TO brain_work_finder;
CREATE POLICY work_finder ON users FOR SELECT TO brain_work_finder USING (true);

CREATE OR REPLACE FUNCTION due_agent_work(max_items integer)
  RETURNS TABLE (tenant_id uuid, user_id uuid, kind text, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT w.tenant_id, w.user_id, w.kind, w.id FROM (
    SELECT t.tenant_id, t.user_id, 'trigger'::text AS kind, t.id, t.next_run_at AS due
      FROM agent_triggers t
     WHERE t.enabled AND t.next_run_at <= now()
    UNION ALL
    SELECT r.tenant_id, r.user_id, 'run'::text, r.id, r.created_at
      FROM agent_runs r
     WHERE r.status = 'running' AND (r.lease_until IS NULL OR r.lease_until < now())
    UNION ALL
    SELECT r.tenant_id, r.user_id, 'run'::text, r.id, r.created_at
      FROM agent_runs r
      JOIN write_proposals p ON p.id = r.waiting_proposal_id
     WHERE r.status = 'waiting_approval'
       AND (r.lease_until IS NULL OR r.lease_until < now())
       AND (p.status NOT IN ('pending', 'executing') OR (p.status = 'pending' AND p.expires_at <= now()))
  ) w
  JOIN users u ON u.tenant_id = w.tenant_id AND u.id = w.user_id
  WHERE u.deactivated_at IS NULL
  ORDER BY w.due
  LIMIT LEAST(max_items, 100);
$$;
