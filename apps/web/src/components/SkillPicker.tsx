"use client";

import Link from "next/link";
import type { Skill } from "@/lib/api";
import { TOOL_LABELS } from "./SkillEditor";
import { skillOwnerText } from "./SkillList";

const linesText = (text: string) => {
  const count = text.split("\n").length;
  return count === 1 ? "this line" : `all ${count} of these lines`;
};

type Props = {
  skills: readonly Skill[];
  selectedId: string;
  onSelect: (id: string) => void;
};

/**
 * Picks a skill for a run, showing exactly what it will tell the agent, so a colleague's skill is never
 * followed unseen.
 */
export function SkillPicker({ skills, selectedId, onSelect }: Props) {
  const usable = skills.filter((skill) => skill.readable);
  const chosen = usable.find((skill) => skill.id === selectedId) ?? null;
  if (usable.length === 0) {
    return (
      <p className="mt-3 text-sm text-slate-500">
        Save instructions you reuse as a{" "}
        <Link href="/skills" className="font-medium text-brand underline underline-offset-2">
          skill
        </Link>
        .
      </p>
    );
  }
  return (
    <div className="mt-3">
      <label htmlFor="agent-skill" className="text-sm font-medium">
        Follow a skill
      </label>
      <select
        id="agent-skill"
        aria-describedby={chosen ? "agent-skill-details" : undefined}
        value={chosen?.id ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        <option value="">No skill</option>
        {usable.map((skill) => (
          <option key={skill.id} value={skill.id}>
            {skill.name}
            {skill.mine ? "" : ` (from ${skill.ownerName})`}
          </option>
        ))}
      </select>
      {chosen && (
        <div id="agent-skill-details" aria-live="polite" className="mt-3 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-800">
          <p className="text-xs text-slate-500">
            {skillOwnerText(chosen)}. The agent will be told {linesText(chosen.instructions)}:
          </p>
          <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-slate-700 dark:text-slate-300">{chosen.instructions}</p>
          <p className="mt-2 text-xs text-slate-500">It may only: {chosen.tools.map((tool) => TOOL_LABELS[tool] ?? tool).join(" · ")}</p>
        </div>
      )}
    </div>
  );
}
