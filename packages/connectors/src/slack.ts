import { AppError } from "@brain/core";
import { toTextSearchTerm } from "./atlassian.js";
import { buildSearchArgs } from "./schema-search.js";
import type { SearchAdapter, SearchHit } from "./types.js";

// Slack lists its tools only to a signed-in client, so nothing here has been seen live. Tool names
// are tried in order and arguments come from the server's own schema. Results may be JSON or
// formatted text, so hits are found by their message links rather than by an assumed shape.
// In formatted text a pasted link to another workspace would also count (see ADR 0001).
const SEARCH_TOOLS = ["slack_search_public_and_private", "slack_search_public"] as const;
const SNIPPET_CHARS = 300;
const TITLE_CHARS = 80;
const MAX_LINE_CHARS = 2000;
const MAX_DEPTH = 6;
const MESSAGE_LINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/(p\d+)$/;
const LINKS_IN_TEXT = /https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+/g;
const ANY_LINK = /https?:\/\/\S+/g;
const MARKUP = /[[\](){}"*_`>|]/g;

function toHit(url: string, text: string): SearchHit | null {
  const match = MESSAGE_LINK.exec(url);
  if (!match) return null;
  const snippet = text.replace(/\s+/g, " ").trim();
  return {
    serverId: "slack",
    externalId: `slack:${match[1]}/${match[2]}`,
    title: snippet.slice(0, TITLE_CHARS) || "Slack message",
    url,
    snippet: snippet.slice(0, SNIPPET_CHARS),
    updatedAt: null,
  };
}

/** In JSON, only a message's own permalink and text are used, never names or other fields. */
function hitsFromJson(value: unknown, depth: number, found: Map<string, SearchHit>): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => hitsFromJson(item, depth + 1, found));
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.permalink === "string") {
    const hit = toHit(obj.permalink, typeof obj.text === "string" ? obj.text : "");
    if (hit && !found.has(hit.url)) found.set(hit.url, hit);
  }
  Object.values(obj).forEach((child) => hitsFromJson(child, depth + 1, found));
}

/** Each line is capped first, and only simple patterns run on it, so hostile text stays cheap. */
function hitsFromText(text: string, found: Map<string, SearchHit>): void {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.slice(0, MAX_LINE_CHARS);
    const links = line.match(LINKS_IN_TEXT);
    if (!links) continue;
    const words = line.replace(ANY_LINK, " ").replace(MARKUP, " ");
    for (const url of links) {
      const hit = toHit(url, words);
      if (hit && !found.has(hit.url)) found.set(hit.url, hit);
    }
  }
}

export function parseSlackMessages(text: string): SearchHit[] {
  const found = new Map<string, SearchHit>();
  try {
    hitsFromJson(JSON.parse(text), 0, found);
  } catch {
    hitsFromText(text, found);
  }
  return [...found.values()];
}

export const slackSearch: SearchAdapter = {
  serverId: "slack",
  async search(session, query, limit) {
    // Slack also gives # and @ meaning, so they go too.
    const cleaned = query.replace(/[#@]/g, " ");
    if (!cleaned.trim()) return [];
    const term = toTextSearchTerm(cleaned);
    if (!term) return [];
    const tools = await session.listTools();
    const tool = SEARCH_TOOLS.map((name) => tools.find((t) => t.name === name)).find(Boolean);
    if (!tool) throw new AppError("UNAVAILABLE", "Slack offered no supported search tool");
    const result = await session.callTool(tool.name, buildSearchArgs(tool, term, limit));
    if (result.isError) throw new AppError("UNAVAILABLE", "Slack search failed");
    return parseSlackMessages(result.text).slice(0, limit);
  },
};
