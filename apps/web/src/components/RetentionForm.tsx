"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Retention } from "@/lib/api";

export const MAX_DAYS = 3650;

type Props = {
  retention: Retention;
  isSaving: boolean;
  /** Resolves true when saved. */
  onSave: (retention: Retention) => Promise<boolean>;
};

const asText = (days: number | null) => (days === null ? "" : String(days));

/** Empty keeps everything; otherwise a whole number of days. */
function parseDays(text: string): number | null | "invalid" {
  if (!text.trim()) return null;
  if (!/^\d+$/.test(text.trim())) return "invalid";
  const days = Number(text);
  return days >= 1 && days <= MAX_DAYS ? days : "invalid";
}

/** What a setting means, in words, so nobody has to read a number as a policy. */
export function keptFor(days: number | null): string {
  if (days === null) return "kept until people delete them";
  return `removed ${days} ${days === 1 ? "day" : "days"} after they were last used`;
}

const FIELD =
  "mt-1 w-32 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums shadow-sm focus-visible:outline-2 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900";

/** For admins: how long the company keeps chats and agent runs (FR-ADM-03). */
export function RetentionForm({ retention, isSaving, onSave }: Props) {
  const id = useId();
  const [chats, setChats] = useState(asText(retention.conversationDays));
  const [runs, setRuns] = useState(asText(retention.agentRunDays));
  const [error, setError] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // The confirmation replaces the Save button, so focus moves to it, and back to Save when it closes.
  useEffect(() => {
    if (isConfirming) cancelRef.current?.focus();
    else if (wasConfirming.current) saveRef.current?.focus();
    wasConfirming.current = isConfirming;
  }, [isConfirming]);

  // Escape closes the confirmation, as it would any dialog.
  useEffect(() => {
    if (!isConfirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsConfirming(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isConfirming]);

  const conversationDays = parseDays(chats);
  const agentRunDays = parseDays(runs);
  const isValid = conversationDays !== "invalid" && agentRunDays !== "invalid";
  const removesMore =
    isValid &&
    ((conversationDays !== null && (retention.conversationDays === null || conversationDays < retention.conversationDays)) ||
      (agentRunDays !== null && (retention.agentRunDays === null || agentRunDays < retention.agentRunDays)));

  async function save() {
    if (conversationDays === "invalid" || agentRunDays === "invalid") return;
    setIsConfirming(false);
    await onSave({ conversationDays, agentRunDays });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isValid) {
      setError(`Use a whole number of days from 1 to ${MAX_DAYS}, or leave it empty to keep everything.`);
      return;
    }
    setError(null);
    // Shortening removes data for everyone in the company within the hour, so it is confirmed first.
    if (removesMore) setIsConfirming(true);
    else void save();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div className="flex flex-wrap gap-6">
        <div>
          <label htmlFor={`${id}-chats`} className="text-sm font-medium">
            Keep chats for (days)
          </label>
          <input id={`${id}-chats`} inputMode="numeric" value={chats} disabled={isConfirming} onChange={(e) => setChats(e.target.value)} placeholder="Keep" className={`block ${FIELD}`} />
        </div>
        <div>
          <label htmlFor={`${id}-runs`} className="text-sm font-medium">
            Keep finished agent runs for (days)
          </label>
          <input id={`${id}-runs`} inputMode="numeric" value={runs} disabled={isConfirming} onChange={(e) => setRuns(e.target.value)} placeholder="Keep" className={`block ${FIELD}`} />
        </div>
      </div>
      <p className="text-sm text-slate-500">Leave a field empty to keep those until people delete them. Agents still working are never removed.</p>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {isConfirming ? (
        <div
          role="alertdialog"
          aria-label="Confirm removing data"
          aria-describedby={`${id}-confirm`}
          className="rounded-md bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <p id={`${id}-confirm`}>
            {[
              typeof conversationDays === "number" && `chats unused for more than ${conversationDays} days`,
              typeof agentRunDays === "number" && `finished agent runs older than ${agentRunDays} days`,
            ]
              .filter(Boolean)
              .join(" and ")
              .replace(/^./, (c) => c.toUpperCase())}{" "}
            will be removed for everyone in your company, starting within the hour. They cannot be brought back.
          </p>
          <div className="mt-3 flex gap-3">
            <button ref={cancelRef} type="button" onClick={() => setIsConfirming(false)} className="font-medium">
              Cancel
            </button>
            <button type="button" disabled={isSaving} onClick={() => void save()} className="rounded-md bg-red-700 px-3 py-1.5 font-semibold text-white hover:bg-red-800 disabled:opacity-50">
              Remove older data
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={saveRef}
          type="submit"
          disabled={isSaving}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-white dark:text-slate-900"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
      )}
    </form>
  );
}
