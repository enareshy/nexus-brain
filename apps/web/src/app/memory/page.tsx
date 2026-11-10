"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { MemoryList } from "@/components/MemoryList";
import { WorkGraphList } from "@/components/WorkGraphList";
import { describeError, type GraphItem, type Memory } from "@/lib/api";

function MemoryPage() {
  const { api } = useAuth();
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMemories(await api.memories());
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a change, shows any error, and reloads so the list matches what is stored. */
  async function change(id: string, work: () => Promise<unknown>): Promise<boolean> {
    setBusyId(id);
    setError(null);
    try {
      await work();
      setMemories(await api.memories());
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">Only you can see this</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Memory</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        Things Brain keeps in mind when it answers you or works for you. Only what you write here is remembered, and
        Brain is told never to copy it into anything written for others. Deleting something takes effect from your
        next question, though answers you already have may still mention it.
      </p>
      <div className="mt-10">
        {error && (
          <p role="alert" className="mb-6 text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        {memories === null ? (
          !error && (
            <p role="status" className="text-slate-500">
              Loading…
            </p>
          )
        ) : (
          <>
            <MemoryList
              memories={memories}
              busyId={busyId}
              onAdd={(text) => change("new", () => api.addMemory(text))}
              onUpdate={(id, text) => change(id, () => api.updateMemory(id, text))}
              onDelete={(id) => void change(id, () => api.deleteMemory(id))}
            />
            {memories.length > 1 &&
              (isConfirmingClear ? (
                <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-slate-600 dark:text-slate-400">Delete all {memories.length} memories?</span>
                  <button type="button" onClick={() => setIsConfirmingClear(false)} className="font-medium text-slate-600 dark:text-slate-300">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsConfirmingClear(false);
                      void change("all", () => api.deleteAllMemories());
                    }}
                    className="rounded-md bg-red-700 px-3 py-1.5 font-semibold text-white hover:bg-red-800"
                  >
                    Delete all
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsConfirmingClear(true)}
                  className="mt-6 text-sm font-medium text-red-700 underline underline-offset-4 dark:text-red-400"
                >
                  Delete everything Brain remembers
                </button>
              ))}
          </>
        )}
      </div>
      <WorkGraphSection />
    </div>
  );
}

/**
 * What Brain learned from what the person used (FR-RET-09), to see and clear. Kept apart from the
 * memories above: those are the person's own words, these are ids of items they opened or found helpful.
 */
function WorkGraphSection() {
  const { api } = useAuth();
  const [items, setItems] = useState<GraphItem[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await api.workGraph());
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Runs a change, then reloads the list. A change that worked is said so even if the reload fails,
   * and after clearing the list is emptied either way, so nobody is shown data they just removed.
   */
  async function change(key: string, work: () => Promise<unknown>, outcome: string): Promise<void> {
    setBusyKey(key);
    setError(null);
    setDone(null);
    try {
      await work();
    } catch (e) {
      setError(describeError(e));
      setBusyKey(null);
      return;
    }
    if (key === "all") setItems([]);
    else setItems((current) => current?.filter((item) => `${item.serverId}:${item.itemId}` !== key) ?? null);
    setDone(outcome);
    try {
      setItems(await api.workGraph());
    } catch {
      setDone(`${outcome} The list could not be refreshed; reload the page to see the latest.`);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section aria-labelledby="work-graph-heading" className="mt-16 border-t border-slate-200 pt-10 dark:border-slate-800">
      <h2 id="work-graph-heading" className="text-2xl font-bold tracking-tight">
        What Brain learned from what you use
      </h2>
      <p className="mt-3 text-slate-600 dark:text-slate-400">
        Items you opened through Brain, or that were sources of answers you rated helpful. Brain puts these, and items
        cited alongside them, a little higher in your own results. It never shows you anything your own search did not
        find, and nobody else&apos;s results change. Only each item&apos;s id is kept, never its title or text.
      </p>
      <div className="mt-6">
        {error && (
          <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 text-red-700 dark:text-red-400">
            <p>{error}</p>
            {items === null && (
              <button type="button" onClick={() => void load()} className="text-sm font-medium underline underline-offset-4">
                Try again
              </button>
            )}
          </div>
        )}
        <p role="status" aria-live="polite" className="mb-4 text-sm text-slate-600 empty:hidden dark:text-slate-400">
          {done}
        </p>
        {items === null
          ? !error && <p className="text-slate-500">Loading…</p>
          : (
              <WorkGraphList
                items={items}
                busyKey={busyKey}
                onForget={(item) => void change(`${item.serverId}:${item.itemId}`, () => api.forgetGraphItem(item), "Forgotten.")}
                onClear={() => void change("all", () => api.clearWorkGraph(), "Cleared.")}
              />
            )}
      </div>
    </section>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <MemoryPage />
    </RequireAuth>
  );
}
