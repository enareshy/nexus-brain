-- 0005: append-only ledger with one row per LLM call (FR-MET-01).
CREATE TABLE usage_ledger (
  id                    bigserial PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  user_id               uuid NOT NULL,
  feature               text NOT NULL,
  model                 text NOT NULL,
  input_tokens          integer NOT NULL,
  output_tokens         integer NOT NULL,
  cache_read_tokens     integer NOT NULL DEFAULT 0,
  cache_write_tokens    integer NOT NULL DEFAULT 0,
  -- NULL when the serving model has no known price (e.g. a new fallback model).
  cost_usd              numeric(12, 6),
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX usage_ledger_tenant_time_idx ON usage_ledger (tenant_id, created_at DESC);

ALTER TABLE usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_ledger
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT ON usage_ledger TO brain_app;  -- append-only
GRANT USAGE ON SEQUENCE usage_ledger_id_seq TO brain_app;
