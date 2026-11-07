import { AppError } from "@brain/core";
import type { PoolLike } from "./tenant.js";

/** Postgres codes for a lock wait that hit `lock_timeout`, or a statement stopped by `statement_timeout`. */
const WAIT_ENDED = new Set(["55P03", "57014"]);

function codeOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/**
 * Runs `work` while holding a Postgres advisory lock on `key`, so no other API server runs work for
 * the same key at the same time. The lock is held on its own connection, outside any transaction,
 * and Postgres drops it if that connection or the server holding it goes away.
 *
 * Use a pool kept for locks, so servers waiting for a lock cannot use up the connections the work
 * itself needs. Waits at most `waitMs`, then reports the service as busy.
 */
export async function withSharedLock<T>(pool: PoolLike, key: string, waitMs: number, work: () => Promise<T>): Promise<T> {
  if (!Number.isInteger(waitMs) || waitMs < 1) throw new Error("A lock wait needs a limit");
  const client = await pool.connect().catch((err: unknown) => {
    // Every lock connection is in use, or the database cannot be reached. The kind of failure is
    // kept for the logs; its message is not, as it can name hosts.
    throw new AppError("UNAVAILABLE", "This service is busy with another request. Please try again.", {
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
  const close = (err: unknown) => {
    client.off("error", onLost);
    client.release(err instanceof Error ? err : true);
  };
  try {
    await client.query("SELECT set_config('lock_timeout', $1, false)", [`${waitMs}ms`]);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
  } catch (err) {
    // The connection may be in an unknown state, so it is closed rather than reused.
    close(err);
    if (WAIT_ENDED.has(codeOf(err) ?? "")) {
      throw new AppError("UNAVAILABLE", "This service is busy with another request. Please try again.", { reason: "lock_wait" });
    }
    throw err;
  }
  const unlock = async () => {
    // Closing the connection frees the lock as well, so a lost or failing one is just closed.
    if (lost) return close(lost);
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      await client.query("RESET lock_timeout");
      client.off("error", onLost);
      client.release();
    } catch (err) {
      close(err);
    }
  };
  try {
    return await work();
  } finally {
    await unlock();
  }
}
