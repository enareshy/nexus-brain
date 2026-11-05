"use client";

import { useId, useState, type FormEvent } from "react";
import type { SkillInput } from "@/lib/api";

export const MAX_SKILL_NAME = 80;
export const MAX_SKILL_INSTRUCTIONS = 4_000;

/** What each agent tool lets a skill do, in plain words. */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  search_documents: "Search and read your connected tools",
  list_jira_projects: "See where you can make Jira changes",
  propose_jira_issue: "Propose new Jira issues",
  propose_jira_update: "Propose changes to Jira issues",
  propose_jira_comment: "Propose Jira comments",
};
const TOOLS = Object.keys(TOOL_LABELS);

const FIELD =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900";

type Props = {
  initial?: SkillInput;
  isBusy: boolean;
  submitLabel: string;
  /** Resolves true when saved, so the form can clear or close. */
  onSubmit: (skill: SkillInput) => Promise<boolean>;
  onCancel?: () => void;
};

const EMPTY: SkillInput = { name: "", instructions: "", tools: ["search_documents"], shared: false };

export function SkillEditor({ initial = EMPTY, isBusy, submitLabel, onSubmit, onCancel }: Props) {
  const id = useId();
  const [skill, setSkill] = useState<SkillInput>(initial);
  const canSave = skill.name.trim() !== "" && skill.instructions.trim() !== "" && skill.tools.length > 0;

  function toggleTool(tool: string) {
    setSkill((prev) => ({
      ...prev,
      tools: prev.tools.includes(tool) ? prev.tools.filter((t) => t !== tool) : TOOLS.filter((t) => t === tool || prev.tools.includes(t)),
    }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    const saved = await onSubmit({ ...skill, name: skill.name.trim(), instructions: skill.instructions.trim() });
    if (saved && initial === EMPTY) setSkill(EMPTY);
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div>
        <label htmlFor={`${id}-name`} className="text-sm font-medium">
          Name
        </label>
        <input
          id={`${id}-name`}
          value={skill.name}
          maxLength={MAX_SKILL_NAME}
          onChange={(e) => setSkill((prev) => ({ ...prev, name: e.target.value.replace(/[\r\n]+/g, " ") }))}
          placeholder="Weekly status update"
          className={FIELD}
        />
      </div>
      <div>
        <label htmlFor={`${id}-instructions`} className="text-sm font-medium">
          Instructions
        </label>
        <textarea
          id={`${id}-instructions`}
          value={skill.instructions}
          maxLength={MAX_SKILL_INSTRUCTIONS}
          rows={5}
          onChange={(e) => setSkill((prev) => ({ ...prev, instructions: e.target.value }))}
          placeholder="Find what changed in my projects this week and summarise it in three short bullets, with links."
          className={FIELD}
        />
      </div>
      <fieldset>
        <legend className="text-sm font-medium">What the agent may do</legend>
        <p className="text-sm text-slate-500">Changes are only ever proposed. You still approve each one.</p>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {TOOLS.map((tool) => (
            <label key={tool} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={skill.tools.includes(tool)} onChange={() => toggleTool(tool)} />
              {TOOL_LABELS[tool]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={skill.shared}
          onChange={(e) => setSkill((prev) => ({ ...prev, shared: e.target.checked }))}
          className="mt-1"
        />
        <span>
          Share with my company
          <span className="block text-slate-500">Colleagues can use it with their own access. Only you can change it.</span>
        </span>
      </label>
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isBusy || !canSave}
          className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
        >
          {isBusy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-sm font-medium text-slate-600 dark:text-slate-300">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
