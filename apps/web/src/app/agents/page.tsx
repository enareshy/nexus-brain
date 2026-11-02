"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AgentRunDetail } from "@/components/AgentRunDetail";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { describeError, type AgentRun, type AgentRunSummary, type Proposal } from "@/lib/api";

const POLL_MS = 2_000;
const MAX_GOAL = 2_000;

const STATUS_LABELS: Readonly<Record<AgentRunSummary["status"], string>> = {
  running: "Working",
  waiting_approval: "Needs your decision",
  completed: "Finished",
  failed: "Stopped",
  cancelled: "Cancelled",
};

function AgentsPage() {
  const { api } = useAuth();
  const [runs, setRuns] = useState<AgentRunSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [goal, setGoal] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A slow reply for a run no longer on screen must not replace the one that is. */
  const shownId = useRef<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await api.agentRuns());
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  const loadRun = useCallback(
    async (id: string) => {
      const loaded = await api.agentRun(id);
      const waiting = loaded.waitingProposalId ? await api.proposal(loaded.waitingProposalId) : null;
      setRuns((current) => (current ?? []).map((r) => (r.id === id ? { ...r, status: loaded.status, errorCode: loaded.errorCode } : r)));
      if (shownId.current === id) {
        setRun(loaded);
        setProposal(waiting);
      }
      return loaded;
    },
    [api],
  );

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // Viewing a run is also what moves it on after a decision, so this keeps asking until it ends.
  useEffect(() => {
    if (!selectedId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let isCurrent = true;
    const poll = async () => {
      try {
        const loaded = await loadRun(selectedId);
        if (!isCurrent) return;
        setError(null);
        if (loaded.status === "running" || loaded.status === "waiting_approval") timer = setTimeout(() => void poll(), POLL_MS);
      } catch (e) {
        if (!isCurrent) return;
        setError(describeError(e));
        timer = setTimeout(() => void poll(), POLL_MS * 2);
      }
    };
    void poll();
    return () => {
      isCurrent = false;
      clearTimeout(timer);
    };
  }, [selectedId, loadRun]);

  function select(id: string) {
    setRun(null);
    setProposal(null);
    shownId.current = id;
    setSelectedId(id);
  }

  async function handleStart(event: FormEvent) {
    event.preventDefault();
    setIsStarting(true);
    setError(null);
    try {
      const started = await api.startAgentRun(goal.trim());
      setRuns((current) => [started, ...(current ?? [])]);
      setGoal("");
      select(started.id);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsStarting(false);
    }
  }

  async function act(action: () => Promise<unknown>) {
    if (!selectedId) return;
    setIsBusy(true);
    setError(null);
    try {
      await action();
      // Shows the decision at once. The poll is still running, since only an active run offers these.
      await loadRun(selectedId);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">Works with your access</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Agents</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        Give an agent a task. It reads your connected tools as you, and asks you before it changes anything.
      </p>

      <form onSubmit={(e) => void handleStart(e)} className="mt-8">
        <label htmlFor="agent-goal" className="text-sm font-medium">
          What should the agent do?
        </label>
        <textarea
          id="agent-goal"
          value={goal}
          maxLength={MAX_GOAL}
          rows={3}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Find the open login bugs and draft a comment summarising them"
          className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900"
        />
        <button
          type="submit"
          disabled={isStarting || goal.trim().length === 0}
          className="mt-3 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:translate-y-px disabled:opacity-50"
        >
          {isStarting ? "Starting…" : "Start agent"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-6 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {run && (
        <div className="mt-10">
          <AgentRunDetail
            run={run}
            proposal={proposal}
            isBusy={isBusy}
            onApprove={(item) => void act(() => api.approveProposal(item.id, item.argsHash))}
            onReject={(item) => void act(() => api.rejectProposal(item.id))}
            onCancel={() => void act(() => api.cancelAgentRun(run.id))}
          />
        </div>
      )}

      <section aria-labelledby="runs-heading" className="mt-12">
        <h2 id="runs-heading" className="text-xl font-bold tracking-tight">
          Your runs
        </h2>
        {runs === null ? (
          <p role="status" className="mt-3 text-slate-500">
            Loading…
          </p>
        ) : runs.length === 0 ? (
          <p className="mt-3 text-slate-500">No agent runs yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {runs.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === selectedId ? "true" : undefined}
                  onClick={() => select(item.id)}
                  className="flex w-full items-baseline justify-between gap-4 py-3 text-left hover:text-brand focus-visible:outline-2 focus-visible:outline-brand aria-[current=true]:font-semibold"
                >
                  <span className="min-w-0 truncate">{item.goal}</span>
                  <span className="shrink-0 text-sm text-slate-500">{STATUS_LABELS[item.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <AgentsPage />
    </RequireAuth>
  );
}
