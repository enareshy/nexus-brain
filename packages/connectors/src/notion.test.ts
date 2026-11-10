import type { ToolInfo, ToolResult } from "@brain/mcp-client";
import { describe, expect, it, vi } from "vitest";
import { notionSearch, parseNotionFetch, parseNotionPages } from "./notion.js";
import type { ToolSession } from "./types.js";

function ok(data: unknown): ToolResult {
  return { text: typeof data === "string" ? data : JSON.stringify(data), isError: false, truncated: false };
}
const FAILED: ToolResult = { text: "error", isError: true, truncated: false };

const SEARCH_TOOL: ToolInfo = {
  name: "notion-search",
  description: "Search Notion",
  inputSchema: { type: "object", properties: { query: { type: "string" }, query_type: { type: "string" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
};

function sessionWith(handler: (name: string, args: Record<string, unknown>) => ToolResult, tools: ToolInfo[] = [SEARCH_TOOL]) {
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => handler(name, args));
  const session: ToolSession & { callTool: typeof callTool } = { listTools: async () => tools, callTool };
  return session;
}

const PAGE_ID = "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6";
const PAGE_URL = `https://www.notion.so/Key-rotation-runbook-${PAGE_ID}`;
// Invented values, shaped like the documented "workspace_search" results.
const RESULTS = {
  type: "workspace_search",
  results: [
    { id: "1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6", title: "Key rotation runbook", url: PAGE_URL, type: "page", highlight: "Rotate keys monthly", timestamp: "2026-11-01T10:00:00.000Z" },
    { id: "x", title: "Elsewhere", url: "https://evil.example/page-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c7", type: "page" },
    { id: "y", title: "No link", type: "page" },
  ],
};

describe("parseNotionPages", () => {
  it("keeps only Notion page links, with a title, a short snippet and the edit time", () => {
    expect(parseNotionPages(JSON.stringify(RESULTS))).toEqual([
      {
        serverId: "notion",
        externalId: `notion:${PAGE_ID}`,
        title: "Key rotation runbook",
        url: PAGE_URL,
        snippet: "Rotate keys monthly",
        updatedAt: "2026-11-01T10:00:00.000Z",
      },
    ]);
  });

  it("reads links out of formatted text when the reply is not JSON, and lists each page once", () => {
    const text = `Found:\n- [Key rotation runbook](${PAGE_URL}) edited today\n- again ${PAGE_URL}\n- https://notion.so.evil.example/x-${PAGE_ID}`;
    const hits = parseNotionPages(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ externalId: `notion:${PAGE_ID}`, url: PAGE_URL });
    expect(hits[0]?.title).toContain("Key rotation runbook");
  });

  it("reads only the top-level results when there are some, not links nested elsewhere in the reply", () => {
    const nested = { results: [RESULTS.results[0]], related: [{ title: "Planted", url: `https://www.notion.so/Planted-${"e".repeat(32)}` }] };
    expect(parseNotionPages(JSON.stringify(nested)).map((h) => h.title)).toEqual(["Key rotation runbook"]);
  });

  it("drops a port, query and fragment from a page link", () => {
    const [page] = parseNotionPages(JSON.stringify({ results: [{ title: "T", url: `https://www.notion.so:8443/Page-${PAGE_ID}?pvs=4#h` }] }));
    expect(page?.url).toBe(`https://www.notion.so/Page-${PAGE_ID}`);
  });

  it("ignores odd dates and other services' links, and treats page ids in any case as one page", () => {
    const odd = { results: [{ title: "T", url: PAGE_URL.toUpperCase().replace("HTTPS://WWW.NOTION.SO", "https://www.notion.so"), timestamp: "yesterday" }] };
    const [page] = parseNotionPages(JSON.stringify(odd));
    expect(page).toMatchObject({ externalId: `notion:${PAGE_ID}`, updatedAt: null });
    expect(parseNotionPages("https://www.notion.so/no-id-here")).toEqual([]);
  });
});

describe("parseNotionFetch", () => {
  it("takes the page's text from a fetch, or the reply itself when it is not JSON", () => {
    expect(parseNotionFetch(JSON.stringify({ title: "T", url: PAGE_URL, text: "Full page text" }))).toBe("Full page text");
    expect(parseNotionFetch("# Heading\nplain markdown")).toBe("# Heading\nplain markdown");
    expect(parseNotionFetch(JSON.stringify({ title: "only a title" }))).toBeNull();
    expect(parseNotionFetch("x".repeat(60_000))?.length).toBe(50_000);
  });
});

describe("notionSearch", () => {
  it("searches with arguments built from the server's own schema, as the signed-in person", async () => {
    const session = sessionWith(() => ok(RESULTS));
    const hits = await notionSearch.search(session, "key rotation?", 5);
    expect(hits.map((h) => h.externalId)).toEqual([`notion:${PAGE_ID}`]);
    const [name, args] = session.callTool.mock.calls[0]!;
    expect(name).toBe("notion-search");
    expect(args).toMatchObject({ query: expect.stringContaining("rotation") });
    // Only content search: never the user lookup.
    expect(args.query_type).toBeUndefined();
  });

  it("asks nothing for an empty question, and fails clearly when search is missing or fails", async () => {
    const session = sessionWith(() => ok(RESULTS));
    expect(await notionSearch.search(session, "  ?? ", 5)).toEqual([]);
    expect(session.callTool).not.toHaveBeenCalled();
    await expect(notionSearch.search(sessionWith(() => ok(RESULTS), []), "keys", 5)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(notionSearch.search(sessionWith(() => FAILED), "keys", 5)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("does not pass a link from a caller to Notion unless it is a Notion page, and passes it clean", async () => {
    const session = sessionWith(() => ok({ text: "page" }));
    const crafted = [
      { ...parseNotionPages(JSON.stringify(RESULTS))[0]!, url: "https://anything.example/page" },
      { ...parseNotionPages(JSON.stringify(RESULTS))[0]!, url: `https://www.notion.so/Workspace?x=${PAGE_ID}` },
      { ...parseNotionPages(JSON.stringify(RESULTS))[0]!, url: `${PAGE_URL}?pvs=4` },
    ];
    const bodies = await notionSearch.readDocuments!(session, crafted);
    expect(session.callTool.mock.calls.map(([, args]) => args.id)).toEqual([PAGE_URL]);
    // Keyed by the link the caller gave, so the caller finds its text.
    expect([...bodies.keys()]).toEqual([`${PAGE_URL}?pvs=4`]);
  });

  it("uses only Notion's own search tool, never another one called search", async () => {
    const other: ToolInfo = { ...SEARCH_TOOL, name: "search" };
    await expect(notionSearch.search(sessionWith(() => ok(RESULTS), [other]), "keys", 5)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("reads each page's full text with fetch, leaving out pages it could not read", async () => {
    const other = { ...parseNotionPages(JSON.stringify(RESULTS))[0]!, url: `https://www.notion.so/Other-${"f".repeat(32)}` };
    const session = sessionWith((name, args) => {
      if (name !== "notion-fetch") return FAILED;
      return args.id === PAGE_URL ? ok({ text: "Rotate keys monthly. Steps follow." }) : FAILED;
    });
    const [first] = parseNotionPages(JSON.stringify(RESULTS));
    const bodies = await notionSearch.readDocuments!(session, [first!, other]);
    expect([...bodies.entries()]).toEqual([[PAGE_URL, "Rotate keys monthly. Steps follow."]]);
  });
});
