import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { webConfig } from "./config";

/**
 * OIDC authorization code + PKCE against Keycloak (public client `brain-web`).
 *
 * Tokens live in sessionStorage for this shell: they survive reloads within a tab
 * but not across tabs or browser restarts. Any XSS could read them, which the strict
 * CSP and text-only rendering of untrusted data mitigate. Phase 5 moves to a
 * backend-for-frontend with httpOnly cookies.
 *
 * Access tokens are short-lived (5 min in the dev realm); automatic silent renew uses
 * the refresh token grant before expiry. If renewal fails the session is cleared.
 */
let manager: UserManager | null = null;

export function userManager(): UserManager {
  if (manager) return manager;
  const origin = window.location.origin;
  manager = new UserManager({
    authority: webConfig.oidcIssuer,
    client_id: webConfig.oidcClientId,
    redirect_uri: `${origin}/auth/callback`,
    post_logout_redirect_uri: origin,
    response_type: "code",
    scope: "openid",
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
    loadUserInfo: false,
  });
  return manager;
}
