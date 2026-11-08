// Erasing one person (FR-ADM-03, GDPR right to erasure), on real Postgres with a temporary person.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./config.js";
import { applyMigrations, loadMigrations } from "./migrator.js";
import { seed } from "./seed.js";
import { seedUser, TENANTS } from "./seed-data.js";
import { eraseUser, reactivateUser } from "./users.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const ACME = TENANTS.acme.id;
const admin = { tenantId: ACME, userId: seedUser("patAcme").id };
const member = { tenantId: ACME, userId: seedUser("bob").id };
/** A second temporary person, so no seeded account's data is touched. */
let colleague: string;

let owner: pg.Client;
let appPool: pg.Pool;
let person: string;

async function addEverything(userId: string, proposalStatus = "pending"): Promise<void> {
  const q = (text: string, values: unknown[]) => owner.query(text, values);
  const chat = randomUUID();
  await q("INSERT INTO conversations (id, tenant_id, user_id, title_ciphertext) VALUES ($1, $2, $3, 'sealed')", [chat, ACME, userId]);
  await q("INSERT INTO conversation_messages (id, conversation_id, tenant_id, user_id, role, payload_ciphertext) VALUES ($1, $2, $3, $4, 'user', 'sealed')", [
    randomUUID(),
    chat,
    ACME,
    userId,
  ]);
  await q("INSERT INTO memories (id, tenant_id, user_id, text_ciphertext) VALUES ($1, $2, $3, 'sealed')", [randomUUID(), ACME, userId]);
  await q("INSERT INTO skills (id, tenant_id, user_id, name_ciphertext, instructions_ciphertext, tools, shared) VALUES ($1, $2, $3, 'n', 'i', '{search_documents}', true)", [
    randomUUID(),
    ACME,
    userId,
  ]);
  await q("INSERT INTO agent_runs (id, tenant_id, user_id, status, goal_ciphertext, state_ciphertext, deadline_at) VALUES ($1, $2, $3, 'cancelled', 'g', 's', now())", [
    randomUUID(),
    ACME,
    userId,
  ]);
  await q("INSERT INTO agent_triggers (id, tenant_id, user_id, kind, goal_ciphertext, interval_minutes, next_run_at, enabled) VALUES ($1, $2, $3, 'schedule', 'g', 60, now(), false)", [
    randomUUID(),
    ACME,
    userId,
  ]);
  await q(
    `INSERT INTO write_proposals (id, tenant_id, user_id, server_id, action, tool_name, tool_class, args, args_hash, site_origin, status, expires_at)
     VALUES ($1, $2, $3, 's', 'a', 't', 'write', '{}', 'h', 'https://x.example', $4, now())`,
    [randomUUID(), ACME, userId, proposalStatus],
  );
  await q("INSERT INTO notifications (id, tenant_id, user_id, kind, dedupe_key, title_ciphertext) VALUES ($1, $2, $3, 'run_finished', $4, 't')", [
    randomUUID(),
    ACME,
    userId,
    randomUUID(),
  ]);
  await q("INSERT INTO usage_ledger (tenant_id, user_id, feature, model, input_tokens, output_tokens, cost_usd) VALUES ($1, $2, 'erase-test', 'm', 1, 1, 0.5)", [ACME, userId]);
  await q("INSERT INTO work_graph_edges (tenant_id, user_id, source_key, target_key, kind) VALUES ($1, $2, 'me', 'atlassian:ENG-1', 'opened')", [ACME, userId]);
  await q("INSERT INTO rate_limit_uses (id, tenant_id, user_id, bucket, expires_at) VALUES ($1, $2, $3, 'answer', now() + interval '1 minute')", [randomUUID(), ACME, userId]);
}

const count = async (table: string, userId: string) =>
  Number((await owner.query(`SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [userId])).rows[0].n);

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  appPool = new pg.Pool({ connectionString: APP_URL, max: 2 });
});

beforeEach(async () => {
  person = randomUUID();
  colleague = randomUUID();
  for (const id of [person, colleague]) {
    await owner.query(
      "INSERT INTO users (id, tenant_id, email, display_name, role, external_subject) VALUES ($1, $2, $3, 'Leaver', 'member', $4)",
      [id, ACME, `leaver-${id}@acme.example`, `leaver-${id}`],
    );
  }
});

afterAll(async () => {
  await owner?.query("DELETE FROM usage_ledger WHERE feature = 'erase-test'");
  await owner?.query("DELETE FROM users WHERE tenant_id = $1 AND (email LIKE 'leaver-%' OR email LIKE 'erased-%')", [ACME]);
  await owner?.end();
  await appPool?.end();
});

describe("erasing one person (FR-ADM-03)", () => {
  it("deletes everything they own, keeps the company's usage, and leaves nothing that names them", async () => {
    await addEverything(person);
    await addEverything(colleague);
    const group = (await owner.query("SELECT id FROM groups WHERE tenant_id = $1 LIMIT 1", [ACME])).rows[0].id;
    await owner.query("INSERT INTO group_members (tenant_id, group_id, user_id) VALUES ($1, $2, $3)", [ACME, group, person]);
    await owner.query("UPDATE users SET deactivated_at = now() WHERE id = $1", [person]);

    const result = await eraseUser(appPool, admin, person);
    expect(result).toEqual({ erased: true, conversations: 1, memories: 1, skills: 1, agentRuns: 1, automaticAgents: 1, changes: 1, notifications: 1 });
    for (const table of ["conversations", "conversation_messages", "memories", "skills", "agent_runs", "agent_triggers", "write_proposals", "notifications", "mcp_connections", "work_graph_edges", "rate_limit_uses"]) {
      expect(await count(table, person)).toBe(0);
    }
    expect(await count("group_members", person)).toBe(0);
    expect(await count("usage_ledger", person)).toBe(1);
    expect(await count("memories", colleague)).toBe(1);
    expect(await count("skills", colleague)).toBe(1);
    expect(await count("work_graph_edges", colleague)).toBe(1);
    expect(await count("rate_limit_uses", colleague)).toBe(1);

    // Nothing can be written for them afterwards, even by a chat that was already under way.
    await expect(
      owner.query("INSERT INTO conversations (id, tenant_id, user_id, title_ciphertext) VALUES ($1, $2, $3, 'late')", [randomUUID(), ACME, person]),
    ).rejects.toThrow(/turned off/);

    const row = (await owner.query("SELECT email, display_name, external_subject, erased_at FROM users WHERE id = $1", [person])).rows[0];
    expect(row).toMatchObject({ email: `erased-${person}@erased.invalid`, display_name: "Erased person", external_subject: `erased:${person}` });
    expect(row.erased_at).not.toBeNull();
    const audit = (await owner.query("SELECT user_id, meta::text AS meta FROM audit_log WHERE action = 'user.erased' AND resource = $1", [person])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(admin.userId);
    expect(audit[0].meta).not.toMatch(/leaver|Leaver/);

    expect((await eraseUser(appPool, admin, person)).erased).toBe(false);
    await expect(reactivateUser(appPool, admin, person)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses until they are turned off, and while a change they approved is being carried out", async () => {
    await expect(eraseUser(appPool, admin, person)).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/Turn this person off/) });
    await addEverything(person, "executing");
    await owner.query("UPDATE users SET deactivated_at = now() WHERE id = $1", [person]);
    await expect(eraseUser(appPool, admin, person)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/still being carried out/) });
    expect(await count("memories", person)).toBe(1);
  });

  it("lets only an active admin erase, never themselves, and only within their own company", async () => {
    await owner.query("UPDATE users SET deactivated_at = now() WHERE id = $1", [person]);
    await expect(eraseUser(appPool, member, person)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(eraseUser(appPool, admin, admin.userId)).rejects.toMatchObject({ code: "VALIDATION" });
    const otherCompanyAdmin = { tenantId: TENANTS.globex.id, userId: seedUser("patGlobex").id };
    await expect(eraseUser(appPool, otherCompanyAdmin, person)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(eraseUser(appPool, admin, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    const client = await appPool.connect();
    try {
      await expect(client.query("SELECT * FROM app_erase_person($1, $2)", [admin.userId, person])).rejects.toThrow(/no company in scope/);
      // Naming an admin who is not the signed-in person is refused, so the audit entry cannot be forged.
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [ACME, member.userId]);
      await expect(client.query("SELECT * FROM app_erase_person($1, $2)", [admin.userId, person])).rejects.toThrow(/not allowed/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect((await owner.query("SELECT erased_at FROM users WHERE id = $1", [person])).rows[0].erased_at).toBeNull();
  });
});
