import type { AuditEntry } from "@/lib/api";

type Props = { entries: readonly AuditEntry[] };

const ACTION_LABELS: Readonly<Record<string, string>> = {
  search: "Searched",
  answer: "Asked for an AI answer",
  "audit.viewed": "Viewed this activity",
  "connection.connected": "Connected a service",
  "connection.disconnected": "Disconnected a service",
  "connection.app_saved": "Changed a service's setup",
  "write.proposed": "Drafted a change",
  "write.approved": "Approved a change",
  "write.rejected": "Rejected a change",
  "write.succeeded": "Change completed",
  "write.failed": "Change failed",
  "write.unknown": "Change outcome unknown",
};

function retrievedCount(entry: AuditEntry): number | null {
  const list = entry.meta.results ?? entry.meta.retrieved;
  return Array.isArray(list) ? list.length : null;
}

/** Everything here is shown as text. Document IDs are listed, but never document content. */
export function ActivityList({ entries }: Props) {
  if (entries.length === 0) return <p className="text-slate-500">No activity matches.</p>;
  return (
    <ul className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
      {entries.map((entry) => {
        const count = retrievedCount(entry);
        return (
          <li key={entry.id} className="grid gap-1 py-3 text-sm sm:grid-cols-[11rem_1fr]">
            <time dateTime={entry.createdAt} className="text-slate-500">
              {new Date(entry.createdAt).toLocaleString()}
            </time>
            <div>
              <p className="font-medium">
                {ACTION_LABELS[entry.action] ?? entry.action}
                {entry.resource ? ` · ${entry.resource}` : ""}
                {count === null ? "" : ` · ${count} ${count === 1 ? "document" : "documents"} returned`}
              </p>
              <p className="break-all font-mono text-xs text-slate-500">{entry.userEmail ?? entry.userId ?? "system"}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
