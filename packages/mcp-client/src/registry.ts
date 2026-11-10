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
  /** The server has no client registration, so each company needs an app created in advance. */
  readonly needsApp?: boolean;
  /** Services from one provider can share a company's app. Defaults to the server id. */
  readonly appKey?: string;
  /** That app. Comes from the company's encrypted setup or the environment, never from a user's vault. */
  readonly client?: PreRegisteredClient;
  /** Extra query parameters a provider needs on its consent URL. */
  readonly authorizationParams?: Readonly<Record<string, string>>;
}

export interface PreRegisteredClient {
  readonly clientId: string;
  readonly clientSecret: string;
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

/**
 * Notion's hosted MCP server. Its OAuth metadata was probed on 2026-11-10: the authorization server,
 * token, registration and revocation endpoints are all on mcp.notion.com, with PKCE (S256) and
 * client registration without a secret, so no app is needed in advance. Only workspace members can
 * connect, not guests. It also offers write tools, which Brain never calls: writes go only through
 * the approval policy, which knows none of Notion's.
 */
export const NOTION_SERVER: McpServerDefinition = Object.freeze({
  id: "notion",
  displayName: "Notion",
  url: "https://mcp.notion.com/mcp",
  allowedHosts: Object.freeze(["mcp.notion.com"]),
});

/**
 * GitHub remote MCP, on the endpoint where the server itself refuses writes. Its sign-in has
 * no client registration (probed 2026-11-01), so it needs a GitHub App created in advance.
 */
export function createGithubServer(client?: PreRegisteredClient): McpServerDefinition {
  return Object.freeze({
    id: "github",
    displayName: "GitHub",
    url: "https://api.githubcopilot.com/mcp/readonly",
    allowedHosts: Object.freeze(["api.githubcopilot.com", "github.com"]),
    needsApp: true,
    ...(client ? { client } : {}),
  });
}

/**
 * Google has no client registration (probed 2026-11-01) and issues a refresh token only with
 * these consent URL parameters. Its services share one company app.
 */
function createGoogleServer(
  server: Pick<McpServerDefinition, "id" | "displayName" | "scope"> & { readonly host: string },
  client?: PreRegisteredClient,
): McpServerDefinition {
  const { host, ...rest } = server;
  return Object.freeze({
    ...rest,
    url: `https://${host}/mcp/v1`,
    allowedHosts: Object.freeze([host, "accounts.google.com", "oauth2.googleapis.com"]),
    authorizationParams: Object.freeze({ access_type: "offline", prompt: "consent" }),
    needsApp: true,
    appKey: "google",
    ...(client ? { client } : {}),
  });
}

/** Google Drive remote MCP, limited to the read-only scope. */
export function createGoogleDriveServer(client?: PreRegisteredClient): McpServerDefinition {
  return createGoogleServer(
    {
      id: "google-drive",
      displayName: "Google Drive",
      host: "drivemcp.googleapis.com",
      scope: "https://www.googleapis.com/auth/drive.readonly",
    },
    client,
  );
}

/** Gmail remote MCP, limited to the read-only scope: it cannot send, change or draft mail. */
export function createGmailServer(client?: PreRegisteredClient): McpServerDefinition {
  return createGoogleServer(
    {
      id: "gmail",
      displayName: "Gmail",
      host: "gmailmcp.googleapis.com",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    },
    client,
  );
}

/**
 * Slack remote MCP. Slack allows only Marketplace and internal apps, with a client secret.
 * Search and channel reading only: no posting, and no direct or group messages.
 */
export function createSlackServer(): McpServerDefinition {
  return Object.freeze({
    id: "slack",
    displayName: "Slack",
    url: "https://mcp.slack.com/mcp",
    allowedHosts: Object.freeze(["mcp.slack.com", "slack.com"]),
    scope: "search:read.public search:read.private channels:history groups:history",
    needsApp: true,
  });
}

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
