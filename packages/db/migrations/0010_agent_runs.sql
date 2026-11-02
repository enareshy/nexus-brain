-- 0010: agent runs with saved progress (FR-AGT-01, FR-AGT-03, FR-AGT-06). A run acts as one person and
-- is visible only to them. Goals, saved state and results are stored only as AES-GCM ciphertext.
CREATE TABLE agent_runs (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  user_id              uuid NOT NULL,
  status               text NOT NULL CHECK (status IN ('running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  goal_ciphertext      text NOT NULL,
  state_ciphertext     text NOT NULL,
  result_ciphertext    text,
  error_code           text,
  turn_count           integer NOT NULL DEFAULT 0,
  cost_usd             numeric(12, 6) NOT NULL DEFAULT 0,
  waiting_proposal_id  uuid,
  -- Whoever holds a live lease is advancing the run. An expired one means that process stopped.
  lease_until          timestamptz,
  deadline_at          timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_runs_owner_time_idx ON agent_runs (tenant_id, user_id, created_at DESC);

CREATE TABLE agent_steps (
  run_id            uuid NOT NULL,
  seq               integer NOT NULL,
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  tool_name         text NOT NULL,
  args_hash         text NOT NULL,
  outcome           text NOT NULL,
  detail_ciphertext text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id, tenant_id, user_id) REFERENCES agent_runs (id, tenant_id, user_id) ON DELETE CASCADE
);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON agent_runs
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());

ALTER TABLE agent_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_steps FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON agent_steps
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());

GRANT SELECT, INSERT, UPDATE ON agent_runs TO brain_app;
GRANT SELECT, INSERT ON agent_steps TO brain_app;

-- Which agent run drafted a proposed change, if any. Set once, like the rest of the proposal.
ALTER TABLE write_proposals ADD COLUMN agent_run_id uuid;
