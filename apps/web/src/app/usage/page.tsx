"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { BudgetForm } from "@/components/BudgetForm";
import { UsageDashboard } from "@/components/UsageDashboard";
import { ApiError, describeError, type Budget, type UsageOverview } from "@/lib/api";

function UsagePage() {
  const { api } = useAuth();
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOverview(await api.usageOverview());
    } catch (e) {
      if (e instanceof ApiError && e.code === "FORBIDDEN") setIsForbidden(true);
      else setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(budget: Budget) {
    setIsSaving(true);
    setNotice(null);
    setError(null);
    try {
      await api.setBudget(budget);
      setNotice("Limits saved. They apply from the next request.");
      setOverview(await api.usageOverview());
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">Admins only</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">Usage</h1>
      <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
        What AI work cost your company this month, and the limits that keep it in check. Amounts are estimates from
        the provider&apos;s list prices.
      </p>
      <div className="mt-10">
        {error && (
          <div role="alert" className="mb-6 text-red-700 dark:text-red-400">
            <p>{error}</p>
            <button type="button" onClick={() => void load()} className="mt-2 font-medium underline underline-offset-4">
              Try again
            </button>
          </div>
        )}
        {isForbidden ? (
          <p role="alert" className="text-slate-600 dark:text-slate-400">
            Only a workspace admin can view spending.
          </p>
        ) : overview === null ? (
          !error && (
            <p role="status" className="text-slate-500">
              Loading…
            </p>
          )
        ) : (
          <>
            <UsageDashboard overview={overview} />
            <section aria-labelledby="limits-heading" className="mt-12 border-t border-slate-200 pt-8 dark:border-slate-800">
              <h2 id="limits-heading" className="text-xl font-semibold tracking-tight">
                Monthly limits
              </h2>
              {notice && (
                <p role="status" className="mt-3 text-sm text-slate-600 dark:text-slate-400">
                  {notice}
                </p>
              )}
              <div className="mt-5">
                <BudgetForm budget={overview.budget} isSaving={isSaving} onSave={(b) => void handleSave(b)} />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <UsagePage />
    </RequireAuth>
  );
}
