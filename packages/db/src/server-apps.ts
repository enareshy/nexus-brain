import { eq } from "drizzle-orm";
import { mcpServerApps } from "./schema.js";
import { withTenant, type PoolLike, type UserScope } from "./tenant.js";

export interface StoredServerApp {
  readonly clientId: string;
  readonly secretCiphertext: string;
}

/** Which services this company has set up, and when. Never returns secrets. */
export function listServerApps(
  pool: PoolLike,
  tenantId: string,
): Promise<Array<{ serverId: string; updatedAt: Date }>> {
  return withTenant(pool, tenantId, (db) =>
    db.select({ serverId: mcpServerApps.serverId, updatedAt: mcpServerApps.updatedAt }).from(mcpServerApps),
  );
}

export function getServerApp(pool: PoolLike, tenantId: string, serverId: string): Promise<StoredServerApp | null> {
  return withTenant(pool, tenantId, async (db) => {
    const [row] = await db
      .select({ clientId: mcpServerApps.clientId, secretCiphertext: mcpServerApps.secretCiphertext })
      .from(mcpServerApps)
      .where(eq(mcpServerApps.serverId, serverId))
      .limit(1);
    return row ?? null;
  });
}

/** Inserts or replaces the company's app. Callers must have checked the user is an admin. */
export function saveServerApp(
  pool: PoolLike,
  scope: UserScope,
  serverId: string,
  app: StoredServerApp,
): Promise<void> {
  return withTenant(pool, scope.tenantId, async (db) => {
    const values = { ...app, updatedBy: scope.userId, updatedAt: new Date() };
    await db
      .insert(mcpServerApps)
      .values({ ...values, tenantId: scope.tenantId, serverId })
      .onConflictDoUpdate({ target: [mcpServerApps.tenantId, mcpServerApps.serverId], set: values });
  });
}
