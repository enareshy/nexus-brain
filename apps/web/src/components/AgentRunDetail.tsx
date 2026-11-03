import type { AgentRun, Proposal } from "@/lib/api";
import { safeHttpUrl } from "@/lib/safe-url";
import { ProposalCard } from "./ProposalCard";

type Props = {
  run: AgentRun;
  /** The change the run is waiting on, once loaded. */
  proposal: Proposal | null;
  isBusy: boolean;
  onApprove: (proposal: Proposal) => void;
  onReject: (proposal: Proposal) => void;
  onCancel: () => void;
};

const TOOL_LABELS: Readonly<Record<string, string>> = {
  search_documents: "Searched your connected tools",
  list_jira_projects: "Looked up your Jira projects",
  propose_jira_issue: "Proposed a new Jira issue",
  propose_jira_update: "Proposed a Jira issue update",
  propose_jira_comment: "Proposed a Jira comment",
};

const STOP_REASONS: Readonly<Record<string, string>> = {
  step_limit: "Stopped because it reached its limit of steps.",
  cost_limit: "Stopped because it reached its spending limit.",
  budget_limit: "Stopped because this month's AI budget is used up. An admin can raise it.",
  budget_unavailable: "Stopped because the budget could not be checked. Try again shortly.",
  time_limit: "Stopped because it ran out of time.",
  model_unavailable: "Stopped because the AI service could not be reached. Nothing further was done.",
  refused: "The AI declined to continue with this.",
  incomplete: "Stopped before it could finish.",
  cancelled: "You cancelled this run.",
};

function stepOutcome(outcome: string): string | null {
  if (outcome === "ok") return null;
  if (outcome === "waiting_for_approval") return "Needed your decision.";
  if (outcome === "not_in_manifest") return "Refused: it is not allowed to use that tool.";
  if (outcome === "invalid_input") return "Refused: the request was not valid.";
  return "That step did not work.";
}

export function AgentRunDetail({ run, proposal, isBusy, onApprove, onReject, onCancel }: Props) {
  const isActive = run.status === "running" || run.status === "waiting_approval";
  return (
    <article aria-label="Agent run details">
      <h2 className="text-2xl font-bold tracking-tight">{run.goal}</h2>

      {run.status === "running" && (
        <p role="status" className="mt-2 text-sm text-slate-500">
          Working…
        </p>
      )}

      <ol className="mt-5 space-y-3 border-l-2 border-slate-200 pl-4 dark:border-slate-800">
        {run.steps.map((step) => {
          const note = stepOutcome(step.outcome);
          return (
            <li key={step.seq} className="text-sm">
              <p className="font-medium">{TOOL_LABELS[step.tool] ?? "Tried something it is not allowed to do"}</p>
              {note && <p className="text-slate-600 dark:text-slate-400">{note}</p>}
              {step.documents.length > 0 && (
                <ul aria-label="Documents read" className="mt-1 text-slate-600 dark:text-slate-400">
                  {step.documents.map((doc) => {
                    const link = safeHttpUrl(doc.url);
                    return (
                      <li key={doc.url}>
                        {link ? (
                          <a href={link} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                            {doc.title}
                          </a>
                        ) : (
                          doc.title
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
        {run.steps.length === 0 && <li className="text-sm text-slate-500">No steps yet.</li>}
      </ol>

      {proposal && (
        <section aria-label="Waiting for your decision" className="mt-6 rounded-md border border-amber-300 px-4 dark:border-amber-800">
          <ul>
            <ProposalCard proposal={proposal} isBusy={isBusy} onApprove={onApprove} onReject={onReject} />
          </ul>
        </section>
      )}

      {run.result && <p className="mt-6 whitespace-pre-wrap">{run.result}</p>}
      {run.errorCode && (
        <p role="alert" className="mt-6 text-sm text-red-800 dark:text-red-300">
          {STOP_REASONS[run.errorCode] ?? "Stopped unexpectedly."}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-4 text-sm text-slate-500">
        <span>Cost so far: ${run.costUsd.toFixed(2)}</span>
        {isActive && (
          <button type="button" onClick={onCancel} className="font-medium text-slate-700 underline underline-offset-4 dark:text-slate-200">
            Cancel this run
          </button>
        )}
      </div>
    </article>
  );
}
