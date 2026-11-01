"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { ChangeForm } from "@/components/ChangeForm";
import { ProposalCard } from "@/components/ProposalCard";
import { ApiError, describeError, type Proposal, type WriteRequest, type WriteTarget } from "@/lib/api";

const SERVER_ID = "atlassian";

function ChangesPage() {
  const { api } = useAuth();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [targets, setTargets] = useState<WriteTarget[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsConnection, setNeedsConnection] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isProposing, setIsProposing] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setNeedsConnection(false);
    try {
      const [loadedProposals, loadedTargets] = await Promise.all([api.proposals(), api.writeTargets(SERVER_ID)]);
      setProposals(loadedProposals);
      setTargets(loadedTargets);
    } catch (e) {
      if (e instanceof ApiError && e.code === "RECONNECT_REQUIRED") setNeedsConnection(true);
      else setLoadError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  function replace(updated: Proposal) {
    setProposals((current) => (current ?? []).map((p) => (p.id === updated.id ? updated : p)));
  }

  async function handlePropose(request: WriteRequest) {
    setIsProposing(true);
    setActionError(null);
    try {
      const created = await api.propose(SERVER_ID, request);
      setProposals((current) => [created, ...(current ?? [])]);
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setIsProposing(false);
    }
  }

  async function decide(id: string, decision: () => Promise<Proposal>) {
    setBusyId(id);
    setActionError(null);
    try {
      replace(await decision());
    } catch (e) {
      setActionError(describeError(e));
      // The change may have moved on, for example if this request timed out while it ran.
      setProposals(await api.proposals().catch(() => proposals));
    } finally {
      setBusyId(null);
    }
  }

  const waiting = proposals?.filter((p) => p.status === "pending") ?? [];
  const finished = proposals?.filter((p) => p.status !== "pending") ?? [];
  const list = (items: Proposal[]) => (
    <ul className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
      {items.map((p) => (
        <ProposalCard
          key={p.id}
          proposal={p}
          isBusy={busyId !== null}
          onApprove={(item) => void decide(item.id, () => api.approveProposal(item.id, item.argsHash))}
          onReject={(item) => void decide(item.id, () => api.rejectProposal(item.id))}
        />
      ))}
    </ul>
  );

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">You approve every change</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Changes</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        Changes run with your own Jira account, and only after you have seen and approved exactly what will be sent.
      </p>

      {actionError && (
        <p role="alert" className="mt-6 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          {actionError}
        </p>
      )}

      {needsConnection ? (
        <p className="mt-10">
          Connect Jira to make changes.{" "}
          <Link href="/connections" className="font-medium text-brand underline underline-offset-4">
            Go to Connections
          </Link>
        </p>
      ) : loadError ? (
        <div role="alert" className="mt-10 text-red-700 dark:text-red-400">
          <p>{loadError}</p>
          <button type="button" onClick={() => void load()} className="mt-3 font-medium underline underline-offset-4">
            Try again
          </button>
        </div>
      ) : proposals === null || targets === null ? (
        <p role="status" className="mt-10 text-slate-500">
          Loading…
        </p>
      ) : (
        <>
          {waiting.length > 0 && (
            <section aria-labelledby="waiting-heading" className="mt-10">
              <h2 id="waiting-heading" className="text-2xl font-bold tracking-tight">
                Waiting for your approval
              </h2>
              <div className="mt-4">{list(waiting)}</div>
            </section>
          )}
          <section aria-labelledby="new-heading" className="mt-10">
            <h2 id="new-heading" className="text-2xl font-bold tracking-tight">
              New change
            </h2>
            <div className="mt-4">
              {targets.length === 0 ? (
                <p className="text-slate-500">Your Jira account has no site you can change.</p>
              ) : (
                <ChangeForm targets={targets} isBusy={isProposing} onSubmit={(r) => void handlePropose(r)} />
              )}
            </div>
          </section>
          {finished.length > 0 && (
            <section aria-labelledby="history-heading" className="mt-12">
              <h2 id="history-heading" className="text-2xl font-bold tracking-tight">
                History
              </h2>
              <div className="mt-4">{list(finished)}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <ChangesPage />
    </RequireAuth>
  );
}
