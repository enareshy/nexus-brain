// Full path: API -> vault (Postgres RLS) -> OAuth + MCP against a local mock server.
import { createSecretBox } from "@brain/core";
import { mockSearch } from "@brain/connectors";
import { applyMigrations, createAppPool, loadMigrations, MIGRATIONS_DIR, seed } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { createRegistry } from "@brain/mcp-client";
import { simulateConsent, startMockMcpServer, type MockMcpServer } from "@brain/mcp-client/testing";
import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createJwtVerifier } from "../auth/jwt-verifier.js";
import { createDbUserDirectory } from "../auth/user-directory.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { ConnectionsService } from "./connections.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain";
const ACME = TENANTS.acme.id;
const SERVER = "mock";

let app: NestFastifyApplication;
let pool: pg.Pool;
let mock: MockMcpServer;
let keys: TestKeys;

beforeAll(async () => {
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
    await seed(owner);
    // Fresh connection state for a deterministic run (owner role, test DB only).
    await owner.query("DELETE FROM mcp_connections WHERE server_id = $1", [SERVER]);
    await owner.query("DELETE FROM oauth_states WHERE server_id = $1", [SERVER]);
    await owner.query("DELETE FROM mcp_client_registrations WHERE server_id = $1", [SERVER]);
  } finally {
    await owner.end();
  }

  mock = await startMockMcpServer({
    id: SERVER,
    issuesByIdentity: {
      "pat-jira": [{ key: "ACME-101", summary: "Login bug on SSO", url: "https://acme.example/browse/ACME-101", updated: "2026-10-30" }],
    },
  });
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  keys = await createTestKeys();

  app = await createApp({
    logger: createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) }),
    directory: createDbUserDirectory(pool),
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
    answers: { answer: async () => {} },
    connections: new ConnectionsService({
      pool,
      box: createSecretBox(randomBytes(32).toString("base64")),
      registry: createRegistry([mock.definition]),
      adapters: new Map([[SERVER, { ...mockSearch, serverId: SERVER }]]),
      client: { redirectUrl: "http://127.0.0.1:3001/oauth/callback", clientName: "Nexus Brain (int test)" },
    }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await mock?.close();
});

interface InjectResult {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions over JSON
  json(): any;
}
type Caller = (method: "GET" | "POST" | "DELETE", url: string, body?: object) => Promise<InjectResult>;

async function as(user: "patAcme" | "bob"): Promise<Caller> {
  const token = await keys.sign({ tenant_id: ACME }, { subject: seedUser(user).subject });
  return ((method, url, body) =>
    app.getHttpAdapter().getInstance().inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    })) as Caller;
}

/** Simulates the browser: consent at the provider, then our public callback redirect. */
async function consentViaCallback(authorizationUrl: string): Promise<{ code: string; state: string }> {
  const consent = await simulateConsent(authorizationUrl);
  const res = await app.getHttpAdapter().getInstance().inject({
    method: "GET",
    url: `/oauth/callback?code=${consent.code}&state=${consent.state}`,
  });
  const forwarded = new URL(String(res.headers.location));
  return { code: forwarded.searchParams.get("code") ?? "", state: forwarded.searchParams.get("state") ?? "" };
}

describe("connect Jira (mock) and search as that user", () => {
  let used = { code: "", state: "" };

  it("does not let a colleague complete Pat's consent, and does not burn it", async () => {
    const pat = await as("patAcme");
    const bob = await as("bob");
    mock.setNextIdentity("pat-jira");

    const started = await pat("POST", `/connections/${SERVER}/authorize`);
    expect(started.statusCode).toBe(200);
    const forwarded = await consentViaCallback(started.json().data.authorizationUrl);

    const hijack = await bob("POST", "/connections/complete", forwarded);
    expect(hijack.statusCode).toBe(400);
    expect((await bob("GET", "/connections")).json().data[0].status).toBe("not_connected");

    const done = await pat("POST", "/connections/complete", forwarded);
    expect(done.statusCode).toBe(200);
    expect(done.json().data).toEqual({ serverId: SERVER });
    used = forwarded;

    expect((await pat("GET", "/connections")).json().data).toEqual([
      expect.objectContaining({ serverId: SERVER, status: "active" }),
    ]);
  });

  it("stores tokens only as ciphertext", async () => {
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      const { rows } = await owner.query<{ tokens_ciphertext: string }>(
        "SELECT tokens_ciphertext FROM mcp_connections WHERE server_id = $1",
        [SERVER],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokens_ciphertext.startsWith("v1.")).toBe(true);
      expect(rows[0]!.tokens_ciphertext).not.toMatch(/access_token|refresh_token/);
    } finally {
      await owner.end();
    }
  });

  it("rejects a replayed completion", async () => {
    const pat = await as("patAcme");
    expect((await pat("POST", "/connections/complete", used)).statusCode).toBe(400);
  });

  it("searches with citations as the connected user", async () => {
    const pat = await as("patAcme");
    const res = await pat("GET", "/search?q=login");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.hits).toEqual([
      expect.objectContaining({ externalId: "ACME-101", url: "https://acme.example/browse/ACME-101", serverId: SERVER }),
    ]);
  });

  it("handles concurrent searches without racing the refresh token", async () => {
    mock.expireAccessTokens();
    const pat = await as("patAcme");
    const results = await Promise.all([1, 2, 3].map(() => pat("GET", "/search?q=login")));
    for (const res of results) expect(res.json().data.sources[0]).toMatchObject({ ok: true });
    expect((await pat("GET", "/connections")).json().data[0].status).toBe("active");
  });

  it("does not let a colleague use Pat's connection", async () => {
    const bob = await as("bob");
    expect((await bob("GET", "/connections")).json().data[0].status).toBe("not_connected");
    expect((await bob("GET", "/search?q=login")).json().data).toEqual({ hits: [], sources: [] });
  });

  it("lists live tools for the ADR capture", async () => {
    const pat = await as("patAcme");
    const res = await pat("GET", `/connections/${SERVER}/tools`);
    expect(res.json().data.map((t: { name: string }) => t.name)).toEqual(["search_issues", "create_issue"]);
  });

  it("writes audit rows with a keyed query fingerprint, never the raw query", async () => {
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      const { rows } = await owner.query<{ action: string; meta: Record<string, unknown> }>(
        "SELECT action, meta FROM audit_log WHERE tenant_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 30",
        [ACME, seedUser("patAcme").id],
      );
      expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["connection.connected", "search"]));
      const searchRow = rows.find((r) => r.action === "search")!;
      expect(JSON.stringify(searchRow.meta)).not.toContain("login");
      expect(searchRow.meta.queryFingerprint).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await owner.end();
    }
  });

  it("disconnects and revokes the grant at the provider", async () => {
    const pat = await as("patAcme");
    const before = mock.stats.revocations;
    const res = await pat("DELETE", `/connections/${SERVER}`);
    expect(res.json().data).toEqual({ disconnected: true, revoked: true });
    expect(mock.stats.revocations).toBeGreaterThan(before);
    expect((await pat("GET", "/connections")).json().data[0].status).toBe("not_connected");
  });

  it("marks a connection for reconnect when the grant is revoked elsewhere", async () => {
    const pat = await as("patAcme");
    mock.setNextIdentity("pat-jira");
    const started = await pat("POST", `/connections/${SERVER}/authorize`);
    await pat("POST", "/connections/complete", await consentViaCallback(started.json().data.authorizationUrl));

    mock.expireAccessTokens();
    mock.revokeRefreshTokens();
    const search = await pat("GET", "/search?q=login");
    expect(search.json().data.sources[0]).toMatchObject({ ok: false, error: "RECONNECT_REQUIRED" });
    expect((await pat("GET", "/connections")).json().data[0].status).toBe("needs_reauth");
    await pat("DELETE", `/connections/${SERVER}`);
  });
});
