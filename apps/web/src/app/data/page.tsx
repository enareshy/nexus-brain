"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { keptFor, RetentionForm } from "@/components/RetentionForm";
import { describeError, type Retention } from "@/lib/api";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Saves the export as a file on the person's device. Nothing is sent anywhere else. */
function download(data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nexus-brain-my-data-${new Date().toISOString().slice(0, 10)}.json`;
  // In the page and freed after the click, as some browsers cancel a download otherwise.
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function DataPage() {
  const { api } = useAuth();
  const [retention, setRetention] = useState<Retention | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [settings, me] = await Promise.all([api.retention(), api.me()]);
      setRetention(settings);
      setIsAdmin(ADMIN_ROLES.has(me.role));
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleExport() {
    setIsExporting(true);
    setError(null);
    setNotice(null);
    try {
      download(await api.exportMyData());
      setNotice("Your data was saved as a file on this device.");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsExporting(false);
    }
  }

  async function handleSave(next: Retention): Promise<boolean> {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      setRetention(await api.setRetention(next));
      setNotice("Saved. Removing anything older starts within the hour.");
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">Yours to keep or remove</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Your data</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        Download everything Brain holds for you, and see how long your company keeps it.
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

      <section aria-labelledby="export-heading" className="mt-10">
        <h2 id="export-heading" className="text-xl font-bold tracking-tight">
          Download your data
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          One file with your chats, memories, skills, agent runs, automatic agents, proposed changes and which services you
          have connected. It includes nothing of anyone else&apos;s, and no passwords or tokens.
        </p>
        <button
          type="button"
          disabled={isExporting}
          onClick={() => void handleExport()}
          className="mt-4 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-ink disabled:opacity-50"
        >
          {isExporting ? "Preparing…" : "Download my data"}
        </button>
      </section>

      <section aria-labelledby="retention-heading" className="mt-12 border-t border-slate-200 pt-8 dark:border-slate-800">
        <h2 id="retention-heading" className="text-xl font-bold tracking-tight">
          How long your company keeps data
        </h2>
        {retention === null ? (
          !error && (
            <p role="status" className="mt-3 text-slate-500">
              Loading…
            </p>
          )
        ) : (
          <>
            <ul className="mt-3 space-y-1 text-sm text-slate-600 dark:text-slate-400">
              <li>Chats are {keptFor(retention.conversationDays)}.</li>
              <li>Finished agent runs and their notifications are {keptFor(retention.agentRunDays)}.</li>
            </ul>
            {isAdmin && (
              <div className="mt-6">
                <RetentionForm key={JSON.stringify(retention)} retention={retention} isSaving={isSaving} onSave={handleSave} />
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <DataPage />
    </RequireAuth>
  );
}
