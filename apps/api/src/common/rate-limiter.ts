import { AppError, isAppError } from "@brain/core";
import { releaseRateLimit, takeRateLimit, type PoolLike, type RateLimit, type UserScope } from "@brain/db";

export type { RateLimit };

/** Per-person limits. `take` returns a use id, or null at the limit; `release` gives a use back. */
export interface RateLimiter {
  take(scope: UserScope, limit: RateLimit): Promise<string | null>;
  release(scope: UserScope, id: string): Promise<void>;
}

/**
 * Shared by every server and kept across restarts. What the running API uses. When the database
 * cannot be reached, nothing is allowed (the limit is a cost guard) and the person is told to retry.
 */
export function createPgRateLimiter(pool: PoolLike): RateLimiter {
  return {
    async take(scope, limit) {
      try {
        return await takeRateLimit(pool, scope, limit);
      } catch (err) {
        if (isAppError(err)) throw err;
        throw new AppError("UNAVAILABLE", "Brain is busy right now. Please try again in a moment.", { reason: "rate_limit_store", errorType: err instanceof Error ? err.name : typeof err });
      }
    },
    release: (scope, id) => releaseRateLimit(pool, scope, id),
  };
}

/** Gives a use back, trying once more on failure; a use never given back frees itself when it expires. */
export async function releaseQuietly(
  limiter: RateLimiter,
  scope: UserScope,
  id: string,
  onError: (err: unknown) => void,
): Promise<void> {
  try {
    await limiter.release(scope, id);
  } catch {
    await limiter.release(scope, id).catch(onError);
  }
}

interface Use {
  readonly id: string;
  readonly expiresAt: number;
}

/** Most uses kept for one person and kind; far above any limit here, so a bug cannot grow memory without end. */
const MAX_USES_PER_KEY = 1_000;

/** One process only, for tests and tools. Same rules as the shared one. */
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  let uses = new Map<string, readonly Use[]>();
  let next = 0;
  const keyOf = (scope: UserScope, bucket: string) => `${scope.tenantId}|${scope.userId}|${bucket}`;
  const prune = (at: number) => {
    uses = new Map([...uses].map(([key, list]) => [key, list.filter((use) => use.expiresAt > at)] as const).filter(([, list]) => list.length > 0));
  };
  return {
    async take(scope, limit) {
      const at = now();
      prune(at);
      const key = keyOf(scope, limit.bucket);
      const current = uses.get(key) ?? [];
      if (current.length >= Math.min(limit.max, MAX_USES_PER_KEY)) return null;
      next += 1;
      const id = `${key}|${next}`;
      uses.set(key, [...current, { id, expiresAt: at + limit.windowMs }]);
      return id;
    },
    async release(scope, id) {
      const owner = `${scope.tenantId}|${scope.userId}|`;
      if (!id.startsWith(owner)) return;
      uses = new Map([...uses].map(([key, list]) => [key, list.filter((use) => use.id !== id)] as const));
    },
  };
}
