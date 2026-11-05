-- 0019: plans with a monthly pool of credits, and top-ups (FR-MET-02, FR-MET-04). One credit is one
-- cent of AI cost. A company with no plan has no credit pool and works as before, within its budget.
-- The plan is set by an operator with the owner role (src/cli/set-plan.ts); the app can only read it.
CREATE TABLE tenant_plans (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  plan            text NOT NULL CHECK (plan ~ '^[a-z][a-z0-9_-]{0,39}$'),
  monthly_credits integer NOT NULL CHECK (monthly_credits BETWEEN 0 AND 100000000),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_plans FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_plans
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT ON tenant_plans TO brain_app;

-- Credits an admin added for the month they were added in. Append-only: a top-up is never changed.
CREATE TABLE credit_topups (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  credits    integer NOT NULL CHECK (credits BETWEEN 1 AND 1000000),
  added_by   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, added_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX credit_topups_tenant_time_idx ON credit_topups (tenant_id, created_at);

ALTER TABLE credit_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_topups FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_topups
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT ON credit_topups TO brain_app;
