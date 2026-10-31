import { AppError } from "@brain/core";
import pg from "pg";
import type { PoolLike } from "./tenant.js";

const CONNECT_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const STATEMENT_TIMEOUT_MS = 10_000;
const IDLE_IN_TX_TIMEOUT_MS = 15_000;

export interface AppPoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  /** Idle-client errors (e.g. database restart) must be handled or Node crashes. */
  readonly onError: (err: Error) => void;
}

/** Application pool with bounded waits so a slow database cannot hang every request. */
export function createAppPool(options: AppPoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${IDLE_IN_TX_TIMEOUT_MS}`,
  });
  pool.on("error", options.onError);
  return pool;
}

/**
 * Refuses to run if the application role could bypass row-level security
 * (superuser or BYPASSRLS). Call once at startup.
 */
export async function assertRlsEnforced(pool: PoolLike): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    const role = rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new AppError(
        "CONFIG_INVALID",
        "DATABASE_APP_ROLE_URL must use a role subject to row-level security (not superuser, not BYPASSRLS)",
      );
    }
  } finally {
    client.release();
  }
}
