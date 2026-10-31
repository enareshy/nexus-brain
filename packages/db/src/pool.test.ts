import { AppError } from "@brain/core";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertRlsEnforced, createAppPool } from "./pool.js";
import { seed } from "./seed.js";
import type { PoolLike } from "./tenant.js";

function poolReturning(rows: unknown[]) {
  const release = vi.fn();
  const client = { query: vi.fn(async () => ({ rows })), release } as unknown as PoolClient;
  return { pool: { connect: vi.fn(async () => client) } as unknown as PoolLike, release };
}

describe("assertRlsEnforced", () => {
  it("accepts a role without superuser or BYPASSRLS", async () => {
    const { pool, release } = poolReturning([{ rolsuper: false, rolbypassrls: false }]);
    await expect(assertRlsEnforced(pool)).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    [{ rolsuper: true, rolbypassrls: false }],
    [{ rolsuper: false, rolbypassrls: true }],
  ])("rejects a role that bypasses RLS: %o", async (row) => {
    const { pool, release } = poolReturning([row]);
    await expect(assertRlsEnforced(pool)).rejects.toBeInstanceOf(AppError);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects when the role cannot be found", async () => {
    const { pool } = poolReturning([]);
    await expect(assertRlsEnforced(pool)).rejects.toThrow(/row-level security/);
  });
});

describe("createAppPool", () => {
  it("sets bounded timeouts and registers an error handler", async () => {
    const onError = vi.fn();
    const pool = createAppPool({ connectionString: "postgres://u:p@localhost:1/db", onError });
    expect(pool.options.connectionTimeoutMillis).toBe(5000);
    expect(String(pool.options.options)).toContain("statement_timeout=10000");
    pool.emit("error", new Error("idle client lost"));
    expect(onError).toHaveBeenCalledOnce();
    await pool.end();
  });
});

describe("seed", () => {
  it("sets the tenant before writing each tenant's rows", async () => {
    const sql: string[] = [];
    const client = { query: vi.fn(async (q: string) => (sql.push(q.trim()), { rows: [] })) };
    await seed(client as never);

    const firstSetConfig = sql.findIndex((q) => q.startsWith("SELECT set_config"));
    const firstInsert = sql.findIndex((q) => q.startsWith("INSERT"));
    expect(firstSetConfig).toBeGreaterThan(-1);
    expect(firstSetConfig).toBeLessThan(firstInsert);
    expect(sql.filter((q) => q.startsWith("SELECT set_config"))).toHaveLength(2);
    expect(sql.at(-1)).toBe("COMMIT");
  });

  it("rolls back and rethrows on failure", async () => {
    const sql: string[] = [];
    const client = {
      query: vi.fn(async (q: string) => {
        sql.push(q.trim());
        if (q.startsWith("INSERT INTO users")) throw new Error("boom");
        return { rows: [] };
      }),
    };
    await expect(seed(client as never)).rejects.toThrow("boom");
    expect(sql).toContain("ROLLBACK");
  });
});
