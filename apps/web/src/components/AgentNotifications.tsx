"use client";

import { useCallback, useEffect, useState } from "react";
import { describeError, type Notification } from "@/lib/api";
import { useAuth } from "./AuthProvider";

const POLL_MS = 30_000;

const KIND_LABELS: Readonly<Record<string, string>> = {
  run_needs_decision: "Needs your decision",
  run_finished: "Finished",
  run_stopped: "Stopped",
  trigger_paused: "Paused: Jira needs reconnecting, or your admin turned it off",
  trigger_skipped: "Skipped: reached today's limit on automatic runs",
};

type Props = { onOpenRun: (id: string) => void };

export function AgentNotifications({ onOpenRun }: Props) {
  const { api } = useAuth();
  const [items, setItems] = useState<Notification[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.notifications()).items.filter((item) => !item.read));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
    // Nothing to show on a hidden tab, so it stops asking.
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function markAllRead() {
    try {
      await api.markNotificationsRead();
      setItems([]);
    } catch (e) {
      setError(describeError(e));
    }
  }

  function open(item: Notification) {
    if (item.runId) onOpenRun(item.runId);
    setItems((current) => current.filter((other) => other.id !== item.id));
  }

  if (items.length === 0 && !error) return null;
  return (
    <section aria-labelledby="notifications-heading" className="mt-12">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="notifications-heading" className="text-xl font-bold tracking-tight">
          For your attention
        </h2>
        {items.length > 0 && (
          <button type="button" onClick={() => void markAllRead()} className="text-sm font-medium underline underline-offset-4">
            Mark all read
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800 dark:text-red-300">
          {error}
        </p>
      )}
      <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {items.map((item) => (
          <li key={item.id} className="py-3 text-sm">
            <p className="font-medium">{KIND_LABELS[item.kind] ?? "Update"}</p>
            {item.runId ? (
              <button type="button" onClick={() => open(item)} className="mt-0.5 text-left underline underline-offset-4">
                {item.title}
              </button>
            ) : (
              <p className="mt-0.5 text-slate-600 dark:text-slate-400">{item.title}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
