-- 0023: undo for changes Brain made (FR-WR-06).
-- before_state: the fields a change overwrote, read just before it was sent.
-- after_state:  the same fields read just after it succeeded.
-- An undo is an ordinary proposal that puts before_state back. It names the change it undoes
-- (undo_of) and the state it expects to find (expected_state), so it fails rather than overwrite
-- edits someone made in between.
ALTER TABLE write_proposals
  ADD COLUMN before_state   jsonb,
  ADD COLUMN after_state    jsonb,
  ADD COLUMN undo_of        uuid REFERENCES write_proposals (id) ON DELETE SET NULL,
  ADD COLUMN expected_state jsonb;

CREATE INDEX write_proposals_undo_of_idx ON write_proposals (undo_of) WHERE undo_of IS NOT NULL;

-- undo_of and expected_state are fixed at creation, like the arguments; the states are outcomes.
GRANT UPDATE (before_state, after_state) ON write_proposals TO brain_app;
