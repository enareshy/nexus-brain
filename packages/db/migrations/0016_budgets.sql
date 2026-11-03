-- 0016: monthly AI spending limits (FR-MET-03). One row per company; no row means no limit, so
-- companies that never set one keep working as before. Spend is summed from the usage ledger.
CREATE TABLE tenant_budgets (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- NULL means no limit at that level.
  monthly_limit_usd    numeric(12, 2) CHECK (monthly_limit_usd IS NULL OR monthly_limit_usd >= 0),
  per_person_limit_usd numeric(12, 2) CHECK (per_person_limit_usd IS NULL OR per_person_limit_usd >= 0),
  warn_at_percent      integer NOT NULL DEFAULT 80 CHECK (warn_at_percent BETWEEN 1 AND 100),
  updated_by           uuid NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id)
);

ALTER TABLE tenant_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_budgets FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_budgets
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON tenant_budgets TO brain_app;

-- A person's spend this month is checked before every AI call.
CREATE INDEX usage_ledger_tenant_user_time_idx ON usage_ledger (tenant_id, user_id, created_at);
