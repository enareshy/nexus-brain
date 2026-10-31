import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, loadMigrations } from "./migrator.js";

function fakeClient(applied: string[], failSql?: string) {
  const executed: string[] = [];
  const query = vi.fn(async (sql: string) => {
    executed.push(sql.trim());
    if (failSql && sql === failSql) throw new Error("syntax error");
    if (sql.startsWith("SELECT version")) return { rows: applied.map((version) => ({ version })) };
    return { rows: [] };
  });
  return { client: { query } as never, executed };
}

describe("loadMigrations", () => {
  it("loads numbered .sql files in order and ignores others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    await writeFile(join(dir, "0002_b.sql"), "SELECT 2;");
    await writeFile(join(dir, "0001_a.sql"), "SELECT 1;");
    await writeFile(join(dir, "notes.txt"), "x");

    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => m.version)).toEqual(["0001_a", "0002_b"]);
    expect(migrations[0]?.sql).toBe("SELECT 1;");
  });
});

describe("applyMigrations", () => {
  const migrations = [
    { version: "0001_a", sql: "SELECT 1;" },
    { version: "0002_b", sql: "SELECT 2;" },
  ];

  it("applies only pending migrations", async () => {
    const { client, executed } = fakeClient(["0001_a"]);
    const applied = await applyMigrations(client, migrations);
    expect(applied).toEqual(["0002_b"]);
    expect(executed).not.toContain("SELECT 1;");
    expect(executed).toContain("SELECT 2;");
  });

  it("is a no-op when everything is applied", async () => {
    const { client } = fakeClient(["0001_a", "0002_b"]);
    expect(await applyMigrations(client, migrations)).toEqual([]);
  });

  it("rolls back and reports the failing version", async () => {
    const { client, executed } = fakeClient([], "SELECT 2;");
    await expect(applyMigrations(client, migrations)).rejects.toThrow(/0002_b failed/);
    expect(executed).toContain("ROLLBACK");
  });
});
