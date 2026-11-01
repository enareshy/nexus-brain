-- 0006: changes waiting for a person's approval, and what happened to them (FR-WR-02, FR-WR-05).
-- One row is one possible write: the atomic pending -> executing claim is what stops a replay.
CREATE TABLE write_proposals (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  user_id        uuid NOT NULL,
  server_id      text NOT NULL,
  action         text NOT NULL,
  tool_name      text NOT NULL,
  tool_class     text NOT NULL CHECK (tool_class IN ('write', 'external-effect')),
  args           jsonb NOT NULL,
  args_hash      text NOT NULL,
  site_origin    text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'executing', 'succeeded', 'failed', 'unknown', 'rejected')),
  external_id    text,
  result_url     text,
  error_code     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  decided_at     timestamptz,
  completed_at   timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX write_proposals_owner_time_idx ON write_proposals (tenant_id, user_id, created_at DESC);

ALTER TABLE write_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE write_proposals FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON write_proposals
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());

-- What was approved cannot change after creation: the app may update only the outcome columns.
GRANT SELECT, INSERT ON write_proposals TO brain_app;
GRANT UPDATE (status, external_id, result_url, error_code, decided_at, completed_at) ON write_proposals TO brain_app;
