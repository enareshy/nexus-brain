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

  it("shows the passage each source was cited for, under that source", () => {
    const state: AnswerState = {
      ...base,
      status: "done",
      outcome: "answered",
      grounded: true,
      parts: [
        { kind: "text", text: "Rotate monthly." },
        { kind: "cite", source: 1, quotes: ["Passwords rotate monthly."] },
        { kind: "text", text: " Use the vault." },
        { kind: "cite", source: 1, quotes: ["Passwords rotate monthly.", "Keep them in the vault."] },
      ],
    };
    render(<AnswerPanel state={state} />);
    const list = screen.getByRole("list", { name: "Sources" });
    expect(within(list).getAllByText("Passwords rotate monthly.")).toHaveLength(1);
    expect(within(list).getByText("Keep them in the vault.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Source 1: Runbook" })[0]).toHaveAttribute(
      "title",
      "Passwords rotate monthly.",
    );
  });

  it("shows saved answers without passages as before", () => {
    const state: AnswerState = { ...base, status: "done", outcome: "answered", grounded: true, parts: [{ kind: "cite", source: 1 }] };
    render(<AnswerPanel state={state} />);
    expect(screen.queryByRole("blockquote")).toBeNull();
    expect(screen.getByRole("link", { name: "Runbook" })).toBeInTheDocument();
  });

  it("marks bracketed numbers the AI wrote itself, which are not checked citations", () => {
    const state: AnswerState = {
      ...base,
      status: "done",
      outcome: "answered",
      grounded: true,
      parts: [{ kind: "text", text: "Rotate monthly [2] and [12]." }, { kind: "cite", source: 1, quotes: [] }],
    };
    render(<AnswerPanel state={state} />);
    const written = screen.getAllByTitle("Written by the AI, not a checked citation");
    expect(written.map((el) => el.textContent)).toEqual(["[2]", "[12]"]);
    expect(screen.queryByRole("link", { name: /Source 2/ })).toBeNull();
    expect(screen.getByText(/Grey numbers in brackets were written by the AI/)).toBeInTheDocument();
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
    ["search_only", false, /AI service is not available/],
    ["answered", false, /no citations/],
  ] as const)("explains outcome %s", (outcome, grounded, pattern) => {
    render(<AnswerPanel state={{ ...base, status: "done", outcome, grounded }} />);
    expect(screen.getByText(pattern)).toBeInTheDocument();
  });

  it("lists every result found when the AI was unavailable, as there is no answer to cite them (NFR-AVAIL-01)", () => {
    const hits = [
      { serverId: "s", externalId: "1", title: "Runbook", url: "https://acme.example/1", snippet: "", updatedAt: null, score: 1 },
      { serverId: "s", externalId: "2", title: "Bad link", url: "javascript:alert(1)", snippet: "", updatedAt: null, score: 1 },
    ];
    render(<AnswerPanel state={{ ...base, status: "done", outcome: "search_only", grounded: false, hits }} />);
    expect(screen.getByRole("link", { name: "Runbook" })).toHaveAttribute("href", "https://acme.example/1");
    expect(screen.getByText("Bad link")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Bad link" })).toBeNull();
  });

  it("does not list the results again where the page already shows them", () => {
    render(<AnswerPanel state={{ ...base, status: "done", outcome: "search_only", grounded: false }} resultsShownElsewhere />);
    expect(screen.queryAllByRole("listitem")).toEqual([]);
    expect(screen.getByText(/AI service is not available/)).toBeInTheDocument();
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

const READY = { setup: "ready", redirectUrl: "http://127.0.0.1:3001/oauth/callback", allowed: true } as const;
const CONNECTIONS: Connection[] = [
  { serverId: "atlassian", displayName: "Atlassian", status: "active", lastUsedAt: "2026-10-31T10:00:00Z", ...READY },
  { serverId: "slack", displayName: "Slack", status: "not_connected", lastUsedAt: null, ...READY },
  { serverId: "github", displayName: "GitHub", status: "needs_reauth", lastUsedAt: null, ...READY },
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

  describe("a service the company has turned off", () => {
    const OFF: Connection[] = [{ ...CONNECTIONS[0]!, allowed: false }, { ...CONNECTIONS[1]!, allowed: false }];

    it("tells a member it is off, offers no way to connect, but still lets them disconnect", async () => {
      const onDisconnect = vi.fn();
      render(<ConnectionsList connections={OFF} busyServerId={null} onConnect={vi.fn()} onDisconnect={onDisconnect} />);
      const rows = screen.getAllByRole("listitem");
      expect(within(rows[0]!).getByText("Turned off")).toBeInTheDocument();
      expect(within(rows[0]!).getByText(/Your admin has turned this off/)).toBeInTheDocument();
      expect(within(rows[1]!).queryByRole("button", { name: /Connect/ })).not.toBeInTheDocument();
      await userEvent.click(within(rows[0]!).getByRole("button", { name: "Disconnect Atlassian" }));
      expect(onDisconnect).toHaveBeenCalledWith("atlassian");
      expect(screen.queryByRole("button", { name: /for everyone/ })).not.toBeInTheDocument();
    });

    it("lets an admin turn a service off and on for everyone", async () => {
      const onSetAllowed = vi.fn();
      render(
        <ConnectionsList
          connections={[CONNECTIONS[0]!, OFF[1]!]}
          busyServerId={null}
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
          canSetUp
          onSetAllowed={onSetAllowed}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Turn off Atlassian for everyone" }));
      await userEvent.click(screen.getByRole("button", { name: "Allow Slack for everyone" }));
      expect(onSetAllowed.mock.calls).toEqual([["atlassian", false], ["slack", true]]);
    });
  });

  describe("a service that needs setup", () => {
    const NEEDS_SETUP: Connection[] = [
      {
        serverId: "google-drive",
        displayName: "Google Drive",
        status: "not_connected",
        lastUsedAt: null,
        setup: "needs_app",
        redirectUrl: "http://127.0.0.1:3001/oauth/callback",
        allowed: true,
      },
    ];
    const noop = () => {};

    it("offers no connect button, and tells a member to ask an admin", () => {
      render(<ConnectionsList connections={NEEDS_SETUP} busyServerId={null} onConnect={noop} onDisconnect={noop} />);
      expect(screen.getByText(/Ask a workspace admin/)).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("guides an admin with links, the redirect address and a secret field", async () => {
      const user = userEvent.setup();
      const onSaveApp = vi.fn();
      render(
        <ConnectionsList connections={NEEDS_SETUP} busyServerId={null} onConnect={noop} onDisconnect={noop} canSetUp onSaveApp={onSaveApp} />,
      );
      await user.click(screen.getByRole("button", { name: "Set up Google Drive" }));

      expect(screen.getByRole("link", { name: "Create client" })).toHaveAttribute("rel", "noopener noreferrer");
      expect(screen.getByText(NEEDS_SETUP[0]!.redirectUrl)).toBeInTheDocument();
      expect(screen.getByLabelText("Client secret")).toHaveAttribute("type", "password");

      const save = screen.getByRole("button", { name: "Save and connect" });
      expect(save).toBeDisabled();
      await user.type(screen.getByLabelText("Client ID"), " my-id ");
      await user.type(screen.getByLabelText("Client secret"), "my-secret");
      await user.click(save);
      expect(onSaveApp).toHaveBeenCalledWith("google-drive", { clientId: "my-id", clientSecret: "my-secret" });
    });

    it("lets an admin, but not a member, change a saved setup and warns about reconnecting", async () => {
      const user = userEvent.setup();
      const configured: Connection[] = [{ ...NEEDS_SETUP[0]!, setup: "configured" }];
      const { unmount } = render(<ConnectionsList connections={configured} busyServerId={null} onConnect={noop} onDisconnect={noop} />);
      expect(screen.queryByRole("button", { name: /Change setup/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeInTheDocument();
      unmount();

      render(<ConnectionsList connections={configured} busyServerId={null} onConnect={noop} onDisconnect={noop} canSetUp />);
      await user.click(screen.getByRole("button", { name: "Change setup for Google Drive" }));
      expect(screen.getByText(/asks everyone in your workspace to connect again/)).toBeInTheDocument();
    });

    it("uses one Google setup for Gmail too, and lists only read scopes for Slack", async () => {
      const user = userEvent.setup();
      const rows = [
        { ...NEEDS_SETUP[0]!, serverId: "gmail", displayName: "Gmail" },
        { ...NEEDS_SETUP[0]!, serverId: "slack", displayName: "Slack" },
      ];
      render(<ConnectionsList connections={rows} busyServerId={null} onConnect={noop} onDisconnect={noop} canSetUp />);
      await user.click(screen.getByRole("button", { name: "Set up Gmail" }));
      expect(screen.getByText(/covers both Google Drive and Gmail/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Set up Slack" }));
      const scopes = screen.getByText(/user token scopes/).textContent ?? "";
      expect(scopes).not.toMatch(/write|im:|mpim/);
    });

    it("copies the redirect address", async () => {
      const user = userEvent.setup();
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
      render(<ConnectionsList connections={NEEDS_SETUP} busyServerId={null} onConnect={noop} onDisconnect={noop} canSetUp />);
      await user.click(screen.getByRole("button", { name: "Set up Google Drive" }));
      await user.click(screen.getByRole("button", { name: "Copy" }));
      expect(writeText).toHaveBeenCalledWith(NEEDS_SETUP[0]!.redirectUrl);
      expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    });

    it("says so when a service has no guide", async () => {
      const user = userEvent.setup();
      const unknown = [{ ...NEEDS_SETUP[0]!, serverId: "other", displayName: "Other" }];
      render(<ConnectionsList connections={unknown} busyServerId={null} onConnect={noop} onDisconnect={noop} canSetUp />);
      await user.click(screen.getByRole("button", { name: "Set up Other" }));
      expect(screen.getByText(/can't be set up from here/)).toBeInTheDocument();
    });

    it("builds a prefilled, read-only GitHub link with the redirect address", async () => {
      const user = userEvent.setup();
      const github = [{ ...NEEDS_SETUP[0]!, serverId: "github", displayName: "GitHub" }];
      render(<ConnectionsList connections={github} busyServerId={null} onConnect={noop} onDisconnect={noop} canSetUp />);
      await user.click(screen.getByRole("button", { name: "Set up GitHub" }));
      const href = screen.getByRole("link", { name: "Open GitHub" }).getAttribute("href") ?? "";
      expect(href).toContain("contents=read");
      expect(href).not.toContain("=write");
      expect(href).toContain(encodeURIComponent(NEEDS_SETUP[0]!.redirectUrl));
    });
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
  it("says when results came from AI-suggested words, as plain text", () => {
    const result: SearchResult = {
      hits: [],
      sources: [{ id: "a", ok: true, hits: 0, ms: 1 }],
      expandedTerms: ["rotation", "<b>keys</b>"],
    };
    render(<SearchResults result={result} query="q" />);
    expect(screen.getByText(/No matches, even with AI-suggested words: rotation, <b>keys<\/b>/)).toBeInTheDocument();
  });

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
