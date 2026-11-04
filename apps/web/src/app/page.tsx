"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { AnswerPanel } from "@/components/AnswerPanel";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import type { ItemWorkState } from "@/components/ItemWork";
import { hitKey, SearchResults } from "@/components/SearchResults";
import { INITIAL_ANSWER, readAnswerStream, reduceAnswer, type AnswerState } from "@/lib/answer";
import { ApiError, describeError, type Hit, type ItemTask, type SearchResult, type WriteRequest } from "@/lib/api";

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
  const [answer, setAnswer] = useState<{ query: string; state: AnswerState } | null>(null);
  const answerAbort = useRef<AbortController | null>(null);
  const [work, setWork] = useState<ItemWorkState | null>(null);
  const workAbort = useRef<AbortController | null>(null);
  const workRun = useRef(0);

  // Leaving this query (or the page) cancels any answer or item work still streaming, which stops spending.
  // Clearing it also means returning to this query later offers the buttons again.
  useEffect(
    () => () => {
      answerAbort.current?.abort();
      workAbort.current?.abort();
      setAnswer(null);
      setWork(null);
    },
    [query],
  );

  async function handleItemTask(hit: Hit, task: ItemTask) {
    const controller = new AbortController();
    workAbort.current?.abort();
    workAbort.current = controller;
    workRun.current += 1;
    const run = workRun.current;
    const key = hitKey(hit);
    const apply = (next: (state: AnswerState) => AnswerState) =>
      setWork((prev) => (controller.signal.aborted ? prev : { key, run, kind: task.kind, state: next(prev?.run === run ? prev.state : INITIAL_ANSWER) }));

    setWork({ key, run, kind: task.kind, state: INITIAL_ANSWER });
    try {
      const body = await api.openItemStream(task, hit, controller.signal);
      await readAnswerStream(body, (event) => apply((state) => reduceAnswer(state, event)));
      apply((state) =>
        state.status === "streaming" ? { ...state, status: "error", error: "This was interrupted. Please try again." } : state,
      );
    } catch (e) {
      if (controller.signal.aborted) return;
      apply((state) => ({ ...state, status: "error", error: describeError(e) }));
    }
  }

  // Only records the change: the person approves it on the Changes page before anything happens in Jira.
  async function handlePropose(request: WriteRequest) {
    await api.propose("atlassian", request);
  }

  async function handleAnswer() {
    const controller = new AbortController();
    answerAbort.current?.abort();
    answerAbort.current = controller;
    const asked = query;
    const apply = (next: (state: AnswerState) => AnswerState) =>
      setAnswer((prev) => {
        if (controller.signal.aborted) return prev;
        return { query: asked, state: next(prev?.query === asked ? prev.state : INITIAL_ANSWER) };
      });

    setAnswer({ query: asked, state: INITIAL_ANSWER });
    try {
      const body = await api.openAnswerStream(asked, controller.signal);
      await readAnswerStream(body, (event) => apply((state) => reduceAnswer(state, event)));
      // A stream that closes without `done` or `error` lost its connection part-way.
      apply((state) =>
        state.status === "streaming"
          ? { ...state, status: "error", error: "The answer was interrupted. Please try again." }
          : state,
      );
    } catch (e) {
      if (controller.signal.aborted) return;
      apply((state) => ({ ...state, status: "error", error: describeError(e) }));
    }
  }

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
  const currentAnswer = answer && answer.query === query ? answer.state : null;
  // Answers cost money, so they only run on request, and only when there is something to read.
  const canAnswer =
    current !== null && "result" in current && current.result.hits.length > 0 && currentAnswer?.status !== "streaming" && currentAnswer?.status !== "done";
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
        {currentAnswer && <AnswerPanel state={currentAnswer} />}
        {canAnswer && (
          <button
            type="button"
            onClick={() => void handleAnswer()}
            className="mb-10 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Answer with AI
          </button>
        )}
        {current && "error" in current && (
          <p role="alert" className="text-red-700 dark:text-red-400">
            {current.error}
          </p>
        )}
        {current && "result" in current && (
          <SearchResults
            result={current.result}
            query={query}
            work={work}
            onItemTask={(hit, task) => void handleItemTask(hit, task)}
            onPropose={handlePropose}
          />
        )}
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
