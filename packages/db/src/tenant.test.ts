import { AppError } from "@brain/core";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withTenant, type PoolLike } from "./tenant.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

function fakePool(failOn?: string) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (failOn && sql.startsWith(failOn)) throw new Error(`${failOn} failed`);
      return { rows: [], rowCount: 0 };
    }),
    release,
  } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as PoolLike;
  return { pool, queries, release };
}

describe("withTenant", () => {
  it("rejects a non-UUID tenant before touching the pool", async () => {
    const { pool } = fakePool();
    await expect(withTenant(pool, "acme", async () => 1)).rejects.toBeInstanceOf(AppError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("sets the tenant transaction-locally, commits and releases", async () => {
    const { pool, queries, release } = fakePool();
    const result = await withTenant(pool, TENANT, async () => "done");

    expect(result).toBe("done");
    expect(queries.map((q) => q.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.tenant_id', $1, true)",
      "COMMIT",
    ]);
    expect(queries[1]?.params).toEqual([TENANT]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back, rethrows and releases when work fails", async () => {
    const { pool, queries, release } = fakePool();
    await expect(
      withTenant(pool, TENANT, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(queries.map((q) => q.sql)).toContain("ROLLBACK");
    expect(queries.map((q) => q.sql)).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps the original error when ROLLBACK itself fails", async () => {
    const { pool, release } = fakePool("ROLLBACK");
    await expect(
      withTenant(pool, TENANT, async () => {
        throw new Error("original");
      }),
    ).rejects.toThrow("original");
    expect(release).toHaveBeenCalledOnce();
  });
});
