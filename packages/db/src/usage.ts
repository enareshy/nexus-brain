import { usageLedger } from "./schema.js";
import { withTenant, type PoolLike, type UserScope } from "./tenant.js";

export interface UsageEntry {
  readonly feature: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number | null;
}

/** Appends one LLM call to the tenant's usage ledger (FR-MET-01). */
export function appendUsage(pool: PoolLike, scope: UserScope, entry: UsageEntry): Promise<void> {
  return withTenant(pool, scope.tenantId, async (db) => {
    await db.insert(usageLedger).values({
      ...entry,
      tenantId: scope.tenantId,
      userId: scope.userId,
      costUsd: entry.costUsd === null ? null : entry.costUsd.toFixed(6),
    });
  });
}
