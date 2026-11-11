// A company's AI settings (FR-ADM-02, FR-LLM-07): admin-only changes, audited, and kept per company.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AI_SETTINGS, getAiSettings, saveAiSettings, type AiSettings } from "./ai-settings.js";
import { MIGRATIONS_DIR } from "./config.js";
import { applyMigrations, loadMigrations } from "./migrator.js";
import { seed } from "./seed.js";
import { seedUser, TENANTS } from "./seed-data.js";
import { withTenant } from "./tenant.js";
import { tenantAiSettings } from "./schema.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const ACME = TENANTS.acme.id;
const GLOBEX = TENANTS.globex.id;
const admin = { tenantId: ACME, userId: seedUser("patAcme").id };
const member = { tenantId: ACME, userId: seedUser("bob").id };
const cautious: AiSettings = { modelChoice: "standard", agentsEnabled: true, automaticAgentsEnabled: false, automaticRunsPerDay: 3, agentChangesAllowed: true, peopleChooseModel: false };

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
  await owner.query("DELETE FROM tenant_ai_settings");
});

afterAll(async () => {
  await owner?.query("DELETE FROM tenant_ai_settings");
  await owner?.query("DELETE FROM audit_log WHERE action = 'admin.ai_settings_changed'");
  await owner?.end();
  await appPool?.end();
});

describe("company AI settings", () => {
  it("uses the defaults until an admin changes them, then keeps the change with an audit entry", async () => {
    expect(await getAiSettings(appPool, ACME)).toEqual(DEFAULT_AI_SETTINGS);

    await saveAiSettings(appPool, admin, cautious);
    expect(await getAiSettings(appPool, ACME)).toEqual(cautious);

    const audit = (await owner.query("SELECT user_id, meta FROM audit_log WHERE tenant_id = $1 AND action = 'admin.ai_settings_changed' ORDER BY id DESC LIMIT 1", [ACME])).rows[0];
    expect(audit.user_id).toBe(admin.userId);
    expect(audit.meta).toEqual({ before: DEFAULT_AI_SETTINGS, after: cautious });
  });

  it("lets only an active admin change them", async () => {
    await expect(saveAiSettings(appPool, member, cautious)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await owner.query("UPDATE users SET deactivated_at = now() WHERE id = $1", [admin.userId]);
    try {
      await expect(saveAiSettings(appPool, admin, cautious)).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await owner.query("UPDATE users SET deactivated_at = NULL WHERE id = $1", [admin.userId]);
    }
    expect(await getAiSettings(appPool, ACME)).toEqual(DEFAULT_AI_SETTINGS);
  });

  it("keeps each company's settings apart (row-level security)", async () => {
    await saveAiSettings(appPool, admin, cautious);
    expect(await getAiSettings(appPool, GLOBEX)).toEqual(DEFAULT_AI_SETTINGS);
    const seenFromGlobex = await withTenant(appPool, GLOBEX, (db) => db.select().from(tenantAiSettings));
    expect(seenFromGlobex).toEqual([]);
    // An admin of another company cannot write a row for this one.
    const globexAdmin = { tenantId: GLOBEX, userId: seedUser("patGlobex").id };
    await expect(
      withTenant(appPool, GLOBEX, (db) => db.insert(tenantAiSettings).values({ ...cautious, tenantId: ACME, updatedBy: globexAdmin.userId })),
    ).rejects.toThrow();
  });

  it("refuses values outside the allowed range", async () => {
    await expect(saveAiSettings(appPool, admin, { ...cautious, automaticRunsPerDay: 11 })).rejects.toThrow();
    await expect(saveAiSettings(appPool, admin, { ...cautious, modelChoice: "huge" as never })).rejects.toThrow();
    expect(await getAiSettings(appPool, ACME)).toEqual(DEFAULT_AI_SETTINGS);
  });
});
