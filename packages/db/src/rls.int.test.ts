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
import { assertRlsEnforced } from "./pool.js";
import { claimProposal, createProposal, getProposal, rejectProposal } from "./proposals.js";
import {
  auditLog,
  groupMembers,
  mcpConnections,
  mcpServerApps,
  oauthStates,
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
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    // These rows belong to a seed user, so they would otherwise count towards that user's caps.
    await owner.query("DELETE FROM write_proposals WHERE server_id = 'leaktest'");
    await owner.query("DELETE FROM mcp_server_apps WHERE server_id = 'leaktest'");
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
