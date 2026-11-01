import { AppError } from "@brain/core";

export interface McpServerDefinition {
  readonly id: string;
  readonly displayName: string;
  /** Streamable HTTP endpoint. */
  readonly url: string;
  /**
   * Every host our server-side code may contact for this server (MCP endpoint,
   * OAuth discovery, registration, token). Anything else is refused (SSRF guard).
   */
  readonly allowedHosts: readonly string[];
  /** Test/dev only: permit plain http to loopback. Never set for real servers. */
  readonly allowInsecureLoopback?: boolean;
  readonly scope?: string;
}

/**
 * Atlassian remote MCP (Jira + Confluence). Endpoint and OAuth endpoints verified by
 * probe on 2026-10-31 (docs/DECISIONS-AND-INTEGRATIONS.md §1a). Tool names are NOT
 * verified; see packages/connectors.
 */
export const ATLASSIAN_SERVER: McpServerDefinition = Object.freeze({
  id: "atlassian",
  displayName: "Atlassian (Jira + Confluence)",
  url: "https://mcp.atlassian.com/v1/mcp",
  allowedHosts: Object.freeze(["mcp.atlassian.com"]),
});

export interface ServerRegistry {
  get(id: string): McpServerDefinition;
  list(): readonly McpServerDefinition[];
}

/** Admin allow-list of MCP servers (FR-MCP-02). Unknown IDs are rejected. */
export function createRegistry(definitions: readonly McpServerDefinition[]): ServerRegistry {
  const byId = new Map(definitions.map((d) => [d.id, d]));
  if (byId.size !== definitions.length) {
    throw new AppError("CONFIG_INVALID", "Duplicate MCP server id in registry");
  }
  return {
    get(id) {
      const def = byId.get(id);
      if (!def) throw new AppError("NOT_FOUND", "Unknown or not allow-listed MCP server");
      return def;
    },
    list: () => [...byId.values()],
  };
}
