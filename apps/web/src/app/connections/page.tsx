"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { ConnectionsList } from "@/components/ConnectionsList";
import { describeError, type Connection } from "@/lib/api";
import { safeHttpUrl } from "@/lib/safe-url";

type Message = { readonly tone: "ok" | "error"; readonly text: string };

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

function ConnectionsPage() {
  const { api } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const justConnected = params.get("connected");
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [canSetUp, setCanSetUp] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [loaded, me] = await Promise.all([api.connections(), api.me()]);
      setConnections(loaded);
      setCanSetUp(ADMIN_ROLES.has(me.role));
    } catch (e) {
      setLoadError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Confirm "?connected=" only for a server that really is connected, then drop it from the URL.
  useEffect(() => {
    if (!justConnected || !connections) return;
    const match = connections.find((c) => c.serverId === justConnected && c.status === "active");
    if (match) setMessage({ tone: "ok", text: `${match.displayName} is connected.` });
    router.replace("/connections");
  }, [justConnected, connections, router]);

  // Returning via Back from the provider restores this page from bfcache; unstick the button.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setBusyServerId(null);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function handleConnect(serverId: string) {
    setBusyServerId(serverId);
    setMessage(null);
    try {
      const { authorizationUrl } = await api.authorize(serverId);
      // The API already restricts this to the server's allow-listed hosts; re-check the scheme here.
      const target = safeHttpUrl(authorizationUrl);
      if (!target) throw new Error("unsafe authorization URL");
      window.location.assign(target);
    } catch (e) {
      setMessage({ tone: "error", text: describeError(e) });
      setBusyServerId(null);
    }
  }

  /** Saving goes straight on to connecting, so the admin has nothing more to click. */
  async function handleSaveApp(serverId: string, app: { clientId: string; clientSecret: string }) {
    setBusyServerId(serverId);
    setMessage(null);
    try {
      await api.saveServerApp(serverId, app);
    } catch (e) {
      setMessage({ tone: "error", text: describeError(e) });
      setBusyServerId(null);
      return;
    }
    await load();
    await handleConnect(serverId);
  }

  async function handleDisconnect(serverId: string) {
    setBusyServerId(serverId);
    setMessage(null);
    try {
      const { revoked } = await api.disconnect(serverId);
      setMessage({
        tone: "ok",
        text: revoked
          ? "Disconnected and access revoked at the provider."
          : "Disconnected. Revoke the app's access in the provider's settings too.",
      });
      await load();
    } catch (e) {
      setMessage({ tone: "error", text: describeError(e) });
    } finally {
      setBusyServerId(null);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">Your access</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Connections</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        Each connection uses your own account. Nexus Brain only sees what you can see, and nobody
        else in your workspace can use your connection.
      </p>
      {/* Always mounted so screen readers announce changes to its text. */}
      <div role="status" aria-live="polite" className="mt-6 empty:hidden">
        {message?.tone === "ok" && (
          <p className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            {message.text}
          </p>
        )}
      </div>
      {message?.tone === "error" && (
        <p role="alert" className="mt-6 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          {message.text}
        </p>
      )}
      <div className="mt-10">
        {loadError ? (
          <div role="alert" className="text-red-700 dark:text-red-400">
            <p>{loadError}</p>
            <button type="button" onClick={() => void load()} className="mt-3 font-medium underline underline-offset-4">
              Try again
            </button>
          </div>
        ) : connections === null ? (
          <p role="status" className="text-slate-500">Loading…</p>
        ) : (
          <ConnectionsList
            connections={connections}
            busyServerId={busyServerId}
            onConnect={(id) => void handleConnect(id)}
            onDisconnect={(id) => void handleDisconnect(id)}
            canSetUp={canSetUp}
            onSaveApp={(id, app) => void handleSaveApp(id, app)}
          />
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <Suspense fallback={<p role="status" className="text-slate-500">Loading…</p>}>
        <ConnectionsPage />
      </Suspense>
    </RequireAuth>
  );
}
