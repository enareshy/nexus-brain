import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type AgentMode, type AgentModeView, type AgentRun, type Proposal } from "@/lib/api";
import { AgentModeSetting } from "./AgentModeSetting";
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

describe("AgentModeSetting", () => {
  const view = (mode: AgentMode, companyAllowsChanges = true): AgentModeView => ({ mode, companyAllowsChanges });

  it("shows the person's choice and saves a new one", async () => {
    const save = vi.fn(async (mode: AgentMode) => view(mode));
    render(<AgentModeSetting load={async () => view("ask")} save={save} />);
    const readOnly = await screen.findByRole("radio", { name: /Read only/ });
    expect(screen.getByRole("radio", { name: /Ask me first/ })).toBeChecked();
    await userEvent.click(readOnly);
    expect(save).toHaveBeenCalledWith("read_only");
    await waitFor(() => expect(readOnly).toBeChecked());
  });

  it("says when an admin made agents read only, and offers no choice then", async () => {
    render(<AgentModeSetting load={async () => view("ask", false)} save={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("An admin has made Brain's agents read only");
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });

  it("explains a failure to load or save", async () => {
    const load = vi.fn<() => Promise<AgentModeView>>().mockRejectedValueOnce(new ApiError("NETWORK", "x", 0)).mockResolvedValue(view("read_only"));
    const { unmount } = render(<AgentModeSetting load={load} save={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("radio", { name: /Read only/ })).toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();
    const save = vi.fn(async () => Promise.reject(new ApiError("NETWORK", "x", 0)));
    render(<AgentModeSetting load={async () => view("ask")} save={save} />);
    await userEvent.click(await screen.findByRole("radio", { name: /Read only/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Ask me first/ })).toBeChecked();
  });
});

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
