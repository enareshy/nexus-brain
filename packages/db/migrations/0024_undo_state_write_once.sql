-- 0024: what an undo would put back can be saved once and never changed (FR-WR-06, code review).
-- A new change starts with neither state. before_state is saved only on a change already being
-- sent, after_state only on one already marked succeeded, and neither can be replaced or cleared
-- afterwards, so a later undo restores what was really there even if some other path in the app
-- were misused. (The table owner can still drop the trigger; the app role cannot.)
CREATE FUNCTION app_undo_state_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.before_state IS NOT NULL OR NEW.after_state IS NOT NULL THEN
      RAISE EXCEPTION 'a new change has no saved state yet' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.before_state IS DISTINCT FROM OLD.before_state
     AND (OLD.before_state IS NOT NULL OR OLD.status <> 'executing' OR NEW.status <> 'executing') THEN
    RAISE EXCEPTION 'before_state is saved once, while the change is sent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.after_state IS DISTINCT FROM OLD.after_state
     AND (OLD.after_state IS NOT NULL OR OLD.status <> 'succeeded' OR NEW.status <> 'succeeded') THEN
    RAISE EXCEPTION 'after_state is saved once, after the change succeeded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER undo_state_write_once_insert BEFORE INSERT ON write_proposals
  FOR EACH ROW EXECUTE FUNCTION app_undo_state_write_once();
CREATE TRIGGER undo_state_write_once BEFORE UPDATE OF before_state, after_state ON write_proposals
  FOR EACH ROW EXECUTE FUNCTION app_undo_state_write_once();
