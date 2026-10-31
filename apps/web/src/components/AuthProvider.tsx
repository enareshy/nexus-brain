"use client";

import type { User } from "oidc-client-ts";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createApiClient, type ApiClient } from "@/lib/api";
import { userManager } from "@/lib/auth";
import { webConfig } from "@/lib/config";
import { safeReturnPath } from "@/lib/safe-url";

interface AuthState {
  readonly ready: boolean;
  readonly user: User | null;
  readonly displayName: string | null;
  readonly api: ApiClient;
  signIn(returnTo?: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const mgr = userManager();
    let active = true;
    const clearSession = () => {
      void mgr.removeUser();
      if (active) setUser(null);
    };

    mgr
      .getUser()
      .then(async (u) => {
        if (u && u.expired) {
          // Try the refresh token once; otherwise the user signs in again.
          const renewed = await mgr.signinSilent().catch(() => null);
          if (!renewed) await mgr.removeUser();
          return renewed;
        }
        return u;
      })
      .then((u) => {
        if (active) setUser(u ?? null);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setReady(true);
      });

    const onLoaded = (u: User) => setUser(u);
    const onUnloaded = () => setUser(null);
    mgr.events.addUserLoaded(onLoaded);
    mgr.events.addUserUnloaded(onUnloaded);
    mgr.events.addAccessTokenExpired(clearSession);
    mgr.events.addSilentRenewError(clearSession);
    return () => {
      active = false;
      mgr.events.removeUserLoaded(onLoaded);
      mgr.events.removeUserUnloaded(onUnloaded);
      mgr.events.removeAccessTokenExpired(clearSession);
      mgr.events.removeSilentRenewError(clearSession);
    };
  }, []);

  const signIn = useCallback(async (returnTo?: string) => {
    await userManager().signinRedirect({ state: { returnTo: safeReturnPath(returnTo) } });
  }, []);

  const signOut = useCallback(async () => {
    await userManager().signoutRedirect();
  }, []);

  const api = useMemo(
    () => createApiClient(webConfig.apiUrl, () => (user && !user.expired ? user.access_token : null)),
    [user],
  );

  const value = useMemo<AuthState>(
    () => ({
      ready,
      user,
      displayName: (user?.profile.name as string | undefined) ?? user?.profile.preferred_username ?? null,
      api,
      signIn,
      signOut,
    }),
    [ready, user, api, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
