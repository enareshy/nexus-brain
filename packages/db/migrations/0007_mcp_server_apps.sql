-- 0007: the sign-in app each company uses for a service that has no client registration.
-- One app per (tenant, server). The secret is stored only as AES-GCM ciphertext.
CREATE TABLE mcp_server_apps (
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  server_id          text NOT NULL,
  client_id          text NOT NULL,
  secret_ciphertext  text NOT NULL,
  updated_by         uuid NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, server_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id)
);

ALTER TABLE mcp_server_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_server_apps FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_server_apps
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON mcp_server_apps TO brain_app;
