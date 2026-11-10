import type { RankerStatus } from "@/lib/api";

type Props = {
  status: RankerStatus;
};

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function explanation(status: RankerStatus): string {
  if (status.state === "never_trained") {
    return `Results keep their usual order. Once your company has rated at least ${status.minAnswers} answers, an operator trains it, and it is switched on only if it ranks results better.`;
  }
  const d = status.details;
  if (status.state === "on") {
    return d
      ? `Learned from ${d.answers} rated answers. On answers it had not learned from, it put the cited result higher than the usual order did (score ${d.holdoutMrr.toFixed(2)} against ${d.baselineMrr.toFixed(2)}).`
      : "It is in use. The details of its last training could not be read; training it again will show them.";
  }
  if (!d) return "Results keep their usual order. The details of its last training could not be read.";
  if (d.reason === "too_few") {
    return `It has ${d.answers} rated answers so far and needs at least ${status.minAnswers} before it can learn anything reliable. Results keep their usual order.`;
  }
  if (d.reason === "no_gain") {
    return `It learned from ${d.answers} rated answers but did not rank answers clearly better than the usual order, so results keep their usual order.`;
  }
  return "Training switched it on, but the saved result could not be used, so results keep their usual order. Training it again should fix this.";
}

/**
 * Whether the company's learned ranker is in use (FR-RET-08). It learns only general signals from
 * ratings (position, match score, age, which service), never who rated or any document.
 */
export function RankerStatusPanel({ status }: Props) {
  const label = status.state === "never_trained" ? "Not trained yet" : status.state === "on" ? "On" : "Off";
  const tone =
    status.state === "on"
      ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
      : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  return (
    <div>
      <p className="flex flex-wrap items-center gap-3">
        <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${tone}`}>{label}</span>
        {status.state !== "never_trained" && when(status.trainedAt) && (
          <span className="text-sm text-slate-500">Last trained {when(status.trainedAt)}</span>
        )}
      </p>
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">{explanation(status)}</p>
    </div>
  );
}
