// Admin setup of a service's sign-in app, per company: API -> Postgres RLS -> OAuth against a mock.
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
import { unusedAudit, unusedProposals, unusedConversations } from "../test-support/fake-proposals.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { ConnectionsService } from "./connections.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain";
const SERVER = "mockapp";
const SHARED = "mocksharedapp";
const APP = { clientId: "acme-client-id", clientSecret: "acme-very-secret-value" };

let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let mock: MockMcpServer;
let keys: TestKeys;

interface InjectResult {
  readonly statusCode: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions over JSON
  json(): any;
  readonly body: string;
}
type Caller = (method: "GET" | "POST" | "DELETE", url: string, body?: object) => Promise<InjectResult>;

async function as(user: "alice" | "bob" | "patGlobex"): Promise<Caller> {
  const seeded = seedUser(user);
  const token = await keys.sign({ tenant_id: TENANTS[seeded.tenant].id }, { subject: seeded.subject });
  return ((method, url, body) =>
    app.getHttpAdapter().getInstance().inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    })) as Caller;
}

const clean = async () => {
  for (const table of ["mcp_server_apps", "mcp_connections", "oauth_states"]) {
    await owner.query(`DELETE FROM ${table} WHERE server_id = ANY($1)`, [[SERVER, SHARED]]);
  }
};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  await clean();

  mock = await startMockMcpServer({ id: SERVER, issuesByIdentity: { someone: [] }, preRegisteredClient: APP });
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  keys = await createTestKeys();
  app = await createApp({
    logger: createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) }),
    directory: createDbUserDirectory(pool),
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
    answers: { answer: async () => {} },
    proposals: unusedProposals,
    audit: unusedAudit,
    conversations: unusedConversations,
    connections: new ConnectionsService({
      pool,
      box: createSecretBox(randomBytes(32).toString("base64")),
      registry: createRegistry([
        { ...mock.definition, needsApp: true },
        { ...mock.definition, id: SHARED, needsApp: true, appKey: SERVER },
      ]),
      adapters: new Map([[SERVER, { ...mockSearch, serverId: SERVER }]]),
      client: { redirectUrl: "http://127.0.0.1:3001/oauth/callback", clientName: "Nexus Brain (int test)" },
    }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await clean();
  await owner?.end();
  await app?.close();
  await pool?.end();
  await mock?.close();
});

describe("setting up a service's sign-in app", () => {
  it("starts unset, and nobody can connect yet", async () => {
    const bob = await as("bob");
    const list = await bob("GET", "/connections");
    expect(list.json().data[0]).toMatchObject({
      serverId: SERVER,
      setup: "needs_app",
      redirectUrl: "http://127.0.0.1:3001/oauth/callback",
    });
    expect((await bob("POST", `/connections/${SERVER}/authorize`)).statusCode).toBe(400);
  });

  it("is refused for a member, and for bad input", async () => {
    const bob = await as("bob");
    const alice = await as("alice");
    expect((await bob("POST", `/connections/${SERVER}/app`, APP)).statusCode).toBe(403);
    expect((await alice("POST", `/connections/${SERVER}/app`, { clientId: "x" })).statusCode).toBe(400);
    expect((await alice("POST", `/connections/${SERVER}/app`, { ...APP, clientId: "has space" })).statusCode).toBe(400);
    expect((await alice("POST", "/connections/unknown-server/app", APP)).statusCode).toBe(404);
    expect((await bob("GET", "/connections")).json().data[0].setup).toBe("needs_app");
  });

  it("lets an admin save it, and never shows or stores the secret in the clear", async () => {
    const alice = await as("alice");
    const saved = await alice("POST", `/connections/${SERVER}/app`, APP);
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(APP.clientSecret);

    const list = await alice("GET", "/connections");
    expect(list.json().data[0].setup).toBe("configured");
    expect(list.body).not.toContain(APP.clientSecret);

    const { rows } = await owner.query("SELECT * FROM mcp_server_apps WHERE server_id = $1", [SERVER]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(APP.clientSecret);
    const audit = await owner.query("SELECT meta FROM audit_log WHERE action = 'connection.app_saved' AND resource = $1", [SERVER]);
    expect(audit.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(audit.rows)).not.toContain(APP.clientSecret);
  });

  it("lets services from one provider share the app, so it is set up once", async () => {
    const alice = await as("alice");
    const rows = (await alice("GET", "/connections")).json().data as Array<{ serverId: string; setup: string }>;
    expect(rows.find((r) => r.serverId === SHARED)?.setup).toBe("configured");
    const started = await alice("POST", `/connections/${SHARED}/authorize`);
    expect(new URL(started.json().data.authorizationUrl).searchParams.get("client_id")).toBe(APP.clientId);
  });

  it("does not apply to another company", async () => {
    const other = await as("patGlobex");
    expect((await other("GET", "/connections")).json().data[0].setup).toBe("needs_app");
    expect((await other("POST", `/connections/${SERVER}/authorize`)).statusCode).toBe(400);
  });

  it("lets a member connect with one click once it is set up, using the company's app", async () => {
    const bob = await as("bob");
    mock.setNextIdentity("someone");
    const started = await bob("POST", `/connections/${SERVER}/authorize`);
    expect(started.statusCode).toBe(200);
    const url = new URL(started.json().data.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe(APP.clientId);
    const consent = await simulateConsent(url.toString());
    expect((await bob("POST", "/connections/complete", consent)).statusCode).toBe(200);
    expect((await bob("GET", "/connections")).json().data[0].status).toBe("active");
    expect(mock.stats.registrations).toBe(0);
  });

  it("does not need a restart to replace the app, and asks people connected before to reconnect", async () => {
    const alice = await as("alice");
    const bob = await as("bob");
    expect((await bob("GET", "/connections")).json().data[0].status).toBe("active");

    expect((await alice("POST", `/connections/${SERVER}/app`, { ...APP, clientId: "second-client" })).statusCode).toBe(200);
    const started = await alice("POST", `/connections/${SERVER}/authorize`);
    expect(new URL(started.json().data.authorizationUrl).searchParams.get("client_id")).toBe("second-client");

    expect((await bob("GET", "/connections")).json().data[0].status).toBe("needs_reauth");
    expect((await bob("GET", `/connections/${SERVER}/tools`)).statusCode).toBe(409);
    const before = mock.stats.mcpCalls;
    const search = await bob("GET", "/search?q=anything");
    expect(search.json().data.sources).toEqual([]);
    expect(mock.stats.mcpCalls).toBe(before);

    expect((await alice("POST", `/connections/${SERVER}/app`, APP)).statusCode).toBe(200);
    mock.setNextIdentity("someone");
    const again = await bob("POST", `/connections/${SERVER}/authorize`);
    const consent = await simulateConsent(again.json().data.authorizationUrl);
    expect((await bob("POST", "/connections/complete", consent)).statusCode).toBe(200);
    expect((await bob("GET", "/connections")).json().data[0].status).toBe("active");
  });
});
