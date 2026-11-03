"use client";

import { useState, type FormEvent } from "react";
import type { Budget } from "@/lib/api";

type Props = {
  budget: Budget | null;
  isSaving: boolean;
  onSave: (budget: Budget) => void;
};

const DEFAULT_WARN_PERCENT = 80;

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900";

const asText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

/** Empty means no limit. Anything else must be a non-negative amount. */
function parseLimit(text: string): number | null | "invalid" {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

export function BudgetForm({ budget, isSaving, onSave }: Props) {
  const [monthly, setMonthly] = useState(asText(budget?.monthlyLimitUsd));
  const [perPerson, setPerPerson] = useState(asText(budget?.perPersonLimitUsd));
  const [warnAt, setWarnAt] = useState(String(budget?.warnAtPercent ?? DEFAULT_WARN_PERCENT));
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const monthlyLimitUsd = parseLimit(monthly);
    const perPersonLimitUsd = parseLimit(perPerson);
    const warnAtPercent = Number(warnAt);
    if (monthlyLimitUsd === "invalid" || perPersonLimitUsd === "invalid") {
      setError("Limits are amounts in dollars, or empty for no limit.");
      return;
    }
    if (!Number.isInteger(warnAtPercent) || warnAtPercent < 1 || warnAtPercent > 100) {
      setError("The warning level is a whole number from 1 to 100.");
      return;
    }
    setError(null);
    onSave({ monthlyLimitUsd, perPersonLimitUsd, warnAtPercent });
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-3">
      <label className="text-sm font-medium">
        Company limit per month ($)
        <input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="No limit" className={inputClass} />
      </label>
      <label className="text-sm font-medium">
        Limit per person per month ($)
        <input inputMode="decimal" value={perPerson} onChange={(e) => setPerPerson(e.target.value)} placeholder="No limit" className={inputClass} />
      </label>
      <label className="text-sm font-medium">
        Warn people at (%)
        <input inputMode="numeric" value={warnAt} onChange={(e) => setWarnAt(e.target.value)} className={inputClass} />
      </label>
      <div className="flex flex-wrap items-center gap-4 sm:col-span-3">
        <button
          type="submit"
          disabled={isSaving}
          className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:translate-y-px disabled:opacity-50"
        >
          {isSaving ? "Saving…" : "Save limits"}
        </button>
        <p className="text-sm text-slate-500">
          When a limit is reached, new answers and agent steps stop until you raise it or the month ends (months reset on
          the 1st, UTC). Calls with no known price count as $0.50 each.
        </p>
        {error && (
          <p role="alert" className="w-full text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
