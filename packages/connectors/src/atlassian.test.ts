import type { ToolInfo, ToolResult } from "@brain/mcp-client";
import { describe, expect, it } from "vitest";
import {
  atlassianSearch,
  buildCql,
  buildJql,
  parseConfluenceResults,
  parseJiraIssues,
  parseSites,
  toKeywords,
  toTextSearchTerm,
} from "./atlassian.js";
import type { ToolSession } from "./types.js";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const ORIGIN = "https://acme.atlassian.net";
const site = { origin: ORIGIN };

// Shapes below mirror the live server's responses, with synthetic values.
const SITES = [
  { id: CLOUD, url: `${ORIGIN}/`, name: "acme", scopes: ["search:confluence", "read:page:confluence"] },
  { id: CLOUD, url: `${ORIGIN}/`, name: "acme", scopes: ["read:jira-work", "write:jira-work"] },
];
const CONFLUENCE = {
  results: [
    {
      content: { id: "12345", title: "Runbook", history: { createdBy: { email: "someone@acme.example" } } },
      title: "@@@hl@@@Runbook@@@endhl@@@",
      excerpt: "How to @@@hl@@@rotate@@@endhl@@@ keys",
      url: "/spaces/ENG/pages/12345/Runbook",
      lastModified: "2026-10-30T10:00:00.000Z",
    },
  ],
  _links: { base: `${ORIGIN}/wiki` },
};
const JIRA = {
  issues: [{ key: "ACME-1", fields: { summary: "Login bug", updated: "2026-10-31T10:00:00.000+0000" } }],
  isLast: true,
};

function result(value: unknown, isError = false): ToolResult {
  return { text: typeof value === "string" ? value : JSON.stringify(value), isError, truncated: false };
}

function fakeSession(responses: Record<string, ToolResult>): ToolSession & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    listTools: async (): Promise<readonly ToolInfo[]> => [],
    callTool: async (name, args) => {
      calls.push([name, args]);
      return responses[name] ?? result({});
    },
  };
}

describe("parseSites", () => {
  it("merges per-product entries for one site", () => {
    const sites = parseSites(JSON.stringify(SITES));
    expect(sites).toHaveLength(1);
    expect(sites[0]?.origin).toBe(ORIGIN);
    expect([...sites[0]!.scopes]).toContain("read:jira-work");
    expect([...sites[0]!.scopes]).toContain("search:confluence");
  });

  it("rejects sites outside https *.atlassian.net, so citations cannot be redirected", () => {
    const bad = [
      { id: "a", url: "https://evil.example/", scopes: [] },
      { id: "b", url: "http://acme.atlassian.net/", scopes: [] },
      { id: "c", url: "https://acme.atlassian.net.evil.example/", scopes: [] },
      { id: "d", url: "not a url", scopes: [] },
      { id: "e", scopes: [] },
      "junk",
    ];
    expect(parseSites(JSON.stringify(bad))).toEqual([]);
    expect(parseSites("not json")).toEqual([]);
    expect(parseSites("{}")).toEqual([]);
  });
});

describe("parseConfluenceResults", () => {
  it("builds the citation from the trusted site origin and strips highlight markers", () => {
    expect(parseConfluenceResults(JSON.stringify(CONFLUENCE), site)).toEqual([
      {
        serverId: "atlassian",
        externalId: "confluence:12345",
        title: "Runbook",
        url: `${ORIGIN}/wiki/spaces/ENG/pages/12345/Runbook`,
        snippet: "How to rotate keys",
        updatedAt: "2026-10-30T10:00:00.000Z",
      },
    ]);
  });

  it("never copies people data from the result", () => {
    expect(JSON.stringify(parseConfluenceResults(JSON.stringify(CONFLUENCE), site))).not.toContain("someone@acme.example");
  });

  it.each(["https://evil.example/x", "//evil.example/x", "javascript:alert(1)", null])(
    "drops an unsafe result URL: %s",
    (url) => {
      const hostile = { results: [{ ...CONFLUENCE.results[0], url }] };
      expect(parseConfluenceResults(JSON.stringify(hostile), site)).toEqual([]);
    },
  );

  it("ignores malformed payloads", () => {
    expect(parseConfluenceResults("nope", site)).toEqual([]);
    expect(parseConfluenceResults(JSON.stringify({ results: ["x", { title: "t" }] }), site)).toEqual([]);
  });
});

describe("parseJiraIssues", () => {
  it("builds browse URLs from the trusted site origin", () => {
    expect(parseJiraIssues(JSON.stringify(JIRA), site)).toEqual([
      {
        serverId: "atlassian",
        externalId: "ACME-1",
        title: "Login bug",
        url: `${ORIGIN}/browse/ACME-1`,
        snippet: "",
        updatedAt: "2026-10-31T10:00:00.000+0000",
      },
    ]);
  });

  it("drops issues with a malformed key or no summary", () => {
    const bad = { issues: [{ key: "../evil", fields: { summary: "x" } }, { key: "ACME-2", fields: {} }, { fields: { summary: "x" } }, "x"] };
    expect(parseJiraIssues(JSON.stringify(bad), site)).toEqual([]);
    expect(parseJiraIssues("nope", site)).toEqual([]);
  });
});

describe("buildJql", () => {
  it("searches an exact issue key by key, case-insensitively", () => {
    expect(buildJql(" acme-123 ", "acme 123")).toBe('key = "ACME-123"');
  });

  it("uses a text search for everything else", () => {
    expect(buildJql("login", "login")).toBe('text ~ "login" ORDER BY updated DESC');
    expect(buildJql("login bug", "login bug")).toBe('(text ~ "login" OR text ~ "bug") ORDER BY updated DESC');
    expect(buildJql('ACME-1" OR x', "ACME 1 OR x")).toBe('(text ~ "ACME" OR text ~ "1" OR text ~ "x") ORDER BY updated DESC');
  });
});

describe("toKeywords and buildCql", () => {
  it("turns a natural question into its meaningful words", () => {
    expect(toKeywords("What is the project about")).toEqual(["project"]);
    expect(toKeywords("How do we rotate the API signing keys")).toEqual(["rotate", "API", "signing", "keys"]);
  });

  it("keeps words when a query is only stop words, so it still searches", () => {
    expect(toKeywords("what is this")).toEqual(["what", "is", "this"]);
  });

  it("dedupes case-insensitively and caps the number of keywords", () => {
    expect(toKeywords("Login login LOGIN")).toEqual(["LOGIN"]);
    expect(toKeywords("a1 b2 c3 d4 e5 f6 g7 h8 i9 j10")).toHaveLength(8);
  });

  it("groups keywords so they cannot escape the page filter", () => {
    expect(buildCql("login")).toBe('type = page AND text ~ "login"');
    expect(buildCql("login bug")).toBe('type = page AND (text ~ "login" OR text ~ "bug")');
  });

  it("removes query operators, including comparison operators", () => {
    expect(toTextSearchTerm("a=b, c<d. e>f;")).toBe("a b c d e f");
  });
});

describe("toTextSearchTerm", () => {
  it("removes search operators that would be syntax errors", () => {
    expect(toTextSearchTerm('login-bug (sso) "now" a:b')).toBe("login bug sso now a b");
  });

  it("can reduce to nothing", () => {
    expect(toTextSearchTerm("!!!")).toBe("");
  });
});

describe("readDocuments", () => {
  const page = { serverId: "atlassian", externalId: "confluence:12345", title: "t", url: `${ORIGIN}/wiki/p`, snippet: "", updatedAt: null, siteId: CLOUD };
  const issue = { ...page, externalId: "ACME-1", url: `${ORIGIN}/browse/ACME-1` };

  it("reads Confluence and Jira bodies by hit URL with the right arguments", async () => {
    const session = fakeSession({
      getConfluencePage: result({ id: "12345", body: "# Runbook" }),
      getJiraIssue: result({ key: "ACME-1", fields: { description: "Steps to reproduce" } }),
    });
    const bodies = await atlassianSearch.readDocuments!(session, [page, issue]);
    expect(bodies.get(page.url)).toBe("# Runbook");
    expect(bodies.get(issue.url)).toBe("Steps to reproduce");
    expect(session.calls.find(([n]) => n === "getConfluencePage")?.[1]).toEqual({ cloudId: CLOUD, pageId: "12345", contentFormat: "markdown" });
    expect(session.calls.find(([n]) => n === "getJiraIssue")?.[1]).toMatchObject({ cloudId: CLOUD, issueIdOrKey: "ACME-1" });
  });

  it("leaves out unreadable hits: errors, revoked access, no site, odd ids", async () => {
    const session = fakeSession({ getConfluencePage: result("Forbidden", true), getJiraIssue: result("not json") });
    const noSite = { ...page, siteId: undefined, url: `${ORIGIN}/x` };
    const odd = { ...page, externalId: "../../evil", url: `${ORIGIN}/y` };
    const bodies = await atlassianSearch.readDocuments!(session, [page, issue, noSite, odd]);
    expect(bodies.size).toBe(0);
  });

  it("survives a thrown tool call", async () => {
    const session = fakeSession({});
    session.callTool = async () => {
      throw new Error("network");
    };
    expect((await atlassianSearch.readDocuments!(session, [page])).size).toBe(0);
  });

  it("carries the site id from search results", () => {
    const [hit] = parseConfluenceResults(JSON.stringify(CONFLUENCE), { origin: ORIGIN, id: CLOUD });
    expect(hit?.siteId).toBe(CLOUD);
    const [jira] = parseJiraIssues(JSON.stringify(JIRA), { origin: ORIGIN, id: CLOUD });
    expect(jira?.siteId).toBe(CLOUD);
  });
});

describe("atlassianSearch", () => {
  const full = {
    getAccessibleAtlassianResources: result(SITES),
    searchJiraIssuesUsingJql: result(JIRA),
    searchConfluenceUsingCql: result(CONFLUENCE),
  };

  it("searches Jira and Confluence once per site, with no Rovo-credit tools", async () => {
    const session = fakeSession(full);
    const hits = await atlassianSearch.search(session, "login", 10);

    expect(hits.map((h) => h.externalId)).toEqual(["ACME-1", "confluence:12345"]);
    expect(session.calls.map(([name]) => name).sort()).toEqual([
      "getAccessibleAtlassianResources",
      "searchConfluenceUsingCql",
      "searchJiraIssuesUsingJql",
    ]);
    expect(session.calls.some(([name]) => name === "search")).toBe(false);
    const jira = session.calls.find(([name]) => name === "searchJiraIssuesUsingJql")?.[1];
    expect(jira).toMatchObject({ cloudId: CLOUD, jql: 'text ~ "login" ORDER BY updated DESC', maxResults: 10 });
    const wiki = session.calls.find(([name]) => name === "searchConfluenceUsingCql")?.[1];
    expect(wiki).toMatchObject({ cloudId: CLOUD, cql: 'type = page AND text ~ "login"', limit: 10 });
  });

  it("cannot be broken out of the query string", async () => {
    const session = fakeSession(full);
    await atlassianSearch.search(session, 'x" OR project = SECRET OR text ~ "y', 5);
    const jira = session.calls.find(([name]) => name === "searchJiraIssuesUsingJql")?.[1];
    // Quotes and operators are gone, and each word sits in its own literal.
    expect(jira?.jql).toBe('(text ~ "x" OR text ~ "project" OR text ~ "SECRET" OR text ~ "text" OR text ~ "y") ORDER BY updated DESC');
  });

  it("only uses products the grant covers", async () => {
    const session = fakeSession({ ...full, getAccessibleAtlassianResources: result([SITES[0]]) });
    await atlassianSearch.search(session, "login", 5);
    expect(session.calls.some(([name]) => name === "searchJiraIssuesUsingJql")).toBe(false);
  });

  it("keeps results when one product fails", async () => {
    const session = fakeSession({ ...full, searchJiraIssuesUsingJql: result("nope", true) });
    const hits = await atlassianSearch.search(session, "login", 5);
    expect(hits.map((h) => h.externalId)).toEqual(["confluence:12345"]);
  });

  it("fails when every product fails or sites cannot be listed, without echoing server text", async () => {
    const allFail = fakeSession({
      getAccessibleAtlassianResources: result(SITES),
      searchJiraIssuesUsingJql: result("stack trace", true),
      searchConfluenceUsingCql: result("stack trace", true),
    });
    await expect(atlassianSearch.search(allFail, "login", 5)).rejects.toMatchObject({ code: "UNAVAILABLE", message: "Atlassian search failed" });

    const noSites = fakeSession({ getAccessibleAtlassianResources: result("stack trace", true) });
    await expect(atlassianSearch.search(noSites, "login", 5)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("makes no calls for an operators-only query, and returns nothing without sites", async () => {
    const session = fakeSession(full);
    expect(await atlassianSearch.search(session, "!!!", 5)).toEqual([]);
    expect(session.calls).toEqual([]);

    const empty = fakeSession({ getAccessibleAtlassianResources: result([]) });
    expect(await atlassianSearch.search(empty, "login", 5)).toEqual([]);
  });

  it("respects the limit and interleaves products", async () => {
    const issues = ["AB-1", "AB-2", "AB-3"].map((key) => ({ key, fields: { summary: key } }));
    const session = fakeSession({ ...full, searchJiraIssuesUsingJql: result({ issues }) });
    const hits = await atlassianSearch.search(session, "login", 2);
    expect(hits.map((h) => h.externalId)).toEqual(["AB-1", "confluence:12345"]);
  });
});
