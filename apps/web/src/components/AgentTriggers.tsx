"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { describeError, type AgentTrigger, type NewAgentTrigger } from "@/lib/api";
import { useAuth } from "./AuthProvider";

type When = "daily" | "hourly" | "weekly" | "jira_assigned";

const WHEN_LABELS: Readonly<Record<When, string>> = {
  daily: "Every day",
  hourly: "Every hour",
  weekly: "Every week",
  jira_assigned: "When a Jira issue is assigned to me",
};
const MAX_GOAL = 2_000;

function triggerWhen(trigger: AgentTrigger): string {
  return trigger.kind === "jira_assigned" ? WHEN_LABELS.jira_assigned : WHEN_LABELS[trigger.schedule ?? "daily"];
}

function toNewTrigger(when: When, goal: string): NewAgentTrigger {
  return when === "jira_assigned" ? { kind: "jira_assigned", goal } : { kind: "schedule", goal, schedule: when };
}

/** Agents that start on their own. They read as the person, and every change still waits for approval. */
export function AgentTriggers() {
  const { api } = useAuth();
  const [triggers, setTriggers] = useState<AgentTrigger[] | null>(null);
  const [when, setWhen] = useState<When>("daily");
  const [goal, setGoal] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTriggers(await api.agentTriggers());
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      const created = await api.createAgentTrigger(toNewTrigger(when, goal.trim()));
      setTriggers((current) => [created, ...(current ?? [])]);
      setGoal("");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRemove(id: string) {
    setError(null);
    try {
      await api.deleteAgentTrigger(id);
      setTriggers((current) => (current ?? []).filter((trigger) => trigger.id !== id));
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <section aria-labelledby="triggers-heading" className="mt-12">
      <h2 id="triggers-heading" className="text-xl font-bold tracking-tight">
        Automatic agents
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        These start on their own, up to 10 runs a day, and spend AI credits each time. They still ask before changing anything.
      </p>

      <form onSubmit={(e) => void handleCreate(e)} className="mt-4 space-y-3">
        <div>
          <label htmlFor="trigger-when" className="text-sm font-medium">
            When
          </label>
          <select
            id="trigger-when"
            value={when}
            onChange={(e) => setWhen(e.target.value as When)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900"
          >
            {(Object.keys(WHEN_LABELS) as When[]).map((value) => (
              <option key={value} value={value}>
                {WHEN_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="trigger-goal" className="text-sm font-medium">
            What should it do?
          </label>
          <textarea
            id="trigger-goal"
            value={goal}
            maxLength={MAX_GOAL}
            rows={2}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Read the issue and summarise what I need to do"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900"
          />
        </div>
        <button
          type="submit"
          disabled={isSaving || goal.trim().length === 0}
          className="rounded-md px-3 py-2 text-sm font-semibold ring-1 ring-slate-300 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 dark:ring-slate-700 dark:hover:bg-slate-800"
        >
          {isSaving ? "Saving…" : "Add automatic agent"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800 dark:text-red-300">
          {error}
        </p>
      )}

      {triggers && triggers.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {triggers.map((trigger) => (
            <li key={trigger.id} className="flex items-baseline justify-between gap-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{triggerWhen(trigger)}</p>
                <p className="mt-0.5 break-words text-slate-600 dark:text-slate-400">{trigger.goal}</p>
                {!trigger.enabled && (
                  <p className="mt-0.5 text-red-800 dark:text-red-300">
                    {trigger.pausedReason === "service_turned_off"
                      ? "Paused because your admin turned Jira off."
                      : "Paused because Jira needs reconnecting. Reconnect it, then add this again."}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label={`Remove: ${trigger.goal}`}
                onClick={() => void handleRemove(trigger.id)}
                className="shrink-0 font-medium underline underline-offset-4"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
