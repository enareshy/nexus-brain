// A company's learned ranker (FR-RET-08): ratings saved as general signals, per company, which the
// app can add to but never read; models only an operator writes.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./config.js";
import { applyMigrations, loadMigrations } from "./migrator.js";
import {
  companiesWithRankingExamples,
  getTenantRanker,
  loadRankingExamples,
  purgeOldRankingExamples,
  recordRankingExamples,
  saveTenantRanker,
  type StoredRankingExample,
} from "./ranker.js";
import { seed } from "./seed.js";
import { TENANTS } from "./seed-data.js";
import { withTenant } from "./tenant.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const ACME = TENANTS.acme.id;
const GLOBEX = TENANTS.globex.id;

let owner: pg.Client;
let appPool: pg.Pool;

const example = (over: Partial<StoredRankingExample> = {}): StoredRankingExample => ({
  group: randomUUID(),
  serverId: "atlassian",
  position: 0,
  scoreRatio: 1,
  ageDays: 3.5,
  label: 1,
  ...over,
});

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  appPool = new pg.Pool({ connectionString: APP_URL, max: 2 });
});

beforeEach(async () => {
  await owner.query("DELETE FROM ranking_examples");
  await owner.query("DELETE FROM tenant_rankers");
});

afterAll(async () => {
  await owner?.query("DELETE FROM ranking_examples");
  await owner?.query("DELETE FROM tenant_rankers");
  await owner?.end();
  await appPool?.end();
});

describe("ratings saved for a company's ranker", () => {
  it("are added by the app for its own company only, and read back only by an operator", async () => {
    const group = randomUUID();
    await recordRankingExamples(appPool, ACME, [example({ group }), example({ group, position: 1, label: 0, ageDays: null })]);
    // The same answer saved again, as after a changed rating, adds nothing, even at other places.
    await recordRankingExamples(appPool, ACME, [example({ group, label: 0 }), example({ group, position: 2, label: 0 })]);
    expect(await companiesWithRankingExamples(owner)).toEqual([ACME]);
    const rows = await loadRankingExamples(owner, ACME);
    expect(rows).toEqual([
      // Whole days only.
      { group, serverId: "atlassian", position: 0, scoreRatio: 1, ageDays: 4, label: 1 },
      { group, serverId: "atlassian", position: 1, scoreRatio: 1, ageDays: null, label: 0 },
    ]);
    expect(await loadRankingExamples(owner, GLOBEX)).toEqual([]);

    // The app cannot read, change or remove them, nor add any for another company.
    await expect(withTenant(appPool, ACME, (db) => db.execute("SELECT * FROM ranking_examples"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(appPool, ACME, (db) => db.execute("DELETE FROM ranking_examples"))).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(appPool, ACME, (db) =>
        db.execute(`INSERT INTO ranking_examples (tenant_id, answer_group, server_id, position, score_ratio, label)
          VALUES ('${GLOBEX}', '${randomUUID()}', 'atlassian', 0, 1, 1)`),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("hold no person, and refuse values outside their bounds", async () => {
    const columns = await owner.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ranking_examples'");
    expect(columns.rows.map((r) => r.column_name)).not.toContain("user_id");
    // Saved by day, not time, so rows cannot be matched to a chat by when they happened.
    expect(columns.rows.filter((r) => /time/.test(r.data_type))).toEqual([]);
    for (const bad of [example({ serverId: "Not An Id" }), example({ position: 100 }), example({ scoreRatio: 1.5 }), example({ ageDays: -1 })]) {
      await expect(recordRankingExamples(appPool, ACME, [bad])).rejects.toThrow();
    }
    await expect(recordRankingExamples(appPool, ACME, Array.from({ length: 21 }, () => example()))).rejects.toThrow(/At most/);
    await expect(recordRankingExamples(appPool, ACME, [example(), example()])).rejects.toThrow(/one answer at a time/);
  });

  it("are deleted after 180 days", async () => {
    const old = randomUUID();
    await recordRankingExamples(appPool, ACME, [example({ group: old })]);
    await recordRankingExamples(appPool, ACME, [example()]);
    await owner.query("UPDATE ranking_examples SET saved_on = current_date - 181 WHERE answer_group = $1", [old]);
    expect(await purgeOldRankingExamples(owner)).toBe(1);
    expect(await loadRankingExamples(owner, ACME)).toHaveLength(1);
  });
});

describe("a company's trained ranker", () => {
  it("is written by an operator and read by the app for its own company only", async () => {
    const model = { version: 1, bias: -1, weights: { position: 1, score: 0, recency: 0, undated: 0 }, sources: {} };
    await saveTenantRanker(owner, ACME, model, { active: true });
    expect(await getTenantRanker(appPool, ACME)).toMatchObject({ model, metrics: { active: true }, trainedAt: expect.any(Date) });
    expect(await getTenantRanker(appPool, GLOBEX)).toBeNull();
    await saveTenantRanker(owner, ACME, null, { active: false });
    expect((await getTenantRanker(appPool, ACME))?.model).toBeNull();
    await expect(
      withTenant(appPool, ACME, (db) => db.execute("UPDATE tenant_rankers SET model = NULL")),
    ).rejects.toThrow(/permission denied/);
  });
});
