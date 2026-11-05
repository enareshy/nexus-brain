"use client";

import { useState, type FormEvent } from "react";
import { MAX_AUTOMATIC_RUNS_PER_DAY, type AiSettings } from "@/lib/api";

type Props = {
  settings: AiSettings;
  /** Members see the settings but cannot change them. */
  canChange: boolean;
  isSaving: boolean;
  onSave: (settings: AiSettings) => void;
};

const MODELS: ReadonlyArray<{ value: AiSettings["modelChoice"]; label: string; detail: string }> = [
  { value: "premium", label: "Most capable", detail: "The best answers and agents. Costs about twice as much." },
  { value: "standard", label: "Balanced", detail: "Good answers and agents for about half the cost." },
];
const RUNS_PER_DAY = Array.from({ length: MAX_AUTOMATIC_RUNS_PER_DAY }, (_, i) => i + 1);

/** The settings in words, for people who cannot change them. */
export function describeAiSettings(settings: AiSettings): readonly string[] {
  const model = MODELS.find((m) => m.value === settings.modelChoice)?.label ?? settings.modelChoice;
  return [
    `Answers and agents use the ${model.toLowerCase()} model.`,
    settings.agentsEnabled ? "Agents are on." : "Agents are turned off.",
    !settings.agentsEnabled
      ? "Automatic agents do not run while agents are off."
      : settings.automaticAgentsEnabled
        ? `Automatic agents are on, up to ${settings.automaticRunsPerDay} ${settings.automaticRunsPerDay === 1 ? "run" : "runs"} a day for each person.`
        : "Automatic agents are turned off.",
  ];
}

const CHECKBOX = "mt-0.5 h-4 w-4 rounded border-slate-300 text-brand focus-visible:outline-2 focus-visible:outline-brand";

/** The company's AI settings (FR-ADM-02, FR-LLM-07). */
export function AiSettingsForm({ settings, canChange, isSaving, onSave }: Props) {
  const [draft, setDraft] = useState<AiSettings>(settings);
  const isChanged = JSON.stringify(draft) !== JSON.stringify(settings);

  if (!canChange) {
    return (
      <ul className="mt-3 space-y-1 text-sm text-slate-600 dark:text-slate-400">
        {describeAiSettings(settings).map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li>Only an admin can change these.</li>
      </ul>
    );
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isChanged) onSave(draft);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-6">
      <fieldset>
        <legend className="text-sm font-medium">Model for answers and agents</legend>
        <div className="mt-2 space-y-2">
          {MODELS.map((m) => (
            <label key={m.value} aria-label={m.label} className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="model-choice"
                value={m.value}
                checked={draft.modelChoice === m.value}
                onChange={() => setDraft({ ...draft, modelChoice: m.value })}
                className="mt-0.5 h-4 w-4 border-slate-300 text-brand focus-visible:outline-2 focus-visible:outline-brand"
              />
              <span>
                <span className="font-medium">{m.label}</span>
                <span className="block text-slate-500 dark:text-slate-400">{m.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Agents</legend>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={draft.agentsEnabled}
            onChange={(e) => setDraft({ ...draft, agentsEnabled: e.target.checked })}
            className={CHECKBOX}
          />
          <span>
            People can use agents
            <span className="block text-slate-500 dark:text-slate-400">Turning this off also stops runs already going, before their next step.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={draft.automaticAgentsEnabled}
            disabled={!draft.agentsEnabled}
            onChange={(e) => setDraft({ ...draft, automaticAgentsEnabled: e.target.checked })}
            className={CHECKBOX}
          />
          <span>
            Automatic agents can run
            <span className="block text-slate-500 dark:text-slate-400">Scheduled agents, and ones started by Jira assignments or @Brain comments.</span>
          </span>
        </label>
        <label className="block text-sm">
          <span>Automatic runs a day, for each person</span>
          <select
            value={draft.automaticRunsPerDay}
            disabled={!draft.agentsEnabled || !draft.automaticAgentsEnabled}
            onChange={(e) => setDraft({ ...draft, automaticRunsPerDay: Number(e.target.value) })}
            className="mt-1 block w-24 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums shadow-sm focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
          >
            {RUNS_PER_DAY.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <p className="text-sm text-slate-500 dark:text-slate-400">Every change applies from the next answer or agent step, and is recorded in the activity log.</p>
      <button
        type="submit"
        disabled={isSaving || !isChanged}
        className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
      >
        {isSaving ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}
