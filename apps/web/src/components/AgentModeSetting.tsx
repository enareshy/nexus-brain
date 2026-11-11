"use client";

import { useEffect, useState } from "react";
import { describeError, type AgentMode, type AgentModeView } from "@/lib/api";

type Props = {
  load: () => Promise<AgentModeView>;
  save: (mode: AgentMode) => Promise<AgentModeView>;
};

const MODES: ReadonlyArray<{ value: AgentMode; label: string; detail: string }> = [
  { value: "ask", label: "Ask me first", detail: "Agents can propose changes, and nothing changes until you approve." },
  { value: "read_only", label: "Read only", detail: "Agents only search and answer. They never propose changes." },
];

/** Whether the person's own agents may propose changes (FR-AGT-04). Approval is always required. */
export function AgentModeSetting({ load, save }: Props) {
  const [view, setView] = useState<AgentModeView | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let isCurrent = true;
    load().then(
      (loaded) => {
        if (!isCurrent) return;
        setView(loaded);
        setError(null);
      },
      (err: unknown) => isCurrent && setError(describeError(err)),
    );
    return () => {
      isCurrent = false;
    };
  }, [load, attempt]);

  async function choose(mode: AgentMode) {
    setIsSaving(true);
    setError(null);
    try {
      setView(await save(mode));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsSaving(false);
    }
  }

  const companyReadOnly = view ? !view.companyAllowsChanges : false;
  return (
    <fieldset className="mt-8">
      <legend className="text-sm font-medium">When an agent wants to change something</legend>
      {companyReadOnly && (
        <p role="status" className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          An admin has made Brain's agents read only for your company, so they only search and answer.
        </p>
      )}
      <div className="mt-2 space-y-2">
        {MODES.map((m) => (
          <label key={m.value} aria-label={m.label} className="flex items-start gap-3 text-sm">
            <input
              type="radio"
              name="agent-mode"
              value={m.value}
              checked={view?.mode === m.value}
              disabled={!view || isSaving || companyReadOnly}
              onChange={() => void choose(m.value)}
              aria-describedby={`agent-mode-${m.value}`}
              className="mt-0.5 h-4 w-4 border-slate-300 text-brand focus-visible:outline-2 focus-visible:outline-brand"
            />
            <span>
              <span className="font-medium">{m.label}</span>
              <span id={`agent-mode-${m.value}`} className="block text-slate-500 dark:text-slate-400">
                {m.detail}
              </span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
          {!view && (
            <>
              {" "}
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="font-medium underline underline-offset-2">
                Try again
              </button>
            </>
          )}
        </p>
      )}
    </fieldset>
  );
}
