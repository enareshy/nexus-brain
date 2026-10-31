-- 0004: OAuth completion now requires the signed-in user (login-CSRF fix, security review M1).
-- Pending states are visible only to the user who started them; the state-holder bypass is removed.
DROP POLICY owner_or_state_holder ON oauth_states;
CREATE POLICY owner_only ON oauth_states
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
