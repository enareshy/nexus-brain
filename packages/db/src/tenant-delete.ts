import { eq } from "drizzle-orm";
import { creditTopups, tenants, users } from "./schema.js";
import { withTenant, type PoolLike } from "./tenant.js";

export type TenantDeletion =
  | { readonly deleted: true }
  | { readonly deleted: false; readonly reason: "not_found" | "name_mismatch" | "people_active"; readonly active?: number };

/**
 * Deletes a whole company and everything it holds (FR-ADM-03): people, chats, memories, runs, usage,
 * settings and audit trail. For operators only, with the owner role. Everyone must have been turned
 * off first, which revokes their connections at each service; deleting rows alone would leave tokens
 * working there. The company's name must be given back exactly, so a mistyped id cannot delete one.
 * Only the database: sign-in accounts at the identity provider, and any copies outside Postgres, are
 * removed separately.
 */
export function deleteTenant(pool: PoolLike, tenantId: string, confirmName: string): Promise<TenantDeletion> {
  return withTenant(pool, tenantId, async (db) => {
    const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).for("update");
    if (!tenant) return { deleted: false, reason: "not_found" };
    if (tenant.name !== confirmName) return { deleted: false, reason: "name_mismatch" };
    // Locked, so nobody can be turned back on, or connect, between this check and the delete.
    const people = await db
      .select({ id: users.id, deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.tenantId, tenantId))
      .for("update");
    const active = people.filter((person) => person.deactivatedAt === null);
    if (active.length > 0) return { deleted: false, reason: "people_active", active: active.length };
    // Top-ups refer to people without a cascade, so they go first; everything else follows the company.
    await db.delete(creditTopups).where(eq(creditTopups.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    return { deleted: true };
  });
}
