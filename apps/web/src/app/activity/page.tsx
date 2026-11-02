"use client";

import { useCallback, useEffect, useState } from "react";
import { ActivityList } from "@/components/ActivityList";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { ApiError, describeError, type AuditEntry } from "@/lib/api";

function ActivityPage() {
  const { api } = useAuth();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      setError(null);
      try {
        const page = await api.audit(before);
        setEntries((current) => (before ? [...(current ?? []), ...page.entries] : page.entries));
        setNextBefore(page.nextBefore);
      } catch (e) {
        if (e instanceof ApiError && e.code === "FORBIDDEN") setIsForbidden(true);
        else setError(describeError(e));
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function handleLoadMore() {
    if (nextBefore === null) return;
    setIsLoadingMore(true);
    await load(nextBefore);
    setIsLoadingMore(false);
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">Admins only</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Activity</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        Who searched, what they were shown and what changed. Questions and document text are never stored here.
      </p>
      <div className="mt-10">
        {isForbidden ? (
          <p role="alert" className="text-slate-600 dark:text-slate-400">
            Only a workspace admin can view activity.
          </p>
        ) : error ? (
          <div role="alert" className="text-red-700 dark:text-red-400">
            <p>{error}</p>
            <button type="button" onClick={() => void load()} className="mt-3 font-medium underline underline-offset-4">
              Try again
            </button>
          </div>
        ) : entries === null ? (
          <p role="status" className="text-slate-500">
            Loading…
          </p>
        ) : (
          <>
            <ActivityList entries={entries} />
            {nextBefore !== null && (
              <button
                type="button"
                disabled={isLoadingMore}
                onClick={() => void handleLoadMore()}
                className="mt-6 rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800"
              >
                {isLoadingMore ? "Loading…" : "Show more"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <ActivityPage />
    </RequireAuth>
  );
}
