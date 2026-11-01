import type { ToolResult } from "@brain/mcp-client";
import { describe, expect, it, vi } from "vitest";
import { buildPullRequestQuery, githubSearch, parseGithubItems } from "./github.js";
import type { SearchHit, ToolSession } from "./types.js";

// Shapes below mirror the live server's responses, with synthetic values.
const ME = { login: "pat", id: 1, profile_url: "https://github.com/pat" };
const REPOS = {
  total_count: 2,
  items: [
    { name: "alpha", full_name: "pat/alpha", html_url: "https://github.com/pat/alpha" },
    { name: "beta", full_name: "pat/beta", html_url: "https://github.com/pat/beta" },
  ],
};
const PR = {
  number: 7,
  title: "Fix login",
  body: "Details of the fix",
  html_url: "https://github.com/pat/alpha/pull/7",
  updated_at: "2026-11-01T00:00:00Z",
};
const ISSUE = {
  number: 3,
  title: "Login fails",
  body: "It fails after reset",
  html_url: "https://github.com/pat/beta/issues/3",
  updated_at: "2026-10-31T00:00:00Z",
};

function ok(data: unknown): ToolResult {
  return { text: JSON.stringify(data), isError: false, truncated: false };
}

function session(overrides: Record<string, () => ToolResult> = {}) {
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const override = overrides[name];
    if (override) return override();
    if (name === "get_me") return ok(ME);
    if (name === "search_repositories") return ok(REPOS);
    if (name === "search_pull_requests") return ok({ items: [PR] });
    if (name === "search_issues") return ok({ items: args.repo === "beta" ? [ISSUE] : [] });
    throw new Error(`unexpected tool ${name}`);
  });
  const fake: ToolSession & { callTool: typeof callTool } = { listTools: async () => [], callTool };
  return fake;
}

describe("parseGithubItems", () => {
  it("normalises issues and pull requests", () => {
    expect(parseGithubItems(JSON.stringify({ items: [PR, ISSUE] }))).toEqual([
      {
        serverId: "github",
        externalId: "pat/alpha#pull/7",
        title: "Fix login",
        url: PR.html_url,
        snippet: "Details of the fix",
        updatedAt: PR.updated_at,
      },
      {
        serverId: "github",
        externalId: "pat/beta#issues/3",
        title: "Login fails",
        url: ISSUE.html_url,
        snippet: "It fails after reset",
        updatedAt: ISSUE.updated_at,
      },
    ]);
  });

  it("drops results whose link is not an issue or pull request on github.com", () => {
    const bad = [
      { ...PR, html_url: "https://evil.example/pat/alpha/pull/7" },
      { ...PR, html_url: "http://github.com/pat/alpha/pull/7" },
      { ...PR, html_url: "https://github.com.evil.example/pat/alpha/pull/7" },
      { ...PR, html_url: "https://github.com/pat/alpha/pull/7/../../../x" },
      { ...PR, html_url: "https://github.com/./evil/pull/1" },
      { ...PR, html_url: "https://github.com/../evil/pull/1" },
      { ...PR, html_url: "https://github.com/pat/../pull/1" },
      { ...PR, html_url: "javascript:alert(1)" },
      { ...PR, title: "" },
      "nonsense",
    ];
    expect(parseGithubItems(JSON.stringify({ items: bad }))).toEqual([]);
  });

  it("handles a result with no items, or text that is not JSON", () => {
    expect(parseGithubItems('{"total_count":0}')).toEqual([]);
    expect(parseGithubItems("nope")).toEqual([]);
  });

  it("limits a long body to a snippet and accepts a missing one", () => {
    const [long] = parseGithubItems(JSON.stringify({ items: [{ ...PR, body: "x".repeat(1000) }] }));
    expect(long?.snippet.length).toBe(300);
    const [none] = parseGithubItems(JSON.stringify({ items: [{ ...PR, body: null }] }));
    expect(none?.snippet).toBe("");
  });
});

describe("buildPullRequestQuery", () => {
  it("limits the search to the user's own repositories, matching any keyword", () => {
    expect(buildPullRequestQuery("pat", "login reset")).toBe("user:pat login OR reset");
  });

  it("cannot be widened or changed by the question", () => {
    // Punctuation is removed earlier by toTextSearchTerm; operators are case-sensitive.
    expect(buildPullRequestQuery("pat", "login OR NOT AND reset")).toBe("user:pat login OR reset");
    expect(buildPullRequestQuery("pat", "OR NOT")).toBe("user:pat or OR not");
  });

  it("keeps within GitHub's limit of five operators", () => {
    const query = buildPullRequestQuery("pat", "one two three four five six seven eight");
    expect(query.match(/ OR /g)).toHaveLength(5);
  });
});

describe("search", () => {
  it("searches pull requests and the user's repositories, and interleaves the results", async () => {
    const fake = session();
    const hits = await githubSearch.search(fake, "login", 10);
    expect(hits.map((h) => h.externalId)).toEqual(["pat/alpha#pull/7", "pat/beta#issues/3"]);
    expect(fake.callTool).toHaveBeenCalledWith("search_issues", expect.objectContaining({ owner: "pat", repo: "alpha", query: "login" }));
    expect(fake.callTool).toHaveBeenCalledWith("search_issues", expect.objectContaining({ owner: "pat", repo: "beta" }));
    expect(fake.callTool).toHaveBeenCalledWith(
      "search_pull_requests",
      expect.objectContaining({ query: "user:pat login" }),
    );
  });

  it("strips search qualifiers from the question", async () => {
    const fake = session();
    await githubSearch.search(fake, "repo:someone/private login", 10);
    const prQuery = fake.callTool.mock.calls.find(([name]) => name === "search_pull_requests")?.[1].query;
    expect(prQuery).toBe("user:pat repo OR someone OR private OR login");
    expect(String(prQuery)).not.toContain("repo:");
  });

  it("does not let words in a question act as issue search operators", async () => {
    const fake = session();
    await githubSearch.search(fake, "payment NOT refund", 10);
    const issueQuery = fake.callTool.mock.calls.find(([name]) => name === "search_issues")?.[1].query;
    expect(issueQuery).toBe("payment not refund");
  });

  it("never searches outside the signed-in user's repositories", async () => {
    const fake = session({
      search_repositories: () =>
        ok({ items: [{ name: "evil", full_name: "other/evil", html_url: "https://github.com/other/evil" }] }),
    });
    await githubSearch.search(fake, "login", 10);
    expect(fake.callTool.mock.calls.some(([name]) => name === "search_issues")).toBe(false);
  });

  it("returns nothing for a question with no words, without calling GitHub", async () => {
    const fake = session();
    expect(await githubSearch.search(fake, "?!", 10)).toEqual([]);
    expect(fake.callTool).not.toHaveBeenCalled();
  });

  it("still returns what worked when one search fails", async () => {
    const failed = { text: "error", isError: true, truncated: false };
    const hits = await githubSearch.search(session({ search_pull_requests: () => failed }), "login", 10);
    expect(hits.map((h) => h.externalId)).toEqual(["pat/beta#issues/3"]);
  });

  it("fails when every search fails, or the user cannot be identified", async () => {
    const failed = { text: "error", isError: true, truncated: false };
    await expect(
      githubSearch.search(session({ search_pull_requests: () => failed, search_issues: () => failed }), "login", 10),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(githubSearch.search(session({ get_me: () => failed }), "login", 10)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("caches only the slow-changing lookups", () => {
    expect(Object.keys(githubSearch.cachedTools ?? {}).sort()).toEqual(["get_me", "search_repositories"]);
  });
});

describe("readDocuments", () => {
  const hit = (externalId: string, url: string): SearchHit => ({
    serverId: "github",
    externalId,
    title: "t",
    url,
    snippet: "",
    updatedAt: null,
  });

  it("reads issue and pull request bodies with the right tool", async () => {
    const callTool = vi.fn(async (name: string) => ok({ body: name === "issue_read" ? "issue text" : "pr text" }));
    const bodies = await githubSearch.readDocuments!({ listTools: async () => [], callTool }, [
      hit("pat/beta#issues/3", ISSUE.html_url),
      hit("pat/alpha#pull/7", PR.html_url),
    ]);
    expect(bodies.get(ISSUE.html_url)).toBe("issue text");
    expect(bodies.get(PR.html_url)).toBe("pr text");
    expect(callTool).toHaveBeenCalledWith("issue_read", { method: "get", owner: "pat", repo: "beta", issue_number: 3 });
    expect(callTool).toHaveBeenCalledWith("pull_request_read", { method: "get", owner: "pat", repo: "alpha", pullNumber: 7 });
  });

  it("skips bad ids, failed reads and empty bodies", async () => {
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      if (args.repo === "fails") return { text: "x", isError: true, truncated: false };
      return ok({ body: name === "issue_read" ? null : "" });
    });
    const bodies = await githubSearch.readDocuments!({ listTools: async () => [], callTool }, [
      hit("not-an-id", "https://github.com/a/b/issues/1"),
      hit("pat/fails#issues/1", "https://github.com/pat/fails/issues/1"),
      hit("pat/empty#issues/1", "https://github.com/pat/empty/issues/1"),
    ]);
    expect(bodies.size).toBe(0);
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});
