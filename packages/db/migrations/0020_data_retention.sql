-- 0020: how long a company keeps chats and agent runs (FR-ADM-03, NFR-COMP-01). No row, or NULL,
-- means keep. Expired rows are removed by app_purge_expired(), which the app calls on a timer.
CREATE TABLE tenant_retention (
  tenant_id         uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_days integer CHECK (conversation_days IS NULL OR conversation_days BETWEEN 1 AND 3650),
  agent_run_days    integer CHECK (agent_run_days IS NULL OR agent_run_days BETWEEN 1 AND 3650),
  updated_by        uuid NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id)
);

ALTER TABLE tenant_retention ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_retention FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_retention
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON tenant_retention TO brain_app;

-- Row-level security keeps people's chats and runs apart, so removing expired ones across people needs
-- a role of its own, like the work finder. It cannot log in, reads only ids, owners and dates, and
-- can delete only what one function decides has expired. Messages, feedback and steps go with their
-- parent through their foreign keys.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_data_keeper') THEN
    CREATE ROLE brain_data_keeper NOLOGIN;
  END IF;
END $$;

GRANT brain_data_keeper TO CURRENT_USER;
GRANT USAGE, CREATE ON SCHEMA public TO brain_data_keeper;
GRANT SELECT (tenant_id, conversation_days, agent_run_days) ON tenant_retention TO brain_data_keeper;
GRANT SELECT (id, tenant_id, updated_at), DELETE ON conversations TO brain_data_keeper;
GRANT SELECT (id, tenant_id, status, updated_at), DELETE ON agent_runs TO brain_data_keeper;
GRANT SELECT (id, tenant_id, created_at), DELETE ON notifications TO brain_data_keeper;
CREATE POLICY data_keeper ON tenant_retention FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_read ON conversations FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON conversations FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_read ON agent_runs FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON agent_runs FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_read ON notifications FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON notifications FOR DELETE TO brain_data_keeper USING (true);

-- Removes, per company, chats untouched for longer than it keeps them, finished agent runs older than
-- that, and notifications as old. Runs still working or waiting for a decision are never removed.
-- At most max_rows of each kind per company per call, so one call stays short.
CREATE FUNCTION app_purge_expired(max_rows integer)
  RETURNS TABLE (tenant_id uuid, conversations integer, agent_runs integer, notifications integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  batch integer := LEAST(GREATEST(max_rows, 1), 10000);
  n_conversations integer;
  n_runs integer;
  n_notifications integer;
BEGIN
  -- One sweep at a time, even with several API servers; another simply finds nothing to do.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('app_purge_expired', 0)) THEN
    RETURN;
  END IF;
  FOR r IN SELECT t.tenant_id, t.conversation_days, t.agent_run_days FROM tenant_retention t LOOP
    n_conversations := 0;
    n_runs := 0;
    n_notifications := 0;
    -- Each company on its own: one that fails is skipped, and the others' removals still stand.
    BEGIN
    IF r.conversation_days IS NOT NULL THEN
      DELETE FROM conversations c WHERE c.id IN (
        SELECT x.id FROM conversations x
         WHERE x.tenant_id = r.tenant_id AND x.updated_at < now() - make_interval(days => r.conversation_days)
         LIMIT batch);
      GET DIAGNOSTICS n_conversations = ROW_COUNT;
    END IF;
    IF r.agent_run_days IS NOT NULL THEN
      DELETE FROM agent_runs a WHERE a.id IN (
        SELECT x.id FROM agent_runs x
         WHERE x.tenant_id = r.tenant_id AND x.status IN ('completed', 'failed', 'cancelled')
           AND x.updated_at < now() - make_interval(days => r.agent_run_days)
         LIMIT batch);
      GET DIAGNOSTICS n_runs = ROW_COUNT;
      DELETE FROM notifications n WHERE n.id IN (
        SELECT x.id FROM notifications x
         WHERE x.tenant_id = r.tenant_id AND x.created_at < now() - make_interval(days => r.agent_run_days)
         LIMIT batch);
      GET DIAGNOSTICS n_notifications = ROW_COUNT;
    END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'app_purge_expired skipped a company: %', SQLSTATE;
      CONTINUE;
    END;
    IF n_conversations + n_runs + n_notifications > 0 THEN
      tenant_id := r.tenant_id;
      conversations := n_conversations;
      agent_runs := n_runs;
      notifications := n_notifications;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;
ALTER FUNCTION app_purge_expired(integer) OWNER TO brain_data_keeper;
REVOKE CREATE ON SCHEMA public FROM brain_data_keeper;
REVOKE ALL ON FUNCTION app_purge_expired(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_expired(integer) TO brain_app;
