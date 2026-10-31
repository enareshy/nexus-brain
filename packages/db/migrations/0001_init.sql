-- 0001_init: tenancy, identity, groups, audit log, with row-level security (FR-ID-01, FR-ID-03, FR-ADM-01).
-- Forward-only. Runs as the migration (owner) role; the API connects as brain_app, which is subject to RLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_app') THEN
    CREATE ROLE brain_app NOLOGIN;  -- login and password are provisioned per environment, never here
  END IF;
END
$$;

-- Current tenant from the transaction-local setting; NULL when unset, which matches no rows.
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  region      text NOT NULL DEFAULT 'us-east-1',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email             text NOT NULL,
  display_name      text NOT NULL,
  role              text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  external_subject  text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, external_subject)
);

CREATE TABLE groups (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

-- Composite foreign keys make a cross-tenant membership impossible, independent of RLS.
CREATE TABLE group_members (
  tenant_id  uuid NOT NULL,
  group_id   uuid NOT NULL,
  user_id    uuid NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES groups (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)  REFERENCES users  (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX group_members_user_idx ON group_members (tenant_id, user_id);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid,
  action      text NOT NULL,
  resource    text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_time_idx ON audit_log (tenant_id, created_at DESC);

-- Row-level security: enabled and forced on every tenant-scoped table.
ALTER TABLE tenants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants       FORCE  ROW LEVEL SECURITY;
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         FORCE  ROW LEVEL SECURITY;
ALTER TABLE groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups        FORCE  ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log     FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON groups
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON group_members
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Least privilege for the application role. Tenants are provisioned by operators, not the app.
GRANT USAGE ON SCHEMA public TO brain_app;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO brain_app;
GRANT SELECT ON tenants TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, groups, group_members TO brain_app;
GRANT SELECT, INSERT ON audit_log TO brain_app;  -- append-only
GRANT USAGE ON SEQUENCE audit_log_id_seq TO brain_app;
