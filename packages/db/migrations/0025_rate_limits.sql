-- 0025: per-person rate limits shared by every API server, and kept across restarts.
-- One row per use, kept until it expires: a request is allowed while fewer than the limit are
-- unexpired. The same rows also count work in progress ("slots"), which are deleted when the work
-- ends and expire on their own if a server stops mid-way. Holds only ids and times.
CREATE TABLE rate_limit_uses (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  bucket      text NOT NULL CHECK (bucket ~ '^[a-z_]{1,40}$'),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX rate_limit_uses_lookup_idx ON rate_limit_uses (tenant_id, user_id, bucket, expires_at);

ALTER TABLE rate_limit_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_uses FORCE  ROW LEVEL SECURITY;
-- Only the person's own uses: nobody can read, add to or clear someone else's limit.
CREATE POLICY own_uses ON rate_limit_uses
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
GRANT SELECT, INSERT, DELETE ON rate_limit_uses TO brain_app;
