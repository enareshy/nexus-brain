import { AppError, UuidSchema } from "@brain/core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { schema } from "./schema.js";
import { rollbackQuietly } from "./tx.js";

export type TenantDb = NodePgDatabase<typeof schema>;

/** Minimal pool surface so tests can pass a fake. */
export type PoolLike = Pick<Pool, "connect">;

/**
 * Runs `work` in a transaction scoped to one tenant. RLS policies read
 * `app.tenant_id`, which `set_config(..., true)` makes transaction-local, so the
 * setting can never leak to the next user of the pooled connection.
 */
export async function withTenant<T>(
  pool: PoolLike,
  tenantId: string,
  work: (db: TenantDb) => Promise<T>,
): Promise<T> {
  if (!UuidSchema.safeParse(tenantId).success) {
    throw new AppError("VALIDATION", "tenantId must be a UUID");
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(drizzle(client, { schema }));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await rollbackQuietly(client);
    throw err;
  } finally {
    client.release();
  }
}
