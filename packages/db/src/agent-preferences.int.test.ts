// Each person's choice of whether their agents may propose changes (FR-AGT-04): theirs alone.
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAgentMode, setAgentMode } from "./agent-preferences.js";
import { MIGRATIONS_DIR } from "./config.js";
import { applyMigrations, loadMigrations } from "./migrator.js";
import { seed } from "./seed.js";
import { seedUser, TENANTS } from "./seed-data.js";
import { withUser } from "./tenant.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const bob = { tenantId: TENANTS.acme.id, userId: seedUser("bob").id };
const alice = { tenantId: TENANTS.acme.id, userId: seedUser("alice").id };

let owner: pg.Client;
let appPool: pg.Pool;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  appPool = new pg.Pool({ connectionString: APP_URL, max: 2 });
});

beforeEach(async () => {
  await owner.query("DELETE FROM agent_preferences");
  await owner.query("DELETE FROM audit_log WHERE action = 'agent.mode_changed'");
});

afterAll(async () => {
  await owner?.query("DELETE FROM agent_preferences");
  await owner?.query("DELETE FROM audit_log WHERE action = 'agent.mode_changed'");
  await owner?.end();
  await appPool?.end();
});

describe("a person's agent mode", () => {
  it("is 'ask' until they change it, can be changed back, and each change is audited", async () => {
    expect(await getAgentMode(appPool, bob)).toBe("ask");
    await setAgentMode(appPool, bob, "read_only");
    expect(await getAgentMode(appPool, bob)).toBe("read_only");
    await setAgentMode(appPool, bob, "ask");
    expect(await getAgentMode(appPool, bob)).toBe("ask");
    const { rows } = await owner.query("SELECT user_id, meta FROM audit_log WHERE action = 'agent.mode_changed' ORDER BY created_at");
    expect(rows).toEqual([
      { user_id: bob.userId, meta: { mode: "read_only" } },
      { user_id: bob.userId, meta: { mode: "ask" } },
    ]);
  });

  it("is the person's own: a colleague can neither see nor change it", async () => {
    await setAgentMode(appPool, bob, "read_only");
    expect(await getAgentMode(appPool, alice)).toBe("ask");
    await withUser(appPool, alice, async (db) => {
      expect((await db.execute(sql`SELECT * FROM agent_preferences`)).rows).toEqual([]);
      await db.execute(sql`UPDATE agent_preferences SET read_only = false`);
    });
    await expect(
      withUser(appPool, alice, (db) => db.execute(sql`INSERT INTO agent_preferences (tenant_id, user_id, read_only) VALUES (${bob.tenantId}, ${bob.userId}, false)`)),
    ).rejects.toThrow();
    expect(await getAgentMode(appPool, bob)).toBe("read_only");
  });

  it("cannot be set by someone turned off", async () => {
    await owner.query("UPDATE users SET deactivated_at = now() WHERE tenant_id = $1 AND id = $2", [alice.tenantId, alice.userId]);
    try {
      await expect(setAgentMode(appPool, alice, "read_only")).rejects.toThrow();
    } finally {
      await owner.query("UPDATE users SET deactivated_at = NULL WHERE tenant_id = $1 AND id = $2", [alice.tenantId, alice.userId]);
    }
  });

  it("is removed when the person is erased", async () => {
    await setAgentMode(appPool, alice, "read_only");
    await owner.query("BEGIN");
    try {
      await owner.query("UPDATE users SET erased_at = now() WHERE tenant_id = $1 AND id = $2", [alice.tenantId, alice.userId]);
      expect((await owner.query("SELECT count(*)::int AS n FROM agent_preferences WHERE user_id = $1", [alice.userId])).rows[0].n).toBe(0);
    } finally {
      await owner.query("ROLLBACK");
    }
  });
});
