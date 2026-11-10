"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AiSettingsForm } from "@/components/AiSettingsForm";
import { RankerStatusPanel } from "@/components/RankerStatusPanel";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { describeError, type AiSettings, type RankerStatus } from "@/lib/api";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** The rest of the admin console lives on pages people already know; this ties them together. */
const SECTIONS: ReadonlyArray<{ href: string; title: string; detail: string }> = [
  { href: "/people", title: "People", detail: "Turn people off, which revokes their connections, or erase them." },
  { href: "/connections", title: "Services", detail: "Choose which services your company may connect to Brain." },
  { href: "/usage", title: "Usage and credits", detail: "See AI costs, set spending limits and add credits." },
  { href: "/data", title: "Data", detail: "Set how long chats and agent runs are kept." },
  { href: "/activity", title: "Activity", detail: "The audit trail of searches, answers, agents and changes." },
];

function AdminPage() {
  const { api } = useAuth();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ranker, setRanker] = useState<RankerStatus | null>(null);
  const [rankerError, setRankerError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [loaded, me] = await Promise.all([api.aiSettings(), api.me()]);
      setSettings(loaded);
      const admin = ADMIN_ROLES.has(me.role);
      setIsAdmin(admin);
      // Admins only; its own failure must not hide the settings above.
      if (admin) {
        setRankerError(null);
        api.rankerStatus().then(setRanker, (e: unknown) => setRankerError(describeError(e)));
      }
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(next: AiSettings) {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      setSettings(await api.setAiSettings(next));
      setNotice("Saved. The change applies from the next answer or agent step.");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">For your company</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Admin</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        Decide how your company uses Brain&apos;s AI, and find everything else admins look after.
      </p>

      {error && (
        <p role="alert" className="mt-6 text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-6 text-sm text-slate-600 dark:text-slate-400">
          {notice}
        </p>
      )}

      <section aria-labelledby="ai-heading" className="mt-10">
        <h2 id="ai-heading" className="text-xl font-bold tracking-tight">
          AI settings
        </h2>
        {settings === null ? (
          !error && (
            <p role="status" className="mt-3 text-slate-500">
              Loading…
            </p>
          )
        ) : (
          <AiSettingsForm key={JSON.stringify(settings)} settings={settings} canChange={isAdmin} isSaving={isSaving} onSave={(next) => void handleSave(next)} />
        )}
      </section>

      {isAdmin && (
        <section aria-labelledby="ranker-heading" className="mt-12 border-t border-slate-200 pt-8 dark:border-slate-800">
          <h2 id="ranker-heading" className="text-xl font-bold tracking-tight">
            Learned ranking
          </h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            Brain can learn from your company&apos;s ratings of answers which kinds of results people find useful, and
            put those a little higher for everyone here. It keeps only general signals (place in the list, match score,
            age and which service), never who rated or anything about a document.
          </p>
          <div className="mt-4">
            {rankerError ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                {rankerError}
              </p>
            ) : ranker ? (
              <RankerStatusPanel status={ranker} />
            ) : (
              <p role="status" className="text-sm text-slate-500">
                Loading…
              </p>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="more-heading" className="mt-12 border-t border-slate-200 pt-8 dark:border-slate-800">
        <h2 id="more-heading" className="text-xl font-bold tracking-tight">
          Also for admins
        </h2>
        <ul className="mt-4 divide-y divide-slate-200 dark:divide-slate-800">
          {SECTIONS.map((section) => (
            <li key={section.href}>
              <Link
                href={section.href}
                className="group flex items-baseline justify-between gap-4 py-3 focus-visible:outline-2 focus-visible:outline-brand"
              >
                <span>
                  <span className="font-medium group-hover:text-brand">{section.title}</span>
                  <span className="block text-sm text-slate-500 dark:text-slate-400">{section.detail}</span>
                </span>
                <span aria-hidden="true" className="text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-brand">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <AdminPage />
    </RequireAuth>
  );
}
