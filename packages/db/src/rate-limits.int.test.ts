// Per-person rate limits shared by every API server (NFR-SEC-05 abuse limits, FR-MET budgets' companion).
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./config.js";
import { applyMigrations, loadMigrations } from "./migrator.js";
import { releaseRateLimit, takeRateLimit } from "./rate-limits.js";
import { seed } from "./seed.js";
import { seedUser, TENANTS } from "./seed-data.js";
import { withUser } from "./tenant.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const bob = { tenantId: TENANTS.acme.id, userId: seedUser("bob").id };
const pat = { tenantId: TENANTS.acme.id, userId: seedUser("patAcme").id };
const answers = { bucket: "answer", max: 2, windowMs: 60_000 } as const;

let owner: pg.Client;
let appPool: pg.Pool;
let otherServer: pg.Pool;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  appPool = new pg.Pool({ connectionString: APP_URL, max: 4 });
  // A second pool stands in for a second API server.
  otherServer = new pg.Pool({ connectionString: APP_URL, max: 4 });
});

beforeEach(async () => {
  await owner.query("DELETE FROM rate_limit_uses");
});

afterAll(async () => {
  await owner?.query("DELETE FROM rate_limit_uses");
  await owner?.end();
  await appPool?.end();
  await otherServer?.end();
});

describe("shared rate limits", () => {
  it("allows up to the limit per person, counted across servers", async () => {
    expect(await takeRateLimit(appPool, bob, answers)).toEqual(expect.any(String));
    expect(await takeRateLimit(otherServer, bob, answers)).toEqual(expect.any(String));
    expect(await takeRateLimit(appPool, bob, answers)).toBeNull();
    expect(await takeRateLimit(otherServer, bob, answers)).toBeNull();
    // Someone else, and another kind of use, have their own counts.
    expect(await takeRateLimit(appPool, pat, answers)).toEqual(expect.any(String));
    expect(await takeRateLimit(appPool, bob, { ...answers, bucket: "export" })).toEqual(expect.any(String));
  });

  it("holds the limit when requests arrive at the same time", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => takeRateLimit(i % 2 ? appPool : otherServer, bob, answers)),
    );
    expect(results.filter((id) => id !== null)).toHaveLength(answers.max);
  });

  it("frees a use when it expires, and when it is given back", async () => {
    const first = await takeRateLimit(appPool, bob, answers);
    await takeRateLimit(appPool, bob, answers);
    expect(await takeRateLimit(appPool, bob, answers)).toBeNull();

    await releaseRateLimit(appPool, bob, first as string);
    expect(await takeRateLimit(appPool, bob, answers)).toEqual(expect.any(String));

    await owner.query("UPDATE rate_limit_uses SET expires_at = now() - interval '1 second'");
    expect(await takeRateLimit(appPool, bob, answers)).toEqual(expect.any(String));
    // Expired uses are cleared as they are passed, so the table stays small.
    expect((await owner.query("SELECT count(*)::int AS n FROM rate_limit_uses")).rows[0].n).toBe(1);
  });

  it("keeps each person's uses private to them", async () => {
    const id = await takeRateLimit(appPool, bob, answers);
    // Pat can neither see Bob's uses nor give one back for him.
    await releaseRateLimit(appPool, pat, id as string);
    const seen = await withUser(appPool, pat, (db) => db.execute("SELECT count(*)::int AS n FROM rate_limit_uses"));
    expect((seen.rows[0] as { n: number }).n).toBe(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM rate_limit_uses")).rows[0].n).toBe(1);
    // Nor add one in his name.
    await expect(
      withUser(appPool, pat, (db) =>
        db.execute(`INSERT INTO rate_limit_uses (id, tenant_id, user_id, bucket, expires_at)
          VALUES (gen_random_uuid(), '${bob.tenantId}', '${bob.userId}', 'answer', now() + interval '1 minute')`),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses limits that make no sense", async () => {
    await expect(takeRateLimit(appPool, bob, { bucket: "Answer!", max: 1, windowMs: 1000 })).rejects.toThrow();
    await expect(takeRateLimit(appPool, bob, { bucket: "answer", max: 0, windowMs: 1000 })).rejects.toThrow();
    await expect(takeRateLimit(appPool, bob, { bucket: "answer", max: 1, windowMs: 0 })).rejects.toThrow();
  });
});
