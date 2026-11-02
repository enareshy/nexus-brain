"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { MemoryList } from "@/components/MemoryList";
import { describeError, type Memory } from "@/lib/api";

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
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <MemoryPage />
    </RequireAuth>
  );
}
