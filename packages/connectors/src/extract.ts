import type { SearchHit } from "./types.js";

const MAX_DEPTH = 6;
const SNIPPET_CHARS = 300;
const TITLE_KEYS = ["summary", "title", "name"] as const;
const URL_KEYS = ["url", "webUrl", "browseUrl", "htmlUrl", "html_url", "link"] as const;
const ID_KEYS = ["key", "id", "number"] as const;
const SNIPPET_KEYS = ["excerpt", "snippet", "description", "body", "text"] as const;
const UPDATED_KEYS = ["updated", "updatedAt", "updated_at", "lastModified"] as const;

type Obj = Record<string, unknown>;

/**
 * Pulls citable results out of an MCP tool's JSON text without knowing its exact shape.
 * Citation URLs must be https on one of `citationHosts` (exact host or `*.suffix`), so
 * untrusted content cannot plant javascript: or phishing links as "sources".
 * Non-JSON or shapeless output yields no hits rather than guessed ones.
 */
export function extractHits(
  text: string,
  serverId: string,
  citationHosts: readonly string[],
): SearchHit[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  const isAllowed = hostMatcher(citationHosts);
  const hits = new Map<string, SearchHit>();
  walk(data, 0, (obj) => {
    const hit = toHit(obj, serverId, isAllowed);
    if (hit && !hits.has(hit.url)) hits.set(hit.url, hit);
  });
  return [...hits.values()];
}

function hostMatcher(patterns: readonly string[]): (url: URL) => boolean {
  const rules = patterns.map((p) => p.toLowerCase());
  return (url) => {
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      rules.some((rule) => (rule.startsWith("*.") ? host.endsWith(rule.slice(1)) : host === rule))
    );
  };
}

function walk(value: unknown, depth: number, visit: (obj: Obj) => void): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, depth + 1, visit));
    return;
  }
  const obj = value as Obj;
  visit(obj);
  for (const child of Object.values(obj)) walk(child, depth + 1, visit);
}

function toHit(obj: Obj, serverId: string, isAllowed: (url: URL) => boolean): SearchHit | null {
  const fields = isObj(obj.fields) ? obj.fields : {};
  const title = firstString(obj, TITLE_KEYS) ?? firstString(fields, TITLE_KEYS);
  const externalId = firstString(obj, ID_KEYS) ?? (typeof obj.id === "number" ? String(obj.id) : null);
  const url =
    safeUrl(firstString(obj, URL_KEYS), isAllowed) ?? jiraBrowseUrl(obj, isAllowed);
  if (!title || !externalId || !url) return null;

  const snippet = firstString(obj, SNIPPET_KEYS) ?? firstString(fields, SNIPPET_KEYS) ?? "";
  return {
    serverId,
    externalId,
    title: title.slice(0, 500),
    url,
    snippet: snippet.slice(0, SNIPPET_CHARS),
    updatedAt: firstString(obj, UPDATED_KEYS) ?? firstString(fields, UPDATED_KEYS),
  };
}

/** Jira REST issues carry `self` (API URL) and `key`; the browse URL is derived from them. */
function jiraBrowseUrl(obj: Obj, isAllowed: (url: URL) => boolean): string | null {
  const self = safeUrl(typeof obj.self === "string" ? obj.self : null, isAllowed);
  if (!self || typeof obj.key !== "string" || !/^[A-Z][A-Z0-9_]+-\d+$/.test(obj.key)) return null;
  return `${new URL(self).origin}/browse/${obj.key}`;
}

function firstString(obj: Obj, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function safeUrl(value: string | null, isAllowed: (url: URL) => boolean): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return isAllowed(url) ? url.toString() : null;
  } catch {
    return null;
  }
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
