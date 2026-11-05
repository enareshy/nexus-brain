"use client";

import { useState } from "react";
import type { Skill, SkillInput } from "@/lib/api";
import { SkillEditor, TOOL_LABELS } from "./SkillEditor";

type Props = {
  skills: readonly Skill[];
  busyId: string | null;
  onUpdate: (id: string, skill: SkillInput) => Promise<boolean>;
  onDelete: (id: string) => void;
};

/** Who can see a skill, from the person's point of view. */
export function skillOwnerText(skill: Pick<Skill, "mine" | "shared" | "ownerName">): string {
  if (!skill.mine) return `Shared by ${skill.ownerName}`;
  return skill.shared ? "Yours, shared with your company" : "Yours, only you can see it";
}

/** Skill text is written by people in the company, so it is shown as plain text, never as markup. */
export function SkillList({ skills, busyId, onUpdate, onDelete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (skills.length === 0) return <p className="text-slate-500">No skills yet.</p>;

  return (
    <ul className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
      {skills.map((skill) => (
        <li key={skill.id} className="py-5">
          {editingId === skill.id ? (
            <SkillEditor
              initial={{ name: skill.name, instructions: skill.instructions, tools: skill.tools, shared: skill.shared }}
              isBusy={busyId === skill.id}
              submitLabel="Save"
              onSubmit={async (changed) => {
                const saved = await onUpdate(skill.id, changed);
                if (saved) setEditingId(null);
                return saved;
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">{skill.readable ? skill.name : "This skill could not be read"}</h3>
                <span className="text-xs text-slate-500">{skillOwnerText(skill)}</span>
              </div>
              {skill.readable && (
                <>
                  <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-400">{skill.instructions}</p>
                  <p className="mt-2 text-xs text-slate-500">May: {skill.tools.map((tool) => TOOL_LABELS[tool] ?? tool).join(" · ")}</p>
                </>
              )}
              {skill.mine && (
                <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                  {skill.readable && (
                    <button type="button" onClick={() => setEditingId(skill.id)} aria-label={`Edit ${skill.name}`} className="font-medium text-brand">
                      Edit
                    </button>
                  )}
                  {confirmingId === skill.id ? (
                    <>
                      <span className="text-slate-600 dark:text-slate-400">Delete this skill{skill.shared ? " for everyone" : ""}?</span>
                      <button type="button" onClick={() => setConfirmingId(null)} className="font-medium text-slate-600 dark:text-slate-300">
                        Keep
                      </button>
                      <button
                        type="button"
                        disabled={busyId === skill.id}
                        onClick={() => {
                          setConfirmingId(null);
                          onDelete(skill.id);
                        }}
                        className="rounded-md bg-red-700 px-3 py-1 font-semibold text-white hover:bg-red-800 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(skill.id)}
                      aria-label={`Delete ${skill.readable ? skill.name : "this skill"}`}
                      className="font-medium text-red-700 dark:text-red-400"
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
