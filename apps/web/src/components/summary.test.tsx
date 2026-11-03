import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { INITIAL_ANSWER, type AnswerState } from "@/lib/answer";
import type { Hit, SearchResult } from "@/lib/api";
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

describe("summaries on search results (FR-AST-06)", () => {
  it("offers a summary for each readable result and asks for the one chosen", async () => {
    const user = userEvent.setup();
    const onSummarise = vi.fn();
    render(<SearchResults result={result([hit("KAN-1"), hit("KAN-2")])} query="launch" onSummarise={onSummarise} />);
    await user.click(screen.getByRole("button", { name: "Summarise Issue KAN-2" }));
    expect(onSummarise).toHaveBeenCalledWith(expect.objectContaining({ externalId: "KAN-2", siteId: "site-1" }));
  });

  it("shows the summary under its own result, and holds the others while one is being written", () => {
    const { rerender } = render(
      <SearchResults result={result([hit("KAN-1"), hit("KAN-2")])} query="launch" summary={{ key: hitKey(hit("KAN-1")), state: streaming }} onSummarise={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Summarise Issue KAN-1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Summarise Issue KAN-2" })).toBeDisabled();

    rerender(
      <SearchResults result={result([hit("KAN-1"), hit("KAN-2")])} query="launch" summary={{ key: hitKey(hit("KAN-1")), state: done }} onSummarise={vi.fn()} />,
    );
    const first = screen.getAllByRole("listitem")[0]!;
    expect(within(first).getByText("Launch moved to May.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarise Issue KAN-2" })).toBeEnabled();
  });

  it("offers no summary without a handler, for an unsafe link, or for a service Brain cannot read in full", () => {
    const { unmount } = render(<SearchResults result={result([hit("KAN-1")])} query="launch" />);
    expect(screen.queryByRole("button", { name: /Summarise/ })).toBeNull();
    unmount();
    const slack = { ...hit("C1-123"), serverId: "slack" };
    render(<SearchResults result={result([hit("KAN-9", "javascript:alert(1)"), slack])} query="launch" onSummarise={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Summarise/ })).toBeNull();
  });

  it("offers to try again after a summary fails", async () => {
    const user = userEvent.setup();
    const onSummarise = vi.fn();
    const failed: AnswerState = { ...INITIAL_ANSWER, status: "error", error: "Brain could not read this item with your access" };
    render(<SearchResults result={result([hit("KAN-1")])} query="launch" summary={{ key: hitKey(hit("KAN-1")), state: failed }} onSummarise={onSummarise} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not read/);
    await user.click(screen.getByRole("button", { name: "Try summarising Issue KAN-1 again" }));
    expect(onSummarise).toHaveBeenCalledTimes(1);
  });

  it("keeps the same issue on two sites apart", () => {
    expect(hitKey({ ...hit("KAN-1"), siteId: "a" })).not.toBe(hitKey({ ...hit("KAN-1"), siteId: "b" }));
  });
});
