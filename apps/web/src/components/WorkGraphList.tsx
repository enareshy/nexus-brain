"use client";

import { useEffect, useRef, useState } from "react";
import type { GraphItem } from "@/lib/api";

type Props = {
  items: readonly GraphItem[];
  /** `service:id` of the item being forgotten, or "all" while clearing. */
  busyKey: string | null;
  onForget: (item: { serverId: string; itemId: string }) => void;
  onClear: () => void;
};

const quietButton =
  "rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50 dark:text-slate-300 dark:hover:text-white";

/** Counts stop at 20 when stored, so 20 means "20 or more". */
const MAX_COUNT = 20;
/** The most items the page is sent; the data export has every one. */
export const MAX_LISTED_ITEMS = 200;

const times = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** For counts stored with that cap. */
const cappedTimes = (n: number, one: string, many: string) => (n >= MAX_COUNT ? `${MAX_COUNT}+ ${many}` : times(n, one, many));

/** How the person used an item, in plain words. */
function usage(item: GraphItem): string {
  const parts = [
    item.opened > 0 ? `Opened ${cappedTimes(item.opened, "time", "times")}` : null,
    item.helpful > 0 ? `Helpful in ${cappedTimes(item.helpful, "answer", "answers")}` : null,
  ].filter(Boolean);
  const linked = item.linkedItems > 0 ? `cited with ${times(item.linkedItems, "other item", "other items")}` : null;
  return [parts.join(", "), linked].filter(Boolean).join(", ");
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The person's own work graph (FR-RET-09): items they opened or found helpful, which Brain uses to
 * put those and related items a little higher in their own results. Item ids come from connected
 * services and are shown as plain text.
 */
export function WorkGraphList({ items, busyKey, onForget, onClear }: Props) {
  const [isConfirming, setIsConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Moves focus to the choice just opened, so keyboard and screen reader users land on it.
  useEffect(() => {
    if (isConfirming) cancelRef.current?.focus();
  }, [isConfirming]);

  if (items.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        Nothing yet. When you open an item through Brain or rate an answer helpful, it shows here.
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {items.map((item) => {
          const key = `${item.serverId}:${item.itemId}`;
          return (
            <li key={key} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="break-all font-medium">{item.itemId}</p>
                <p className="mt-0.5 text-sm text-slate-500">
                  <span className="font-mono text-xs">{item.serverId}</span> · {usage(item)}
                  {when(item.lastSeenAt) && ` · last ${when(item.lastSeenAt)}`}
                </p>
              </div>
              <button
                type="button"
                disabled={busyKey === key || busyKey === "all"}
                onClick={() => onForget({ serverId: item.serverId, itemId: item.itemId })}
                aria-label={`Forget ${item.serverId} ${item.itemId}`}
                className={quietButton}
              >
                Forget
              </button>
            </li>
          );
        })}
      </ul>
      {items.length >= MAX_LISTED_ITEMS && (
        <p className="mt-3 text-sm text-slate-500">
          Showing the {MAX_LISTED_ITEMS} most recent. Download your data on the Data page to see every one.
        </p>
      )}
      {isConfirming ? (
        <div role="group" aria-label="Clear what Brain learned" className="mt-6 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-600 dark:text-slate-400">
            Clear everything Brain learned from what you use? Your results go back to their usual order.
          </span>
          <button type="button" ref={cancelRef} onClick={() => setIsConfirming(false)} className="font-medium text-slate-600 dark:text-slate-300">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setIsConfirming(false);
              onClear();
            }}
            className="rounded-md bg-red-700 px-3 py-1.5 font-semibold text-white hover:bg-red-800"
          >
            Clear
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busyKey === "all"}
          onClick={() => setIsConfirming(true)}
          className="mt-6 text-sm font-medium text-red-700 underline underline-offset-4 disabled:opacity-50 dark:text-red-400"
        >
          Clear all of it
        </button>
      )}
    </div>
  );
}
