-- 0012: agent triggers and notifications (FR-AGT-05). Both are private to one person, like agent runs.
CREATE TABLE agent_triggers (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('schedule', 'jira_assigned')),
  goal_ciphertext  text NOT NULL,
  interval_minutes integer NOT NULL CHECK (interval_minutes >= 5),
  next_run_at      timestamptz NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  paused_reason    text,
  -- Set once a Jira trigger has noted the issues already assigned, which never start a run.
  baselined_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_triggers_due_idx ON agent_triggers (next_run_at) WHERE enabled;

-- What a trigger has already acted on, so one assignment starts one run. Holds keyed hashes, not keys.
CREATE TABLE agent_trigger_events (
  trigger_id uuid NOT NULL,
  event_hash text NOT NULL,
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trigger_id, event_hash),
  FOREIGN KEY (trigger_id, tenant_id, user_id) REFERENCES agent_triggers (id, tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE notifications (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  kind             text NOT NULL,
  -- One notification per event, even if a step repeats after a restart.
  dedupe_key       text NOT NULL,
  title_ciphertext text NOT NULL,
  agent_run_id     uuid,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, dedupe_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX notifications_owner_time_idx ON notifications (tenant_id, user_id, created_at DESC);

-- A trigger can be deleted while its runs stay in the person's history, so this is not a foreign key.
ALTER TABLE agent_runs ADD COLUMN trigger_id uuid;
CREATE INDEX agent_runs_trigger_idx ON agent_runs (tenant_id, user_id, created_at) WHERE trigger_id IS NOT NULL;

ALTER TABLE agent_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_triggers FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON agent_triggers
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());

ALTER TABLE agent_trigger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_trigger_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON agent_trigger_events
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON notifications
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_triggers TO brain_app;
GRANT SELECT, INSERT, DELETE ON agent_trigger_events TO brain_app;
GRANT SELECT, INSERT, UPDATE ON notifications TO brain_app;

-- Row-level security stops the app seeing across people, which is the point, but something must find
-- work that is due with nobody signed in. This role cannot log in, and can read only identifiers and
-- timing, never goals, state or results. The app can only call the one function it owns.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_work_finder') THEN
    CREATE ROLE brain_work_finder NOLOGIN;
  END IF;
END $$;

-- Needed to hand the function to that role below, when the migrating role is not a superuser.
GRANT brain_work_finder TO CURRENT_USER;
GRANT USAGE, CREATE ON SCHEMA public TO brain_work_finder;
GRANT SELECT (id, tenant_id, user_id, next_run_at, enabled) ON agent_triggers TO brain_work_finder;
GRANT SELECT (id, tenant_id, user_id, status, lease_until, waiting_proposal_id, created_at) ON agent_runs TO brain_work_finder;
GRANT SELECT (id, status, expires_at) ON write_proposals TO brain_work_finder;
CREATE POLICY work_finder ON agent_triggers FOR SELECT TO brain_work_finder USING (true);
CREATE POLICY work_finder ON agent_runs FOR SELECT TO brain_work_finder USING (true);
CREATE POLICY work_finder ON write_proposals FOR SELECT TO brain_work_finder USING (true);

-- Triggers that are due, runs whose worker stopped, and runs whose proposal has been decided or expired.
CREATE FUNCTION due_agent_work(max_items integer)
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
  ORDER BY w.due
  LIMIT LEAST(max_items, 100);
$$;
ALTER FUNCTION due_agent_work(integer) OWNER TO brain_work_finder;
REVOKE CREATE ON SCHEMA public FROM brain_work_finder;
REVOKE ALL ON FUNCTION due_agent_work(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION due_agent_work(integer) TO brain_app;
