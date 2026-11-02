-- 0011: each claim of an agent run gets its own token, and only its holder can save. A worker that
-- outlives its lease then stops, instead of overwriting the progress of the worker that took over.
ALTER TABLE agent_runs ADD COLUMN lease_token uuid;
