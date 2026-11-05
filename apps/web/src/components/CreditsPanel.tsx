"use client";

import { useId, useState, type FormEvent } from "react";
import type { Credits } from "@/lib/api";

/** The same as the API's limit for one top-up. */
export const MAX_TOP_UP = 1_000_000;

type Props = {
  /** Null when the company has no plan. */
  credits: Credits | null;
  isAdding: boolean;
  /** Resolves true when added, so the field can clear. */
  onAdd: (credits: number) => Promise<boolean>;
};

const count = (n: number) => n.toLocaleString("en-US");
const date = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const BAR = { ok: "bg-brand", warn: "bg-amber-500", stop: "bg-red-600" } as const;

/** The company's credits this month (FR-MET-02), and top-ups for admins (FR-MET-04). One credit is one cent. */
export function CreditsPanel({ credits, isAdding, onAdd }: Props) {
  const id = useId();
  const [amount, setAmount] = useState("");

  if (!credits) {
    return (
      <section aria-labelledby={`${id}-heading`} className="mt-12 border-t border-slate-200 pt-8 dark:border-slate-800">
        <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight">
          Credits
        </h2>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          Your company has no plan yet, so agents are limited only by the spending limits below.
        </p>
      </section>
    );
  }

  const total = credits.monthlyCredits + credits.topUpCredits;
  const usedPercent = total <= 0 ? 100 : Math.min(100, (credits.usedCredits / total) * 100);
  const parsed = Number(amount);
  const isValid = amount.trim() !== "" && Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TOP_UP;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isValid && (await onAdd(parsed))) setAmount("");
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="mt-12 border-t border-slate-200 pt-8 dark:border-slate-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight">
          Credits
        </h2>
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">{credits.planLabel} plan</span>
      </div>
      <p className="mt-3 text-4xl font-bold tabular-nums">
        {count(credits.leftCredits)} <span className="text-lg font-medium text-slate-500">of {count(total)} left</span>
      </p>
      <div
        role="meter"
        aria-label="Credits used this month"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(usedPercent)}
        aria-valuetext={`${count(credits.usedCredits)} of ${count(total)} credits used`}
        className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
      >
        <div className={`h-full ${BAR[credits.level]}`} style={{ width: `${usedPercent}%` }} />
      </div>
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
        {count(credits.monthlyCredits)} a month from your plan
        {credits.topUpCredits > 0 && `, plus ${count(credits.topUpCredits)} added this month`}. One credit is one cent of AI
        cost. Agents use credits and pause when they run out; answers don&apos;t use any.
      </p>
      {credits.topUps.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm text-slate-600 dark:text-slate-400">
          {credits.topUps.map((topUp) => (
            <li key={topUp.id}>
              {date(topUp.createdAt)}: {count(topUp.credits)} credits added{topUp.addedByEmail ? ` by ${topUp.addedByEmail}` : ""}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${id}-amount`} className="text-sm font-medium">
            Add credits for this month
          </label>
          <input
            id={`${id}-amount`}
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="1000"
            className="mt-1 block w-40 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
          />
        </div>
        <button
          type="submit"
          disabled={isAdding || !isValid}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-white dark:text-slate-900"
        >
          {isAdding ? "Adding…" : "Add credits"}
        </button>
        <p className="w-full text-xs text-slate-500">
          {amount && !isValid
            ? `Add from 1 to ${count(MAX_TOP_UP)} credits at a time.`
            : "Added credits last until the end of this month and cannot be removed."}
        </p>
      </form>
    </section>
  );
}
