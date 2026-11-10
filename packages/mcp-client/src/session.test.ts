import { AppError } from "@brain/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGithubServer,
  createGmailServer,
  createGoogleDriveServer,
  createRegistry,
  createSlackServer,
  NOTION_SERVER,
} from "./registry.js";
import {
  beginAuthorization,
  completeAuthorization,
  MAX_TOOL_RESULT_CHARS,
  openSession,
  revokeAuthorization,
  toToolResult,
  type ClientContext,
} from "./session.js";
import {
  createMemoryStore,
  simulateConsent,
  startMockMcpServer,
  type MemoryStore,
  type MockMcpServer,
} from "./testing/index.js";

const ISSUES = {
  pat: [
    { key: "ACME-101", summary: "Login bug on SSO", url: "https://acme.example/browse/ACME-101", updated: "2026-10-30T10:00:00Z" },
    { key: "ACME-102", summary: "Billing export", url: "https://acme.example/browse/ACME-102", updated: "2026-10-29T10:00:00Z" },
  ],
  gina: [],
};

let mock: MockMcpServer;
let ctx: ClientContext;

beforeAll(async () => {
  mock = await startMockMcpServer({ issuesByIdentity: ISSUES });
  ctx = { redirectUrl: "http://127.0.0.1:3001/oauth/callback", clientName: "Nexus Brain (test)" };
});

afterAll(async () => {
  await mock.close();
});

async function connect(identity: string, store: MemoryStore): Promise<void> {
  mock.setNextIdentity(identity);
  const start = await beginAuthorization(mock.definition, store, ctx);
  const consent = await simulateConsent(start.authorizationUrl);
  expect(consent.state).toBe(start.state);
  await completeAuthorization(mock.definition, store, ctx, {
    code: consent.code,
    codeVerifier: start.codeVerifier,
  });
}

describe("OAuth authorization flow", () => {
  it("registers a client, uses PKCE S256 and stores tokens", async () => {
    const store = createMemoryStore();
    mock.setNextIdentity("pat");
    const start = await beginAuthorization(mock.definition, store, ctx);

    const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(start.state.length).toBeGreaterThanOrEqual(43);
    expect(store.state.clientInfo).toBeDefined();
    expect(store.state.tokens).toBeUndefined();

    const consent = await simulateConsent(start.authorizationUrl);
    await completeAuthorization(mock.definition, store, ctx, {
      code: consent.code,
      codeVerifier: start.codeVerifier,
    });
    expect(store.state.tokens?.access_token).toBeTruthy();
    expect(store.state.tokens?.refresh_token).toBeTruthy();
  });

  it("rejects a code exchanged with the wrong verifier", async () => {
    const store = createMemoryStore();
    const start = await beginAuthorization(mock.definition, store, ctx);
    const consent = await simulateConsent(start.authorizationUrl);
    await expect(
      completeAuthorization(mock.definition, store, ctx, {
        code: consent.code,
        codeVerifier: "x".repeat(64),
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(store.state.tokens).toBeUndefined();
  });

  it("always starts a fresh consent even when tokens exist", async () => {
    const store = createMemoryStore();
    await connect("pat", store);
    const again = await beginAuthorization(mock.definition, store, ctx);
    expect(again.authorizationUrl).toContain("/authorize");
  });
});

describe("a server without client registration", () => {
  const client = { clientId: "app-client-id", clientSecret: "app-client-secret" };
  let appMock: MockMcpServer;

  beforeAll(async () => {
    appMock = await startMockMcpServer({ issuesByIdentity: ISSUES, preRegisteredClient: client });
  });

  afterAll(async () => {
    await appMock.close();
  });

  it("connects with the configured app, never registers, and never stores its secret", async () => {
    const def = { ...appMock.definition, client };
    const store = createMemoryStore();
    appMock.setNextIdentity("pat");

    const start = await beginAuthorization(def, store, ctx);
    expect(new URL(start.authorizationUrl).searchParams.get("client_id")).toBe(client.clientId);
    const consent = await simulateConsent(start.authorizationUrl);
    await completeAuthorization(def, store, ctx, { code: consent.code, codeVerifier: start.codeVerifier });

    expect(appMock.stats.registrations).toBe(0);
    expect(store.state.clientInfo).toBeUndefined();
    expect(JSON.stringify(store.state)).not.toContain(client.clientSecret);

    const session = await openSession(def, store, ctx);
    await session.close();
    expect(store.state.tokens?.access_token).toBeTruthy();
  });

  it("refreshes tokens with the configured app", async () => {
    const def = { ...appMock.definition, client };
    const store = createMemoryStore();
    appMock.setNextIdentity("pat");
    const start = await beginAuthorization(def, store, ctx);
    const consent = await simulateConsent(start.authorizationUrl);
    await completeAuthorization(def, store, ctx, { code: consent.code, codeVerifier: start.codeVerifier });

    const before = appMock.stats.refreshGrants;
    appMock.expireAccessTokens();
    const session = await openSession(def, store, ctx);
    await session.close();
    expect(appMock.stats.refreshGrants).toBe(before + 1);
  });

  it("fails clearly when the app's secret is wrong, keeping no tokens", async () => {
    const def = { ...appMock.definition, client: { ...client, clientSecret: "wrong" } };
    const store = createMemoryStore();
    const start = await beginAuthorization(def, store, ctx);
    const consent = await simulateConsent(start.authorizationUrl);
    await expect(
      completeAuthorization(def, store, ctx, { code: consent.code, codeVerifier: start.codeVerifier }),
    ).rejects.toBeInstanceOf(AppError);
    expect(store.state.tokens).toBeUndefined();
  });

  it("sends a server's extra sign-in settings and its scope", async () => {
    const def = {
      ...appMock.definition,
      client,
      scope: "read.only",
      authorizationParams: { access_type: "offline", prompt: "consent" },
    };
    const start = await beginAuthorization(def, createMemoryStore(), ctx);
    const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("read.only");
  });

  it("revokes with the configured app, which is not in the vault", async () => {
    const def = { ...appMock.definition, client };
    const store = createMemoryStore();
    appMock.setNextIdentity("pat");
    const start = await beginAuthorization(def, store, ctx);
    const consent = await simulateConsent(start.authorizationUrl);
    await completeAuthorization(def, store, ctx, { code: consent.code, codeVerifier: start.codeVerifier });

    const before = appMock.stats.revocations;
    expect(await revokeAuthorization(def, ctx, store.state.tokens!, undefined)).toBe(true);
    expect(appMock.stats.revocations).toBeGreaterThan(before);
  });

  it("cannot connect without an app configured", async () => {
    await expect(beginAuthorization(appMock.definition, createMemoryStore(), ctx)).rejects.toBeInstanceOf(AppError);
  });
});

describe("createGithubServer", () => {
  it("uses the read-only endpoint and only GitHub's hosts", () => {
    const def = createGithubServer({ clientId: "id", clientSecret: "secret" });
    expect(def.url).toBe("https://api.githubcopilot.com/mcp/readonly");
    expect(def.allowedHosts).toEqual(["api.githubcopilot.com", "github.com"]);
    expect(def.client).toEqual({ clientId: "id", clientSecret: "secret" });
  });
});

describe("createGoogleDriveServer", () => {
  it("asks only for read-only access, and only Google's hosts are allowed", () => {
    const def = createGoogleDriveServer({ clientId: "id", clientSecret: "secret" });
    expect(def.url).toBe("https://drivemcp.googleapis.com/mcp/v1");
    expect(def.scope).toBe("https://www.googleapis.com/auth/drive.readonly");
    expect(def.allowedHosts).toEqual(["drivemcp.googleapis.com", "accounts.google.com", "oauth2.googleapis.com"]);
    expect(def.authorizationParams).toEqual({ access_type: "offline", prompt: "consent" });
  });
});

describe("createGmailServer", () => {
  it("can only read mail, and shares Google's app with Drive", () => {
    const def = createGmailServer();
    expect(def.url).toBe("https://gmailmcp.googleapis.com/mcp/v1");
    expect(def.scope).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(def.needsApp).toBe(true);
    expect(def.appKey).toBe(createGoogleDriveServer().appKey);
    expect(def.client).toBeUndefined();
  });
});

describe("NOTION_SERVER", () => {
  it("talks only to Notion's MCP host, which also serves its sign-in, and needs no app in advance", () => {
    expect(NOTION_SERVER).toMatchObject({ id: "notion", url: "https://mcp.notion.com/mcp" });
    expect(NOTION_SERVER.allowedHosts).toEqual(["mcp.notion.com"]);
    expect(NOTION_SERVER.needsApp).toBeUndefined();
    expect(NOTION_SERVER.client).toBeUndefined();
  });
});

describe("createSlackServer", () => {
  it("asks for no posting scope and no direct messages", () => {
    const def = createSlackServer();
    expect(def.allowedHosts).toEqual(["mcp.slack.com", "slack.com"]);
    expect(def.scope).not.toMatch(/write|im:|mpim/);
    expect(def.needsApp).toBe(true);
  });
});

describe("MCP session as the connected user", () => {
  it("lists tools with annotations", async () => {
    const store = createMemoryStore();
    await connect("pat", store);
    const session = await openSession(mock.definition, store, ctx);
    try {
      const tools = await session.listTools();
      const search = tools.find((t) => t.name === "search_issues");
      expect(search?.annotations).toMatchObject({ readOnlyHint: true });
      expect(search?.inputSchema).toHaveProperty("properties.query");
    } finally {
      await session.close();
    }
  });

  it("returns only what that user's account can see", async () => {
    const patStore = createMemoryStore();
    const ginaStore = createMemoryStore();
    await connect("pat", patStore);
    await connect("gina", ginaStore);

    const pat = await openSession(mock.definition, patStore, ctx);
    const gina = await openSession(mock.definition, ginaStore, ctx);
    try {
      const patResult = await pat.callTool("search_issues", { query: "login" });
      const ginaResult = await gina.callTool("search_issues", { query: "login" });
      expect(patResult.text).toContain("ACME-101");
      expect(ginaResult.text).not.toContain("ACME-101");
    } finally {
      await pat.close();
      await gina.close();
    }
  });

  it("refreshes an expired access token transparently", async () => {
    const store = createMemoryStore();
    await connect("pat", store);
    const before = store.state.tokens?.access_token;
    const refreshesBefore = mock.stats.refreshGrants;
    mock.expireAccessTokens();

    const session = await openSession(mock.definition, store, ctx);
    try {
      const result = await session.callTool("search_issues", { query: "billing" });
      expect(result.text).toContain("ACME-102");
    } finally {
      await session.close();
    }
    expect(mock.stats.refreshGrants).toBeGreaterThan(refreshesBefore);
    expect(store.state.tokens?.access_token).not.toBe(before);
  });

  it("requires reconnecting when the refresh token is revoked", async () => {
    const store = createMemoryStore();
    await connect("pat", store);
    mock.expireAccessTokens();
    mock.revokeRefreshTokens();

    const error = await openSession(mock.definition, store, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("RECONNECT_REQUIRED");
    expect(store.state.needsReauth).toBe(true);
  });

  it("keeps requiring reconnect on later calls (tokens hidden once marked)", async () => {
    const store = createMemoryStore();
    await connect("pat", store);
    mock.expireAccessTokens();
    mock.revokeRefreshTokens();
    await openSession(mock.definition, store, ctx).catch(() => undefined);

    const second = (await openSession(mock.definition, store, ctx).catch((e: unknown) => e)) as AppError;
    expect(second.code).toBe("RECONNECT_REQUIRED");
  });

  it("refuses a server whose host is not allow-listed", async () => {
    const store = createMemoryStore();
    const spoofed = { ...mock.definition, allowedHosts: ["mcp.atlassian.com"] };
    await expect(beginAuthorization(spoofed, store, ctx)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("maps an unreachable server to UNAVAILABLE", async () => {
    const store = createMemoryStore();
    const dead = { ...mock.definition, url: "http://127.0.0.1:1/mcp" };
    await expect(openSession(dead, store, ctx)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("revokeAuthorization", () => {
  it("revokes refresh and access tokens at the provider", async () => {
    const store = createMemoryStore();
    await connect("pat", store);
    const before = mock.stats.revocations;
    const revoked = await revokeAuthorization(mock.definition, ctx, store.state.tokens!, store.state.clientInfo);
    expect(revoked).toBe(true);
    expect(mock.stats.revocations - before).toBe(2);
    await expect(openSession(mock.definition, store, ctx)).rejects.toMatchObject({
      code: "RECONNECT_REQUIRED",
    });
  });

  it("returns false without client information", async () => {
    const store = createMemoryStore();
    await connect("pat", store);
    expect(await revokeAuthorization(mock.definition, ctx, store.state.tokens!, undefined)).toBe(false);
  });

  it("returns false when discovery fails", async () => {
    const dead = { ...mock.definition, url: "http://127.0.0.1:1/mcp" };
    expect(await revokeAuthorization(dead, ctx, { access_token: "a", token_type: "Bearer" }, { client_id: "c" })).toBe(false);
  });
});

describe("toToolResult", () => {
  it("falls back to structured content when there is no text", () => {
    expect(toToolResult({ content: [], structuredContent: { files: [] } }).text).toBe('{"files":[]}');
    expect(toToolResult({ content: [{ type: "text", text: "a" }], structuredContent: { b: 1 } }).text).toBe("a");
  });

  it("joins text parts, ignores others and flags errors", () => {
    const result = toToolResult({
      content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }],
      isError: true,
    });
    expect(result).toEqual({ text: "a\nb", isError: true, truncated: false });
  });

  it("truncates oversized results", () => {
    const huge = "x".repeat(MAX_TOOL_RESULT_CHARS + 10);
    const result = toToolResult({ content: [{ type: "text", text: huge }] });
    expect(result.text).toHaveLength(MAX_TOOL_RESULT_CHARS);
    expect(result.truncated).toBe(true);
  });

  it("handles a result without content", () => {
    expect(toToolResult({})).toEqual({ text: "", isError: false, truncated: false });
  });
});

describe("createRegistry", () => {
  it("returns allow-listed servers and rejects unknown ones", () => {
    const registry = createRegistry([mock.definition]);
    expect(registry.get(mock.definition.id).url).toBe(mock.definition.url);
    expect(registry.list()).toHaveLength(1);
    expect(() => registry.get("rogue")).toThrowError(/not allow-listed/);
  });

  it("rejects duplicate ids", () => {
    expect(() => createRegistry([mock.definition, mock.definition])).toThrowError(/Duplicate/);
  });
});
