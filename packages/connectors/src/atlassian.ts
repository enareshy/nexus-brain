import { AppError } from "@brain/core";
import { escapeJql, sanitizeQuery } from "./schema-search.js";
import type { SearchAdapter, SearchHit, ToolSession } from "./types.js";

// Tool names and result shapes verified against the live Atlassian MCP server on
// 2026-11-01 (docs/adr/0001-mcp-servers.md), except the Jira issue shape: that site had
// no issues, so parseJiraIssues follows the documented Jira REST format until confirmed.
// Never call the `search` tool: its description says each call may use up to 10 Rovo Credits.
const SITES_TOOL = "getAccessibleAtlassianResources";
const JIRA_TOOL = "searchJiraIssuesUsingJql";
const CONFLUENCE_TOOL = "searchConfluenceUsingCql";
const JIRA_SCOPE = "read:jira-work";
const CONFLUENCE_SCOPE = "search:confluence";
const MAX_SITES = 3;
const SITES_TTL_MS = 5 * 60 * 1000;
const SNIPPET_CHARS = 300;
const SITE_HOST = /^[a-z0-9-]+\.atlassian\.net$/i;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
/** Characters with special meaning in Jira/Confluence text search (Lucene syntax). */
const TEXT_SEARCH_OPERATORS = /[+\-&|!(){}[\]^~*?:\\/"'=<>,.;]/g;
const MAX_KEYWORDS = 8;
/** Words that carry no search meaning. English only for now. */
const STOP_WORDS = new Set(
  (
    "a about after all also am an and any are as at be been but by can could did do does for from had has have how i if " +
    "in into is it its me my no not of on or our should so tell that the their them there these this to us was we were " +
    "what when where which who why will with would you your"
  ).split(" "),
);

interface Site {
  readonly id: string;
  readonly origin: string;
  readonly scopes: ReadonlySet<string>;
}

type SiteRef = Pick<Site, "origin"> & { readonly id?: string };
type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Plain words for a text search: operators would be syntax errors or change the meaning. */
export function toTextSearchTerm(query: string): string {
  return sanitizeQuery(query).replace(TEXT_SEARCH_OPERATORS, " ").replace(/\s+/g, " ").trim();
}

/**
 * The server lists one entry per product for the same site, so entries are merged by id.
 * Only https *.atlassian.net sites are accepted; their origin is the trusted citation base.
 */
export function parseSites(text: string): Site[] {
  const data = parseJson(text);
  const sites = new Map<string, { origin: string; scopes: Set<string> }>();
  for (const entry of Array.isArray(data) ? data : []) {
    if (!isObj(entry)) continue;
    const id = str(entry.id);
    const url = str(entry.url);
    if (!id || !url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || !SITE_HOST.test(parsed.hostname)) continue;
    const site = sites.get(id) ?? { origin: parsed.origin, scopes: new Set<string>() };
    for (const scope of Array.isArray(entry.scopes) ? entry.scopes : []) {
      if (typeof scope === "string") site.scopes.add(scope);
    }
    sites.set(id, site);
  }
  return [...sites].map(([id, site]) => ({ id, ...site }));
}

export function parseJiraIssues(text: string, site: SiteRef): SearchHit[] {
  const data = parseJson(text);
  const issues = isObj(data) && Array.isArray(data.issues) ? data.issues : [];
  const hits: SearchHit[] = [];
  for (const issue of issues) {
    if (!isObj(issue)) continue;
    const key = str(issue.key);
    const fields = isObj(issue.fields) ? issue.fields : {};
    const title = str(fields.summary);
    if (!key || !ISSUE_KEY.test(key) || !title) continue;
    hits.push({
      serverId: "atlassian",
      externalId: key,
      title: stripHighlights(title).slice(0, 500),
      url: `${site.origin}/browse/${key}`,
      snippet: "",
      updatedAt: str(fields.updated),
      ...(site.id ? { siteId: site.id } : {}),
    });
  }
  return hits;
}

/** Confluence results carry a URL relative to <site>/wiki and highlight markers in excerpts. */
export function parseConfluenceResults(text: string, site: SiteRef): SearchHit[] {
  const data = parseJson(text);
  const results = isObj(data) && Array.isArray(data.results) ? data.results : [];
  const hits: SearchHit[] = [];
  for (const result of results) {
    if (!isObj(result)) continue;
    const content = isObj(result.content) ? result.content : {};
    const id = str(content.id);
    const title = str(result.title) ?? str(content.title);
    const url = confluenceUrl(str(result.url), site.origin);
    if (!id || !title || !url) continue;
    hits.push({
      serverId: "atlassian",
      externalId: `confluence:${id}`,
      title: stripHighlights(title).slice(0, 500),
      url,
      snippet: stripHighlights(str(result.excerpt) ?? "").slice(0, SNIPPET_CHARS),
      updatedAt: str(result.lastModified),
      ...(site.id ? { siteId: site.id } : {}),
    });
  }
  return hits;
}

function confluenceUrl(relative: string | null, origin: string): string | null {
  if (!relative || !relative.startsWith("/") || relative.startsWith("//")) return null;
  try {
    const url = new URL(`${origin}/wiki${relative}`);
    return url.origin === origin ? url.toString() : null;
  } catch {
    return null;
  }
}

function stripHighlights(text: string): string {
  return text.replace(/@@@(?:end)?hl@@@/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Meaningful words of a question, deduplicated. A `text ~` phrase of a whole sentence
 * rarely matches anything, so questions search on their keywords instead.
 */
export function toKeywords(term: string): string[] {
  const words = term.split(" ").filter(Boolean);
  const meaningful = words.filter((word) => !STOP_WORDS.has(word.toLowerCase()));
  const unique = new Map((meaningful.length > 0 ? meaningful : words).map((w) => [w.toLowerCase(), w]));
  return [...unique.values()].slice(0, MAX_KEYWORDS);
}

/** Matches any keyword; each stays inside its own quoted literal. */
function textClause(term: string): string {
  const clauses = toKeywords(term).map((word) => `text ~ "${escapeJql(word)}"`);
  return clauses.length > 1 ? `(${clauses.join(" OR ")})` : (clauses[0] ?? "");
}

/** An exact issue key searches by key; anything else is a keyword text search. */
export function buildJql(query: string, term: string): string {
  const candidate = query.trim().toUpperCase();
  if (ISSUE_KEY.test(candidate)) return `key = "${candidate}"`;
  return `${textClause(term)} ORDER BY updated DESC`;
}

export function buildCql(term: string): string {
  return `type = page AND ${textClause(term)}`;
}

async function searchJira(
  session: ToolSession,
  site: Site,
  query: string,
  term: string,
  limit: number,
): Promise<SearchHit[]> {
  const result = await session.callTool(JIRA_TOOL, {
    cloudId: site.id,
    jql: buildJql(query, term),
    maxResults: limit,
    fields: ["summary", "updated"],
  });
  if (result.isError) throw new AppError("UNAVAILABLE", "Jira search failed");
  return parseJiraIssues(result.text, site);
}

async function searchConfluence(session: ToolSession, site: Site, term: string, limit: number): Promise<SearchHit[]> {
  const result = await session.callTool(CONFLUENCE_TOOL, {
    cloudId: site.id,
    cql: buildCql(term),
    limit,
  });
  if (result.isError) throw new AppError("UNAVAILABLE", "Confluence search failed");
  return parseConfluenceResults(result.text, site);
}

const CONFLUENCE_ID = /^confluence:(\d+)$/;

/** Reads one hit's markdown body; Jira descriptions follow the documented shape (unverified). */
async function readBody(session: ToolSession, hit: SearchHit): Promise<string | null> {
  if (!hit.siteId) return null;
  const page = CONFLUENCE_ID.exec(hit.externalId)?.[1];
  if (page) {
    const result = await session.callTool("getConfluencePage", {
      cloudId: hit.siteId,
      pageId: page,
      contentFormat: "markdown",
    });
    const data = result.isError ? null : parseJson(result.text);
    return isObj(data) ? str(data.body) : null;
  }
  if (!ISSUE_KEY.test(hit.externalId)) return null;
  const result = await session.callTool("getJiraIssue", {
    cloudId: hit.siteId,
    issueIdOrKey: hit.externalId,
    fields: ["summary", "description"],
    responseContentFormat: "markdown",
  });
  const data = result.isError ? null : parseJson(result.text);
  const fields = isObj(data) && isObj(data.fields) ? data.fields : {};
  return str(fields.description);
}

/** Searches Jira (JQL) and Confluence (CQL) on each site the user's grant covers. */
export const atlassianSearch: SearchAdapter = {
  serverId: "atlassian",
  // Only where to search; every search and read still runs with the user's token.
  cachedTools: { [SITES_TOOL]: SITES_TTL_MS },
  async readDocuments(session, hits) {
    const settled = await Promise.allSettled(
      hits.map(async (hit) => [hit.url, await readBody(session, hit)] as const),
    );
    const bodies = new Map<string, string>();
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value[1]) bodies.set(outcome.value[0], outcome.value[1]);
    }
    return bodies;
  },
  async search(session: ToolSession, query: string, limit: number): Promise<SearchHit[]> {
    const term = toTextSearchTerm(query);
    if (!term) return [];

    const sitesResult = await session.callTool(SITES_TOOL, {});
    if (sitesResult.isError) throw new AppError("UNAVAILABLE", "Could not list Atlassian sites");
    const sites = parseSites(sitesResult.text).slice(0, MAX_SITES);

    const searches = sites.flatMap((site) => [
      ...(site.scopes.has(JIRA_SCOPE) ? [searchJira(session, site, query, term, limit)] : []),
      ...(site.scopes.has(CONFLUENCE_SCOPE) ? [searchConfluence(session, site, term, limit)] : []),
    ]);
    if (searches.length === 0) return [];

    const settled = await Promise.allSettled(searches);
    const succeeded = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (succeeded.length === 0) throw new AppError("UNAVAILABLE", "Atlassian search failed");

    // Interleave products so one long list cannot crowd out the other.
    const merged: SearchHit[] = [];
    for (let i = 0; merged.length < limit && succeeded.some((list) => i < list.length); i += 1) {
      for (const list of succeeded) {
        const hit = list[i];
        if (hit && merged.length < limit) merged.push(hit);
      }
    }
    return merged;
  },
};
