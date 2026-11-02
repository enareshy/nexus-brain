import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Proposal, WriteTarget } from "@/lib/api";
import { ActivityList } from "./ActivityList";
import { ChangeForm } from "./ChangeForm";
import { ProposalCard } from "./ProposalCard";

const proposal: Proposal = {
  id: "p1",
  serverId: "atlassian",
  action: "create_issue",
  toolName: "createJiraIssue",
  toolClass: "write",
  args: { projectKey: "ENG", summary: "Fix login" },
  argsHash: "a".repeat(64),
  status: "pending",
  externalId: null,
  url: null,
  errorCode: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-11-01T01:00:00.000Z",
};

const targets: WriteTarget[] = [
  {
    siteId: "s1",
    siteOrigin: "https://acme.atlassian.net",
    projects: [
      { key: "ENG", name: "Engineering", issueTypes: ["Task", "Bug"] },
      { key: "OPS", name: "Operations", issueTypes: ["Incident"] },
    ],
  },
];

function renderCard(overrides: Partial<Proposal> = {}, isBusy = false) {
  const onApprove = vi.fn();
  const onReject = vi.fn();
  const item = { ...proposal, ...overrides };
  render(<ProposalCard proposal={item} isBusy={isBusy} onApprove={onApprove} onReject={onReject} />);
  return { onApprove, onReject, item };
}

describe("ActivityList", () => {
  const entry = {
    id: 1,
    userId: "u1",
    userEmail: "pat@example.com",
    action: "search",
    resource: null,
    meta: { results: [{ serverId: "a", externalId: "1" }, { serverId: "a", externalId: "2" }] },
    createdAt: "2026-11-01T10:00:00.000Z",
  };

  it("says who did what and how many documents they were shown", () => {
    render(<ActivityList entries={[entry]} />);
    expect(screen.getByText(/Searched · 2 documents returned/)).toBeInTheDocument();
    expect(screen.getByText("pat@example.com")).toBeInTheDocument();
  });

  it("names an unfamiliar action as text, and falls back when there is no user", () => {
    render(
      <ActivityList
        entries={[{ ...entry, action: "<b>x</b>", userEmail: null, userId: null, meta: { retrieved: [{}] }, resource: "gmail" }]}
      />,
    );
    expect(screen.getByText(/<b>x<\/b> · gmail · 1 document returned/)).toBeInTheDocument();
    expect(screen.getByText("system")).toBeInTheDocument();
  });

  it("explains an empty list", () => {
    render(<ActivityList entries={[]} />);
    expect(screen.getByText("No activity matches.")).toBeInTheDocument();
  });
});

describe("ProposalCard", () => {
  it("shows the server, the tool and the exact arguments before approval", () => {
    renderCard();
    expect(screen.getByText("atlassian · createJiraIssue")).toBeInTheDocument();
    const details = screen.getByLabelText("Exact details of: Create a Jira issue");
    expect(JSON.parse(details.textContent ?? "")).toEqual(proposal.args);
  });

  it("approves and rejects the proposal shown", async () => {
    const user = userEvent.setup();
    const { onApprove, onReject, item } = renderCard();
    await user.click(screen.getByRole("button", { name: "Approve: Create a Jira issue" }));
    await user.click(screen.getByRole("button", { name: "Reject: Create a Jira issue" }));
    expect(onApprove).toHaveBeenCalledWith(item);
    expect(onReject).toHaveBeenCalledWith(item);
  });

  it("disables both buttons while another change is running", () => {
    renderCard({}, true);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });

  it("warns that a comment is visible to other people", () => {
    renderCard({ toolClass: "external-effect", action: "add_comment" });
    expect(screen.getByText(/Other people will see this/)).toBeInTheDocument();
  });

  it("links a finished change, and offers no approval once it is decided", () => {
    renderCard({ status: "succeeded", externalId: "ENG-7", url: "https://acme.atlassian.net/browse/ENG-7" });
    expect(screen.getByText(/Done: ENG-7/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in Jira" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not link an unsafe result URL", () => {
    renderCard({ status: "succeeded", externalId: "ENG-7", url: "javascript:alert(1)" });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("tells the user to check Jira when the outcome is unknown", () => {
    renderCard({ status: "unknown", errorCode: "outcome_unknown" });
    expect(screen.getByText(/may or may not have happened/)).toBeInTheDocument();
  });

  it("renders hostile argument text as text", () => {
    renderCard({ args: { summary: "<img src=x onerror=alert(1)>" } });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Exact details/).textContent).toContain("<img src=x");
  });
});

describe("ChangeForm", () => {
  function renderForm() {
    const onSubmit = vi.fn();
    render(<ChangeForm targets={targets} isBusy={false} onSubmit={onSubmit} />);
    return onSubmit;
  }

  it("needs a summary before an issue can be reviewed", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();
    const submit = screen.getByRole("button", { name: "Review change" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Summary"), "  Fix login  ");
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({
      action: "create_issue",
      siteId: "s1",
      projectKey: "ENG",
      issueType: "Task",
      summary: "Fix login",
    });
  });

  it("uses a valid issue type after the project changes", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();
    await user.selectOptions(screen.getByLabelText("Issue type"), "Bug");
    await user.selectOptions(screen.getByLabelText("Project"), "OPS");
    await user.type(screen.getByLabelText("Summary"), "Outage");
    await user.click(screen.getByRole("button", { name: "Review change" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ projectKey: "OPS", issueType: "Incident" }));
  });

  it("sends only what an update changes", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();
    await user.click(screen.getByRole("radio", { name: "Update an issue" }));
    await user.type(screen.getByLabelText("Issue key"), "eng-1");
    expect(screen.getByRole("button", { name: "Review change" })).toBeDisabled();
    await user.type(screen.getByLabelText(/New summary/), "Better title");
    await user.click(screen.getByRole("button", { name: "Review change" }));
    expect(onSubmit).toHaveBeenCalledWith({
      action: "update_issue",
      siteId: "s1",
      issueKey: "ENG-1",
      summary: "Better title",
    });
  });

  it("builds a comment", async () => {
    const user = userEvent.setup();
    const onSubmit = renderForm();
    await user.click(screen.getByRole("radio", { name: "Add a comment" }));
    await user.type(screen.getByLabelText("Issue key"), "ENG-2");
    await user.type(screen.getByLabelText("Comment"), "Looks good");
    await user.click(screen.getByRole("button", { name: "Review change" }));
    expect(onSubmit).toHaveBeenCalledWith({ action: "add_comment", siteId: "s1", issueKey: "ENG-2", body: "Looks good" });
  });
});
