import { AppError } from "@brain/core";
import type { ToolInfo, ToolResult } from "@brain/mcp-client";
import { describe, expect, it, vi } from "vitest";
import { extractHits } from "./extract.js";
import { federatedSearch } from "./federated.js";
import {
  buildSearchArgs,
  createSchemaSearchAdapter,
  escapeJql,
  sanitizeQuery,
} from "./schema-search.js";
import type { SearchHit, ToolSession } from "./types.js";

const HOSTS = ["a.example", "x.example", "gh.example", "*.atlassian.net"];

function tool(name: string, properties: Record<string, unknown>, required: string[] = []): ToolInfo {
  return { name, description: "", inputSchema: { type: "object", properties, required }, annotations: {} };
}

function textResult(value: unknown, isError = false): ToolResult {
  return { text: typeof value === "string" ? value : JSON.stringify(value), isError, truncated: false };
}

describe("extractHits", () => {
  it("reads generic results with url, title and id", () => {
    const hits = extractHits(
      JSON.stringify({ issues: [{ key: "ACME-1", summary: "Login bug", url: "https://a.example/browse/ACME-1", updated: "2026-10-30" }] }),
      "mock",
      HOSTS,
    );
    expect(hits).toEqual([
      { serverId: "mock", externalId: "ACME-1", title: "Login bug", url: "https://a.example/browse/ACME-1", snippet: "", updatedAt: "2026-10-30" },
    ]);
  });

  it("derives Jira browse URLs from REST issue shapes", () => {
    const hits = extractHits(
      JSON.stringify({ issues: [{ key: "ACME-7", self: "https://acme.atlassian.net/rest/api/3/issue/1007", fields: { summary: "SSO", description: "desc", updated: "2026-10-01" } }] }),
      "atlassian",
      HOSTS,
    );
    expect(hits[0]).toMatchObject({ url: "https://acme.atlassian.net/browse/ACME-7", title: "SSO", snippet: "desc", updatedAt: "2026-10-01" });
  });

  it("drops citations to hosts outside the connected service, and plain http", () => {
    const items = [
      { id: "1", title: "phish", url: "https://evil.example/login" },
      { id: "2", title: "lookalike", url: "https://atlassian.net.evil.example/x" },
      { id: "3", title: "cleartext", url: "http://a.example/x" },
      { key: "ACME-9", self: "https://evil.example/rest/api/3/issue/9", fields: { summary: "forged self" } },
      { id: "4", title: "ok", url: "https://acme.atlassian.net/browse/ACME-4" },
    ];
    expect(extractHits(JSON.stringify(items), "atlassian", HOSTS).map((h) => h.externalId)).toEqual(["4"]);
  });

  it("rejects javascript: and other non-http URLs", () => {
    const hits = extractHits(JSON.stringify([{ id: "1", title: "x", url: "javascript:alert(1)" }]), "s", HOSTS);
    expect(hits).toEqual([]);
  });

  it("returns nothing for non-JSON text", () => {
    expect(extractHits("Here are your issues: ACME-1", "s", HOSTS)).toEqual([]);
  });

  it("dedupes by URL and caps snippet length", () => {
    const item = { id: "1", title: "t", url: "https://x.example/1", excerpt: "e".repeat(1000) };
    const hits = extractHits(JSON.stringify([item, item]), "s", HOSTS);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toHaveLength(300);
  });

  it("accepts numeric ids", () => {
    expect(extractHits(JSON.stringify([{ id: 42, name: "PR", html_url: "https://gh.example/pr/42" }]), "github", HOSTS)[0]?.externalId).toBe("42");
  });
});

describe("buildSearchArgs", () => {
  it("uses query and a limit-style argument when present", () => {
    expect(buildSearchArgs(tool("s", { query: {}, maxResults: {} }), "login", 5)).toEqual({ query: "login", maxResults: 5 });
  });

  it("builds escaped JQL when only jql is available", () => {
    const args = buildSearchArgs(tool("s", { jql: {} }), 'say "hi" \\ now', 5);
    expect(args.jql).toBe('text ~ "say \\"hi\\" \\\\ now" ORDER BY updated DESC');
  });

  it("passes cloudId when supported", () => {
    expect(buildSearchArgs(tool("s", { query: {}, cloudId: {} }, ["cloudId"]), "x", 3, "site-1")).toMatchObject({ cloudId: "site-1" });
  });

  it("fails clearly on unsupported required arguments", () => {
    expect(() => buildSearchArgs(tool("s", { query: {}, projectKey: {} }, ["projectKey"]), "x", 3)).toThrowError(/unsupported arguments/);
  });

  it("fails when the tool has no query argument", () => {
    expect(() => buildSearchArgs(tool("s", { foo: {} }), "x", 3)).toThrowError(/no query or jql/);
  });
});

describe("sanitizeQuery / escapeJql", () => {
  it("strips control characters, collapses whitespace and caps length", () => {
    expect(sanitizeQuery("  a\u0000b\n\tc  ")).toBe("a b c");
    expect(sanitizeQuery("x".repeat(500))).toHaveLength(200);
  });

  it("rejects an empty query", () => {
    expect(() => sanitizeQuery("   ")).toThrowError(AppError);
  });

  it("escapes backslashes before quotes", () => {
    expect(escapeJql('\\"')).toBe('\\\\\\"');
  });
});

describe("createSchemaSearchAdapter", () => {
  const issues = { issues: [{ key: "ACME-1", summary: "Login bug", url: "https://a.example/browse/ACME-1" }] };

  function session(tools: ToolInfo[], responses: Record<string, ToolResult>): ToolSession & { calls: Array<[string, Record<string, unknown>]> } {
    const calls: Array<[string, Record<string, unknown>]> = [];
    return {
      calls,
      listTools: async () => tools,
      callTool: async (name, args) => {
        calls.push([name, args]);
        return responses[name] ?? textResult("{}");
      },
    };
  }

  it("uses the first candidate tool the server lists", async () => {
    const adapter = createSchemaSearchAdapter({ serverId: "x", citationHosts: HOSTS, searchTools: ["missing", "search"] });
    const s = session([tool("search", { query: {} })], { search: textResult(issues) });
    const hits = await adapter.search(s, "login", 5);
    expect(hits.map((h) => h.externalId)).toEqual(["ACME-1"]);
    expect(s.calls[0]).toEqual(["search", { query: "login" }]);
  });

  it("resolves cloudId from a site-listing tool when required", async () => {
    const adapter = createSchemaSearchAdapter({ serverId: "x", citationHosts: HOSTS, searchTools: ["search"], resourceTools: ["sites"] });
    const s = session(
      [tool("search", { query: {}, cloudId: {} }, ["query", "cloudId"]), tool("sites", {})],
      { sites: textResult([{ id: "cloud-123", name: "acme" }]), search: textResult(issues) },
    );
    await adapter.search(s, "login", 5);
    expect(s.calls.at(-1)).toEqual(["search", { query: "login", cloudId: "cloud-123" }]);
  });

  it("reports the available tools when no candidate matches", async () => {
    const adapter = createSchemaSearchAdapter({ serverId: "x", citationHosts: HOSTS, searchTools: ["search"] });
    const error = (await adapter.search(session([tool("other", {})], {}), "q", 5).catch((e) => e)) as AppError;
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.details).toEqual({ available: ["other"] });
  });

  it("fails when cloudId is needed but cannot be resolved", async () => {
    const adapter = createSchemaSearchAdapter({ serverId: "x", citationHosts: HOSTS, searchTools: ["search"], resourceTools: ["sites"] });
    const needsCloud = tool("search", { query: {}, cloudId: {} });
    await expect(adapter.search(session([needsCloud], {}), "q", 5)).rejects.toThrow(/no site-listing tool/);
    await expect(
      adapter.search(session([needsCloud, tool("sites", {})], { sites: textResult("not json") }), "q", 5),
    ).rejects.toThrow(/No accessible site/);
  });

  it("maps tool errors without echoing server text", async () => {
    const adapter = createSchemaSearchAdapter({ serverId: "x", citationHosts: HOSTS, searchTools: ["search"] });
    const s = session([tool("search", { query: {} })], { search: textResult("internal stack trace", true) });
    const error = (await adapter.search(s, "q", 5).catch((e) => e)) as AppError;
    expect(error.message).not.toContain("stack trace");
  });
});

describe("federatedSearch", () => {
  const hit = (url: string, serverId = "a"): SearchHit => ({ serverId, externalId: url, title: url, url, snippet: "", updatedAt: null });

  it("merges sources with reciprocal rank fusion and dedupes by URL", async () => {
    const result = await federatedSearch(
      [
        { id: "a", run: async () => [hit("u1"), hit("u2")] },
        { id: "b", run: async () => [hit("u2", "b"), hit("u3", "b")] },
      ],
      { limit: 10 },
    );
    expect(result.hits.map((h) => h.url)).toEqual(["u2", "u1", "u3"]);
    expect(result.sources.every((s) => s.ok)).toBe(true);
  });

  it("isolates a failing source and reports only its error code", async () => {
    const result = await federatedSearch(
      [
        { id: "ok", run: async () => [hit("u1")] },
        { id: "bad", run: async () => { throw new AppError("RECONNECT_REQUIRED", "x"); } },
        { id: "crash", run: async () => { throw new Error("secret detail"); } },
      ],
      { limit: 10 },
    );
    expect(result.hits).toHaveLength(1);
    expect(result.sources.find((s) => s.id === "bad")).toMatchObject({ ok: false, error: "RECONNECT_REQUIRED" });
    expect(JSON.stringify(result.sources)).not.toContain("secret detail");
  });

  it("drops sources that exceed the time budget", async () => {
    vi.useFakeTimers();
    const pending = federatedSearch(
      [{ id: "slow", run: () => new Promise(() => {}) }, { id: "fast", run: async () => [hit("u1")] }],
      { limit: 10, budgetMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(60);
    const result = await pending;
    vi.useRealTimers();
    expect(result.sources.find((s) => s.id === "slow")).toMatchObject({ ok: false, error: "TIMEOUT" });
    expect(result.hits).toHaveLength(1);
  });

  it("respects the limit", async () => {
    const result = await federatedSearch([{ id: "a", run: async () => [hit("1"), hit("2"), hit("3")] }], { limit: 2 });
    expect(result.hits).toHaveLength(2);
  });
});
