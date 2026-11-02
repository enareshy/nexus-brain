"use client";

import { useState } from "react";
import type { Connection } from "@/lib/api";
import { ServerSetup } from "./ServerSetup";
import { StatusBadge } from "./StatusBadge";

type Props = {
  connections: readonly Connection[];
  busyServerId: string | null;
  onConnect: (serverId: string) => void;
  onDisconnect: (serverId: string) => void;
  canSetUp?: boolean;
  onSaveApp?: (serverId: string, app: { clientId: string; clientSecret: string }) => void;
  onSetAllowed?: (serverId: string, allowed: boolean) => void;
};

function lastUsedLabel(value: string | null): string {
  if (!value) return "Never used";
  return `Last used ${new Date(value).toLocaleString()}`;
}

export function ConnectionsList({
  connections,
  busyServerId,
  onConnect,
  onDisconnect,
  canSetUp = false,
  onSaveApp = () => {},
  onSetAllowed = () => {},
}: Props) {
  const [settingUp, setSettingUp] = useState<string | null>(null);

  if (connections.length === 0) {
    return <p className="text-slate-500">No services are enabled for this workspace yet.</p>;
  }

  return (
    <ul className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
      {connections.map((c) => {
        const isBusy = busyServerId === c.serverId;
        const isConnected = c.status === "active";
        const actionLabel = c.status === "needs_reauth" ? "Reconnect" : "Connect";
        const needsSetup = c.setup === "needs_app";
        const isTurnedOff = !c.allowed;
        const canChange = canSetUp && c.setup === "configured";
        const isSettingUp = (needsSetup || canChange) && settingUp === c.serverId;
        return (
          <li key={c.serverId} className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-4 py-5">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold tracking-tight">{c.displayName}</h2>
                {isTurnedOff ? (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    Turned off
                  </span>
                ) : (
                  !needsSetup && <StatusBadge status={c.status} />
                )}
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {isTurnedOff
                  ? canSetUp
                    ? "Turned off for everyone in your workspace."
                    : "Your admin has turned this off. Nothing can read through it."
                  : needsSetup
                  ? canSetUp
                    ? "Needs a one-time setup before anyone can connect."
                    : "Not available yet. Ask a workspace admin to set it up."
                  : lastUsedLabel(c.lastUsedAt)}
              </p>
              {canSetUp && (
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label={`${isTurnedOff ? "Allow" : "Turn off"} ${c.displayName} for everyone`}
                  onClick={() => onSetAllowed(c.serverId, isTurnedOff)}
                  className="mr-4 mt-1 text-sm font-medium text-slate-600 underline underline-offset-4 hover:text-slate-900 disabled:opacity-50 dark:text-slate-300 dark:hover:text-white"
                >
                  {isTurnedOff ? "Allow for everyone" : "Turn off for everyone"}
                </button>
              )}
              {canChange && !isTurnedOff && (
                <button
                  type="button"
                  aria-expanded={isSettingUp}
                  aria-label={`Change setup for ${c.displayName}`}
                  onClick={() => setSettingUp(isSettingUp ? null : c.serverId)}
                  className="mt-1 text-sm font-medium text-slate-600 underline underline-offset-4 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                >
                  {isSettingUp ? "Close setup" : "Change setup"}
                </button>
              )}
            </div>
            {isTurnedOff ? (
              isConnected || c.status === "needs_reauth" ? (
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label={`Disconnect ${c.displayName}`}
                  onClick={() => onDisconnect(c.serverId)}
                  className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800"
                >
                  {isBusy ? "Disconnecting…" : "Disconnect"}
                </button>
              ) : (
                <span />
              )
            ) : needsSetup ? (
              canSetUp && (
                <button
                  type="button"
                  aria-expanded={isSettingUp}
                  aria-label={`Set up ${c.displayName}`}
                  onClick={() => setSettingUp(isSettingUp ? null : c.serverId)}
                  className="rounded-md bg-brand px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:translate-y-px"
                >
                  {isSettingUp ? "Close" : "Set up"}
                </button>
              )
            ) : isConnected ? (
              <button
                type="button"
                disabled={isBusy}
                aria-label={`Disconnect ${c.displayName}`}
                onClick={() => onDisconnect(c.serverId)}
                className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800"
              >
                {isBusy ? "Disconnecting…" : "Disconnect"}
              </button>
            ) : (
              <button
                type="button"
                disabled={isBusy}
                aria-label={`${actionLabel} ${c.displayName}`}
                onClick={() => onConnect(c.serverId)}
                className="rounded-md bg-brand px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:translate-y-px disabled:opacity-50"
              >
                {isBusy ? "Opening…" : actionLabel}
              </button>
            )}
            {isSettingUp && (
              <div className="col-span-2">
                <ServerSetup connection={c} isBusy={isBusy} onSave={onSaveApp} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
