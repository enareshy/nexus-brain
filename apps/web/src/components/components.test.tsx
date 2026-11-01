import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { INITIAL_ANSWER, type AnswerState } from "@/lib/answer";
import type { Connection, SearchResult } from "@/lib/api";
import { AnswerPanel } from "./AnswerPanel";
import { ConnectionsList } from "./ConnectionsList";
import { SearchResults } from "./SearchResults";

describe("AnswerPanel", () => {
  const hit = {
    serverId: "atlassian",
    externalId: "confluence:1",
    title: "Runbook",
    url: "https://acme.atlassian.net/wiki/p/1",
    snippet: "",
    updatedAt: null,
    score: 1,
  };
  const base: AnswerState = { ...INITIAL_ANSWER, hits: [hit] };

  it("shows progress before text arrives", () => {
    render(<AnswerPanel state={INITIAL_ANSWER} />);
    expect(screen.getByText("Reading your sources…")).toBeInTheDocument();
  });

  it("renders inline citations and a source list linking safely", () => {
    const state: AnswerState = {
      ...base,
      status: "done",
      outcome: "answered",
      grounded: true,
      parts: [{ kind: "text", text: "Rotate monthly." }, { kind: "cite", source: 1 }],
    };
    render(<AnswerPanel state={state} />);
    const marker = screen.getByRole("link", { name: "Source 1: Runbook" });
    expect(marker).toHaveAttribute("href", hit.url);
    expect(marker).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Runbook" })).toHaveAttribute("href", hit.url);
  });

  it("does not link unsafe URLs or missing sources, and renders hostile text as text", () => {
    const hostile = { ...hit, title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)" };
    const state: AnswerState = {
      ...base,
      hits: [hostile],
      parts: [
        { kind: "text", text: "<script>alert(1)</script>" },
        { kind: "cite", source: 1 },
        { kind: "cite", source: 9 },
      ],
    };
    const { container } = render(<AnswerPanel state={state} />);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(container.querySelector("img, script")).toBeNull();
  });

  it.each([
    ["no_documents", true, /Nothing you can access/],
    ["refused", true, /declined/],
    ["incomplete", true, /cut off/],
    ["answered", false, /no citations/],
  ] as const)("explains outcome %s", (outcome, grounded, pattern) => {
    render(<AnswerPanel state={{ ...base, status: "done", outcome, grounded }} />);
    expect(screen.getByText(pattern)).toBeInTheDocument();
  });

  it("reports partly read documents and errors", () => {
    const { unmount } = render(<AnswerPanel state={{ ...base, status: "done", outcome: "answered", grounded: true, truncatedDocuments: 2 }} />);
    expect(screen.getByText(/2 long documents were only partly read/)).toBeInTheDocument();
    unmount();
    render(<AnswerPanel state={{ ...base, status: "done", outcome: "answered", grounded: true, truncatedDocuments: 1 }} />);
    expect(screen.getByText(/One long document was only partly read/)).toBeInTheDocument();
    render(<AnswerPanel state={{ ...base, status: "error", error: "Not configured" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not configured");
  });
});

const CONNECTIONS: Connection[] = [
  { serverId: "atlassian", displayName: "Atlassian", status: "active", lastUsedAt: "2026-10-31T10:00:00Z" },
  { serverId: "slack", displayName: "Slack", status: "not_connected", lastUsedAt: null },
  { serverId: "github", displayName: "GitHub", status: "needs_reauth", lastUsedAt: null },
];

describe("ConnectionsList", () => {
  it("shows status and the right action per connection", async () => {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    render(<ConnectionsList connections={CONNECTIONS} busyServerId={null} onConnect={onConnect} onDisconnect={onDisconnect} />);

    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("Connected")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Not connected")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Reconnect needed")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Never used")).toBeInTheDocument();

    await userEvent.click(within(rows[0]!).getByRole("button", { name: "Disconnect Atlassian" }));
    await userEvent.click(within(rows[1]!).getByRole("button", { name: "Connect Slack" }));
    await userEvent.click(within(rows[2]!).getByRole("button", { name: "Reconnect GitHub" }));
    expect(onDisconnect).toHaveBeenCalledWith("atlassian");
    expect(onConnect.mock.calls).toEqual([["slack"], ["github"]]);
  });

  it("disables the busy row's button", () => {
    const { unmount } = render(
      <ConnectionsList connections={CONNECTIONS} busyServerId="slack" onConnect={vi.fn()} onDisconnect={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Connect Slack" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect Slack" })).toHaveTextContent("Opening…");
    unmount();
    render(<ConnectionsList connections={CONNECTIONS} busyServerId="atlassian" onConnect={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Disconnect Atlassian" })).toHaveTextContent("Disconnecting…");
  });

  it("explains an empty list", () => {
    render(<ConnectionsList connections={[]} busyServerId={null} onConnect={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByText(/No services are enabled/)).toBeInTheDocument();
  });
});

const hit = (over: Partial<SearchResult["hits"][number]> = {}) => ({
  serverId: "atlassian",
  externalId: "ACME-101",
  title: "Login bug on SSO",
  url: "https://acme.atlassian.net/browse/ACME-101",
  snippet: "Users cannot sign in",
  updatedAt: null,
  score: 0.03,
  ...over,
});

describe("SearchResults", () => {
  it("links safe citations in a new tab without opener access", () => {
    render(<SearchResults query="login" result={{ hits: [hit()], sources: [{ id: "atlassian", ok: true, hits: 1, ms: 40 }] }} />);
    const link = screen.getByRole("link", { name: "Login bug on SSO" });
    expect(link).toHaveAttribute("href", "https://acme.atlassian.net/browse/ACME-101");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("1 result for “login”")).toBeInTheDocument();
  });

  it("never links unsafe URLs and renders hostile text as text", () => {
    const hostile = hit({ title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)", snippet: "<script>x</script>" });
    const { container } = render(
      <SearchResults query="x" result={{ hits: [hostile], sources: [{ id: "atlassian", ok: true, hits: 1, ms: 1 }] }} />,
    );
    expect(screen.queryByRole("link", { name: /img/ })).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img, script")).toBeNull();
  });

  it("explains failing sources and offers reconnect", () => {
    render(
      <SearchResults
        query="x"
        result={{
          hits: [],
          sources: [
            { id: "atlassian", ok: false, hits: 0, ms: 5, error: "RECONNECT_REQUIRED" },
            { id: "slack", ok: false, hits: 0, ms: 3000, error: "TIMEOUT" },
            { id: "github", ok: false, hits: 0, ms: 5, error: "ERROR" },
          ],
        }}
      />,
    );
    expect(screen.getByText(/needs reconnecting/)).toBeInTheDocument();
    expect(screen.getByText(/too slow/)).toBeInTheDocument();
    expect(screen.getByText(/returned an error/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/connections");
    expect(screen.getByText(/Nothing you can access matched/)).toBeInTheDocument();
  });

  it("prompts to connect when nothing is connected", () => {
    render(<SearchResults query="x" result={{ hits: [], sources: [] }} />);
    expect(screen.getByRole("link", { name: "Connect Jira" })).toHaveAttribute("href", "/connections");
  });

  it("pluralises and handles hits without snippets", () => {
    render(
      <SearchResults
        query="x"
        result={{ hits: [hit(), hit({ url: "https://acme.atlassian.net/browse/ACME-2", externalId: "ACME-2", snippet: "" })], sources: [{ id: "atlassian", ok: true, hits: 2, ms: 1 }] }}
      />,
    );
    expect(screen.getByText("2 results for “x”")).toBeInTheDocument();
  });
});
