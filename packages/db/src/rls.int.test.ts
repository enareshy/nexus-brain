// Tenant-isolation leak suite (NFR-SEC-01, FR-ID-03). Run with `pnpm test:leak` after `pnpm infra:up`.
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./config.js";
import { findUserBySubject } from "./directory.js";
import { applyMigrations, loadMigrations } from "./migrator.js";
import { assertRlsEnforced } from "./pool.js";
import { auditLog, groupMembers, tenants, users } from "./schema.js";
import { GROUPS, TENANTS, seedUser } from "./seed-data.js";
import { seed } from "./seed.js";
import { withTenant } from "./tenant.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain";
const APP_URL =
  process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain";

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

describe("findUserBySubject", () => {
  it("resolves a subject with fresh group memberships", async () => {
    const pat = seedUser("patAcme");
    const user = await findUserBySubject(appPool, ACME, pat.subject);
    expect(user).toEqual({
      userId: pat.id,
      tenantId: ACME,
      role: "member",
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
