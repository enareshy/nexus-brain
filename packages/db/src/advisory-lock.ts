import { AppError } from "@brain/core";
import { setTimeout as sleep } from "node:timers/promises";
import type { PoolLike } from "./tenant.js";

/** How often a waiting server asks for the lock again: soon at first, then every 200 ms. */
const FIRST_RETRY_MS = 25;
const MAX_RETRY_MS = 200;
const BUSY = "This service is busy with another request. Please try again.";

function codeOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

function stopped(): AppError {
  return new AppError("UNAVAILABLE", "The request ended before this service was free.", { reason: "lock_cancelled" });
}

/**
 * Runs `work` while holding a Postgres advisory lock on `key`, so no other API server runs work for
 * the same key at the same time. The lock is held on its own connection, outside any transaction,
 * and Postgres drops it if that connection or the server holding it goes away.
 *
 * Use a pool kept for locks, so servers waiting for a lock cannot use up the connections the work
 * itself needs. The lock is asked for again and again rather than waited on inside Postgres, so a
 * request that is cancelled (`signal`) stops waiting at once and frees its connection. Waits at
 * most `waitMs`, then reports the service as busy.
 */
export async function withSharedLock<T>(
  pool: PoolLike,
  key: string,
  waitMs: number,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isInteger(waitMs) || waitMs < 1) throw new Error("A lock wait needs a limit");
  if (signal?.aborted) throw stopped();
  const client = await pool.connect().catch((err: unknown) => {
    // Every lock connection is in use, or the database cannot be reached. The kind of failure is
    // kept for the logs; its message is not, as it can name hosts.
    throw new AppError("UNAVAILABLE", BUSY, {
      reason: "lock_pool",
      errorType: err instanceof Error ? err.name : typeof err,
      ...(codeOf(err) ? { pgCode: codeOf(err) } : {}),
    });
  });
  // A connection lost while the lock is held raises an error on the client itself; left unhandled
  // it would stop the process. It is kept and the connection closed when the work ends.
  let lost: Error | undefined;
  const onLost = (err: Error) => {
    lost = err;
  };
  client.on("error", onLost);
  const finish = (err?: unknown) => {
    client.off("error", onLost);
    // A connection in an unknown state is closed rather than reused.
    client.release(err === undefined ? undefined : err instanceof Error ? err : true);
  };

  try {
    await acquire(client, key, waitMs, signal);
  } catch (err) {
    // Not getting the lock leaves the connection as it was, so it goes back to the pool.
    finish(err instanceof AppError && !lost ? undefined : err);
    throw err;
  }
  const unlock = async () => {
    // Closing the connection frees the lock as well, so a lost or failing one is just closed.
    if (lost) return finish(lost);
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      finish();
    } catch (err) {
      finish(err);
    }
  };
  try {
    return await work();
  } finally {
    await unlock();
  }
}

async function acquire(
  client: { query(text: string, values: unknown[]): Promise<{ rows: Array<{ ok?: boolean }> }> },
  key: string,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  let retryMs = FIRST_RETRY_MS;
  for (;;) {
    const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [key]);
    if (rows[0]?.ok === true) return;
    if (signal?.aborted) throw stopped();
    if (Date.now() + retryMs > deadline) throw new AppError("UNAVAILABLE", BUSY, { reason: "lock_wait" });
    try {
      await sleep(retryMs, undefined, signal ? { signal } : undefined);
    } catch {
      throw stopped();
    }
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  }
}
