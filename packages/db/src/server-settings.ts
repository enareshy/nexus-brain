import { eq } from "drizzle-orm";
import { tenantServerSettings } from "./schema.js";
import { withTenant, type PoolLike, type UserScope } from "./tenant.js";

/** Services this company has turned off. Anything not listed is allowed. */
export async function listTurnedOffServers(pool: PoolLike, tenantId: string): Promise<Set<string>> {
  const rows = await withTenant(pool, tenantId, (db) =>
    db
      .select({ serverId: tenantServerSettings.serverId })
      .from(tenantServerSettings)
      .where(eq(tenantServerSettings.allowed, false)),
  );
  return new Set(rows.map((row) => row.serverId));
}

/** Callers must have checked the user is an admin. */
export function setServerAllowed(pool: PoolLike, scope: UserScope, serverId: string, allowed: boolean): Promise<void> {
  return withTenant(pool, scope.tenantId, async (db) => {
    const values = { allowed, updatedBy: scope.userId, updatedAt: new Date() };
    await db
      .insert(tenantServerSettings)
      .values({ ...values, tenantId: scope.tenantId, serverId })
      .onConflictDoUpdate({ target: [tenantServerSettings.tenantId, tenantServerSettings.serverId], set: values });
  });
}
