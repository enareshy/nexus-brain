import type { Connection } from "@/lib/api";

type Props = { status: Connection["status"] };

const STYLES: Record<Connection["status"], { label: string; className: string }> = {
  active: {
    label: "Connected",
    className: "bg-emerald-50 text-emerald-800 ring-emerald-600/30 dark:bg-emerald-950 dark:text-emerald-300",
  },
  needs_reauth: {
    label: "Reconnect needed",
    className: "bg-amber-50 text-amber-900 ring-amber-600/40 dark:bg-amber-950 dark:text-amber-200",
  },
  not_connected: {
    label: "Not connected",
    className: "bg-slate-100 text-slate-600 ring-slate-400/30 dark:bg-slate-800 dark:text-slate-300",
  },
};

export function StatusBadge({ status }: Props) {
  const { label, className } = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
