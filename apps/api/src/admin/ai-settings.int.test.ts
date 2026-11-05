// A company's AI settings (FR-ADM-02, FR-LLM-07), on the real database, agent and answer code.
import { createSecretBox } from "@brain/core";
import { applyMigrations, createAppPool, DEFAULT_AI_SETTINGS, loadMigrations, MIGRATIONS_DIR, seed, type AiSettings, type UserScope } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import type { AgentTurn, LlmGateway } from "@brain/llm-gateway";
import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsService } from "../agents/agents.service.js";
import { TriggersService } from "../agents/triggers.service.js";
import { AnswersService } from "../answers/answers.service.js";
import { createApp } from "../app.js";
import { createJwtVerifier } from "../auth/jwt-verifier.js";
import { createDbUserDirectory } from "../auth/user-directory.js";
import { unusedAudit, unusedConversations, unusedProposals } from "../test-support/fake-proposals.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { AiSettingsService } from "./ai-settings.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";

const scopeOf = (person: "bob" | "patAcme"): UserScope => {
  const user = seedUser(person);
  return { tenantId: TENANTS[user.tenant].id, userId: user.id };
};
const bob = scopeOf("bob");
const patAcme = scopeOf("patAcme");

let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let keys: TestKeys;
let settings: AiSettingsService;
let agents: AgentsService;
let triggers: TriggersService;

const agentTurn = vi.fn<LlmGateway["agentTurn"]>();
const say = (text: string): AgentTurn => ({ content: [{ type: "text", text }], text, toolCall: null, stopReason: "end_turn" });
const search: AgentTurn = {
  content: [{ type: "tool_use", id: "t1", name: "search_documents", input: { query: "x" } }],
  text: "",
  toolCall: { id: "t1", name: "search_documents", input: { query: "x" } },
  stopReason: "tool_use",
};
const streamAnswer = vi.fn<LlmGateway["streamAnswer"]>(async (_input, onEvent) => {
  onEvent({ type: "text", text: "ok" });
  return { model: "m", stopReason: "end_turn", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
});
const change = (patch: Partial<AiSettings>) => settings.set(patAcme, { ...DEFAULT_AI_SETTINGS, ...patch });

async function as(person: "bob" | "patAcme") {
  const seeded = seedUser(person);
  const token = await keys.sign({ tenant_id: TENANTS[seeded.tenant].id }, { subject: seeded.subject });
  return (method: "GET" | "POST", url: string, payload?: object) =>
    app.getHttpAdapter().getInstance().inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}

const cleanup = async () => {
  await owner.query("DELETE FROM tenant_ai_settings");
  for (const table of ["agent_triggers", "agent_runs", "notifications"]) {
    await owner.query(`DELETE FROM ${table} WHERE user_id = $1`, [bob.userId]);
  }
};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  keys = await createTestKeys();
  const box = createSecretBox(randomBytes(32).toString("base64"));
  const logger = createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) });
  const gateway: LlmGateway = { streamAnswer, rewriteQuery: vi.fn(async () => []), agentTurn };
  const documents = {
    gatherDocuments: async () => ({
      hits: [{ serverId: "s", externalId: "D-1", title: "Doc", url: "https://acme.example/d1", snippet: "text", updatedAt: null, score: 1 }],
      sources: [],
      bodies: new Map([["https://acme.example/d1", "text"]]),
    }),
  };
  settings = new AiSettingsService({ pool });
  agents = new AgentsService({
    pool,
    box,
    gateway,
    logger,
    documents,
    aiSettings: settings,
    proposals: { targets: async () => [], reject: vi.fn(), proposeForAgent: vi.fn(), get: vi.fn() },
    notify: (scope, notification) => triggers.notify(scope, notification),
  });
  triggers = new TriggersService({ pool, box, logger, agents, aiSettings: settings, assignments: { list: async () => [] }, mentions: { list: async () => [] } });
  app = await createApp({
    logger,
    directory: createDbUserDirectory(pool),
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
    connections: { list: async () => [] } as never,
    proposals: unusedProposals,
    audit: unusedAudit,
    conversations: unusedConversations,
    agents,
    aiSettings: settings,
    answers: new AnswersService({ pool, box, logger, documents, gateway, aiSettings: settings }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

beforeEach(async () => {
  await agents?.settled();
  await cleanup();
  agentTurn.mockReset();
  streamAnswer.mockClear();
});

afterAll(async () => {
  await agents?.settled();
  await cleanup();
  await owner?.query("DELETE FROM audit_log WHERE action = 'admin.ai_settings_changed'");
  await owner?.end();
  await app?.close();
  await pool?.end();
});

describe("who can see and change the settings", () => {
  it("shows everyone the settings, and lets only an admin change them, within the allowed values", async () => {
    const member = await as("bob");
    expect((await member("GET", "/ai-settings")).json().data).toEqual(DEFAULT_AI_SETTINGS);
    const cautious = { ...DEFAULT_AI_SETTINGS, modelChoice: "standard", automaticRunsPerDay: 2 };
    expect((await member("POST", "/admin/ai-settings", cautious)).statusCode).toBe(403);

    const admin = await as("patAcme");
    for (const bad of [{ ...cautious, automaticRunsPerDay: 11 }, { ...cautious, automaticRunsPerDay: 0 }, { ...cautious, modelChoice: "huge" }, { ...cautious, extra: 1 }, {}]) {
      expect((await admin("POST", "/admin/ai-settings", bad)).statusCode).toBe(400);
    }
    expect((await admin("POST", "/admin/ai-settings", cautious)).json().data).toEqual(cautious);
    expect((await member("GET", "/ai-settings")).json().data).toEqual(cautious);
  });
});

describe("the model", () => {
  it("answers with the company's chosen model from the next question on", async () => {
    const member = await as("bob");
    await member("POST", "/answers", { q: "anything" });
    await change({ modelChoice: "standard" });
    await member("POST", "/answers", { q: "anything" });
    expect(streamAnswer.mock.calls.map(([input]) => input.modelChoice)).toEqual(["premium", "standard"]);
  });

  it("runs agents on the company's chosen model, read again for every step", async () => {
    agentTurn.mockImplementationOnce(async () => {
      await change({ modelChoice: "standard" });
      return search;
    });
    agentTurn.mockResolvedValue(say("done"));
    const run = await agents.start(bob, "find something");
    await agents.settled();
    expect(agentTurn.mock.calls.map(([input]) => input.modelChoice)).toEqual(["premium", "standard"]);
    expect(await agents.get(bob, run.id)).toMatchObject({ status: "completed" });
  });
});

describe("turning agents off", () => {
  it("refuses new runs, and stops a run already going before its next step", async () => {
    await change({ agentsEnabled: false });
    expect((await (await as("bob"))("POST", "/agent-runs", { goal: "do it" })).statusCode).toBe(403);

    await change({});
    agentTurn.mockImplementationOnce(async () => {
      await change({ agentsEnabled: false });
      return search;
    });
    agentTurn.mockResolvedValue(say("never reached"));
    const run = await agents.start(bob, "find something");
    await agents.settled();
    expect(agentTurn).toHaveBeenCalledTimes(1);
    expect(await agents.get(bob, run.id)).toMatchObject({ status: "failed", errorCode: "agents_off" });
  });

  it("stops a run when the settings cannot be read, rather than carry on unchecked", async () => {
    const blind = new AgentsService({
      pool,
      box: createSecretBox(randomBytes(32).toString("base64")),
      gateway: { streamAnswer, rewriteQuery: vi.fn(), agentTurn },
      logger: createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) }),
      documents: { gatherDocuments: async () => ({ hits: [], sources: [], bodies: new Map() }) },
      aiSettings: { get: vi.fn().mockResolvedValueOnce(DEFAULT_AI_SETTINGS).mockRejectedValue(new Error("database down")) },
      proposals: { targets: async () => [], reject: vi.fn(), proposeForAgent: vi.fn(), get: vi.fn() },
    });
    const run = await blind.start(bob, "find something");
    await blind.settled();
    expect(agentTurn).not.toHaveBeenCalled();
    expect(await blind.get(bob, run.id)).toMatchObject({ status: "failed", errorCode: "settings_unavailable" });
  });
});

describe("automatic agents", () => {
  const due = async () => {
    await owner.query("UPDATE agent_triggers SET next_run_at = now() - interval '1 second' WHERE user_id = $1", [bob.userId]);
    await triggers.tick();
    await agents.settled();
  };
  const runCount = async () => Number((await owner.query("SELECT count(*) AS n FROM agent_runs WHERE user_id = $1", [bob.userId])).rows[0].n);

  it("skip quietly while turned off, while people can still start agents themselves", async () => {
    agentTurn.mockResolvedValue(say("done"));
    await triggers.create(bob, { kind: "schedule", goal: "Weekly summary", schedule: "hourly" });
    await change({ automaticAgentsEnabled: false });
    await due();
    expect(await runCount()).toBe(0);
    expect((await triggers.notifications(bob)).items).toEqual([]);
    await expect(agents.start(bob, "by hand")).resolves.toMatchObject({ status: "running" });
    await expect(agents.start(bob, "automatic", { triggerId: randomBytes(4).toString("hex") })).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { limit: "automatic_off" },
    });

    await agents.settled();
    await change({});
    await due();
    expect(await runCount()).toBe(2);
  });

  it("are held to the company's lower daily limit", async () => {
    agentTurn.mockResolvedValue(say("done"));
    await change({ automaticRunsPerDay: 1 });
    await triggers.create(bob, { kind: "schedule", goal: "Weekly summary", schedule: "hourly" });
    await due();
    await due();
    expect(await runCount()).toBe(1);
    expect((await triggers.notifications(bob)).items.map((n) => n.kind).sort()).toEqual(["run_finished", "trigger_skipped"]);
  });
});
