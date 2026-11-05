-- 0022: a company's AI settings, set by its admins (FR-ADM-02, FR-LLM-07, FR-AGT-04). No row means
-- the defaults: the most capable model, agents on, automatic agents on, up to 10 automatic runs a day.
CREATE TABLE tenant_ai_settings (
  tenant_id                uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- Which model answers and agents use. Turning search words into a query always uses the fast one.
  model_choice             text NOT NULL DEFAULT 'premium' CHECK (model_choice IN ('premium', 'standard')),
  agents_enabled           boolean NOT NULL DEFAULT true,
  automatic_agents_enabled boolean NOT NULL DEFAULT true,
  -- Per person. Never above the built-in limit of 10.
  automatic_runs_per_day   integer NOT NULL DEFAULT 10 CHECK (automatic_runs_per_day BETWEEN 1 AND 10),
  updated_by               uuid NOT NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id)
);

ALTER TABLE tenant_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_ai_settings
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON tenant_ai_settings TO brain_app;
