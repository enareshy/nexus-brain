import type { Connection } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";

type Props = {
  connections: readonly Connection[];
  busyServerId: string | null;
  onConnect: (serverId: string) => void;
  onDisconnect: (serverId: string) => void;
};

function lastUsedLabel(value: string | null): string {
  if (!value) return "Never used";
  return `Last used ${new Date(value).toLocaleString()}`;
}

export function ConnectionsList({ connections, busyServerId, onConnect, onDisconnect }: Props) {
  if (connections.length === 0) {
    return <p className="text-slate-500">No services are enabled for this workspace yet.</p>;
  }

  return (
    <ul className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
      {connections.map((c) => {
        const isBusy = busyServerId === c.serverId;
        const isConnected = c.status === "active";
        const actionLabel = c.status === "needs_reauth" ? "Reconnect" : "Connect";
        return (
          <li key={c.serverId} className="grid grid-cols-[1fr_auto] items-center gap-6 py-5">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold tracking-tight">{c.displayName}</h2>
                <StatusBadge status={c.status} />
              </div>
              <p className="mt-1 text-sm text-slate-500">{lastUsedLabel(c.lastUsedAt)}</p>
            </div>
            {isConnected ? (
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
          </li>
        );
      })}
    </ul>
  );
}
