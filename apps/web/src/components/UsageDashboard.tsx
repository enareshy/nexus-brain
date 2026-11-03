import type { UsageOverview } from "@/lib/api";

const FEATURE_LABEL: Record<string, string> = {
  answer: "Answers",
  answer_estimated: "Answers (cut short, estimated)",
  query_rewrite: "Search wording",
  query_rewrite_estimated: "Search wording (cut short, estimated)",
  agent: "Agents",
  agent_estimated: "Agents (cut short, estimated)",
};

const usd = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 });

const LEVEL_STYLE = {
  ok: "bg-brand",
  warn: "bg-amber-500",
  stop: "bg-red-600",
} as const;

function Table({ caption, head, rows }: { caption: string; head: readonly string[]; rows: ReadonlyArray<readonly string[]> }) {
  return (
    <table className="w-full text-left text-sm">
      <caption className="mb-2 text-left text-sm font-semibold uppercase tracking-wide text-slate-500">{caption}</caption>
      <thead>
        <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
          {head.map((h, i) => (
            <th key={h} scope="col" className={`py-2 font-medium ${i > 0 ? "text-right" : ""}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={head.length} className="py-3 text-slate-500">
              Nothing yet this month.
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={row[0]} className="border-b border-slate-100 dark:border-slate-900">
              {row.map((cell, i) => (
                <td key={i} className={`py-2 ${i > 0 ? "text-right tabular-nums" : "break-all"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/** This month's AI spending for the company. Read-only; the limits are set with BudgetForm. */
export function UsageDashboard({ overview }: { overview: UsageOverview }) {
  const { summary, budget, companyLevel } = overview;
  const limit = budget?.monthlyLimitUsd ?? null;
  const percent = limit === null ? null : limit <= 0 ? 100 : Math.min(100, (summary.totalUsd / limit) * 100);
  const busiestDay = Math.max(...summary.byDay.map((d) => d.costUsd), 0);
  const month = new Date(summary.monthStart).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="space-y-10">
      <section aria-labelledby="spend-heading">
        <h2 id="spend-heading" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {month}
        </h2>
        <p className="mt-2 text-5xl font-bold tracking-tight tabular-nums">{usd(summary.totalUsd)}</p>
        <p className="mt-1 text-slate-600 dark:text-slate-400">
          {summary.calls.toLocaleString()} AI calls{limit !== null && ` of a ${usd(limit)} monthly limit`}
          {companyLevel === "stop" && " — limit reached, AI work is paused"}
          {companyLevel === "warn" && " — nearing the limit"}
        </p>
        {percent !== null && (
          <div
            role="progressbar"
            aria-label="Share of the monthly limit used"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
          >
            <div className={`h-full ${LEVEL_STYLE[companyLevel]}`} style={{ width: `${percent}%` }} />
          </div>
        )}
        {summary.unpricedCalls > 0 && (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
            {summary.unpricedCalls} calls used a model with no known price. Each is counted at $0.50 so limits still apply.
          </p>
        )}
      </section>

      {summary.byDay.length > 0 && (
        <section aria-labelledby="days-heading">
          <h2 id="days-heading" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            By day
          </h2>
          <ul className="mt-3 flex h-28 items-end gap-1" aria-label="Spending by day">
            {summary.byDay.map((d) => (
              <li
                key={d.day}
                title={`${d.day}: ${usd(d.costUsd)}`}
                aria-label={`${d.day}: ${usd(d.costUsd)}`}
                className="min-w-1 flex-1 rounded-t bg-brand/80"
                style={{ height: `${busiestDay > 0 ? Math.max(4, (d.costUsd / busiestDay) * 100) : 4}%` }}
              />
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-10 md:grid-cols-2">
        <Table
          caption="By feature"
          head={["Feature", "Calls", "Cost"]}
          rows={summary.byFeature.map((f) => [FEATURE_LABEL[f.feature] ?? f.feature, f.calls.toLocaleString(), usd(f.costUsd)])}
        />
        <Table
          caption="By person"
          head={["Person", "Calls", "Cost"]}
          rows={summary.byPerson.map((p) => [p.email ?? "Removed person", p.calls.toLocaleString(), usd(p.costUsd)])}
        />
      </div>
    </div>
  );
}
