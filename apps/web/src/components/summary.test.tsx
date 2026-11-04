import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { INITIAL_ANSWER, type AnswerState } from "@/lib/answer";
import type { Hit, ItemTask, SearchResult } from "@/lib/api";
import type { ItemWorkState } from "./ItemWork";
import { hitKey, SearchResults } from "./SearchResults";

const hit = (externalId: string, url = `https://acme.atlassian.net/browse/${externalId}`): Hit => ({
  serverId: "atlassian",
  externalId,
  title: `Issue ${externalId}`,
  url,
  snippet: "",
  updatedAt: null,
  score: 1,
  siteId: "site-1",
});
const result = (hits: Hit[]): SearchResult => ({ hits, sources: [{ id: "atlassian", ok: true, hits: hits.length, ms: 5 }] });
const streaming: AnswerState = { ...INITIAL_ANSWER, status: "streaming" };
const done: AnswerState = {
  ...INITIAL_ANSWER,
  status: "done",
  parts: [{ kind: "text", text: "Launch moved to May." }],
  hits: [{ ...hit("KAN-1") }],
  outcome: "answered",
  grounded: true,
};
const work = (h: Hit, kind: ItemTask["kind"], state: AnswerState, run = 1): ItemWorkState => ({ key: hitKey(h), run, kind, state });

describe("summaries on search results (FR-AST-06)", () => {
  it("offers a summary for each readable result and asks for the one chosen", async () => {
    const user = userEvent.setup();
    const onItemTask = vi.fn();
    render(<SearchResults result={result([hit("KAN-1"), hit("KAN-2")])} query="launch" onItemTask={onItemTask} />);
    await user.click(screen.getByRole("button", { name: "Summarise Issue KAN-2" }));
    expect(onItemTask).toHaveBeenCalledWith(expect.objectContaining({ externalId: "KAN-2", siteId: "site-1" }), { kind: "summary" });
  });

  it("shows the summary under its own result, and holds the others while one is being written", () => {
    const hits = [hit("KAN-1"), hit("KAN-2")];
    const { rerender } = render(<SearchResults result={result(hits)} query="launch" work={work(hits[0]!, "summary", streaming)} onItemTask={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Summarise Issue KAN-1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Summarise Issue KAN-2" })).toBeDisabled();

    rerender(<SearchResults result={result(hits)} query="launch" work={work(hits[0]!, "summary", done)} onItemTask={vi.fn()} />);
    const first = screen.getAllByRole("listitem")[0]!;
    expect(within(first).getByText("Launch moved to May.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarise Issue KAN-2" })).toBeEnabled();
  });

  it("offers nothing without a handler, for an unsafe link, or for a service Brain cannot read in full", () => {
    const { unmount } = render(<SearchResults result={result([hit("KAN-1")])} query="launch" />);
    expect(screen.queryByRole("button", { name: /Summarise|Draft/ })).toBeNull();
    unmount();
    const slack = { ...hit("C1-123"), serverId: "slack" };
    render(<SearchResults result={result([hit("KAN-9", "javascript:alert(1)"), slack])} query="launch" onItemTask={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Summarise|Draft|subtasks/ })).toBeNull();
  });

  it("offers to try again after a summary fails", async () => {
    const user = userEvent.setup();
    const onItemTask = vi.fn();
    const failed: AnswerState = { ...INITIAL_ANSWER, status: "error", error: "Brain could not read this item with your access" };
    render(<SearchResults result={result([hit("KAN-1")])} query="launch" work={work(hit("KAN-1"), "summary", failed)} onItemTask={onItemTask} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not read/);
    await user.click(screen.getByRole("button", { name: "Try summarising Issue KAN-1 again" }));
    expect(onItemTask).toHaveBeenCalledTimes(1);
  });

  it("keeps the same issue on two sites apart", () => {
    expect(hitKey({ ...hit("KAN-1"), siteId: "a" })).not.toBe(hitKey({ ...hit("KAN-1"), siteId: "b" }));
  });
});

describe("drafts (FR-AST-06)", () => {
  it("asks what to draft and sends the person's words", async () => {
    const user = userEvent.setup();
    const onItemTask = vi.fn();
    render(<SearchResults result={result([hit("KAN-1")])} query="launch" onItemTask={onItemTask} />);
    await user.click(screen.getByRole("button", { name: "Draft something from Issue KAN-1" }));
    expect(screen.getByRole("button", { name: "Draft" })).toBeDisabled();
    await user.type(screen.getByLabelText("What should Brain draft?"), "  a reply saying Friday works ");
    await user.click(screen.getByRole("button", { name: "Draft" }));
    expect(onItemTask).toHaveBeenCalledWith(expect.objectContaining({ externalId: "KAN-1" }), { kind: "draft", request: "a reply saying Friday works" });
  });

  it("sends a finished draft on a Jira issue for approval as a comment, without its citation markers", async () => {
    const user = userEvent.setup();
    const onPropose = vi.fn(async () => {});
    const draft: AnswerState = { ...done, parts: [{ kind: "text", text: "Friday works. " }, { kind: "cite", source: 1 }, { kind: "text", text: "Thanks!" }] };
    render(<SearchResults result={result([hit("KAN-1")])} query="q" work={work(hit("KAN-1"), "draft", draft)} onItemTask={vi.fn()} onPropose={onPropose} />);
    await user.click(screen.getByRole("button", { name: "Send as a comment on KAN-1 for approval" }));
    expect(onPropose).toHaveBeenCalledWith({ action: "add_comment", siteId: "site-1", issueKey: "KAN-1", body: "Friday works. Thanks!" });
    expect(await screen.findByRole("status")).toHaveTextContent(/Nothing changes in Jira until you approve it/);
    expect(screen.queryByRole("button", { name: /Send as a comment/ })).toBeNull();
  });

  it("offers no sending for a draft that is unfinished, refused, or not on a Jira issue", () => {
    const page = { ...hit("KAN-1"), externalId: "confluence:9" };
    const refused: AnswerState = { ...done, outcome: "refused" };
    const { rerender } = render(<SearchResults result={result([page])} query="q" work={work(page, "draft", done)} onItemTask={vi.fn()} onPropose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /for approval/ })).toBeNull();
    rerender(<SearchResults result={result([hit("KAN-1")])} query="q" work={work(hit("KAN-1"), "draft", refused)} onItemTask={vi.fn()} onPropose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /for approval/ })).toBeNull();
    rerender(<SearchResults result={result([hit("KAN-1")])} query="q" work={work(hit("KAN-1"), "draft", streaming, 2)} onItemTask={vi.fn()} onPropose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /for approval/ })).toBeNull();
  });
});

describe("subtasks (FR-AST-06)", () => {
  const suggested: AnswerState = { ...done, parts: [], subtasks: ["Write the fix", "Add a test", "Update docs"] };

  it("offers subtask suggestions only on a Jira issue", () => {
    const page = { ...hit("KAN-2"), externalId: "confluence:9" };
    render(<SearchResults result={result([hit("KAN-1"), page])} query="q" onItemTask={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Suggest subtasks for Issue KAN-1" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Suggest subtasks/ })).toHaveLength(1);
  });

  it("sends only the picked subtasks for approval, one proposal each, under the issue", async () => {
    const user = userEvent.setup();
    const onPropose = vi.fn(async () => {});
    render(<SearchResults result={result([hit("KAN-1")])} query="q" work={work(hit("KAN-1"), "subtasks", suggested)} onItemTask={vi.fn()} onPropose={onPropose} />);
    expect(screen.getByRole("button", { name: "Send for approval" })).toBeDisabled();
    await user.click(screen.getByLabelText("Write the fix"));
    await user.click(screen.getByLabelText("Update docs"));
    await user.click(screen.getByRole("button", { name: "Send 2 for approval" }));
    expect(onPropose.mock.calls).toEqual([
      [{ action: "create_subtask", siteId: "site-1", parentKey: "KAN-1", summary: "Write the fix" }],
      [{ action: "create_subtask", siteId: "site-1", parentKey: "KAN-1", summary: "Update docs" }],
    ]);
    expect(await screen.findByRole("status")).toHaveTextContent("2 subtasks sent for approval.");
    expect(screen.getByLabelText("Add a test")).toBeDisabled();
  });

  it("carries on past a failed send, names what was not sent, and on trying again sends only that", async () => {
    const user = userEvent.setup();
    const onPropose = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    render(<SearchResults result={result([hit("KAN-1")])} query="q" work={work(hit("KAN-1"), "subtasks", suggested)} onItemTask={vi.fn()} onPropose={onPropose} />);
    await user.click(screen.getByLabelText("Write the fix"));
    await user.click(screen.getByLabelText("Add a test"));
    await user.click(screen.getByRole("button", { name: "Send 2 for approval" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^1 sent\. Not sent: Write the fix\./);
    expect(screen.getByLabelText(/Add a test/)).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Send 1 for approval" }));
    expect(onPropose).toHaveBeenCalledTimes(3);
    expect(onPropose.mock.calls[2]).toEqual([expect.objectContaining({ summary: "Write the fix" })]);
    expect(await screen.findByRole("status")).toHaveTextContent("2 subtasks sent for approval.");
  });

  it("says when none were suggested, and shows a refused list as refused rather than empty", () => {
    const { rerender } = render(
      <SearchResults result={result([hit("KAN-1")])} query="q" work={work(hit("KAN-1"), "subtasks", { ...suggested, subtasks: [] })} onItemTask={vi.fn()} />,
    );
    expect(screen.getByText("Brain had no subtasks to suggest.")).toBeInTheDocument();
    rerender(
      <SearchResults result={result([hit("KAN-1")])} query="q" work={work(hit("KAN-1"), "subtasks", { ...suggested, subtasks: [], outcome: "refused" }, 2)} onItemTask={vi.fn()} />,
    );
    expect(screen.queryByText("Brain had no subtasks to suggest.")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
