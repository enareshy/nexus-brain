import { eq } from "drizzle-orm";
import { auditLog, tenantRetention } from "./schema.js";
import { withTenant, type PoolLike, type UserScope } from "./tenant.js";

export interface Retention {
  /** Days a chat is kept after it was last used. Null keeps it. */
  readonly conversationDays: number | null;
  /** Days a finished agent run, and notifications as old, are kept. Null keeps them. */
  readonly agentRunDays: number | null;
}

export interface PurgeResult {
  readonly tenantId: string;
  readonly conversations: number;
  readonly agentRuns: number;
  readonly notifications: number;
}

/** The removals happened, but these companies' audit entries could not be written. */
export class PurgeAuditError extends Error {
  constructor(
    readonly results: readonly PurgeResult[],
    readonly tenantIds: readonly string[],
  ) {
    super("Expired data was removed, but some audit entries could not be written");
    this.name = "PurgeAuditError";
  }
}

/** The company's settings, or null when it has never set any, so everything is kept. */
export async function getRetention(pool: PoolLike, tenantId: string): Promise<Retention | null> {
  const [row] = await withTenant(pool, tenantId, (db) =>
    db
      .select({ conversationDays: tenantRetention.conversationDays, agentRunDays: tenantRetention.agentRunDays })
      .from(tenantRetention)
      .where(eq(tenantRetention.tenantId, tenantId)),
  );
  return row ?? null;
}

/** Callers must have checked the person is an admin. The change and its audit entry commit together. */
export function saveRetention(pool: PoolLike, scope: UserScope, retention: Retention): Promise<void> {
  return withTenant(pool, scope.tenantId, async (db) => {
    const [before] = await db
      .select({ conversationDays: tenantRetention.conversationDays, agentRunDays: tenantRetention.agentRunDays })
      .from(tenantRetention)
      .where(eq(tenantRetention.tenantId, scope.tenantId))
      .for("update");
    const values = { ...retention, updatedBy: scope.userId, updatedAt: new Date() };
    await db
      .insert(tenantRetention)
      .values({ ...values, tenantId: scope.tenantId })
      .onConflictDoUpdate({ target: tenantRetention.tenantId, set: values });
    await db.insert(auditLog).values({
      tenantId: scope.tenantId,
      userId: scope.userId,
      action: "data.retention_changed",
      meta: { before: before ?? null, after: retention },
    });
  });
}

/**
 * Removes what every company's settings say has expired, up to `maxRows` of each kind per company,
 * and records each company's counts in its audit trail. Only the database function can see across
 * people; this connection never does.
 */
export async function purgeExpired(pool: PoolLike, maxRows: number): Promise<PurgeResult[]> {
  const client = await pool.connect();
  let rows: Array<{ tenant_id: string; conversations: number; agent_runs: number; notifications: number }>;
  try {
    rows = (await client.query("SELECT * FROM app_purge_expired($1)", [maxRows])).rows;
  } finally {
    client.release();
  }
  const results = rows.map((r) => ({ tenantId: r.tenant_id, conversations: r.conversations, agentRuns: r.agent_runs, notifications: r.notifications }));
  // Each company's record on its own, so one that cannot be written does not lose the others.
  const failed: string[] = [];
  for (const result of results) {
    const { tenantId, ...removed } = result;
    await withTenant(pool, tenantId, (db) => db.insert(auditLog).values({ tenantId, userId: null, action: "data.expired_removed", meta: removed })).catch(
      () => failed.push(tenantId),
    );
  }
  if (failed.length) throw new PurgeAuditError(results, failed);
  return results;
}
