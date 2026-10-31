import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientBase } from "pg";
import { rollbackQuietly } from "./tx.js";

export interface Migration {
  readonly version: string;
  readonly sql: string;
}

export async function loadMigrations(dir: string): Promise<readonly Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (file) => ({
      version: file.replace(/\.sql$/, ""),
      sql: await readFile(join(dir, file), "utf8"),
    })),
  );
}

/** Applies pending migrations in order, each in its own transaction. Returns applied versions. */
export async function applyMigrations(
  client: Pick<ClientBase, "query">,
  migrations: readonly Migration[],
): Promise<readonly string[]> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
  const done = new Set(rows.map((r) => r.version));
  const pending = migrations.filter((m) => !done.has(m.version));

  const applied: string[] = [];
  for (const migration of pending) {
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
      await client.query("COMMIT");
      applied.push(migration.version);
    } catch (err) {
      await rollbackQuietly(client);
      throw new Error(`Migration ${migration.version} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
  return applied;
}
