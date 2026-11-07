// A person's data export and their company's retention settings (FR-ADM-03, NFR-COMP-01), on real Postgres.
import { createSecretBox } from "@brain/core";
import { applyMigrations, createAppPool, loadMigrations, MIGRATIONS_DIR, seed } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createJwtVerifier } from "../auth/jwt-verifier.js";
import { createDbUserDirectory } from "../auth/user-directory.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { MemoryService } from "../memory/memory.service.js";
import { SkillsService } from "../skills/skills.service.js";
import { unusedAudit, unusedConversations, unusedProposals } from "../test-support/fake-proposals.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { createPgRateLimiter } from "../common/rate-limiter.js";
import { ExportService, type ExportSources } from "./export.service.js";
import { RetentionService } from "./retention.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const SECRET_MEMORY = "I prefer short answers about the Falcon project";

let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let keys: TestKeys;
let conversations: ConversationsService;
let secondServer: { exports: ExportService; pool: pg.Pool };

type Person = "bob" | "alice" | "patAcme";
const scopeOf = (person: Person) => ({ tenantId: TENANTS.acme.id, userId: seedUser(person).id });

async function as(person: Person) {
  const seeded = seedUser(person);
  const token = await keys.sign({ tenant_id: TENANTS[seeded.tenant].id }, { subject: seeded.subject });
  return (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.getHttpAdapter().getInstance().inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}

const people = () => [seedUser("bob").id, seedUser("alice").id];
const cleanup = async () => {
  await owner.query("DELETE FROM tenant_retention WHERE tenant_id = $1", [TENANTS.acme.id]);
  await owner.query("DELETE FROM rate_limit_uses WHERE user_id = ANY($1)", [people()]);
  for (const table of ["memories", "skills", "conversations"]) await owner.query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [people()]);
};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  await cleanup();
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  keys = await createTestKeys();
  const box = createSecretBox(randomBytes(32).toString("base64"));
  const logger = createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) });
  conversations = new ConversationsService({ pool, box });
  const memory = new MemoryService({ pool, box, logger });
  const skills = new SkillsService({ pool, box, logger });
  const none = { list: async () => [] };
  const sources: ExportSources = {
    conversations,
    memories: memory,
    skills,
    agentRuns: { exportAll: async () => [] },
    automaticAgents: none,
    changes: { exportAll: async () => [] },
    connections: { list: async () => [{ serverId: "atlassian", displayName: "Atlassian", status: "connected", lastUsedAt: null, setup: "ready" }] as never },
  };
  const exports = new ExportService({ pool, logger, sources, limiter: createPgRateLimiter(pool) });
  // Another API server, with its own connections, sharing the same database.
  const otherPool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  secondServer = { pool: otherPool, exports: new ExportService({ pool: otherPool, logger, sources, limiter: createPgRateLimiter(otherPool) }) };
  app = await createApp({
    logger,
    directory: createDbUserDirectory(pool),
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
    connections: { list: async () => [] } as never,
    proposals: unusedProposals,
    audit: unusedAudit,
    conversations: unusedConversations,
    agents: { list: async () => [] } as never,
    answers: { answer: async () => {} },
    memory,
    skills,
    data: { retention: new RetentionService({ pool, logger }), exports },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await cleanup();
  await owner?.end();
  await app?.close();
  await pool?.end();
  await secondServer?.pool.end();
});

describe("exporting your own data (FR-ADM-03)", () => {
  it("gives a person everything that is theirs, readable, and nothing of a colleague's or any secret", async () => {
    const bob = await as("bob");
    const alice = await as("alice");
    expect((await bob("POST", "/memories", { text: SECRET_MEMORY })).statusCode).toBe(200);
    const skill = { name: "Bob's skill", instructions: "Do it Bob's way", tools: ["search_documents"], shared: true };
    expect((await bob("POST", "/skills", skill)).statusCode).toBe(201);
    expect((await alice("POST", "/skills", { ...skill, name: "Alice's shared skill" })).statusCode).toBe(201);
    expect((await alice("POST", "/memories", { text: "Alice's private memory" })).statusCode).toBe(200);
    const started = await conversations.begin(scopeOf("bob"), undefined, "when does Falcon launch?");
    await conversations.saveAnswer(scopeOf("bob"), started.conversationId, {
      parts: [{ kind: "text", text: "In May." }],
      hits: [],
      outcome: "answered",
      grounded: false,
      truncatedDocuments: 0,
    });

    const res = await bob("GET", "/me/export");
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.truncated).toBe(false);
    expect(data.profile).toMatchObject({ email: seedUser("bob").email, role: expect.any(String) });
    expect(data.memories.map((m: { text: string }) => m.text)).toEqual([SECRET_MEMORY]);
    expect(data.skills.map((s: { name: string }) => s.name)).toEqual(["Bob's skill"]);
    expect(data.conversations[0]).toMatchObject({ title: "when does Falcon launch?" });
    expect(data.conversations[0].messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(data.connections).toEqual([{ serverId: "atlassian", displayName: "Atlassian", status: "connected", lastUsedAt: null }]);
    expect(res.body).not.toMatch(/Alice's|token|ciphertext/i);

    const audit = await owner.query("SELECT meta::text AS meta FROM audit_log WHERE action = 'data.exported' AND user_id = $1 ORDER BY id DESC LIMIT 1", [seedUser("bob").id]);
    expect(audit.rows[0].meta).not.toContain("Falcon");
    expect((await bob("GET", "/me/export")).statusCode).toBe(429);
    // The limit is the person's, not one server's.
    await expect(secondServer.exports.exportFor(scopeOf("bob"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(secondServer.exports.exportFor(scopeOf("alice"))).resolves.toMatchObject({ truncated: false });
  });

  it("does not count an export that failed, so it can be tried again at once", async () => {
    await owner.query("DELETE FROM rate_limit_uses WHERE user_id = ANY($1)", [people()]);
    const failing = new ExportService({
      pool,
      logger: { error: () => {} },
      limiter: createPgRateLimiter(pool),
      sources: { ...({} as ExportSources), memories: { list: async () => { throw new Error("down"); } } } as ExportSources,
    });
    await expect(failing.exportFor(scopeOf("bob"))).rejects.toThrow();
    await expect(secondServer.exports.exportFor(scopeOf("bob"))).resolves.toMatchObject({ truncated: false });
  });
});

describe("how long data is kept (FR-ADM-03)", () => {
  it("lets everyone see the settings and only an admin change them, within bounds", async () => {
    const bob = await as("bob");
    const pat = await as("patAcme");
    expect((await bob("GET", "/data/retention")).json().data).toEqual({ conversationDays: null, agentRunDays: null });
    expect((await bob("POST", "/admin/retention", { conversationDays: 1, agentRunDays: null })).statusCode).toBe(403);
    for (const body of [{ conversationDays: 0, agentRunDays: null }, { conversationDays: 3651, agentRunDays: null }, { conversationDays: 1.5, agentRunDays: null }, { conversationDays: 30 }, { conversationDays: 30, agentRunDays: null, extra: 1 }]) {
      expect((await pat("POST", "/admin/retention", body)).statusCode).toBe(400);
    }
    const saved = await pat("POST", "/admin/retention", { conversationDays: 90, agentRunDays: 30 });
    expect(saved.json().data).toEqual({ conversationDays: 90, agentRunDays: 30 });
    expect((await bob("GET", "/data/retention")).json().data).toEqual({ conversationDays: 90, agentRunDays: 30 });
  });
});
