// Keeping and removing data (FR-ADM-03, NFR-COMP-01): expiry by company setting, and deleting a company.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./config.js";
import { applyMigrations, loadMigrations } from "./migrator.js";
import { getRetention, purgeExpired, saveRetention } from "./retention.js";
import { seed } from "./seed.js";
import { seedUser, TENANTS } from "./seed-data.js";
import { deleteTenant } from "./tenant-delete.js";
import { withTenant } from "./tenant.js";
import { tenantRetention } from "./schema.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const ACME = TENANTS.acme.id;
const GLOBEX = TENANTS.globex.id;
const bob = seedUser("bob");
const globexPat = seedUser("patGlobex");
const acmeAdmin = { tenantId: ACME, userId: seedUser("patAcme").id };

let owner: pg.Client;
let ownerPool: pg.Pool;
let appPool: pg.Pool;

async function conversation(tenantId: string, userId: string, daysOld: number): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO conversations (id, tenant_id, user_id, title_ciphertext, updated_at) VALUES ($1, $2, $3, 'sealed', now() - make_interval(days => $4))`,
    [id, tenantId, userId, daysOld],
  );
  await owner.query(`INSERT INTO conversation_messages (id, conversation_id, tenant_id, user_id, role, payload_ciphertext) VALUES ($1, $2, $3, $4, 'user', 'sealed')`, [
    randomUUID(),
    id,
    tenantId,
    userId,
  ]);
  return id;
}

async function run(tenantId: string, userId: string, status: string, daysOld: number): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO agent_runs (id, tenant_id, user_id, status, goal_ciphertext, state_ciphertext, deadline_at, updated_at)
     VALUES ($1, $2, $3, $4, 'retention-test', 'sealed', now(), now() - make_interval(days => $5))`,
    [id, tenantId, userId, status, daysOld],
  );
  return id;
}

const exists = async (table: string, id: string) => (await owner.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  ownerPool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 2 });
});

beforeEach(async () => {
  await owner.query("DELETE FROM tenant_retention");
  await owner.query("DELETE FROM agent_runs WHERE goal_ciphertext = 'retention-test'");
  await owner.query("DELETE FROM conversations WHERE title_ciphertext = 'sealed'");
});

afterAll(async () => {
  await owner?.query("DELETE FROM tenant_retention");
  await owner?.query("DELETE FROM agent_runs WHERE goal_ciphertext = 'retention-test'");
  await owner?.query("DELETE FROM conversations WHERE title_ciphertext = 'sealed'");
  await owner?.end();
  await ownerPool?.end();
  await appPool?.end();
});

describe("keeping data for a set time (FR-ADM-03)", () => {
  it("removes only what a company's settings say has expired, and never a run still in progress", async () => {
    await saveRetention(appPool, acmeAdmin, { conversationDays: 30, agentRunDays: 7 });
    const oldChat = await conversation(ACME, bob.id, 40);
    const recentChat = await conversation(ACME, bob.id, 5);
    const oldFinished = await run(ACME, bob.id, "completed", 10);
    const oldWaiting = await run(ACME, bob.id, "waiting_approval", 10);
    const recentFinished = await run(ACME, bob.id, "failed", 2);
    const otherCompany = await conversation(GLOBEX, globexPat.id, 400);

    const results = await purgeExpired(appPool, 1000);
    expect(results.find((r) => r.tenantId === ACME)).toMatchObject({ conversations: 1, agentRuns: 1 });
    expect(results.some((r) => r.tenantId === GLOBEX)).toBe(false);
    expect(await exists("conversations", oldChat)).toBe(false);
    expect((await owner.query("SELECT 1 FROM conversation_messages WHERE conversation_id = $1", [oldChat])).rowCount).toBe(0);
    for (const [table, id] of [
      ["conversations", recentChat],
      ["agent_runs", oldWaiting],
      ["agent_runs", recentFinished],
      ["conversations", otherCompany],
    ] as const) {
      expect(await exists(table, id)).toBe(true);
    }
    expect(await exists("agent_runs", oldFinished)).toBe(false);
    const audit = await owner.query("SELECT meta FROM audit_log WHERE tenant_id = $1 AND action = 'data.expired_removed' ORDER BY id DESC LIMIT 1", [ACME]);
    expect(audit.rows[0].meta).toMatchObject({ conversations: 1, agentRuns: 1 });
  });

  it("keeps everything when a setting is empty, and removes at most a batch per call", async () => {
    await saveRetention(appPool, acmeAdmin, { conversationDays: 1, agentRunDays: null });
    await Promise.all([conversation(ACME, bob.id, 3), conversation(ACME, bob.id, 3), conversation(ACME, bob.id, 3)]);
    const kept = await run(ACME, bob.id, "completed", 900);
    expect((await purgeExpired(appPool, 2)).find((r) => r.tenantId === ACME)?.conversations).toBe(2);
    expect((await purgeExpired(appPool, 2)).find((r) => r.tenantId === ACME)?.conversations).toBe(1);
    expect(await purgeExpired(appPool, 2)).toEqual([]);
    expect(await exists("agent_runs", kept)).toBe(true);
  });

  it("keeps each company's settings to itself, audits changes, and gives the app no way across people", async () => {
    await saveRetention(appPool, acmeAdmin, { conversationDays: 90, agentRunDays: null });
    await saveRetention(appPool, acmeAdmin, { conversationDays: 60, agentRunDays: 30 });
    expect(await getRetention(appPool, ACME)).toEqual({ conversationDays: 60, agentRunDays: 30 });
    expect(await getRetention(appPool, GLOBEX)).toBeNull();
    expect(await withTenant(appPool, GLOBEX, (db) => db.select().from(tenantRetention))).toEqual([]);
    const audit = await owner.query("SELECT meta FROM audit_log WHERE tenant_id = $1 AND action = 'data.retention_changed' ORDER BY id DESC LIMIT 1", [ACME]);
    expect(audit.rows[0].meta).toEqual({ before: { conversationDays: 90, agentRunDays: null }, after: { conversationDays: 60, agentRunDays: 30 } });

    const chat = await conversation(ACME, bob.id, 1);
    const client = await appPool.connect();
    try {
      await expect(client.query("SET ROLE brain_data_keeper")).rejects.toThrow(/permission denied/);
      await client.query("SELECT set_config('app.tenant_id', $1, false)", [ACME]);
      expect((await client.query("DELETE FROM conversations WHERE id = $1", [chat])).rowCount).toBe(0);
    } finally {
      await client.query("RESET ALL");
      client.release();
    }
    expect(await exists("conversations", chat)).toBe(true);
    await expect(
      withTenant(appPool, ACME, (db) => db.insert(tenantRetention).values({ tenantId: ACME, conversationDays: 0, agentRunDays: null, updatedBy: acmeAdmin.userId })),
    ).rejects.toThrow();
  });
});

describe("deleting a company (FR-ADM-03)", () => {
  it("refuses while anyone is active or the name is wrong, then removes everything the company held", async () => {
    const tenantId = randomUUID();
    const person = randomUUID();
    await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'Doomed Ltd')", [tenantId]);
    await owner.query(
      "INSERT INTO users (id, tenant_id, email, display_name, role, external_subject) VALUES ($1, $2, 'p@doomed.example', 'P', 'owner', $3)",
      [person, tenantId, `doomed-${person}`],
    );
    await conversation(tenantId, person, 1);
    await owner.query("INSERT INTO credit_topups (id, tenant_id, credits, added_by) VALUES ($1, $2, 5, $3)", [randomUUID(), tenantId, person]);
    await owner.query("INSERT INTO audit_log (tenant_id, user_id, action) VALUES ($1, $2, 'x')", [tenantId, person]);
    await owner.query("INSERT INTO work_graph_edges (tenant_id, user_id, source_key, target_key, kind) VALUES ($1, $2, 'me', 'atlassian:X-1', 'opened')", [tenantId, person]);
    await owner.query("INSERT INTO ranking_examples (tenant_id, answer_group, server_id, position, score_ratio, label) VALUES ($1, $2, 'atlassian', 0, 1, 1)", [tenantId, randomUUID()]);
    await owner.query("INSERT INTO tenant_rankers (tenant_id, model, metrics) VALUES ($1, NULL, '{}')", [tenantId]);

    expect(await deleteTenant(ownerPool, randomUUID(), "Doomed Ltd")).toEqual({ deleted: false, reason: "not_found" });
    expect(await deleteTenant(ownerPool, tenantId, "doomed ltd")).toEqual({ deleted: false, reason: "name_mismatch" });
    expect(await deleteTenant(ownerPool, tenantId, "Doomed Ltd")).toEqual({ deleted: false, reason: "people_active", active: 1 });

    await owner.query("UPDATE users SET deactivated_at = now() WHERE id = $1", [person]);
    expect(await deleteTenant(ownerPool, tenantId, "Doomed Ltd")).toEqual({ deleted: true });
    for (const table of ["tenants", "users", "conversations", "conversation_messages", "credit_topups", "audit_log", "work_graph_edges", "ranking_examples", "tenant_rankers"]) {
      const column = table === "tenants" ? "id" : "tenant_id";
      expect((await owner.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [tenantId])).rowCount).toBe(0);
    }
    expect((await owner.query("SELECT 1 FROM tenants WHERE id = $1", [ACME])).rowCount).toBe(1);
  });
});
