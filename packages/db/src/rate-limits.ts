import { and, count, eq, gt, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { rateLimitUses } from "./schema.js";
import { withUser, type PoolLike, type UserScope } from "./tenant.js";

/** At most `max` uses per person in any `windowMs`, or at most `max` at once when uses are given back. */
export interface RateLimit {
  readonly bucket: string;
  readonly max: number;
  readonly windowMs: number;
}

const BUCKET = /^[a-z_]{1,40}$/;

function check(limit: RateLimit): void {
  if (!BUCKET.test(limit.bucket)) throw new Error(`Invalid rate limit bucket: ${limit.bucket}`);
  if (!Number.isInteger(limit.max) || limit.max < 1) throw new Error("A rate limit allows at least one use");
  if (!Number.isInteger(limit.windowMs) || limit.windowMs < 1) throw new Error("A rate limit needs a window");
}

/**
 * Records one use and returns its id, or null when the person is at the limit. The count is taken
 * under a per-person lock with the database's clock, so every server sees the same count.
 */
export async function takeRateLimit(pool: PoolLike, scope: UserScope, limit: RateLimit): Promise<string | null> {
  check(limit);
  return withUser(pool, scope, async (db) => {
    const lockKey = `rate|${scope.tenantId}|${scope.userId}|${limit.bucket}`;
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const mine = eq(rateLimitUses.bucket, limit.bucket);
    // The clock now, not when the transaction began, since waiting for the lock takes time.
    await db.delete(rateLimitUses).where(and(mine, lte(rateLimitUses.expiresAt, sql`clock_timestamp()`)));
    const [used] = await db
      .select({ value: count() })
      .from(rateLimitUses)
      .where(and(mine, gt(rateLimitUses.expiresAt, sql`clock_timestamp()`)));
    if ((used?.value ?? 0) >= limit.max) return null;
    const id = randomUUID();
    await db.insert(rateLimitUses).values({
      id,
      tenantId: scope.tenantId,
      userId: scope.userId,
      bucket: limit.bucket,
      expiresAt: sql`clock_timestamp() + make_interval(secs => ${limit.windowMs / 1000})`,
    });
    return id;
  });
}

/** Gives a use back, for work in progress that has ended. Someone else's id does nothing. */
export function releaseRateLimit(pool: PoolLike, scope: UserScope, id: string): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db.delete(rateLimitUses).where(eq(rateLimitUses.id, id));
  });
}
