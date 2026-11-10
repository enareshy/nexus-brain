import { AppError } from "@brain/core";
import { toTextSearchTerm } from "./atlassian.js";
import { buildSearchArgs } from "./schema-search.js";
import type { SearchAdapter, SearchHit, ToolSession } from "./types.js";

// Notion's hosted MCP server (https://mcp.notion.com/mcp), read from its documentation (2026-11-10):
// OAuth with dynamic client registration and PKCE, acting as the signed-in workspace member.
// notion-search finds pages by topic or title, notion-fetch opens one by URL or id. The exact shape
// of search results is not documented, so pages are found by their Notion links rather than by an
// assumed structure, as for Slack. Nothing here has been seen live yet (see ADR 0001).
const SEARCH_TOOL = "notion-search";
const FETCH_TOOL = "notion-fetch";
const PAGE_HOSTS: ReadonlySet<string> = new Set(["www.notion.so", "notion.so"]);
/** A Notion page link ends in the page's id: 32 hex characters. */
const PAGE_ID = /([0-9a-f]{32})$/i;
const LINKS_IN_TEXT = /https:\/\/(?:www\.)?notion\.so\/[^\s)\]"'<>]+/g;
const ANY_LINK = /https?:\/\/\S+/g;
const MARKUP = /[[\](){}"*_`>|#-]/g;
const SNIPPET_CHARS = 300;
const TITLE_CHARS = 120;
const MAX_LINE_CHARS = 2000;
const MAX_DEPTH = 6;
/** Enough of a page for an answer; longer pages are cut, as other services' are. */
const MAX_PAGE_CHARS = 50_000;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** A Notion page link and its page id, or null for anything else (other hosts, no id). */
function pageOf(value: unknown): { url: string; id: string } | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !PAGE_HOSTS.has(url.hostname)) return null;
    const id = PAGE_ID.exec(url.pathname)?.[1];
    // Rebuilt from host and path only: no port, query or fragment survives.
    return id ? { url: `https://${url.hostname}${url.pathname}`, id: id.toLowerCase() } : null;
  } catch {
    return null;
  }
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function toHit(page: { url: string; id: string }, title: string, snippet: string, updatedAt: string | null): SearchHit {
  return {
    serverId: "notion",
    externalId: `notion:${page.id}`,
    title: flat(title).slice(0, TITLE_CHARS) || "Notion page",
    url: page.url,
    snippet: flat(snippet).slice(0, SNIPPET_CHARS),
    updatedAt,
  };
}

/** In JSON, a result is any object with a Notion page link; only its title, highlight and time are kept. */
function hitsFromJson(value: unknown, depth: number, found: Map<string, SearchHit>): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => hitsFromJson(item, depth + 1, found));
    return;
  }
  const obj = value as Record<string, unknown>;
  const page = pageOf(obj.url);
  if (page && !found.has(page.id)) {
    const snippet = str(obj.highlight) ?? str(obj.snippet) ?? str(obj.text) ?? "";
    const updatedAt = isoOrNull(obj.timestamp) ?? isoOrNull(obj.last_edited_time) ?? isoOrNull(obj.lastEditedTime);
    found.set(page.id, toHit(page, str(obj.title) ?? "", snippet, updatedAt));
  }
  Object.values(obj).forEach((child) => hitsFromJson(child, depth + 1, found));
}

/** Each line is capped first, and only simple patterns run on it, so hostile text stays cheap. */
function hitsFromText(text: string, found: Map<string, SearchHit>): void {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.slice(0, MAX_LINE_CHARS);
    const links = line.match(LINKS_IN_TEXT);
    if (!links) continue;
    const words = flat(line.replace(ANY_LINK, " ").replace(MARKUP, " "));
    for (const link of links) {
      const page = pageOf(link);
      if (page && !found.has(page.id)) found.set(page.id, toHit(page, words, "", null));
    }
  }
}

export function parseNotionPages(text: string): SearchHit[] {
  const found = new Map<string, SearchHit>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    hitsFromText(text, found);
    return [...found.values()];
  }
  // A top-level results list is the search's own answer; then nothing nested elsewhere counts.
  const results = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).results : undefined;
  hitsFromJson(Array.isArray(results) ? results : parsed, 0, found);
  return [...found.values()];
}

/** A fetched page's text: the `text` field of a JSON reply, or the reply itself. Untrusted content. */
export function parseNotionFetch(text: string): string | null {
  let body: string | null;
  try {
    const parsed: unknown = JSON.parse(text);
    body = parsed && typeof parsed === "object" ? str((parsed as Record<string, unknown>).text) : null;
  } catch {
    body = str(text);
  }
  return body ? body.slice(0, MAX_PAGE_CHARS) : null;
}

/**
 * Reads one page as the signed-in member. The hit may come from a caller (a summary, a draft, an MCP
 * client), so only a Notion page link is passed on, rebuilt clean; anything else is not read.
 */
async function readPage(session: ToolSession, hit: SearchHit): Promise<string | null> {
  const page = pageOf(hit.url);
  if (!page) return null;
  const result = await session.callTool(FETCH_TOOL, { id: page.url });
  return result.isError ? null : parseNotionFetch(result.text);
}

export const notionSearch: SearchAdapter = {
  serverId: "notion",
  async readDocuments(session, hits) {
    const settled = await Promise.allSettled(hits.map(async (hit) => [hit.url, await readPage(session, hit)] as const));
    const bodies = new Map<string, string>();
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value[1]) bodies.set(outcome.value[0], outcome.value[1]);
    }
    return bodies;
  },
  async search(session, query, limit) {
    const term = toTextSearchTerm(query);
    if (!term) return [];
    const tool = (await session.listTools()).find((t) => t.name === SEARCH_TOOL);
    if (!tool) throw new AppError("UNAVAILABLE", "Notion offered no supported search tool");
    const result = await session.callTool(tool.name, buildSearchArgs(tool, term, limit));
    if (result.isError) throw new AppError("UNAVAILABLE", "Notion search failed");
    return parseNotionPages(result.text).slice(0, limit);
  },
};
