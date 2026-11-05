"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { SkillEditor } from "@/components/SkillEditor";
import { SkillList } from "@/components/SkillList";
import { describeError, type Skill } from "@/lib/api";

function SkillsPage() {
  const { api } = useAuth();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSkills(await api.skills());
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a change, shows any error, and reloads so the list matches what is stored. */
  async function change(id: string, work: () => Promise<unknown>): Promise<boolean> {
    setBusyId(id);
    setError(null);
    try {
      await work();
      setSkills(await api.skills());
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">Reusable instructions</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Skills</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        Save how you like a job done, and choose a skill when you start an{" "}
        <Link href="/agents" className="font-medium text-brand underline underline-offset-2">
          agent
        </Link>
        . A skill can only narrow what the agent may do. Whoever uses it, the agent works with their own access and asks them
        before changing anything.
      </p>

      <section aria-labelledby="new-skill-heading" className="mt-10">
        <h2 id="new-skill-heading" className="text-xl font-bold tracking-tight">
          New skill
        </h2>
        <div className="mt-4">
          <SkillEditor isBusy={busyId === "new"} submitLabel="Add skill" onSubmit={(skill) => change("new", () => api.addSkill(skill))} />
        </div>
      </section>

      {error && (
        <p role="alert" className="mt-6 text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <section aria-labelledby="skills-heading" className="mt-12">
        <h2 id="skills-heading" className="mb-3 text-xl font-bold tracking-tight">
          Your skills and shared ones
        </h2>
        {skills === null ? (
          !error && (
            <p role="status" className="text-slate-500">
              Loading…
            </p>
          )
        ) : (
          <SkillList
            skills={skills}
            busyId={busyId}
            onUpdate={(id, skill) => change(id, () => api.updateSkill(id, skill))}
            onDelete={(id) => void change(id, () => api.deleteSkill(id))}
          />
        )}
      </section>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <SkillsPage />
    </RequireAuth>
  );
}
