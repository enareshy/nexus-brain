import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRun, Proposal } from "@/lib/api";
import { AgentRunDetail } from "./AgentRunDetail";

const base: AgentRun = {
  id: "r1",
  goal: "Summarise login bugs",
  status: "completed",
  errorCode: null,
  createdAt: "2026-11-02T00:00:00Z",
  result: "Two bugs are open.",
  costUsd: 0.0412,
  turnCount: 2,
  waitingProposalId: null,
  steps: [],
};
const proposal: Proposal = {
  id: "p1",
  serverId: "atlassian",
  action: "add_comment",
  toolName: "addCommentToJiraIssue",
  toolClass: "external-effect",
  args: { commentBody: "Summary" },
  argsHash: "a".repeat(64),
  status: "pending",
  externalId: null,
  url: null,
  errorCode: null,
  createdAt: "2026-11-02T00:00:00Z",
  expiresAt: "2026-11-02T01:00:00Z",
};
const show = (run: Partial<AgentRun>, waiting: Proposal | null = null) =>
  render(
    <AgentRunDetail
      run={{ ...base, ...run }}
      proposal={waiting}
      isBusy={false}
      onApprove={vi.fn()}
      onReject={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

describe("AgentRunDetail", () => {
  it("shows the result, cost and the documents the run read", () => {
    show({
      steps: [
        {
          seq: 1,
          tool: "search_documents",
          outcome: "ok",
          documents: [{ title: "Runbook", url: "https://acme.atlassian.net/1" }],
          proposalId: null,
          createdAt: "2026-11-02T00:00:00Z",
        },
      ],
    });
    expect(screen.getByText("Two bugs are open.")).toBeInTheDocument();
    expect(screen.getByText("Cost so far: $0.04")).toBeInTheDocument();
    const docs = screen.getByRole("list", { name: "Documents read" });
    expect(within(docs).getByRole("link", { name: "Runbook" })).toHaveAttribute("href", "https://acme.atlassian.net/1");
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("does not link a document whose address is unsafe", () => {
    show({
      steps: [
        {
          seq: 1,
          tool: "search_documents",
          outcome: "ok",
          documents: [{ title: "Bad", url: "javascript:alert(1)" }],
          proposalId: null,
          createdAt: "2026-11-02T00:00:00Z",
        },
      ],
    });
    expect(screen.getByText("Bad")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Bad" })).not.toBeInTheDocument();
  });

  it("shows exactly what is proposed, with approve and reject, while waiting", () => {
    show({ status: "waiting_approval", result: null, waitingProposalId: "p1" }, proposal);
    expect(screen.getByLabelText(/Exact details of/)).toHaveTextContent("Summary");
    expect(screen.getByRole("button", { name: /Approve/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Cancel this run/ })).toBeInTheDocument();
  });

  it("says plainly when a tool was refused, without repeating the name the model made up", () => {
    show({
      steps: [
        { seq: 1, tool: "delete_issue", outcome: "not_in_manifest", documents: [], proposalId: null, createdAt: "2026-11-02T00:00:00Z" },
      ],
    });
    expect(screen.getByText("Tried something it is not allowed to do")).toBeInTheDocument();
    expect(screen.getByText(/not allowed to use that tool/)).toBeInTheDocument();
    expect(screen.queryByText(/delete_issue/)).not.toBeInTheDocument();
  });

  it.each([
    ["step_limit", /limit of steps/],
    ["cost_limit", /spending limit/],
    ["time_limit", /out of time/],
    ["model_unavailable", /could not be reached/],
    ["something_new", /Stopped unexpectedly/],
  ])("explains why a run stopped: %s", (errorCode, message) => {
    show({ status: "failed", result: null, errorCode });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });
});
