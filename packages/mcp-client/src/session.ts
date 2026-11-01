import { AppError, isAppError } from "@brain/core";
import {
  auth,
  discoverOAuthServerInfo,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidTokenError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomBytes } from "node:crypto";
import {
  assertAllowedUrl,
  createGuardedFetch,
  type FetchLike,
  type ResolveHost,
} from "./guarded-fetch.js";
import {
  StoreBackedOAuthProvider,
  type CredentialStore,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "./provider.js";
import type { McpServerDefinition } from "./registry.js";

const CLIENT_INFO = { name: "nexus-brain", version: "0.1.0" };
const REQUEST_TIMEOUT_MS = 20_000;
/** Cap on text returned from one tool call before it reaches prompts or logs. */
export const MAX_TOOL_RESULT_CHARS = 100_000;

export interface ClientContext {
  readonly redirectUrl: string;
  readonly clientName: string;
  /** Overrides for tests; production uses DNS and global fetch. */
  readonly resolve?: ResolveHost;
  readonly fetchImpl?: FetchLike;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  /** Untrusted text from the server (NFR-SEC-02). Truncated to MAX_TOOL_RESULT_CHARS. */
  readonly text: string;
  readonly isError: boolean;
  readonly truncated: boolean;
}

export interface McpSession {
  listTools(): Promise<readonly ToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface AuthorizationStart {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
}

function guardedFetchFor(def: McpServerDefinition, ctx: ClientContext): FetchLike {
  return createGuardedFetch({
    allowedHosts: def.allowedHosts,
    allowInsecureLoopback: def.allowInsecureLoopback,
    resolve: ctx.resolve,
    fetchImpl: ctx.fetchImpl,
  });
}

/** A pre-registered app comes from configuration, so it is neither loaded from nor saved to the vault. */
function withConfiguredClient(def: McpServerDefinition, store: CredentialStore): CredentialStore {
  if (!def.client) return store;
  // GitHub documents the secret as a body parameter and its metadata names no method.
  const clientInfo = {
    client_id: def.client.clientId,
    client_secret: def.client.clientSecret,
    token_endpoint_auth_method: "client_secret_post",
  };
  return { ...store, loadClientInfo: async () => clientInfo, saveClientInfo: async () => {} };
}

/**
 * Starts the OAuth authorization-code + PKCE flow for the current user. Existing tokens
 * are ignored so the user always sees the consent screen when they click Connect.
 */
export async function beginAuthorization(
  def: McpServerDefinition,
  store: CredentialStore,
  ctx: ClientContext,
): Promise<AuthorizationStart> {
  const state = randomBytes(32).toString("base64url");
  const provider = new StoreBackedOAuthProvider({
    store: { ...withConfiguredClient(def, store), loadTokens: async () => undefined },
    redirectUrl: ctx.redirectUrl,
    clientName: ctx.clientName,
    mode: "interactive",
    state,
  });

  const result = await runAuth(() =>
    auth(provider, { serverUrl: def.url, scope: def.scope, fetchFn: guardedFetchFor(def, ctx) }),
  );
  const url = provider.authorizationUrl;
  const verifier = provider.pendingCodeVerifier;
  if (result !== "REDIRECT" || !url || !verifier) {
    throw new AppError("UNAVAILABLE", "Authorization server did not start a consent flow");
  }
  // The consent URL comes from server metadata; only send users to allow-listed https hosts.
  await assertAllowedUrl(
    url,
    new Set(def.allowedHosts),
    def.allowInsecureLoopback === true,
    ctx.resolve,
  );
  return { authorizationUrl: url.toString(), state, codeVerifier: verifier };
}

/**
 * Revokes tokens at the authorization server (RFC 7009) when it advertises a
 * revocation endpoint. Best effort: returns false if unsupported or refused.
 */
export async function revokeAuthorization(
  def: McpServerDefinition,
  ctx: ClientContext,
  tokens: OAuthTokens,
  client: OAuthClientInformationMixed | undefined,
): Promise<boolean> {
  const fetchFn = guardedFetchFor(def, ctx);
  try {
    const info = await discoverOAuthServerInfo(def.url, { fetchFn });
    // RFC 8414 field; not declared on the SDK's metadata type.
    const metadata = info.authorizationServerMetadata as { revocation_endpoint?: unknown } | undefined;
    const endpoint = typeof metadata?.revocation_endpoint === "string" ? metadata.revocation_endpoint : null;
    if (!endpoint || !client) return false;

    const toRevoke: Array<[string, string]> = [];
    if (tokens.refresh_token) toRevoke.push([tokens.refresh_token, "refresh_token"]);
    toRevoke.push([tokens.access_token, "access_token"]);

    let allRevoked = true;
    for (const [token, hint] of toRevoke) {
      const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.client_id });
      if (client.client_secret) body.set("client_secret", client.client_secret);
      const res = await fetchFn(endpoint, { method: "POST", body });
      allRevoked = allRevoked && res.ok;
    }
    return allRevoked;
  } catch {
    return false;
  }
}

/** Exchanges the authorization code (with the stored PKCE verifier) and saves tokens. */
export async function completeAuthorization(
  def: McpServerDefinition,
  store: CredentialStore,
  ctx: ClientContext,
  input: { readonly code: string; readonly codeVerifier: string },
): Promise<void> {
  const provider = new StoreBackedOAuthProvider({
    store: withConfiguredClient(def, store),
    redirectUrl: ctx.redirectUrl,
    clientName: ctx.clientName,
    mode: "background",
    codeVerifier: input.codeVerifier,
  });
  const result = await runAuth(() =>
    auth(provider, {
      serverUrl: def.url,
      authorizationCode: input.code,
      fetchFn: guardedFetchFor(def, ctx),
    }),
  );
  if (result !== "AUTHORIZED") {
    throw new AppError("UNAVAILABLE", "Authorization could not be completed");
  }
}

/** Opens an authenticated MCP session as the connection's user. */
export async function openSession(
  def: McpServerDefinition,
  store: CredentialStore,
  ctx: ClientContext,
): Promise<McpSession> {
  const provider = new StoreBackedOAuthProvider({
    store: withConfiguredClient(def, store),
    redirectUrl: ctx.redirectUrl,
    clientName: ctx.clientName,
    mode: "background",
  });
  const transport = new StreamableHTTPClientTransport(new URL(def.url), {
    authProvider: provider,
    fetch: guardedFetchFor(def, ctx),
  });
  const client = new Client(CLIENT_INFO);
  await runAuth(() => client.connect(transport, { timeout: REQUEST_TIMEOUT_MS }));

  return {
    async listTools() {
      const tools: ToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await runAuth(() =>
          client.listTools(cursor ? { cursor } : undefined, { timeout: REQUEST_TIMEOUT_MS }),
        );
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema as Record<string, unknown>,
            annotations: (tool.annotations ?? {}) as Record<string, unknown>,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args) {
      const result = await runAuth(() =>
        client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS }),
      );
      return toToolResult(result);
    },
    close: () => client.close(),
  };
}

/** Joins text content and caps its size. Non-text content is ignored. */
export function toToolResult(result: unknown): ToolResult {
  const record = result as { content?: unknown; isError?: unknown };
  const parts = Array.isArray(record.content) ? record.content : [];
  const text = parts
    .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
  const truncated = text.length > MAX_TOOL_RESULT_CHARS;
  return {
    text: truncated ? text.slice(0, MAX_TOOL_RESULT_CHARS) : text,
    isError: record.isError === true,
    truncated,
  };
}

/** OAuth failures that only the user can fix by reconnecting (revoked or expired grant). */
const RECONNECT_ERRORS = [
  UnauthorizedError,
  InvalidGrantError,
  InvalidTokenError,
  InvalidClientError,
  UnauthorizedClientError,
];

/** Maps SDK/network failures to typed errors without leaking server details. */
async function runAuth<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isAppError(err)) throw err;
    if (RECONNECT_ERRORS.some((type) => err instanceof type)) {
      throw new AppError("RECONNECT_REQUIRED", "This connection needs to be reconnected");
    }
    throw new AppError("UNAVAILABLE", "The connected service is unavailable", {
      reason: err instanceof Error ? err.name : "unknown",
    });
  }
}
