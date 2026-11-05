"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { PeopleList } from "@/components/PeopleList";
import { ApiError, describeError, type Deactivation, type Me, type Person } from "@/lib/api";

function summary(name: string, result: Deactivation): string {
  if (!result.changed) return `${name} was already turned off.`;
  const parts = [
    `${result.connectionsRemoved} connection${result.connectionsRemoved === 1 ? "" : "s"} removed`,
    `${result.triggersPaused} automatic agent${result.triggersPaused === 1 ? "" : "s"} paused`,
    `${result.runsCancelled} running agent${result.runsCancelled === 1 ? "" : "s"} cancelled`,
    `${result.proposalsRejected} waiting change${result.proposalsRejected === 1 ? "" : "s"} rejected`,
  ];
  const inProgress =
    result.changesInProgress > 0
      ? ` ${result.changesInProgress} change${result.changesInProgress === 1 ? "" : "s"} they had already approved will still finish.`
      : "";
  return `${name} is turned off: ${parts.join(", ")}.${inProgress}`;
}

function PeoplePage() {
  const { api } = useAuth();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, current] = await Promise.all([api.people(), api.me()]);
      setPeople(list);
      setMe(current);
    } catch (e) {
      if (e instanceof ApiError && e.code === "FORBIDDEN") setIsForbidden(true);
      else setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function change(id: string, action: "deactivate" | "reactivate" | "erase") {
    const name = people?.find((p) => p.id === id)?.displayName ?? "This person";
    setBusyId(id);
    setNotice(null);
    setError(null);
    try {
      if (action === "deactivate") setNotice(summary(name, await api.deactivatePerson(id)));
      else if (action === "erase") {
        await api.erasePerson(id);
        setNotice(`${name} was erased. Everything they owned is gone, and their name and email are removed.`);
      } else {
        await api.reactivatePerson(id);
        setNotice(`${name} can sign in again. They will need to reconnect their services and turn their automatic agents back on.`);
      }
      setPeople(await api.people());
    } catch (e) {
      setError(e instanceof ApiError && e.code === "FORBIDDEN" ? e.message : describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">Admins only</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">People</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        Who can use Nexus Brain. Turning someone off takes effect at once and stops everything running for them.
      </p>
      <div className="mt-10">
        {notice && (
          <p role="status" className="mb-6 rounded-md bg-slate-100 px-4 py-3 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-300">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="mb-6 text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        {isForbidden ? (
          <p role="alert" className="text-slate-600 dark:text-slate-400">
            Only a workspace admin can manage people.
          </p>
        ) : people === null || me === null ? (
          !error && (
            <p role="status" className="text-slate-500">
              Loading…
            </p>
          )
        ) : (
          <PeopleList
            people={people}
            currentUserId={me.userId}
            isOwner={me.role === "owner"}
            busyId={busyId}
            onDeactivate={(id) => void change(id, "deactivate")}
            onReactivate={(id) => void change(id, "reactivate")}
            onErase={(id) => void change(id, "erase")}
          />
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <PeoplePage />
    </RequireAuth>
  );
}
