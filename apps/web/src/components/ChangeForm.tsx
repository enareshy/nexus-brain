"use client";

import { useState, type FormEvent } from "react";
import type { WriteRequest, WriteTarget } from "@/lib/api";

type Action = WriteRequest["action"];

type Props = {
  targets: readonly WriteTarget[];
  isBusy: boolean;
  onSubmit: (request: WriteRequest) => void;
};

const ACTIONS: ReadonlyArray<{ value: Action; label: string }> = [
  { value: "create_issue", label: "Create an issue" },
  { value: "update_issue", label: "Update an issue" },
  { value: "add_comment", label: "Add a comment" },
];
const FIELD =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-brand dark:border-slate-700 dark:bg-slate-900";

export function ChangeForm({ targets, isBusy, onSubmit }: Props) {
  const [action, setAction] = useState<Action>("create_issue");
  const [siteId, setSiteId] = useState(targets[0]?.siteId ?? "");
  const [projectKey, setProjectKey] = useState(targets[0]?.projects[0]?.key ?? "");
  const [issueType, setIssueType] = useState("");
  const [issueKey, setIssueKey] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [comment, setComment] = useState("");

  const site = targets.find((t) => t.siteId === siteId) ?? targets[0];
  const project = site?.projects.find((p) => p.key === projectKey) ?? site?.projects[0];
  const chosenType = project?.issueTypes.includes(issueType) ? issueType : (project?.issueTypes[0] ?? "");
  const details = description.trim() ? { description: description.trim() } : {};

  function buildRequest(): WriteRequest | null {
    if (!site) return null;
    if (action === "create_issue") {
      if (!project || !chosenType || !summary.trim()) return null;
      return {
        action,
        siteId: site.siteId,
        projectKey: project.key,
        issueType: chosenType,
        summary: summary.trim(),
        ...details,
      };
    }
    if (!issueKey.trim()) return null;
    if (action === "update_issue") {
      if (!summary.trim() && !description.trim()) return null;
      const newSummary = summary.trim() ? { summary: summary.trim() } : {};
      return { action, siteId: site.siteId, issueKey: issueKey.trim(), ...newSummary, ...details };
    }
    return comment.trim() ? { action, siteId: site.siteId, issueKey: issueKey.trim(), body: comment.trim() } : null;
  }

  const request = buildRequest();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (request) onSubmit(request);
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <fieldset>
        <legend className="text-sm font-medium">What do you want to do?</legend>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {ACTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="action"
                value={option.value}
                checked={action === option.value}
                onChange={() => setAction(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      {targets.length > 1 && (
        <label className="text-sm font-medium">
          Site
          <select value={site?.siteId ?? ""} onChange={(e) => setSiteId(e.target.value)} className={FIELD}>
            {targets.map((t) => (
              <option key={t.siteId} value={t.siteId}>
                {t.siteOrigin}
              </option>
            ))}
          </select>
        </label>
      )}

      {action === "create_issue" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Project
            <select value={project?.key ?? ""} onChange={(e) => setProjectKey(e.target.value)} className={FIELD}>
              {site?.projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium">
            Issue type
            <select value={chosenType} onChange={(e) => setIssueType(e.target.value)} className={FIELD}>
              {project?.issueTypes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <label className="text-sm font-medium">
          Issue key
          <input
            value={issueKey}
            onChange={(e) => setIssueKey(e.target.value.toUpperCase())}
            placeholder="ENG-123"
            maxLength={100}
            className={FIELD}
          />
        </label>
      )}

      {action === "add_comment" ? (
        <label className="text-sm font-medium">
          Comment
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={4} maxLength={32000} className={FIELD} />
        </label>
      ) : (
        <>
          <label className="text-sm font-medium">
            {action === "update_issue" ? "New summary (optional)" : "Summary"}
            <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={255} className={FIELD} />
          </label>
          <label className="text-sm font-medium">
            {action === "update_issue" ? "New description (optional, replaces the current one)" : "Description (optional)"}
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={32000} className={FIELD} />
          </label>
        </>
      )}

      <div>
        <button
          type="submit"
          disabled={isBusy || !request}
          className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:translate-y-px disabled:opacity-50"
        >
          {isBusy ? "Preparing…" : "Review change"}
        </button>
        <p className="mt-2 text-sm text-slate-500">Nothing changes in Jira until you approve it on the next step.</p>
      </div>
    </form>
  );
}
