// Monthly AI budgets and the spending dashboard (FR-MET-03, FR-MET-04), on the real ledger and agent code.
// Other tests and live checks also spend this month, so limits here are set relative to what is already spent.
import { createSecretBox } from "@brain/core";
import { appendUsage, applyMigrations, createAppPool, loadMigrations, MIGRATIONS_DIR, monthSpend, seed, setPlan, type UserScope } from "@brain/db";
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
import { UsageService } from "./usage.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const FEATURE = "usagetest";

const scopeOf = (person: "bob" | "alice" | "patAcme" | "patGlobex"): UserScope => {
  const user = seedUser(person);
  return { tenantId: TENANTS[user.tenant].id, userId: user.id };
};
const bob = scopeOf("bob");
const alice = scopeOf("alice");
const globex = scopeOf("patGlobex");

let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let keys: TestKeys;
let usage: UsageService;
let agents: AgentsService;
let triggers: TriggersService;

const agentTurn = vi.fn<LlmGateway["agentTurn"]>();
const say = (text: string): AgentTurn => ({ content: [{ type: "text", text }], text, toolCall: null, stopReason: "end_turn" });
const streamAnswer = vi.fn<LlmGateway["streamAnswer"]>(async (_input, onEvent) => {
  onEvent({ type: "text", text: "ok" });
  return { model: "m", stopReason: "end_turn", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
});

const spend = (scope: UserScope, costUsd: number, feature = FEATURE) =>
  appendUsage(pool, scope, { feature, model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
const setBudget = (monthlyLimitUsd: number | null, perPersonLimitUsd: number | null, warnAtPercent = 80) =>
  usage.setBudget(scopeOf("patAcme"), { monthlyLimitUsd, perPersonLimitUsd, warnAtPercent });

async function as(person: "bob" | "alice" | "patAcme") {
  const seeded = seedUser(person);
  const token = await keys.sign({ tenant_id: TENANTS[seeded.tenant].id }, { subject: seeded.subject });
  return (method: "GET" | "POST", url: string, payload?: object) =>
    app.getHttpAdapter().getInstance().inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}

const cleanup = async () => {
  await owner.query("DELETE FROM usage_ledger WHERE feature LIKE 'usagetest%'");
  await owner.query("DELETE FROM tenant_budgets WHERE tenant_id = ANY($1)", [[TENANTS.acme.id, TENANTS.globex.id]]);
  for (const table of ["agent_triggers", "agent_runs", "notifications"]) {
    await owner.query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [[bob.userId, alice.userId]]);
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
  usage = new UsageService({ pool });
  agents = new AgentsService({
    pool,
    box,
    gateway,
    logger,
    documents,
    budget: usage,
    proposals: { targets: async () => [], reject: vi.fn(), proposeForAgent: vi.fn(), get: vi.fn() },
    notify: (scope, notification) => triggers.notify(scope, notification),
  });
  triggers = new TriggersService({ pool, box, logger, agents, assignments: { list: async () => [] }, mentions: { list: async () => [] } });
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
    usage,
    answers: new AnswersService({ pool, box, logger, documents, gateway, budget: usage }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

beforeEach(async () => {
  await agents?.settled();
  await cleanup();
  agentTurn.mockReset();
});

afterAll(async () => {
  await agents?.settled();
  await cleanup();
  await owner?.end();
  await app?.close();
  await pool?.end();
});

describe("who sees spending", () => {
  it("shows the dashboard and limits only to admins, but lets everyone see their own status", async () => {
    const member = await as("bob");
    expect((await member("GET", "/admin/usage")).statusCode).toBe(403);
    expect((await member("POST", "/admin/budget", { monthlyLimitUsd: 1, perPersonLimitUsd: null, warnAtPercent: 80 })).statusCode).toBe(403);
    expect((await member("GET", "/usage/status")).json().data).toEqual({ level: "ok", limit: null, percentUsed: null });
  });

  it("counts only this company's spending, by feature and by person", async () => {
    const admin = await as("patAcme");
    await spend(bob, 2);
    await appendUsage(pool, bob, { feature: FEATURE, model: "unknown-model", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null });
    await spend(globex, 5, "usagetest_globex");
    const { summary } = (await admin("GET", "/admin/usage")).json().data;
    // A call with no known price counts cautiously, so it can never slip past a limit.
    expect(summary.byFeature).toContainEqual({ feature: FEATURE, costUsd: 2.5, calls: 2 });
    expect(summary.unpricedCalls).toBeGreaterThanOrEqual(1);
    expect(summary.byFeature.map((f: { feature: string }) => f.feature)).not.toContain("usagetest_globex");
    expect(summary.byPerson.find((p: { email: string }) => p.email === "bob@acme.example").costUsd).toBeGreaterThanOrEqual(2);
    expect(summary.byPerson.some((p: { userId: string }) => p.userId === globex.userId)).toBe(false);
    expect(summary.byDay.at(-1).day).toBe(new Date().toISOString().slice(0, 10));
  });

  it("saves limits in cents, refuses nonsense, and records who changed them", async () => {
    const admin = await as("patAcme");
    for (const bad of [
      { monthlyLimitUsd: -1, perPersonLimitUsd: null, warnAtPercent: 80 },
      { monthlyLimitUsd: 10, perPersonLimitUsd: null, warnAtPercent: 0 },
      { monthlyLimitUsd: "10", perPersonLimitUsd: null, warnAtPercent: 80 },
      { monthlyLimitUsd: 10, perPersonLimitUsd: null, warnAtPercent: 80, extra: true },
      { monthlyLimitUsd: 0.004, perPersonLimitUsd: null, warnAtPercent: 80 },
    ]) {
      expect((await admin("POST", "/admin/budget", bad)).statusCode).toBe(400);
    }
    const saved = await admin("POST", "/admin/budget", { monthlyLimitUsd: 12.345, perPersonLimitUsd: null, warnAtPercent: 90 });
    expect(saved.json().data).toEqual({ monthlyLimitUsd: 12.35, perPersonLimitUsd: null, warnAtPercent: 90 });
    expect((await admin("GET", "/admin/usage")).json().data.budget).toEqual({ monthlyLimitUsd: 12.35, perPersonLimitUsd: null, warnAtPercent: 90 });
    await admin("POST", "/admin/budget", { monthlyLimitUsd: 20, perPersonLimitUsd: 5, warnAtPercent: 90 });
    const audit = await owner.query("SELECT user_id, meta FROM audit_log WHERE action = 'usage.budget_changed' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]).toMatchObject({
      user_id: seedUser("patAcme").id,
      meta: { before: { monthlyLimitUsd: 12.35, perPersonLimitUsd: null }, after: { monthlyLimitUsd: 20, perPersonLimitUsd: 5 } },
    });
  });
});

describe("limits", () => {
  it("stops a person over their own limit, and nobody else", async () => {
    const [bobSpent, aliceSpent] = await Promise.all([monthSpend(pool, bob), monthSpend(pool, alice)]);
    const limit = Math.ceil(Math.max(bobSpent.person, aliceSpent.person)) + 1;
    await setBudget(null, limit);
    await spend(bob, limit);

    const member = await as("bob");
    expect((await member("GET", "/usage/status")).json().data).toMatchObject({ level: "stop", limit: "person" });
    // Answers stream, so a refusal arrives as the stream's error event, before any paid call.
    streamAnswer.mockClear();
    const refused = await member("POST", "/answers", { q: "anything" });
    expect(refused.body).toContain('"code":"BUDGET_EXCEEDED"');
    expect(refused.body).toContain("You have used your AI budget");
    expect(streamAnswer).not.toHaveBeenCalled();
    expect((await member("POST", "/agent-runs", { goal: "do it" })).statusCode).toBe(402);

    const colleague = await as("alice");
    expect((await colleague("GET", "/usage/status")).json().data.level).toBe("ok");
    const answered = await colleague("POST", "/answers", { q: "anything" });
    expect(answered.body).toContain('"type":"done"');
    expect(streamAnswer).toHaveBeenCalledTimes(1);
  });

  it("warns everyone as the company nears its limit, and stops everyone once it is reached", async () => {
    const { company } = await monthSpend(pool, bob);
    await setBudget(Math.round((company / 0.9) * 100) / 100 + 0.01, null, 80);
    // Members learn the company is near its limit, never how much it has spent.
    expect(await usage.status(alice)).toEqual({ level: "warn", limit: "company", percentUsed: null });
    expect((await (await as("patAcme"))("GET", "/admin/usage")).json().data.companyLevel).toBe("warn");

    await setBudget(0, null);
    await expect(usage.require(alice)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", message: expect.stringContaining("Your company has used") });
  });

  it("stops a running agent at its next step once the budget runs out", async () => {
    const { company } = await monthSpend(pool, bob);
    await setBudget(company + 1, null);
    agentTurn.mockImplementationOnce(async () => {
      await spend(bob, 2); // This step's cost uses up the budget.
      return { content: [{ type: "tool_use", id: "t1", name: "search_documents", input: { query: "x" } }], text: "", toolCall: { id: "t1", name: "search_documents", input: { query: "x" } }, stopReason: "tool_use" };
    });
    agentTurn.mockResolvedValue(say("never reached"));
    const run = await agents.start(bob, "find something");
    await agents.settled();
    expect(agentTurn).toHaveBeenCalledTimes(1);
    expect(await agents.get(bob, run.id)).toMatchObject({ status: "failed", errorCode: "budget_limit" });
  });

  it("stops a running agent when the budget cannot be checked, rather than spend blindly", async () => {
    const blind = new AgentsService({
      pool,
      box: createSecretBox(randomBytes(32).toString("base64")),
      gateway: { streamAnswer, rewriteQuery: vi.fn(), agentTurn },
      logger: createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) }),
      documents: { gatherDocuments: async () => ({ hits: [], sources: [], bodies: new Map() }) },
      budget: { require: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("database down")) },
      proposals: { targets: async () => [], reject: vi.fn(), proposeForAgent: vi.fn(), get: vi.fn() },
    });
    const run = await blind.start(bob, "find something");
    await blind.settled();
    expect(agentTurn).not.toHaveBeenCalled();
    expect(await blind.get(bob, run.id)).toMatchObject({ status: "failed", errorCode: "budget_unavailable" });
  });

  it("shows the person's own status from a short cache, refreshed when an admin changes the limits", async () => {
    expect((await usage.status(bob)).level).toBe("ok");
    await spend(bob, 1);
    await setBudget(null, 0);
    expect(await usage.status(bob)).toEqual({ level: "stop", limit: "person", percentUsed: 100 });
  });

  it("skips automatic agents when the budget is used up, and says so once a day", async () => {
    await triggers.create(bob, { kind: "schedule", goal: "Weekly summary", schedule: "hourly" });
    await setBudget(0, null);
    for (let i = 0; i < 2; i += 1) {
      await owner.query("UPDATE agent_triggers SET next_run_at = now() - interval '1 second' WHERE user_id = $1", [bob.userId]);
      await triggers.tick();
      await agents.settled();
    }
    expect(agentTurn).not.toHaveBeenCalled();
    expect((await triggers.notifications(bob)).items.map((n) => n.kind)).toEqual(["trigger_skipped"]);
  });
});

describe("credits (FR-MET-02, FR-MET-04)", () => {
  let ownerPool: pg.Pool;
  const admin = scopeOf("patAcme");
  const clearCredits = async () => {
    await owner.query("DELETE FROM tenant_plans WHERE tenant_id = ANY($1)", [[TENANTS.acme.id, TENANTS.globex.id]]);
    await owner.query("DELETE FROM credit_topups WHERE tenant_id = ANY($1)", [[TENANTS.acme.id, TENANTS.globex.id]]);
  };
  /** A plan with `spare` credits beyond what this month's metered work has already used. */
  const planWithSpare = async (spare: number) => {
    await setPlan(ownerPool, TENANTS.acme.id, { plan: "team", monthlyCredits: 100_000_000 });
    const used = (await usage.overview(admin)).credits!.usedCredits;
    await setPlan(ownerPool, TENANTS.acme.id, { plan: "team", monthlyCredits: used + spare });
    return used;
  };

  beforeAll(() => {
    ownerPool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
  });
  beforeEach(clearCredits);
  afterAll(async () => {
    await clearCredits();
    await ownerPool.end();
  });

  it("pauses agents once the company's credits are used, while answers keep working", async () => {
    await planWithSpare(10);
    await spend(bob, 0.11, "agent");
    const bobCalls = await as("bob");
    const started = await bobCalls("POST", "/agent-runs", { goal: "do it" });
    expect(started.statusCode).toBe(402);
    expect(started.json().error.message).toMatch(/credits, so agents are paused/);
    expect(agentTurn).not.toHaveBeenCalled();

    const answer = await bobCalls("POST", "/answers", { q: "status?" });
    expect(answer.body).toContain('"type":"done"');
    expect((await bobCalls("GET", "/usage/status")).json().data).toMatchObject({ level: "stop", limit: "credits" });
    await owner.query("DELETE FROM usage_ledger WHERE feature = 'agent' AND cost_usd = 0.11 AND user_id = $1", [bob.userId]);
  });

  it("lets an admin add credits for this month, which resume agents, and shows them on the dashboard", async () => {
    const used = await planWithSpare(0);
    const patCalls = await as("patAcme");
    const added = await patCalls("POST", "/admin/credits", { credits: 250 });
    expect(added.statusCode).toBe(200);
    expect(added.json().data).toMatchObject({ planLabel: "Team", topUpCredits: 250, leftCredits: 250, usedCredits: used });

    agentTurn.mockImplementationOnce(async (_input, _signal, onUsage) => {
      onUsage({ model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimated: false });
      return say("done");
    });
    expect((await (await as("bob"))("POST", "/agent-runs", { goal: "do it" })).statusCode).toBe(201);
    await agents.settled();

    const overview = (await patCalls("GET", "/admin/usage")).json().data;
    expect(overview.credits).toMatchObject({ monthlyCredits: used, topUpCredits: 250, topUps: [expect.objectContaining({ credits: 250, addedByEmail: expect.any(String) })] });
    const audit = await owner.query("SELECT meta FROM audit_log WHERE action = 'usage.credits_added' AND tenant_id = $1 ORDER BY id DESC LIMIT 1", [TENANTS.acme.id]);
    expect(audit.rows[0].meta).toEqual({ credits: 250 });
  });

  it("lets only admins add credits, only whole amounts, and only to a company with a plan", async () => {
    const patCalls = await as("patAcme");
    expect((await patCalls("POST", "/admin/credits", { credits: 100 })).statusCode).toBe(400);
    await planWithSpare(100);
    for (const body of [{ credits: 0 }, { credits: 1.5 }, { credits: 1_000_001 }, { credits: "10" }, { credits: 1, extra: 1 }]) {
      expect((await patCalls("POST", "/admin/credits", body)).statusCode).toBe(400);
    }
    expect((await (await as("bob"))("POST", "/admin/credits", { credits: 100 })).statusCode).toBe(403);
    const topUps = await owner.query("SELECT count(*)::int AS n FROM credit_topups WHERE tenant_id = $1", [TENANTS.acme.id]);
    expect(topUps.rows[0].n).toBe(0);
  });

  it("names a used-up spending limit before used-up credits, as adding credits would not help", async () => {
    await planWithSpare(0);
    await spend(bob, 0.05, "agent");
    const spent = (await monthSpend(pool, bob)).company;
    // Limits keep whole cents, so round down to be sure this one is reached.
    await setBudget(Math.floor(spent * 100) / 100, null);
    const bobCalls = await as("bob");
    expect((await bobCalls("GET", "/usage/status")).json().data).toMatchObject({ level: "stop", limit: "company" });
    const started = await bobCalls("POST", "/agent-runs", { goal: "do it" });
    expect(started.json().error).toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(started.json().error.message).toMatch(/AI budget/);
    await owner.query("DELETE FROM usage_ledger WHERE feature = 'agent' AND cost_usd = 0.05 AND user_id = $1", [bob.userId]);
  });

  it("leaves a company with no plan limited only by its budget", async () => {
    expect((await usage.overview(admin)).credits).toBeNull();
    agentTurn.mockImplementationOnce(async () => say("done"));
    expect((await (await as("bob"))("POST", "/agent-runs", { goal: "do it" })).statusCode).toBe(201);
    await agents.settled();
  });
});
