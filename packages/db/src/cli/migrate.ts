import pg from "pg";
import { loadDbEnv, MIGRATIONS_DIR } from "../config.js";
import { applyMigrations, loadMigrations } from "../migrator.js";

const env = loadDbEnv();
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  const applied = await applyMigrations(client, await loadMigrations(MIGRATIONS_DIR));
  process.stdout.write(
    applied.length ? `Applied: ${applied.join(", ")}\n` : "Database is up to date\n",
  );
} finally {
  await client.end();
}
