-- 0027: a company's learned ranker (FR-RET-08). When someone first rates an answer, each of its
-- results is saved here as general signals only: place in the search's own order, match score
-- relative to the best, age in whole days, which service, and whether it was cited in an answer rated
-- up or down. There is no person, id, title or text. Rows of one answer share a group id, a keyed hash
-- of the company and message, so the same answer is saved once however often its rating changes; the
-- day it was saved is kept, not the time, so rows cannot be matched to a chat by when they happened.
-- An operator trains each company's ranker offline (`ranker:train`); the app only adds rows and reads
-- the trained model.
CREATE TABLE ranking_examples (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  answer_group uuid NOT NULL,
  server_id    text NOT NULL CHECK (server_id ~ '^[a-z0-9-]{1,40}$'),
  position     smallint NOT NULL CHECK (position BETWEEN 0 AND 99),
  score_ratio  real NOT NULL CHECK (score_ratio BETWEEN 0 AND 1),
  age_days     integer CHECK (age_days >= 0),
  label        smallint NOT NULL CHECK (label IN (0, 1)),
  saved_on     date NOT NULL DEFAULT current_date,
  UNIQUE (tenant_id, answer_group, position)
);
CREATE INDEX ranking_examples_tenant_idx ON ranking_examples (tenant_id, saved_on);

ALTER TABLE ranking_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking_examples FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ranking_examples
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- Added only: the app never reads their signals or labels, changes or removes them. It may read
-- which answers and places are already saved, which skipping a repeat (ON CONFLICT) needs.
GRANT INSERT ON ranking_examples TO brain_app;
GRANT SELECT (tenant_id, answer_group, position) ON ranking_examples TO brain_app;

CREATE TABLE tenant_rankers (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- Null when the last training did not beat today's order, which then stays as it is.
  model      jsonb,
  metrics    jsonb NOT NULL,
  trained_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_rankers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_rankers FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_rankers
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT ON tenant_rankers TO brain_app;
