"use client";

import { useEffect, useState } from "react";
import { describeError, type ModelChoice, type PersonalModelView } from "@/lib/api";

type Props = {
  load: () => Promise<PersonalModelView>;
  save: (modelChoice: ModelChoice | null) => Promise<PersonalModelView>;
};

const MODEL_NAMES: Readonly<Record<ModelChoice, string>> = { premium: "Most capable", standard: "Balanced" };
type Option = { value: ModelChoice | null; key: string; label: string; detail: string };

function optionsFor(companyModel: ModelChoice): readonly Option[] {
  return [
    { value: null, key: "company", label: "Your company's choice", detail: `Currently ${MODEL_NAMES[companyModel].toLowerCase()}.` },
    { value: "premium", key: "premium", label: MODEL_NAMES.premium, detail: "The best answers and agents. Costs about twice as much." },
    { value: "standard", key: "standard", label: MODEL_NAMES.standard, detail: "Good answers and agents for about half the cost." },
  ];
}

/** The person's own model for their answers and agents, when their company lets people choose (FR-LLM-07). */
export function PersonalModelSetting({ load, save }: Props) {
  const [view, setView] = useState<PersonalModelView | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;
    load().then(
      (loaded) => isCurrent && setView(loaded),
      (err: unknown) => isCurrent && setError(describeError(err)),
    );
    return () => {
      isCurrent = false;
    };
  }, [load]);

  async function choose(modelChoice: ModelChoice | null) {
    setIsSaving(true);
    setError(null);
    try {
      setView(await save(modelChoice));
    } catch (err) {
      setError(describeError(err));
      // The company may have changed what can be chosen since this was loaded.
      load().then(setView, () => undefined);
    } finally {
      setIsSaving(false);
    }
  }

  if (!view) {
    return error ? (
      <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
        {error}
      </p>
    ) : null;
  }
  if (!view.peopleCanChoose) {
    return (
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
        Your company uses one model for everyone: {MODEL_NAMES[view.companyModel].toLowerCase()}. An admin can let people choose their own.
      </p>
    );
  }
  return (
    <fieldset className="mt-3">
      <legend className="text-sm text-slate-600 dark:text-slate-400">For your own answers and agents.</legend>
      <div className="mt-2 space-y-2">
        {optionsFor(view.companyModel).map((option) => (
          <label key={option.key} aria-label={option.label} className="flex items-start gap-3 text-sm">
            <input
              type="radio"
              name="personal-model"
              value={option.key}
              checked={view.modelChoice === option.value}
              disabled={isSaving}
              onChange={() => void choose(option.value)}
              aria-describedby={`personal-model-${option.key}`}
              className="mt-0.5 h-4 w-4 border-slate-300 text-brand focus-visible:outline-2 focus-visible:outline-brand"
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span id={`personal-model-${option.key}`} className="block text-slate-500 dark:text-slate-400">
                {option.detail}
              </span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </fieldset>
  );
}
