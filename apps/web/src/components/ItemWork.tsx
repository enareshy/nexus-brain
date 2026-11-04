"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import type { AnswerState } from "@/lib/answer";
import { describeError, isJiraIssue, type Hit, type ItemTask, type WriteRequest } from "@/lib/api";
import { AnswerPanel } from "./AnswerPanel";

/** Work running or shown for one search result. `run` changes each time, so a new result starts fresh. */
export type ItemWorkState = { readonly key: string; readonly run: number; readonly kind: ItemTask["kind"]; readonly state: AnswerState };

const MAX_DRAFT_REQUEST = 500;
const MAX_COMMENT_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 255;
const LINK = "text-sm font-medium text-brand underline-offset-4 hover:underline focus-visible:underline disabled:opacity-40";
const BUTTON =
  "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40 dark:bg-white dark:text-slate-900";

type ActionsProps = {
  hit: Hit;
  /** Something is being written for this or another result. */
  isBusy: boolean;
  /** Work already shown for this result, so its button reads "Try again" after a failure. */
  shown: ItemWorkState | null;
  onItemTask: (hit: Hit, task: ItemTask) => void;
};

/** Summarise, draft and subtask buttons for one result (FR-AST-06). Each costs money, so each runs only on request. */
export function ItemActions({ hit, isBusy, shown, onItemTask }: ActionsProps) {
  const [isDrafting, setIsDrafting] = useState(false);
  const [request, setRequest] = useState("");
  const inputId = useId();
  const failed = shown?.state.status === "error";
  if (shown && !failed) return null;
  const retry = failed && shown ? shown.kind : null;

  function handleDraft(event: FormEvent) {
    event.preventDefault();
    const asked = request.trim();
    if (!asked) return;
    setIsDrafting(false);
    onItemTask(hit, { kind: "draft", request: asked });
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <button
          type="button"
          disabled={isBusy}
          aria-label={`${retry === "summary" ? "Try summarising" : "Summarise"} ${hit.title}${retry === "summary" ? " again" : ""}`}
          onClick={() => onItemTask(hit, { kind: "summary" })}
          className={LINK}
        >
          {retry === "summary" ? "Try again" : "Summarise"}
        </button>
        <button
          type="button"
          disabled={isBusy}
          aria-expanded={isDrafting}
          aria-label={`Draft something from ${hit.title}`}
          onClick={() => setIsDrafting((open) => !open)}
          className={LINK}
        >
          Draft…
        </button>
        {isJiraIssue(hit) && (
          <button
            type="button"
            disabled={isBusy}
            aria-label={`Suggest subtasks for ${hit.title}`}
            onClick={() => onItemTask(hit, { kind: "subtasks" })}
            className={LINK}
          >
            Suggest subtasks
          </button>
        )}
      </div>
      {isDrafting && (
        <form onSubmit={handleDraft} className="mt-3 flex max-w-xl gap-2">
          <label htmlFor={inputId} className="sr-only">
            What should Brain draft?
          </label>
          <input
            id={inputId}
            value={request}
            maxLength={MAX_DRAFT_REQUEST}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="e.g. a reply saying we can ship on Friday"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900"
          />
          <button type="submit" disabled={isBusy || !request.trim()} className={BUTTON}>
            Draft
          </button>
        </form>
      )}
    </div>
  );
}

/** The text of a finished draft, without citation markers. */
export function draftText(state: AnswerState): string {
  return state.parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("")
    .trim();
}

type SendState = { readonly status: "idle" | "sending" | "sent" | "error"; readonly message: string };
const IDLE: SendState = { status: "idle", message: "" };

type ResultProps = {
  hit: Hit;
  work: ItemWorkState;
  /** Records a change for the person to approve. Without it, nothing can be sent. */
  onPropose?: (request: WriteRequest) => Promise<void>;
};

/** What was written for one result, and for a Jira issue, a way to send it for approval. Nothing changes in Jira here. */
export function ItemResult({ hit, work, onPropose }: ResultProps) {
  const [send, setSend] = useState<SendState>(IDLE);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // What was already sent, so trying again after a failure never proposes the same change twice.
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const { state } = work;
  const isDone = state.status === "done" && state.outcome === "answered";
  const canSend = Boolean(onPropose) && isJiraIssue(hit) && isDone && send.status !== "sent";
  const draft = work.kind === "draft" ? draftText(state).slice(0, MAX_COMMENT_CHARS) : "";

  /** Sends each change in turn, carrying on past a failure, and reports which were not sent. */
  async function propose(entries: ReadonlyArray<readonly [label: string, request: WriteRequest]>, done: (total: number) => string) {
    if (!onPropose || entries.length === 0) return;
    setSend({ status: "sending", message: "" });
    const succeeded: string[] = [];
    const failed: string[] = [];
    let firstError: unknown = null;
    for (const [label, request] of entries) {
      try {
        await onPropose(request);
        succeeded.push(label);
      } catch (e) {
        failed.push(label);
        firstError ??= e;
      }
    }
    const total = sent.size + succeeded.length;
    setSent((prev) => new Set([...prev, ...succeeded]));
    if (failed.length === 0) {
      setSend({ status: "sent", message: done(total) });
      return;
    }
    const partly = succeeded.length > 0 ? `${succeeded.length} sent. Not sent: ${failed.join(", ")}. ` : "";
    setSend({ status: "error", message: `${partly}${describeError(firstError)}` });
  }

  function toggle(title: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }

  const siteId = isJiraIssue(hit) ? hit.siteId : "";
  const subtaskEntries = state.subtasks
    .filter((title) => picked.has(title) && !sent.has(title))
    .map((title) => [title, { action: "create_subtask", siteId, parentKey: hit.externalId, summary: title.slice(0, MAX_SUMMARY_CHARS) }] as const);
  // A refused or cut-short list says so, rather than reading as "no subtasks".
  const showsPanel = work.kind !== "subtasks" || state.status !== "done" || state.outcome !== "answered";
  const isSending = send.status === "sending";

  return (
    <div className="mt-4 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      {showsPanel && <AnswerPanel state={state} />}
      {!showsPanel && (
        <fieldset>
          <legend className="text-sm font-semibold">
            {state.subtasks.length > 0 ? "Suggested subtasks. Pick the ones to send for approval." : "Brain had no subtasks to suggest."}
          </legend>
          <ul className="mt-2 space-y-1">
            {state.subtasks.map((title) => (
              <li key={title}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.has(title) || sent.has(title)}
                    disabled={!canSend || sent.has(title)}
                    onChange={() => toggle(title)}
                    className="mt-1"
                  />
                  <span>
                    {title}
                    {sent.has(title) && <span className="text-slate-500"> (sent)</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {canSend && work.kind === "draft" && draft && (
        <button
          type="button"
          disabled={isSending}
          onClick={() =>
            void propose([["comment", { action: "add_comment", siteId, issueKey: hit.externalId, body: draft }]], () => "Sent for approval as a comment.")
          }
          className={`mt-3 ${BUTTON}`}
        >
          {isSending ? "Sending…" : `Send as a comment on ${hit.externalId} for approval`}
        </button>
      )}
      {canSend && work.kind === "subtasks" && state.subtasks.length > 0 && (
        <button
          type="button"
          disabled={isSending || subtaskEntries.length === 0}
          onClick={() => void propose(subtaskEntries, (total) => `${total} ${total === 1 ? "subtask" : "subtasks"} sent for approval.`)}
          className={`mt-3 ${BUTTON}`}
        >
          {isSending ? "Sending…" : subtaskEntries.length > 0 ? `Send ${subtaskEntries.length} for approval` : "Send for approval"}
        </button>
      )}
      {send.status === "sent" && (
        <p role="status" className="mt-3 text-sm">
          {send.message} Nothing changes in Jira until you approve it on the{" "}
          <Link href="/changes" className="font-medium text-brand underline underline-offset-2">
            Changes
          </Link>{" "}
          page.
        </p>
      )}
      {send.status === "error" && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {send.message}
        </p>
      )}
    </div>
  );
}
