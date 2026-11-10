// A company's admin turns a service off for everyone, and nothing reads or writes through it (FR-MCP-02).
import { createSecretBox } from "@brain/core";
import type { SearchHit } from "@brain/connectors";
import { applyMigrations, createAppPool, loadMigrations, MIGRATIONS_DIR, seed, setServerAllowed } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { createRegistry } from "@brain/mcp-client";
import { simulateConsent, startMockMcpServer, type MockMcpServer } from "@brain/mcp-client/testing";
import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createJwtVerifier } from "../auth/jwt-verifier.js";
import { createDbUserDirectory } from "../auth/user-directory.js";
import { unusedAgents, unusedAudit, unusedConversations, unusedProposals } from "../test-support/fake-proposals.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { ConnectionsService } from "./connections.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const SERVER = "atlassian";
const ACME = TENANTS.acme.id;

const hit: SearchHit = { serverId: SERVER, externalId: "D-1", title: "Runbook", url: "https://acme.atlassian.net/wiki/1", snippet: "", updatedAt: null };

let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let mock: MockMcpServer;
let keys: TestKeys;
let connections: ConnectionsService;

type Person = "bob" | "alice" | "patGlobex";
async function as(person: Person) {
  const seeded = seedUser(person);
  const token = await keys.sign({ tenant_id: TENANTS[seeded.tenant].id }, { subject: seeded.subject });
  return (method: "GET" | "POST", url: string, payload?: object) =>
    app.getHttpAdapter().getInstance().inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}
const bobScope = { tenantId: ACME, userId: seedUser("bob").id };
const resetSettings = () => owner.query("DELETE FROM tenant_server_settings WHERE tenant_id = ANY($1)", [[ACME, TENANTS.globex.id]]);

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  await resetSettings();
  await owner.query("DELETE FROM mcp_connections WHERE server_id = $1 AND user_id = $2", [SERVER, seedUser("bob").id]);
  await owner.query("DELETE FROM mcp_client_registrations WHERE server_id = $1", [SERVER]);

  mock = await startMockMcpServer({ id: SERVER, issuesByIdentity: { "bob-account": [] } });
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  keys = await createTestKeys();
  connections = new ConnectionsService({
    pool,
    box: createSecretBox(randomBytes(32).toString("base64")),
    registry: createRegistry([mock.definition]),
    adapters: new Map([[SERVER, { serverId: SERVER, search: async () => [hit], readDocuments: async () => new Map([[hit.url, "Full text"]]) }]]),
    client: { redirectUrl: "http://127.0.0.1:3001/oauth/callback", clientName: "Nexus Brain (allow-list test)" },
  });
  app = await createApp({
    logger: createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) }),
    directory: createDbUserDirectory(pool),
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
    connections,
    proposals: unusedProposals,
    audit: unusedAudit,
    conversations: unusedConversations,
    agents: unusedAgents,
    answers: { answer: async () => {} },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const bob = await as("bob");
  mock.setNextIdentity("bob-account");
  const started = await bob("POST", `/connections/${SERVER}/authorize`);
  const consent = await simulateConsent(started.json().data.authorizationUrl);
  expect((await bob("POST", "/connections/complete", consent)).statusCode).toBe(200);
});

beforeEach(resetSettings);

afterAll(async () => {
  await resetSettings();
  await owner?.query("DELETE FROM mcp_connections WHERE server_id = $1 AND user_id = $2", [SERVER, seedUser("bob").id]);
  await owner?.query("DELETE FROM mcp_client_registrations WHERE server_id = $1", [SERVER]);
  await owner?.end();
  connections?.close();
  await app?.close();
  await pool?.end();
  await mock?.close();
});

describe("turning a service off", () => {
  it("lets only an admin change it, and records who did", async () => {
    const bob = await as("bob");
    expect((await bob("POST", `/connections/${SERVER}/allowed`, { allowed: false })).statusCode).toBe(403);
    const alice = await as("alice");
    expect((await alice("POST", `/connections/${SERVER}/allowed`, { allowed: false })).statusCode).toBe(200);
    const audit = await owner.query("SELECT user_id FROM audit_log WHERE action = 'connection.service_turned_off' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0].user_id).toBe(seedUser("alice").id);
    expect((await alice("POST", `/connections/${SERVER}/allowed`, { allowed: "no" })).statusCode).toBe(400);
    expect((await alice("POST", "/connections/unknown-server/allowed", { allowed: false })).statusCode).toBe(404);
  });

  it("stops search, reading and any use of the connection at once, for everyone in that company", async () => {
    const bob = await as("bob");
    expect((await bob("GET", "/search?q=runbook")).json().data.hits).toHaveLength(1);

    await setServerAllowed(pool, { tenantId: ACME, userId: seedUser("alice").id }, SERVER, false);
    expect((await bob("GET", "/search?q=runbook")).json().data).toMatchObject({ hits: [], sources: [] });
    await expect(connections.readItem(bobScope, { serverId: SERVER, externalId: "D-1", url: hit.url })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(connections.readWithSession(bobScope, SERVER, async () => "read")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(connections.writeWithSession(bobScope, SERVER, async () => "wrote")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const documents = await connections.gatherDocuments(bobScope, "runbook", { limit: 5, maxDocuments: 2 });
    expect(documents.hits).toEqual([]);
    expect((await bob("POST", `/connections/${SERVER}/authorize`)).statusCode).toBe(403);
  });

  it("stops work that was already waiting its turn when the service was turned off", async () => {
    // Holds this person's connection, so the search below has to wait for it.
    let release: (() => void) | undefined;
    const holding = connections.writeWithSession(bobScope, SERVER, () => new Promise<void>((resolve) => (release = resolve)));
    // Waits until the session is open and holding the connection, however long that takes here.
    for (let tries = 0; !release && tries < 500; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!release) throw new Error("The connection was never held");
    const waiting = connections.gatherDocuments(bobScope, "runbook", { limit: 5, maxDocuments: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await setServerAllowed(pool, { tenantId: ACME, userId: seedUser("alice").id }, SERVER, false);
    release();
    await holding;
    const result = await waiting;
    expect(result.hits).toEqual([]);
    expect(result.bodies.size).toBe(0);
  });

  it("shows the person their connection as turned off, which they can still remove", async () => {
    await setServerAllowed(pool, { tenantId: ACME, userId: seedUser("alice").id }, SERVER, false);
    const bob = await as("bob");
    const listed = (await bob("GET", "/connections")).json().data as Array<{ serverId: string; status: string; allowed: boolean }>;
    expect(listed.find((c) => c.serverId === SERVER)).toMatchObject({ status: "active", allowed: false });
  });

  it("works again once allowed, with the same connection", async () => {
    const alice = await as("alice");
    await alice("POST", `/connections/${SERVER}/allowed`, { allowed: false });
    await alice("POST", `/connections/${SERVER}/allowed`, { allowed: true });
    const bob = await as("bob");
    expect((await bob("GET", "/search?q=runbook")).json().data.hits).toHaveLength(1);
  });

  it("does not affect another company", async () => {
    await setServerAllowed(pool, { tenantId: TENANTS.globex.id, userId: seedUser("patGlobex").id }, SERVER, false);
    const bob = await as("bob");
    expect((await bob("GET", "/search?q=runbook")).json().data.hits).toHaveLength(1);
    const listed = (await bob("GET", "/connections")).json().data as Array<{ serverId: string; allowed: boolean }>;
    expect(listed.find((c) => c.serverId === SERVER)!.allowed).toBe(true);
  });
});
