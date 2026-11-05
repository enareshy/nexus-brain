"use client";

import { useState } from "react";
import type { Person } from "@/lib/api";

type Props = {
  people: readonly Person[];
  currentUserId: string;
  /** Only an owner may change another owner. */
  isOwner: boolean;
  busyId: string | null;
  onDeactivate: (id: string) => void;
  onReactivate: (id: string) => void;
  /** Without it, nobody can be erased from here. */
  onErase?: (id: string) => void;
};

const ROLE_LABEL: Record<Person["role"], string> = { owner: "Owner", admin: "Admin", member: "Member", guest: "Guest" };

export function PeopleList({ people, currentUserId, isOwner, busyId, onDeactivate, onReactivate, onErase }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingErase, setConfirmingErase] = useState<string | null>(null);

  return (
    <ul className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
      {people.map((p) => {
        const isSelf = p.id === currentUserId;
        const canChange = !isSelf && (p.role !== "owner" || isOwner);
        const isBusy = busyId === p.id;
        const isConfirming = confirming === p.id;
        const isConfirmingErase = confirmingErase === p.id;
        return (
          <li key={p.id} className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-3 py-5">
            <div className={p.active ? undefined : "opacity-60"}>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold tracking-tight">{p.displayName}</h2>
                <span className="font-mono text-xs uppercase tracking-[0.15em] text-slate-500">{ROLE_LABEL[p.role]}</span>
                {!p.active && (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {p.erased ? "Erased" : "Turned off"}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {p.email}
                {isSelf && " · You"}
              </p>
            </div>
            {!canChange || p.erased ? (
              <span />
            ) : !p.active ? (
              isConfirmingErase ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmingErase(null)}
                    className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    aria-label={`Confirm erasing ${p.displayName}`}
                    onClick={() => {
                      setConfirmingErase(null);
                      onErase?.(p.id);
                    }}
                    className="rounded-md bg-red-700 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:opacity-50"
                  >
                    Erase for good
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {onErase && (
                    <button
                      type="button"
                      disabled={isBusy}
                      aria-label={`Erase ${p.displayName}`}
                      onClick={() => setConfirmingErase(p.id)}
                      className="rounded-md px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
                    >
                      {isBusy ? "Working…" : "Erase"}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={isBusy}
                    aria-label={`Turn ${p.displayName} back on`}
                    onClick={() => onReactivate(p.id)}
                    className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800"
                  >
                    {isBusy ? "Working…" : "Turn back on"}
                  </button>
                </div>
              )
            ) : isConfirming ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label={`Confirm turning off ${p.displayName}`}
                  onClick={() => {
                    setConfirming(null);
                    onDeactivate(p.id);
                  }}
                  className="rounded-md bg-red-700 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 active:translate-y-px disabled:opacity-50"
                >
                  Turn off now
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={isBusy}
                aria-label={`Turn off ${p.displayName}`}
                onClick={() => setConfirming(p.id)}
                className="rounded-md px-3 py-2 text-sm font-medium text-red-700 ring-1 ring-red-200 transition hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:opacity-50 dark:text-red-400 dark:ring-red-900 dark:hover:bg-red-950"
              >
                {isBusy ? "Turning off…" : "Turn off"}
              </button>
            )}
            {isConfirming && (
              <p className="col-span-2 text-sm text-slate-600 dark:text-slate-400">
                {p.displayName} will be signed out of Nexus Brain. Their automatic agents stop, running agents are
                cancelled, changes waiting for their approval are rejected and their connections are removed.
                Their history is kept.
              </p>
            )}
            {isConfirmingErase && (
              <p className="col-span-2 text-sm text-slate-600 dark:text-slate-400">
                Everything {p.displayName} owns is deleted for good: chats, memories, skills (including ones shared with
                others), agent runs, automatic agents, proposed changes and notifications. Their name and email are
                removed. Usage costs and the audit trail stay under an anonymous id. This cannot be undone.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
