"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { SearchResults } from "@/components/SearchResults";
import { ApiError, describeError, type SearchResult } from "@/lib/api";

const MAX_QUERY_CHARS = 200;

type Outcome =
  | { readonly query: string; readonly result: SearchResult }
  | { readonly query: string; readonly error: string };

function SearchPage() {
  const router = useRouter();
  const params = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  const { api } = useAuth();
  const [draft, setDraft] = useState(query);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Keep the input in step with Back/Forward navigation.
  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    api
      .search(query, { signal: controller.signal })
      .then((result) => setOutcome({ query, result }))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === "ABORTED") return;
        setOutcome({ query, error: describeError(e) });
      });
    return () => controller.abort();
  }, [api, query]);

  // Only show an outcome that belongs to the current query (no stale results).
  const current = outcome && outcome.query === query ? outcome : null;
  const isLoading = Boolean(query) && current === null;
  const statusText = isLoading
    ? "Searching…"
    : current && "result" in current
      ? `${current.result.hits.length} ${current.result.hits.length === 1 ? "result" : "results"}`
      : "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (next) router.push(`/?q=${encodeURIComponent(next)}`);
  }

  return (
    <div>
      <h1 className="max-w-2xl text-5xl font-bold leading-[1.05] tracking-tight">
        Ask your work.
        <span className="block text-slate-400">Answers only from what you can see.</span>
      </h1>
      <form onSubmit={handleSubmit} role="search" className="mt-10 flex max-w-3xl gap-3">
        <label htmlFor="q" className="sr-only">
          Search connected tools
        </label>
        <input
          id="q"
          name="q"
          value={draft}
          maxLength={MAX_QUERY_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. status of the login bug"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 text-lg shadow-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/15 dark:border-slate-700 dark:bg-slate-900"
        />
        <button
          type="submit"
          disabled={isLoading || !draft.trim()}
          className="rounded-lg bg-slate-900 px-6 py-3 font-semibold text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40 dark:bg-white dark:text-slate-900"
        >
          {isLoading ? "Searching…" : "Search"}
        </button>
      </form>
      <p role="status" className="sr-only">
        {statusText}
      </p>
      <div className="mt-12 max-w-3xl">
        {current && "error" in current && (
          <p role="alert" className="text-red-700 dark:text-red-400">
            {current.error}
          </p>
        )}
        {current && "result" in current && <SearchResults result={current.result} query={query} />}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <Suspense fallback={<p role="status" className="text-slate-500">Loading…</p>}>
        <SearchPage />
      </Suspense>
    </RequireAuth>
  );
}
