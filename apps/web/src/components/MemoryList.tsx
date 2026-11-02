"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Memory } from "@/lib/api";

export const MAX_MEMORY_CHARS = 300;

type Props = {
  memories: readonly Memory[];
  busyId: string | null;
  onAdd: (text: string) => Promise<boolean>;
  onUpdate: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string) => void;
};

const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900";
const quietButton =
  "rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50 dark:text-slate-300 dark:hover:text-white";

/** One line, as the API requires: Enter saves instead of starting a new line. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function MemoryList({ memories, busyId, onAdd, onUpdate, onDelete }: Props) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const editRef = useRef<HTMLInputElement>(null);
  const isAdding = busyId === "new";

  // Moves keyboard focus to the field the person just chose to edit.
  useEffect(() => {
    if (editingId) editRef.current?.focus();
  }, [editingId]);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (draft.trim() && (await onAdd(draft.trim()))) setDraft("");
  }

  async function handleSave(event: FormEvent, id: string) {
    event.preventDefault();
    if (editText.trim() && (await onUpdate(id, editText.trim()))) setEditingId(null);
  }

  return (
    <div>
      <form onSubmit={(e) => void handleAdd(e)} className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <label htmlFor="new-memory" className="sr-only">
          Something for Brain to remember
        </label>
        <input
          id="new-memory"
          value={draft}
          maxLength={MAX_MEMORY_CHARS}
          onChange={(e) => setDraft(oneLine(e.target.value))}
          placeholder="For example: I'm on the Payments team, and I like short answers"
          className={inputClass}
        />
        <button
          type="submit"
          disabled={isAdding || !draft.trim()}
          className="shrink-0 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:translate-y-px disabled:opacity-50"
        >
          {isAdding ? "Saving…" : "Remember"}
        </button>
      </form>

      {memories.length === 0 ? (
        <p className="mt-8 text-slate-500">Nothing yet. Brain only remembers what you add here.</p>
      ) : (
        <ul className="mt-8 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {memories.map((m) => {
            const isBusy = busyId === m.id;
            return (
              <li key={m.id} className="py-4">
                {editingId === m.id ? (
                  <form onSubmit={(e) => void handleSave(e, m.id)} className="flex flex-col gap-2 sm:flex-row sm:items-start">
                    <label htmlFor={`edit-${m.id}`} className="sr-only">
                      Edit memory
                    </label>
                    <input
                      id={`edit-${m.id}`}
                      value={editText}
                      maxLength={MAX_MEMORY_CHARS}
                      onChange={(e) => setEditText(oneLine(e.target.value))}
                      className={inputClass}
                      ref={editRef}
                    />
                    <div className="flex shrink-0 gap-1">
                      <button type="button" onClick={() => setEditingId(null)} className={quietButton}>
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isBusy || !editText.trim()}
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
                      >
                        Save
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="grid grid-cols-[1fr_auto] items-start gap-4">
                    <p className={m.readable ? "break-words pt-1.5" : "pt-1.5 italic text-slate-500"}>
                      {m.readable ? m.text : "This memory could not be read. Delete it and add it again."}
                    </p>
                    <div className="flex gap-1">
                      {m.readable && (
                      <button
                        type="button"
                        aria-label={`Edit: ${m.text}`}
                        onClick={() => {
                          setEditingId(m.id);
                          setEditText(m.text);
                        }}
                        className={quietButton}
                      >
                        Edit
                      </button>
                      )}
                      <button
                        type="button"
                        disabled={isBusy}
                        aria-label={m.readable ? `Delete: ${m.text}` : "Delete unreadable memory"}
                        onClick={() => onDelete(m.id)}
                        className="rounded-md px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        {isBusy ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
