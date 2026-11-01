import { AppError, UuidSchema } from "@brain/core";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { schema } from "./schema.js";
import { rollbackQuietly } from "./tx.js";

export type TenantDb = NodePgDatabase<typeof schema>;

/** Minimal pool surface so tests can pass a fake. */
export type PoolLike = Pick<Pool, "connect">;

export interface UserScope {
  readonly tenantId: string;
  readonly userId: string;
}

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
  return inScopedTransaction(pool, { "app.tenant_id": requireUuid(tenantId, "tenantId") }, work);
}

/** Like withTenant, but also scopes per-user tables (e.g. MCP connections) to one user. */
export async function withUser<T>(
  pool: PoolLike,
  scope: UserScope,
  work: (db: TenantDb) => Promise<T>,
): Promise<T> {
  return inScopedTransaction(
    pool,
    {
      "app.tenant_id": requireUuid(scope.tenantId, "tenantId"),
      "app.user_id": requireUuid(scope.userId, "userId"),
    },
    work,
  );
}

/** Runs `work` in a transaction with the given transaction-local settings. */
export async function inScopedTransaction<T>(
  pool: PoolLike,
  settings: Readonly<Record<string, string>>,
  work: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [name, value] of Object.entries(settings)) {
      await client.query("SELECT set_config($1, $2, true)", [name, value]);
    }
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

function requireUuid(value: string, field: string): string {
  if (!UuidSchema.safeParse(value).success) {
    throw new AppError("VALIDATION", `${field} must be a UUID`);
  }
  return value;
}
