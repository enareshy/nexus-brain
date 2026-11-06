// Local MCP server with a real OAuth 2.1 + PKCE authorization server, for tests and
// local development. It models per-user visibility: each identity sees only its issues.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { McpServerDefinition } from "../registry.js";

export interface MockIssue {
  readonly key: string;
  readonly summary: string;
  readonly url: string;
  readonly updated: string;
}

export interface MockMcpServerOptions {
  readonly id?: string;
  readonly issuesByIdentity: Readonly<Record<string, readonly MockIssue[]>>;
  /** Extra text appended to every search result (prompt-injection tests). */
  readonly injectText?: string;
  /** Models a server with no client registration: only this app may connect, with its secret. */
  readonly preRegisteredClient?: { readonly clientId: string; readonly clientSecret: string };
}

export interface MockMcpServer {
  readonly baseUrl: string;
  readonly definition: McpServerDefinition;
  readonly stats: {
    registrations: number;
    codeGrants: number;
    refreshGrants: number;
    revocations: number;
    /** MCP sessions started, to prove reuse. */
    initializes: number;
    /** All authenticated MCP requests. */
    mcpCalls: number;
  };
  readonly createdIssues: Array<{ identity: string; summary: string }>;
  /** Issues `get_issue` reads and `edit_issue` changes, by key. Tests may edit them "in the service". */
  readonly editableIssues: Map<string, Record<string, unknown>>;
  /** Names of every tool called, in order. */
  readonly calledTools: string[];
  /** Identity the next /authorize call "logs in" as (simulates the user's consent). */
  setNextIdentity(identity: string): void;
  expireAccessTokens(): void;
  revokeRefreshTokens(): void;
  /** Makes the next MCP request fail, as a session the server has dropped would. */
  failNextMcpRequest(): void;
  /** Fails the next tool call with this name after receiving it, without running the tool. */
  failMcpRequestMatching(toolName: string): void;
  /** Slows MCP requests, to hold a request in flight in race tests. */
  setMcpDelay(ms: number): void;
  close(): Promise<void>;
  /** Listens again on the same port after close(). */
  listen(): Promise<void>;
}

interface Grant {
  identity: string;
  expiresAt: number;
}

export async function startMockMcpServer(options: MockMcpServerOptions): Promise<MockMcpServer> {
  const preRegistered = options.preRegisteredClient;
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { identity: string; challenge: string; redirectUri: string; clientId: string }>();
  const accessTokens = new Map<string, Grant>();
  const refreshTokens = new Map<string, string>();
  const stats = { registrations: 0, codeGrants: 0, refreshGrants: 0, revocations: 0, initializes: 0, mcpCalls: 0 };
  let failNext = false;
  let failToolName: string | null = null;
  let mcpDelayMs = 0;
  const createdIssues: Array<{ identity: string; summary: string }> = [];
  const calledTools: string[] = [];
  const editableIssues = new Map<string, Record<string, unknown>>();
  let nextIdentity = Object.keys(options.issuesByIdentity)[0] ?? "anonymous";
  let baseUrl = "";

  const issueTokens = (identity: string) => {
    const access = randomBytes(24).toString("base64url");
    const refresh = randomBytes(24).toString("base64url");
    accessTokens.set(access, { identity, expiresAt: Date.now() + 3600_000 });
    refreshTokens.set(refresh, identity);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: "server_error", detail: String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", baseUrl);
    const path = url.pathname;

    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        // GitHub's metadata lists neither registration nor token endpoint auth methods.
        ...(preRegistered
          ? {}
          : { registration_endpoint: `${baseUrl}/register`, token_endpoint_auth_methods_supported: ["none"] }),
        revocation_endpoint: `${baseUrl}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (path === "/register" && req.method === "POST" && !preRegistered) {
      const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
      const clientId = `client-${randomBytes(8).toString("hex")}`;
      clients.set(clientId, { redirectUris: body.redirect_uris ?? [] });
      stats.registrations += 1;
      return json(res, 201, { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (path === "/authorize") {
      const q = url.searchParams;
      const clientId = q.get("client_id") ?? "";
      const redirectUri = q.get("redirect_uri") ?? "";
      const knownClient = preRegistered
        ? clientId === preRegistered.clientId
        : clients.get(clientId)?.redirectUris.includes(redirectUri);
      if (!knownClient) {
        return json(res, 400, { error: "invalid_request" });
      }
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
        return json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
      }
      const code = randomBytes(16).toString("base64url");
      codes.set(code, { identity: nextIdentity, challenge: q.get("code_challenge")!, redirectUri, clientId });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (
        preRegistered &&
        (form.get("client_id") !== preRegistered.clientId || form.get("client_secret") !== preRegistered.clientSecret)
      ) {
        return json(res, 401, { error: "invalid_client" });
      }
      if (form.get("grant_type") === "authorization_code") {
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get("redirect_uri")) {
          return json(res, 400, { error: "invalid_grant" });
        }
        stats.codeGrants += 1;
        return json(res, 200, issueTokens(grant.identity));
      }
      if (form.get("grant_type") === "refresh_token") {
        const identity = refreshTokens.get(form.get("refresh_token") ?? "");
        if (!identity) return json(res, 400, { error: "invalid_grant" });
        refreshTokens.delete(form.get("refresh_token") ?? "");
        stats.refreshGrants += 1;
        return json(res, 200, issueTokens(identity));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (path === "/revoke" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const token = form.get("token") ?? "";
      if (refreshTokens.delete(token) || accessTokens.delete(token)) stats.revocations += 1;
      res.writeHead(200).end();
      return;
    }
    if (path === "/mcp") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const grant = accessTokens.get(token);
      if (!grant || grant.expiresAt < Date.now()) {
        res.writeHead(401, {
          "www-authenticate": `Bearer error="invalid_token", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
        }).end();
        return;
      }
      const raw = await readBody(req);
      stats.mcpCalls += 1;
      if (mcpDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mcpDelayMs));
      if (failNext) {
        failNext = false;
        return json(res, 500, { error: "session_lost" });
      }
      if (failToolName && raw.includes('"method":"tools/call"') && raw.includes(`"name":"${failToolName}"`)) {
        failToolName = null;
        return json(res, 500, { error: "connection_lost" });
      }
      if (raw.includes('"method":"initialize"')) stats.initializes += 1;
      const call = raw ? (JSON.parse(raw) as { method?: string; params?: { name?: string } }) : {};
      if (call.method === "tools/call" && call.params?.name) calledTools.push(call.params.name);
      const mcp = buildMcpServer(grant.identity);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      return;
    }
    json(res, 404, { error: "not_found" });
  }

  function buildMcpServer(identity: string): McpServer {
    const mcp = new McpServer({ name: "mock-work-system", version: "1.0.0" });
    mcp.registerTool(
      "search_issues",
      {
        description: "Search issues visible to the signed-in user",
        inputSchema: { query: z.string(), limit: z.number().int().optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ query, limit }) => {
        const needle = query.toLowerCase();
        const issues = (options.issuesByIdentity[identity] ?? [])
          .filter((i) => i.summary.toLowerCase().includes(needle) || needle === "*")
          .slice(0, limit ?? 10);
        const text = JSON.stringify({ issues }) + (options.injectText ?? "");
        return { content: [{ type: "text", text }] };
      },
    );
    mcp.registerTool(
      "create_issue",
      {
        description: "Create an issue",
        inputSchema: { summary: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ summary }) => {
        createdIssues.push({ identity, summary });
        return { content: [{ type: "text", text: JSON.stringify({ key: `NEW-${createdIssues.length}` }) }] };
      },
    );
    mcp.registerTool(
      "get_issue",
      {
        description: "Read fields of an issue",
        inputSchema: { key: z.string(), fields: z.array(z.string()) },
        annotations: { readOnlyHint: true },
      },
      async ({ key, fields }) => {
        const issue = editableIssues.get(key);
        if (!issue) return { content: [{ type: "text", text: "Issue not found" }], isError: true };
        const picked = Object.fromEntries(fields.map((f) => [f, issue[f] ?? null]));
        return { content: [{ type: "text", text: JSON.stringify({ key, fields: picked }) }] };
      },
    );
    mcp.registerTool(
      "edit_issue",
      {
        description: "Change fields of an issue",
        inputSchema: { key: z.string(), fields: z.record(z.string(), z.unknown()) },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ key, fields }) => {
        const issue = editableIssues.get(key);
        if (!issue) return { content: [{ type: "text", text: "Issue not found" }], isError: true };
        editableIssues.set(key, { ...issue, ...fields });
        return { content: [{ type: "text", text: JSON.stringify({ key }) }] };
      },
    );
    mcp.registerTool(
      "delete_issue",
      {
        description: "Delete an issue",
        inputSchema: { summary: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ summary }) => {
        createdIssues.push({ identity, summary: `deleted ${summary}` });
        return { content: [{ type: "text", text: "{}" }] };
      },
    );
    return mcp;
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    definition: {
      id: options.id ?? "mock",
      displayName: "Mock work system",
      url: `${baseUrl}/mcp`,
      allowedHosts: ["127.0.0.1"],
      allowInsecureLoopback: true,
    },
    stats,
    createdIssues,
    editableIssues,
    calledTools,
    setNextIdentity: (identity) => {
      nextIdentity = identity;
    },
    expireAccessTokens: () => {
      for (const grant of accessTokens.values()) grant.expiresAt = 0;
    },
    revokeRefreshTokens: () => refreshTokens.clear(),
    failNextMcpRequest: () => {
      failNext = true;
    },
    failMcpRequestMatching: (toolName) => {
      failToolName = toolName;
    },
    setMcpDelay: (ms) => {
      mcpDelayMs = ms;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    listen: () => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve)),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
