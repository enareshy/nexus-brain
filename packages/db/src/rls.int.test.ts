// Tenant-isolation leak suite (NFR-SEC-01, FR-ID-03). Run with `pnpm test:leak` after `pnpm infra:up`.
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_DIR } from "./config.js";
import { findUserBySubject } from "./directory.js";
import { applyMigrations, loadMigrations } from "./migrator.js";
import {
  consumePendingAuthorization,
  deleteConnection,
  getConnection,
  listConnections,
  saveConnection,
  savePendingAuthorization,
} from "./connections.js";
import { addAgentStep, cancelAgentRun, claimAgentRun, createAgentRun, getAgentRun, listAgentSteps, saveAgentRun } from "./agent-runs.js";
import { assertRlsEnforced } from "./pool.js";
import { addMessage, createConversation, deleteConversation, getConversation, listMessages, saveFeedback } from "./conversations.js";
import { getBudget, saveBudget, UNPRICED_CALL_USD, usageSummary } from "./budgets.js";
import { addMemory, deleteAllMemories, deleteMemory, listMemories, updateMemory } from "./memories.js";
import { addSkill, deleteSkill, getSkill, listSkills, updateSkill } from "./skills.js";
import { addTopUp, creditMonth, getPlan, setPlan } from "./credits.js";
import { claimProposal, createProposal, getProposal, rejectProposal } from "./proposals.js";
import {
  agentRuns,
  agentSteps,
  auditLog,
  conversations,
  groupMembers,
  mcpConnections,
  mcpServerApps,
  memories,
  skills,
  tenantPlans,
  creditTopups,
  messageFeedback,
  oauthStates,
  tenantBudgets,
  tenants,
  usageLedger,
  users,
  writeProposals,
} from "./schema.js";
import { appendUsage } from "./usage.js";
import { GROUPS, TENANTS, seedUser } from "./seed-data.js";
import { seed } from "./seed.js";
import { getServerApp, listServerApps, saveServerApp } from "./server-apps.js";
import { inScopedTransaction, withTenant, withUser } from "./tenant.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL =
  process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";

const ACME = TENANTS.acme.id;
const GLOBEX = TENANTS.globex.id;

let appPool: pg.Pool;

beforeAll(async () => {
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
    await seed(owner);
  } finally {
    await owner.end();
  }
  appPool = new pg.Pool({ connectionString: APP_URL, max: 2 });
});

afterAll(async () => {
  await appPool?.end();
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    // These rows belong to a seed user, so they would otherwise count towards that user's caps.
    await owner.query("DELETE FROM agent_runs WHERE goal_ciphertext = 'sealed'");
    await owner.query("DELETE FROM write_proposals WHERE server_id = 'leaktest'");
    await owner.query("DELETE FROM mcp_server_apps WHERE server_id = 'leaktest'");
    // A limit left behind would stop real work in the local workspace.
    await owner.query("DELETE FROM tenant_budgets WHERE tenant_id = $1", [ACME]);
    // Test rows would otherwise count against the company's real monthly budget.
    await owner.query("DELETE FROM usage_ledger WHERE feature = 'leaktest'");
  } finally {
    await owner.end();
  }
});

describe("row-level security as brain_app", () => {
  it("connects as a role that cannot bypass RLS", async () => {
    const { rows } = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("returns only the current tenant's users", async () => {
    const rows = await withTenant(appPool, ACME, (db) => db.select().from(users));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([ACME]));
  });

  it("sees only its own tenant row", async () => {
    const rows = await withTenant(appPool, GLOBEX, (db) => db.select().from(tenants));
    expect(rows.map((r) => r.id)).toEqual([GLOBEX]);
  });

  it("returns nothing when no tenant is set (fail closed)", async () => {
    const { rows } = await appPool.query("SELECT id FROM users");
    expect(rows).toEqual([]);
  });

  it("ignores a forged filter for another tenant", async () => {
    const rows = await withTenant(appPool, ACME, (db) =>
      db.select().from(users).where(sql`${users.tenantId} = ${GLOBEX}`),
    );
    expect(rows).toEqual([]);
  });

  it("rejects writing a row into another tenant", async () => {
    await expect(
      withTenant(appPool, ACME, (db) =>
        db.insert(users).values({
          id: "0a000000-0000-4000-8000-0000000000ff",
          tenantId: GLOBEX,
          email: "intruder@example.com",
          displayName: "Intruder",
          role: "member",
          externalSubject: "intruder",
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("does not leak the tenant setting to the next pooled transaction", async () => {
    await withTenant(appPool, ACME, (db) => db.select().from(users));
    const { rows } = await appPool.query("SELECT current_setting('app.tenant_id', true) AS t");
    expect([null, ""]).toContain(rows[0]?.t);
  });

  it("blocks a cross-tenant group membership via composite foreign keys", async () => {
    const acmeGroup = GROUPS.find((g) => g.tenant === "acme");
    await expect(
      withTenant(appPool, ACME, (db) =>
        db.insert(groupMembers).values({
          tenantId: ACME,
          groupId: acmeGroup!.id,
          userId: seedUser("gus").id,
        }),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("keeps the audit log append-only for the app", async () => {
    await withTenant(appPool, ACME, (db) =>
      db.insert(auditLog).values({ tenantId: ACME, action: "test.append" }),
    );
    await expect(
      withTenant(appPool, ACME, (db) => db.delete(auditLog)),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot create tenants", async () => {
    await expect(
      withTenant(appPool, ACME, (db) =>
        db.insert(tenants).values({ id: "0c000000-0000-4000-8000-000000000001", name: "x", region: "us-east-1" }),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("email uniqueness", () => {
  it("treats emails case-insensitively within a tenant", async () => {
    await expect(
      withTenant(appPool, ACME, (db) =>
        db.insert(users).values({
          id: "0a000000-0000-4000-8000-0000000000fe",
          tenantId: ACME,
          email: "PAT@EXAMPLE.COM",
          displayName: "Pat duplicate",
          role: "member",
          externalSubject: "dup-subject",
        }),
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("assertRlsEnforced", () => {
  it("passes for brain_app", async () => {
    await expect(assertRlsEnforced(appPool)).resolves.toBeUndefined();
  });

  it("fails for the owner role", async () => {
    const ownerPool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
    try {
      await expect(assertRlsEnforced(ownerPool)).rejects.toThrow(/row-level security/);
    } finally {
      await ownerPool.end();
    }
  });
});

describe("MCP connections are private to one user", () => {
  const pat = { tenantId: ACME, userId: seedUser("patAcme").id };
  const bob = { tenantId: ACME, userId: seedUser("bob").id };
  const patGlobex = { tenantId: GLOBEX, userId: seedUser("patGlobex").id };

  it("hides a user's connection from a colleague in the same tenant", async () => {
    await saveConnection(appPool, pat, {
      serverId: "leaktest",
      tokensCiphertext: "v1.sealed",
      scopes: null,
      expiresAt: null,
    });
    expect(await getConnection(appPool, pat, "leaktest")).not.toBeNull();
    expect(await getConnection(appPool, bob, "leaktest")).toBeNull();
    expect((await listConnections(appPool, bob)).map((c) => c.serverId)).not.toContain("leaktest");
    expect(await deleteConnection(appPool, bob, "leaktest")).toBe(false);
    expect(await getConnection(appPool, pat, "leaktest")).not.toBeNull();
  });

  it("hides it from the same person in another tenant", async () => {
    expect(await getConnection(appPool, patGlobex, "leaktest")).toBeNull();
  });

  it("returns no connections when only the tenant (no user) is set", async () => {
    const rows = await withTenant(appPool, ACME, (db) => db.select().from(mcpConnections));
    expect(rows).toEqual([]);
  });

  it("rejects writing a connection for another user", async () => {
    await expect(
      withUser(appPool, bob, (db) =>
        db.insert(mcpConnections).values({
          tenantId: ACME,
          userId: pat.userId,
          serverId: "forged",
          status: "active",
          tokensCiphertext: "x",
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  const pending = (stateHash: string, serverId = "leaktest", ttlMs = 60_000) => ({
    stateHash,
    serverId,
    verifierCiphertext: "v1.verifier",
    expiresAt: new Date(Date.now() + ttlMs),
  });

  it("consumes an OAuth state exactly once, for its owner", async () => {
    const stateHash = `hash-${Date.now()}`;
    await savePendingAuthorization(appPool, pat, pending(stateHash));
    expect(await consumePendingAuthorization(appPool, pat, stateHash)).toMatchObject({
      serverId: "leaktest",
    });
    expect(await consumePendingAuthorization(appPool, pat, stateHash)).toBeNull();
  });

  it("does not let another user consume or burn a pending state (login-CSRF)", async () => {
    const stateHash = `csrf-${Date.now()}`;
    await savePendingAuthorization(appPool, pat, pending(stateHash));
    expect(await consumePendingAuthorization(appPool, bob, stateHash)).toBeNull();
    expect(await consumePendingAuthorization(appPool, patGlobex, stateHash)).toBeNull();
    expect(await consumePendingAuthorization(appPool, pat, stateHash)).not.toBeNull();
  });

  it("refuses an expired OAuth state", async () => {
    const stateHash = `expired-${Date.now()}`;
    await savePendingAuthorization(appPool, pat, pending(stateHash, "leaktest", -1_000));
    expect(await consumePendingAuthorization(appPool, pat, stateHash)).toBeNull();
  });

  it("keeps one pending state per user and server, and purges expired ones", async () => {
    await savePendingAuthorization(appPool, pat, pending(`old-${Date.now()}`, "other", -1_000));
    await savePendingAuthorization(appPool, pat, pending(`first-${Date.now()}`));
    const latest = `second-${Date.now()}`;
    await savePendingAuthorization(appPool, pat, pending(latest));
    const rows = await withUser(appPool, pat, (db) => db.select().from(oauthStates));
    expect(rows.map((r) => r.stateHash)).toEqual([latest]);
    await consumePendingAuthorization(appPool, pat, latest);
  });

  it("never shows other users' pending states", async () => {
    await savePendingAuthorization(appPool, pat, pending(`visible-${Date.now()}`));
    const rows = await withUser(appPool, bob, (db) => db.select().from(oauthStates));
    expect(rows.every((r) => r.userId === bob.userId)).toBe(true);
  });

  afterAll(async () => {
    await deleteConnection(appPool, pat, "leaktest");
  });
});

describe("usage ledger", () => {
  const entry = {
    feature: "leaktest",
    model: "m",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.000123,
  };
  const pat = { tenantId: ACME, userId: seedUser("patAcme").id };

  it("is tenant-isolated", async () => {
    await appendUsage(appPool, pat, entry);
    const own = await withTenant(appPool, ACME, (db) => db.select().from(usageLedger));
    expect(own.some((r) => r.feature === "leaktest" && r.costUsd === "0.000123")).toBe(true);
    const other = await withTenant(appPool, GLOBEX, (db) => db.select().from(usageLedger));
    expect(other.some((r) => r.tenantId === ACME)).toBe(false);
  });

  it("is append-only for the app and accepts an unknown cost", async () => {
    await appendUsage(appPool, pat, { ...entry, costUsd: null });
    await expect(withTenant(appPool, ACME, (db) => db.delete(usageLedger))).rejects.toThrow(/permission denied/);
    await expect(withTenant(appPool, ACME, (db) => db.update(usageLedger).set({ model: "x" }))).rejects.toThrow(/permission denied/);
  });

  it("rejects a row for another tenant", async () => {
    await expect(
      withTenant(appPool, GLOBEX, (db) =>
        db.insert(usageLedger).values({ ...entry, tenantId: ACME, userId: pat.userId, costUsd: null }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("demo seed", () => {
  it("refuses to run in production, before touching the database", async () => {
    const query = vi.fn();
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(seed({ query } as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe("conversations are private to one person", () => {
  const bob = { tenantId: ACME, userId: seedUser("bob").id };
  const alice = { tenantId: ACME, userId: seedUser("alice").id };

  it("hides conversations, messages and feedback from a colleague and from other companies", async () => {
    const id = randomUUID();
    const messageId = randomUUID();
    await createConversation(appPool, bob, { id, titleCiphertext: "sealed" });
    await addMessage(appPool, bob, { id: messageId, conversationId: id, role: "assistant", payloadCiphertext: "sealed" });
    expect(
      await saveFeedback(appPool, bob, { conversationId: id, messageId, rating: "up", reasonCiphertext: null }),
    ).toBe(true);

    const others = [alice, { tenantId: GLOBEX, userId: bob.userId }];
    for (const other of others) {
      expect(await getConversation(appPool, other, id)).toBeNull();
      expect(await listMessages(appPool, other, id, 10)).toEqual([]);
      expect(await deleteConversation(appPool, other, id)).toBe(false);
      expect(await saveFeedback(appPool, other, { conversationId: id, messageId, rating: "down", reasonCiphertext: null })).toBe(false);
    }
    const unscoped = await withTenant(appPool, ACME, (db) => db.select().from(conversations));
    expect(unscoped).toEqual([]);
    expect((await listMessages(appPool, bob, id, 10))[0]?.rating).toBe("up");
    expect(await deleteConversation(appPool, bob, id)).toBe(true);
  });

  it("refuses a row whose owner differs from its parent's, even for the database owner", async () => {
    const id = randomUUID();
    const messageId = randomUUID();
    await createConversation(appPool, bob, { id, titleCiphertext: "sealed" });
    await addMessage(appPool, bob, { id: messageId, conversationId: id, role: "assistant", payloadCiphertext: "sealed" });

    // Alice is allowed to write her own rows, so only the keys can stop these.
    await expect(
      addMessage(appPool, alice, { id: randomUUID(), conversationId: id, role: "user", payloadCiphertext: "x" }),
    ).rejects.toThrow(/foreign key/);
    await expect(
      withUser(appPool, alice, (db) =>
        db.insert(messageFeedback).values({ messageId, tenantId: ACME, userId: alice.userId, rating: "down" }),
      ),
    ).rejects.toThrow(/foreign key/);
    await deleteConversation(appPool, bob, id);
  });

  it("rejects writing into someone else's history", async () => {
    await expect(
      withUser(appPool, alice, (db) =>
        db.insert(conversations).values({ id: randomUUID(), tenantId: ACME, userId: bob.userId, titleCiphertext: "x" }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("memories are private to one person", () => {
  const bob = { tenantId: ACME, userId: seedUser("bob").id };
  const alice = { tenantId: ACME, userId: seedUser("alice").id };

  it("hides a person's memories from a colleague and from other companies, who cannot change them either", async () => {
    const id = randomUUID();
    await addMemory(appPool, bob, { id, textCiphertext: "sealed" }, 30);
    for (const other of [alice, { tenantId: GLOBEX, userId: bob.userId }]) {
      expect(await listMemories(appPool, other)).toEqual([]);
      expect(await updateMemory(appPool, other, id, "changed")).toBeNull();
      expect(await deleteMemory(appPool, other, id)).toBe(false);
      expect(await deleteAllMemories(appPool, other)).toBe(0);
    }
    expect(await withTenant(appPool, ACME, (db) => db.select().from(memories))).toEqual([]);
    expect((await listMemories(appPool, bob)).map((m) => m.textCiphertext)).toEqual(["sealed"]);
    await expect(
      withUser(appPool, alice, (db) => db.insert(memories).values({ id: randomUUID(), tenantId: ACME, userId: bob.userId, textCiphertext: "x" })),
    ).rejects.toThrow(/row-level security/);
    expect(await deleteMemory(appPool, bob, id)).toBe(true);
  });

  it("keeps to the limit even when added at the same time", async () => {
    const added = await Promise.all(
      Array.from({ length: 5 }, () => addMemory(appPool, bob, { id: randomUUID(), textCiphertext: "sealed" }, 3)),
    );
    expect(added.filter(Boolean)).toHaveLength(3);
    expect(await deleteAllMemories(appPool, bob)).toBe(3);
  });
});

describe("skills are the owner's, and shared only within their company (FR-AST-08)", () => {
  const bob = { tenantId: ACME, userId: seedUser("bob").id };
  const alice = { tenantId: ACME, userId: seedUser("alice").id };
  const fields = (shared: boolean) => ({ nameCiphertext: "n", instructionsCiphertext: "i", tools: ["search_documents"], shared });

  it("shows a private skill only to its owner, and a shared one to colleagues but never to another company", async () => {
    const mine = randomUUID();
    const shared = randomUUID();
    await addSkill(appPool, bob, { id: mine, ...fields(false) }, 50);
    await addSkill(appPool, bob, { id: shared, ...fields(true) }, 50);
    expect((await listSkills(appPool, bob)).map((s) => s.id).sort()).toEqual([mine, shared].sort());
    expect((await listSkills(appPool, alice)).map((s) => s.id)).toEqual([shared]);
    expect(await getSkill(appPool, alice, mine)).toBeNull();
    expect(await getSkill(appPool, alice, shared)).toMatchObject({ ownerId: bob.userId, ownerName: expect.any(String) });
    const otherCompany = { tenantId: GLOBEX, userId: seedUser("patGlobex").id };
    expect(await listSkills(appPool, otherCompany)).toEqual([]);
    expect(await getSkill(appPool, otherCompany, shared)).toBeNull();
    expect(await withTenant(appPool, GLOBEX, (db) => db.select().from(skills))).toEqual([]);
    await deleteSkill(appPool, bob, mine);
    await deleteSkill(appPool, bob, shared);
  });

  it("lets only the owner change or delete a skill, even a shared one, and nobody add one as someone else", async () => {
    const id = randomUUID();
    await addSkill(appPool, bob, { id, ...fields(true) }, 50);
    expect(await updateSkill(appPool, alice, id, { ...fields(true), instructionsCiphertext: "evil" })).toBe(false);
    expect(await deleteSkill(appPool, alice, id)).toBe(false);
    await expect(
      withUser(appPool, alice, (db) => db.update(skills).set({ instructionsCiphertext: "evil" }).where(eq(skills.id, id)).returning({ id: skills.id })),
    ).resolves.toEqual([]);
    await expect(
      withUser(appPool, alice, (db) => db.insert(skills).values({ id: randomUUID(), tenantId: ACME, userId: bob.userId, ...fields(true) })),
    ).rejects.toThrow(/row-level security/);
    expect((await getSkill(appPool, bob, id))?.instructionsCiphertext).toBe("i");
    expect(await updateSkill(appPool, bob, id, { ...fields(false), instructionsCiphertext: "new" })).toBe(true);
    expect(await getSkill(appPool, alice, id)).toBeNull();
    expect(await deleteSkill(appPool, bob, id)).toBe(true);
  });

  it("keeps to the limit even when added at the same time", async () => {
    const added = await Promise.all(Array.from({ length: 5 }, () => addSkill(appPool, bob, { id: randomUUID(), ...fields(false) }, 3)));
    expect(added.filter(Boolean)).toHaveLength(3);
    for (const skill of await listSkills(appPool, bob)) await deleteSkill(appPool, bob, skill.id);
  });
});

describe("budgets and spending belong to one company", () => {
  const acmeAdmin = { tenantId: ACME, userId: seedUser("patAcme").id };
  const globexAdmin = { tenantId: GLOBEX, userId: seedUser("patGlobex").id };

  it("keeps a company's limits and spending from another company, which cannot set them either", async () => {
    await saveBudget(appPool, acmeAdmin, { monthlyLimitUsd: 7, perPersonLimitUsd: null, warnAtPercent: 80 });
    expect(await getBudget(appPool, GLOBEX)).toBeNull();
    expect((await getBudget(appPool, ACME))?.monthlyLimitUsd).toBe(7);
    await expect(
      withTenant(appPool, GLOBEX, (db) =>
        db.insert(tenantBudgets).values({ tenantId: ACME, monthlyLimitUsd: "0", warnAtPercent: 80, updatedBy: globexAdmin.userId }),
      ),
    ).rejects.toThrow(/row-level security/);
    const summary = await usageSummary(appPool, GLOBEX);
    expect(summary.byPerson.every((p) => p.userId !== seedUser("bob").id)).toBe(true);
  });
});

describe("agent runs are private to one person", () => {
  const bob = { tenantId: ACME, userId: seedUser("bob").id };
  const alice = { tenantId: ACME, userId: seedUser("alice").id };
  const newRun = (id: string) => ({
    id,
    goalCiphertext: "sealed",
    stateCiphertext: "sealed",
    deadlineAt: new Date(Date.now() + 60_000),
  });
  const limits = { maxWorking: 100, maxRecent: 100, recentSince: new Date(0) };
  const step = (runId: string) => ({ runId, seq: 1, toolName: "t", argsHash: "h", outcome: "ok", detailCiphertext: "sealed" });

  const progress = { stateCiphertext: "x", status: "completed" as const, turnCount: 1, costUsd: 0, leaseMs: null };

  it("hides runs and steps from a colleague and from other companies, who cannot take or cancel them", async () => {
    const id = randomUUID();
    await createAgentRun(appPool, bob, newRun(id), limits);
    await addAgentStep(appPool, bob, step(id));

    for (const other of [alice, { tenantId: GLOBEX, userId: bob.userId }]) {
      expect(await getAgentRun(appPool, other, id)).toBeNull();
      expect(await listAgentSteps(appPool, other, id)).toEqual([]);
      expect(await claimAgentRun(appPool, other, id, 60_000)).toBeNull();
      expect(await cancelAgentRun(appPool, other, id)).toBe(false);
    }
    expect(await withTenant(appPool, ACME, (db) => db.select().from(agentRuns))).toEqual([]);
    expect(await withTenant(appPool, ACME, (db) => db.select().from(agentSteps))).toEqual([]);
    expect(await listAgentSteps(appPool, bob, id)).toHaveLength(1);
    expect(await cancelAgentRun(appPool, bob, id)).toBe(true);
  });

  it("refuses a step on someone else's run, and writing a run for someone else", async () => {
    const id = randomUUID();
    await createAgentRun(appPool, bob, newRun(id), limits);
    // Alice is allowed to write her own rows, so only the key can stop this.
    await expect(addAgentStep(appPool, alice, step(id))).rejects.toThrow(/foreign key/);
    await expect(
      withUser(appPool, alice, (db) =>
        db.insert(agentRuns).values({ ...newRun(randomUUID()), status: "running", tenantId: ACME, userId: bob.userId }),
      ),
    ).rejects.toThrow(/row-level security/);
    await cancelAgentRun(appPool, bob, id);
  });

  it("lets only one caller hold a run, and none once it has finished", async () => {
    const id = randomUUID();
    await createAgentRun(appPool, bob, newRun(id), limits);
    const claims = await Promise.all([claimAgentRun(appPool, bob, id, 60_000), claimAgentRun(appPool, bob, id, 60_000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await cancelAgentRun(appPool, bob, id);
    expect(await claimAgentRun(appPool, bob, id, 60_000)).toBeNull();
    expect(await saveAgentRun(appPool, bob, id, claims.find(Boolean)!.leaseToken!, progress)).toBe(false);
  });

  it("stops a worker whose lease ran out and was taken over from overwriting the new one", async () => {
    const id = randomUUID();
    await createAgentRun(appPool, bob, newRun(id), limits);
    const first = await claimAgentRun(appPool, bob, id, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await claimAgentRun(appPool, bob, id, 60_000);
    expect(second).not.toBeNull();
    expect(await saveAgentRun(appPool, bob, id, first!.leaseToken!, progress)).toBe(false);
    expect(await saveAgentRun(appPool, bob, id, second!.leaseToken!, progress)).toBe(true);
  });

  it("applies the working and hourly limits", async () => {
    const carol = { tenantId: ACME, userId: seedUser("alice").id };
    const one = { maxWorking: 1, maxRecent: 100, recentSince: new Date(0) };
    const id = randomUUID();
    expect(await createAgentRun(appPool, carol, newRun(id), one)).toBe("created");
    expect(await createAgentRun(appPool, carol, newRun(randomUUID()), one)).toBe("too_many_working");
    await cancelAgentRun(appPool, carol, id);
    expect(await createAgentRun(appPool, carol, newRun(randomUUID()), { ...one, maxRecent: 1 })).toBe("too_many_recent");
  });
});

describe("server apps belong to one company", () => {
  const alice = { tenantId: ACME, userId: seedUser("alice").id };
  const app = { clientId: "leaktest-id", secretCiphertext: "sealed" };

  it("hides a company's app from another company", async () => {
    await saveServerApp(appPool, alice, "leaktest", app);
    expect(await getServerApp(appPool, ACME, "leaktest")).toEqual(app);
    expect(await getServerApp(appPool, GLOBEX, "leaktest")).toBeNull();
    expect((await listServerApps(appPool, GLOBEX)).map((a) => a.serverId)).not.toContain("leaktest");
  });

  it("returns nothing when no tenant is set, and rejects writing into another company", async () => {
    await saveServerApp(appPool, alice, "leaktest", app);
    const unscoped = await inScopedTransaction(appPool, {}, (db) => db.select().from(mcpServerApps));
    expect(unscoped).toEqual([]);
    await expect(
      withTenant(appPool, GLOBEX, (db) =>
        db.insert(mcpServerApps).values({ ...app, tenantId: ACME, serverId: "leaktest2", updatedBy: alice.userId }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot be deleted by the app", async () => {
    await expect(withTenant(appPool, ACME, (db) => db.delete(mcpServerApps))).rejects.toThrow(/permission denied/);
  });
});

describe("write proposals are private and cannot change after creation", () => {
  const pat = { tenantId: ACME, userId: seedUser("patAcme").id };
  const bob = { tenantId: ACME, userId: seedUser("bob").id };
  const proposal = (id: string, expiresAt = new Date(Date.now() + 60_000)) => ({
    id,
    serverId: "leaktest",
    action: "create_issue",
    toolName: "create",
    toolClass: "write" as const,
    args: { summary: "x" },
    argsHash: "hash",
    siteOrigin: "https://acme.atlassian.net",
    expiresAt,
  });

  it("hides a proposal from a colleague, who cannot approve or reject it", async () => {
    const id = randomUUID();
    await createProposal(appPool, pat, proposal(id));
    expect(await getProposal(appPool, bob, id)).toBeNull();
    expect(await claimProposal(appPool, bob, id, "hash", 10)).toBeNull();
    expect(await rejectProposal(appPool, bob, id)).toBeNull();
    expect((await getProposal(appPool, pat, id))?.status).toBe("pending");
  });

  it("hides it from the same user id in another tenant", async () => {
    const id = randomUUID();
    await createProposal(appPool, pat, proposal(id));
    expect(await getProposal(appPool, { tenantId: GLOBEX, userId: pat.userId }, id)).toBeNull();
  });

  it("rejects creating a proposal for another user", async () => {
    await expect(
      withUser(appPool, bob, (db) =>
        db.insert(writeProposals).values({ ...proposal(randomUUID()), tenantId: ACME, userId: pat.userId, status: "pending" }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("does not let the app change the arguments, tool or hash, or delete a proposal", async () => {
    const id = randomUUID();
    await createProposal(appPool, pat, proposal(id));
    const update = (set: Partial<typeof writeProposals.$inferInsert>) =>
      withUser(appPool, pat, (db) => db.update(writeProposals).set(set).where(eq(writeProposals.id, id)));
    await expect(update({ args: { summary: "changed" } })).rejects.toThrow(/permission denied/);
    await expect(update({ toolName: "other" })).rejects.toThrow(/permission denied/);
    await expect(update({ argsHash: "other" })).rejects.toThrow(/permission denied/);
    await expect(withUser(appPool, pat, (db) => db.delete(writeProposals))).rejects.toThrow(/permission denied/);
  });

  it("claims once, only with the approved hash, and never after expiry", async () => {
    const id = randomUUID();
    await createProposal(appPool, pat, proposal(id));
    expect(await claimProposal(appPool, pat, id, "changed", 10)).toBeNull();
    const claims = await Promise.all([
      claimProposal(appPool, pat, id, "hash", 10),
      claimProposal(appPool, pat, id, "hash", 10),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    const expired = randomUUID();
    await createProposal(appPool, pat, proposal(expired, new Date(Date.now() - 1_000)));
    expect(await claimProposal(appPool, pat, expired, "hash", 10)).toBeNull();
  });
});

describe("findUserBySubject", () => {
  it("resolves a subject with fresh group memberships", async () => {
    const pat = seedUser("patAcme");
    const user = await findUserBySubject(appPool, ACME, pat.subject);
    expect(user).toEqual({
      userId: pat.id,
      tenantId: ACME,
      role: "admin",
      groupIds: [GROUPS[0].id],
    });
  });

  it("does not resolve a subject from another tenant", async () => {
    const user = await findUserBySubject(appPool, GLOBEX, seedUser("patAcme").subject);
    expect(user).toBeNull();
  });

  it("returns no groups for a guest without memberships", async () => {
    const user = await findUserBySubject(appPool, ACME, seedUser("gina").subject);
    expect(user?.groupIds).toEqual([]);
    expect(user?.role).toBe("guest");
  });
});

describe("plans and credits belong to one company (FR-MET-02)", () => {
  const acmeAdmin = { tenantId: ACME, userId: seedUser("patAcme").id };
  let ownerPool: pg.Pool;

  beforeAll(() => {
    ownerPool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
  });
  afterAll(async () => {
    await ownerPool.query("DELETE FROM tenant_plans WHERE tenant_id = ANY($1)", [[ACME, GLOBEX]]);
    await ownerPool.query("DELETE FROM credit_topups WHERE tenant_id = ANY($1)", [[ACME, GLOBEX]]);
    await ownerPool.query("DELETE FROM usage_ledger WHERE feature LIKE 'credit-test%'");
    await ownerPool.end();
  });

  it("lets only an operator set a plan, and keeps plans and top-ups from other companies", async () => {
    await expect(
      withTenant(appPool, ACME, (db) => db.insert(tenantPlans).values({ tenantId: ACME, plan: "business", monthlyCredits: 999_999 })),
    ).rejects.toThrow(/permission denied/);
    await setPlan(ownerPool, ACME, { plan: "team", monthlyCredits: 20_000 });
    expect(await getPlan(appPool, ACME)).toEqual({ plan: "team", monthlyCredits: 20_000 });
    expect(await getPlan(appPool, GLOBEX)).toBeNull();
    await expect(withTenant(appPool, ACME, (db) => db.update(tenantPlans).set({ monthlyCredits: 1 }))).rejects.toThrow(/permission denied/);

    await addTopUp(appPool, acmeAdmin, { id: randomUUID(), credits: 500 });
    expect(await withTenant(appPool, GLOBEX, (db) => db.select().from(creditTopups))).toEqual([]);
    await expect(
      withTenant(appPool, GLOBEX, (db) => db.insert(creditTopups).values({ id: randomUUID(), tenantId: ACME, credits: 1, addedBy: acmeAdmin.userId })),
    ).rejects.toThrow(/row-level security/);
    await expect(withTenant(appPool, ACME, (db) => db.delete(creditTopups))).rejects.toThrow(/permission denied/);
    const audit = await withTenant(appPool, ACME, (db) =>
      db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.action, "usage.credits_added")),
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it("counts only agent work against credits, never chat, even on another model", async () => {
    const before = (await creditMonth(appPool, ACME))!.meteredUsd;
    const call = (feature: string, model: string, costUsd: number | null) =>
      appendUsage(appPool, acmeAdmin, { feature, model, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
    await call("credit-test-answer", "claude-opus-5-5", 5);
    await call("agent", "claude-opus-5-5", 0.25);
    await call("agent_estimated", "claude-opus-5-5", null);
    await call("credit-test-answer", "claude-opus-4-8", 1);
    const month = (await creditMonth(appPool, ACME))!;
    expect(month.meteredUsd - before).toBeCloseTo(0.25 + UNPRICED_CALL_USD);
    expect(month.topUps.length).toBeGreaterThan(0);
    expect(month.topUps[0]).toMatchObject({ credits: 500, addedByEmail: expect.any(String) });
    expect(await creditMonth(appPool, GLOBEX)).toBeNull();
    await ownerPool.query("DELETE FROM usage_ledger WHERE tenant_id = $1 AND feature LIKE 'agent%' AND created_at > now() - interval '1 minute'", [ACME]);
  });
});
