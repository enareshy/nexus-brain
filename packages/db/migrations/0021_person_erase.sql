-- 0021: erasing one person (FR-ADM-03, GDPR right to erasure). An admin erases someone already turned
-- off, which revoked their connections. Everything they own is deleted, and their name, email and
-- sign-in identity are replaced, so what the company must keep (usage costs, the audit trail) no
-- longer points to them. The row stays only so those records still add up.
ALTER TABLE users ADD COLUMN erased_at timestamptz;

-- The data keeper does this, as the app's role cannot delete runs, proposals or notifications one by
-- one, and should not be able to: those are records of approvals. Only the function below acts as it.
GRANT SELECT (id, tenant_id, role, deactivated_at, erased_at), UPDATE (email, display_name, external_subject, erased_at) ON users TO brain_data_keeper;
GRANT SELECT (tenant_id, user_id), DELETE ON conversations, memories, skills, agent_runs, agent_triggers, notifications, mcp_connections, oauth_states, group_members TO brain_data_keeper;
GRANT SELECT (tenant_id, user_id, status), DELETE ON write_proposals TO brain_data_keeper;
GRANT INSERT ON audit_log TO brain_data_keeper;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO brain_data_keeper;
CREATE POLICY data_keeper ON users FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_erase ON users FOR UPDATE TO brain_data_keeper USING (true) WITH CHECK (true);
CREATE POLICY data_keeper_read ON memories FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON memories FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_read ON skills FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON skills FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_read ON agent_triggers FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON agent_triggers FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_read ON write_proposals FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON write_proposals FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_read ON mcp_connections FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON mcp_connections FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_read ON oauth_states FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON oauth_states FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_read ON group_members FOR SELECT TO brain_data_keeper USING (true);
CREATE POLICY data_keeper_delete ON group_members FOR DELETE TO brain_data_keeper USING (true);
CREATE POLICY data_keeper ON audit_log FOR INSERT TO brain_data_keeper WITH CHECK (true);

-- A chat already under way when someone is turned off must not write anything for them afterwards,
-- least of all after they have been erased.
CREATE TRIGGER require_active_user BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();
CREATE TRIGGER require_active_user BEFORE INSERT ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION app_require_active_user();

-- Erases p_target in the caller's company, as p_actor, who must be the signed-in person (both set by
-- withUser). It checks everything itself under a lock: the actor is an active admin, only an owner
-- erases an owner, nobody erases themselves,
-- the person is already turned off, and no approved change of theirs is still being carried out.
-- Errors: BR400 self, BR403 not allowed, BR404 no such person, BR409 not turned off, BR423 a change in progress.
CREATE FUNCTION app_erase_person(p_actor uuid, p_target uuid)
  RETURNS TABLE (erased boolean, conversations integer, memories integer, skills integer, agent_runs integer,
                 automatic_agents integer, changes integer, notifications integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_actor record;
  v_target record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no company in scope' USING ERRCODE = 'BR500';
  END IF;
  -- The audit entry names the actor, so it must be the person whose session this is.
  IF p_actor IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'BR403';
  END IF;
  IF p_actor = p_target THEN
    RAISE EXCEPTION 'cannot erase yourself' USING ERRCODE = 'BR400';
  END IF;
  -- Always the same order, as turning someone off locks them, so the two cannot deadlock.
  PERFORM 1 FROM users u WHERE u.tenant_id = v_tenant AND u.id IN (p_actor, p_target) ORDER BY u.id FOR UPDATE;
  SELECT u.role, u.deactivated_at INTO v_actor FROM users u WHERE u.tenant_id = v_tenant AND u.id = p_actor;
  IF NOT FOUND OR v_actor.deactivated_at IS NOT NULL OR v_actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'BR403';
  END IF;
  SELECT u.role, u.deactivated_at, u.erased_at INTO v_target FROM users u WHERE u.tenant_id = v_tenant AND u.id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such person' USING ERRCODE = 'BR404';
  END IF;
  IF v_target.role = 'owner' AND v_actor.role <> 'owner' THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'BR403';
  END IF;
  IF v_target.erased_at IS NOT NULL THEN
    erased := false; conversations := 0; memories := 0; skills := 0; agent_runs := 0;
    automatic_agents := 0; changes := 0; notifications := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_target.deactivated_at IS NULL THEN
    RAISE EXCEPTION 'turn them off first' USING ERRCODE = 'BR409';
  END IF;
  IF EXISTS (SELECT 1 FROM write_proposals w WHERE w.tenant_id = v_tenant AND w.user_id = p_target AND w.status = 'executing') THEN
    RAISE EXCEPTION 'a change is still being carried out' USING ERRCODE = 'BR423';
  END IF;

  erased := true;
  DELETE FROM conversations x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  GET DIAGNOSTICS conversations = ROW_COUNT;
  DELETE FROM memories x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  GET DIAGNOSTICS memories = ROW_COUNT;
  DELETE FROM skills x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  GET DIAGNOSTICS skills = ROW_COUNT;
  DELETE FROM agent_runs x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  GET DIAGNOSTICS agent_runs = ROW_COUNT;
  DELETE FROM agent_triggers x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  GET DIAGNOSTICS automatic_agents = ROW_COUNT;
  DELETE FROM write_proposals x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  GET DIAGNOSTICS changes = ROW_COUNT;
  DELETE FROM notifications x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  GET DIAGNOSTICS notifications = ROW_COUNT;
  DELETE FROM mcp_connections x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  DELETE FROM oauth_states x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  DELETE FROM group_members x WHERE x.tenant_id = v_tenant AND x.user_id = p_target;
  UPDATE users u
     SET email = 'erased-' || p_target || '@erased.invalid',
         display_name = 'Erased person',
         external_subject = 'erased:' || p_target,
         erased_at = now()
   WHERE u.tenant_id = v_tenant AND u.id = p_target;
  INSERT INTO audit_log (tenant_id, user_id, action, resource, meta)
  VALUES (v_tenant, p_actor, 'user.erased', p_target::text, jsonb_build_object(
    'conversations', conversations, 'memories', memories, 'skills', skills, 'agentRuns', agent_runs,
    'automaticAgents', automatic_agents, 'changes', changes, 'notifications', notifications));
  RETURN NEXT;
END $$;
ALTER FUNCTION app_erase_person(uuid, uuid) OWNER TO brain_data_keeper;
REVOKE ALL ON FUNCTION app_erase_person(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_erase_person(uuid, uuid) TO brain_app;
