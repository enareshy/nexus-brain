-- 0013: which services a company allows its people to use (FR-MCP-02). A service with no row is
-- allowed, so companies that never change anything keep working as before.
CREATE TABLE tenant_server_settings (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  server_id  text NOT NULL,
  allowed    boolean NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, server_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id)
);

ALTER TABLE tenant_server_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_server_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_server_settings
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON tenant_server_settings TO brain_app;
