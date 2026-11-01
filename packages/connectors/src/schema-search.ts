import { AppError } from "@brain/core";
import type { ToolInfo } from "@brain/mcp-client";
import { extractHits } from "./extract.js";
import type { SearchAdapter, SearchHit, ToolSession } from "./types.js";

const QUERY_MAX_CHARS = 200;
const LIMIT_KEYS = ["limit", "maxResults", "max_results", "top"] as const;

export interface SchemaSearchOptions {
  readonly serverId: string;
  /** Search tool names to try, in order. The first one the server lists is used. */
  readonly searchTools: readonly string[];
  /** Tools that list accessible sites, used when the search tool requires `cloudId`. */
  readonly resourceTools?: readonly string[];
  /** Hosts citation URLs may point to (exact or `*.suffix`); everything else is dropped. */
  readonly citationHosts: readonly string[];
}

/**
 * Search adapter driven by the server's own tool schema: it picks a listed tool and
 * fills `query` or `jql`, `limit`-style and `cloudId` arguments from the input schema.
 * This avoids hard-coding argument shapes we have not verified against the real server.
 */
export function createSchemaSearchAdapter(options: SchemaSearchOptions): SearchAdapter {
  return {
    serverId: options.serverId,
    async search(session: ToolSession, query: string, limit: number): Promise<SearchHit[]> {
      const tools = await session.listTools();
      const tool = pickTool(tools, options.searchTools);
      if (!tool) {
        throw new AppError("UNAVAILABLE", "No supported search tool on this server", {
          available: tools.map((t) => t.name),
        });
      }

      const cloudId = requiresProperty(tool, "cloudId")
        ? await resolveCloudId(session, tools, options.resourceTools ?? [])
        : undefined;
      const result = await session.callTool(tool.name, buildSearchArgs(tool, query, limit, cloudId));
      if (result.isError) {
        throw new AppError("UNAVAILABLE", "The connected service returned an error");
      }
      return extractHits(result.text, options.serverId, options.citationHosts).slice(0, limit);
    },
  };
}

export function buildSearchArgs(
  tool: ToolInfo,
  query: string,
  limit: number,
  cloudId?: string,
): Record<string, unknown> {
  const props = properties(tool);
  const text = sanitizeQuery(query);
  const args: Record<string, unknown> = {};

  if ("query" in props) args.query = text;
  else if ("jql" in props) args.jql = `text ~ "${escapeJql(text)}" ORDER BY updated DESC`;
  else throw new AppError("UNAVAILABLE", `Search tool ${tool.name} has no query or jql argument`);

  const limitKey = LIMIT_KEYS.find((k) => k in props);
  if (limitKey) args[limitKey] = limit;
  if ("cloudId" in props && cloudId) args.cloudId = cloudId;

  const missing = required(tool).filter((name) => !(name in args));
  if (missing.length > 0) {
    throw new AppError("UNAVAILABLE", `Search tool ${tool.name} needs unsupported arguments`, {
      missing,
    });
  }
  return args;
}

/** Collapses whitespace, strips control characters and caps length. */
export function sanitizeQuery(query: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = query.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new AppError("VALIDATION", "Query must not be empty");
  return cleaned.slice(0, QUERY_MAX_CHARS);
}

/** Escapes a value for use inside a double-quoted JQL string literal. */
export function escapeJql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function resolveCloudId(
  session: ToolSession,
  tools: readonly ToolInfo[],
  candidates: readonly string[],
): Promise<string> {
  const tool = pickTool(tools, candidates);
  if (!tool) throw new AppError("UNAVAILABLE", "Search needs a site id but no site-listing tool exists");
  const result = await session.callTool(tool.name, {});
  const id = firstSiteId(result.text);
  if (!id) throw new AppError("UNAVAILABLE", "No accessible site was returned for this account");
  return id;
}

function firstSiteId(text: string): string | null {
  try {
    const data: unknown = JSON.parse(text);
    const list = Array.isArray(data) ? data : [];
    const first = list[0] as { id?: unknown } | undefined;
    return typeof first?.id === "string" ? first.id : null;
  } catch {
    return null;
  }
}

function pickTool(tools: readonly ToolInfo[], names: readonly string[]): ToolInfo | undefined {
  return names.map((n) => tools.find((t) => t.name === n)).find(Boolean);
}

function properties(tool: ToolInfo): Record<string, unknown> {
  const props = tool.inputSchema.properties;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

function required(tool: ToolInfo): string[] {
  const req = tool.inputSchema.required;
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === "string") : [];
}

function requiresProperty(tool: ToolInfo, name: string): boolean {
  return name in properties(tool);
}
