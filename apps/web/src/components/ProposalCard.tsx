import type { Proposal } from "@/lib/api";
import { safeHttpUrl } from "@/lib/safe-url";

type Props = {
  proposal: Proposal;
  isBusy: boolean;
  onApprove: (proposal: Proposal) => void;
  onReject: (proposal: Proposal) => void;
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  create_issue: "Create a Jira issue",
  update_issue: "Update a Jira issue",
  add_comment: "Add a Jira comment",
  create_subtask: "Create a Jira subtask",
};

function outcomeText(proposal: Proposal): string | null {
  switch (proposal.status) {
    case "executing":
      return "Sending this change…";
    case "succeeded":
      return proposal.externalId ? `Done: ${proposal.externalId}` : "Done.";
    case "failed":
      return proposal.errorCode === "tool_not_allowed"
        ? "Not sent. This tool is no longer allowed."
        : "Jira refused this change.";
    case "unknown":
      return "The connection was lost while sending this, so it may or may not have happened. Check Jira before making this change again.";
    case "rejected":
      return "Rejected. Nothing was changed.";
    case "expired":
      return "Expired. Nothing was changed.";
    default:
      return null;
  }
}

/** Shows exactly what will be sent, so an approval is an informed one (FR-WR-02). */
export function ProposalCard({ proposal, isBusy, onApprove, onReject }: Props) {
  const label = ACTION_LABELS[proposal.action] ?? proposal.action;
  const outcome = outcomeText(proposal);
  const link = proposal.status === "succeeded" && proposal.url ? safeHttpUrl(proposal.url) : null;
  const needsCaution = proposal.status === "unknown";

  return (
    <li className="py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-lg font-semibold tracking-tight">{label}</h3>
        <p className="font-mono text-xs text-slate-500">
          {proposal.serverId} · {proposal.toolName}
        </p>
      </div>
      {proposal.toolClass === "external-effect" && (
        <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">Other people will see this and may be notified.</p>
      )}
      <pre
        aria-label={`Exact details of: ${label}`}
        className="mt-3 whitespace-pre-wrap break-words rounded-md bg-slate-100 p-3 font-mono text-xs text-slate-800 dark:bg-slate-900 dark:text-slate-200"
      >
        {JSON.stringify(proposal.args, null, 2)}
      </pre>
      {proposal.status === "pending" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={isBusy}
            aria-label={`Approve: ${label}`}
            onClick={() => onApprove(proposal)}
            className="rounded-md bg-brand px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:translate-y-px disabled:opacity-50"
          >
            {isBusy ? "Working…" : "Approve"}
          </button>
          <button
            type="button"
            disabled={isBusy}
            aria-label={`Reject: ${label}`}
            onClick={() => onReject(proposal)}
            className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800"
          >
            Reject
          </button>
        </div>
      ) : (
        <p className={`mt-3 text-sm ${needsCaution ? "font-medium text-red-800 dark:text-red-300" : "text-slate-600 dark:text-slate-400"}`}>
          {outcome}{" "}
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" className="font-medium text-brand underline underline-offset-4">
              Open in Jira
            </a>
          )}
        </p>
      )}
    </li>
  );
}
