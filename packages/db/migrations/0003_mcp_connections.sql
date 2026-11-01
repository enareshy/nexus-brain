-- 0003: per-user MCP connections, single-use OAuth states, OAuth client registrations
-- (FR-CON-01..03, FR-MCP-02). Token material is stored only as AES-GCM ciphertext.

CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app_current_user() TO brain_app;

-- One row per (tenant, user, server). Visible only to that user inside that tenant.
CREATE TABLE mcp_connections (
  tenant_id          uuid NOT NULL,
  user_id            uuid NOT NULL,
  server_id          text NOT NULL,
  status             text NOT NULL CHECK (status IN ('active', 'needs_reauth')),
  tokens_ciphertext  text NOT NULL,
  scopes             text,
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  PRIMARY KEY (tenant_id, user_id, server_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections FORCE  ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON mcp_connections
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_connections TO brain_app;

-- Pending authorizations. Only a SHA-256 hash of the state is stored. The OAuth callback
-- has no session, so a row is also visible to whoever presents its state hash via
-- app.oauth_state_hash (a 256-bit secret only the initiating browser holds).
CREATE TABLE oauth_states (
  state_hash           text PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  user_id              uuid NOT NULL,
  server_id            text NOT NULL,
  verifier_ciphertext  text NOT NULL,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states (expires_at);

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE  ROW LEVEL SECURITY;
CREATE POLICY owner_or_state_holder ON oauth_states
  USING (
    (tenant_id = app_current_tenant() AND user_id = app_current_user())
    OR state_hash = NULLIF(current_setting('app.oauth_state_hash', true), '')
  )
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
GRANT SELECT, INSERT, DELETE ON oauth_states TO brain_app;

-- OAuth client registered with each MCP server's authorization server (via Dynamic
-- Client Registration or pre-registered). Application-level, not tenant data.
CREATE TABLE mcp_client_registrations (
  server_id               text PRIMARY KEY,
  client_info_ciphertext  text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON mcp_client_registrations TO brain_app;
