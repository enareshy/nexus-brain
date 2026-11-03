import pg from "pg";

// Integration tests get their own database, so they can never touch the dev database
// that holds real connections. Any name not ending in `_test` is refused.

const DEFAULT_OWNER_URL = "postgres://brain:brain@localhost:5432/brain";
const DEFAULT_APP_URL = "postgres://brain_app:brain_app@localhost:5432/brain";
const TEST_SUFFIX = "_test";

export interface TestDatabaseUrls {
  ownerUrl: string;
  appUrl: string;
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

function toTestUrl(raw: string): string {
  const url = new URL(raw);
  const name = databaseName(url);
  if (!name) throw new Error("Test database URL has no database name");
  if (!name.endsWith(TEST_SUFFIX)) url.pathname = `/${name}${TEST_SUFFIX}`;
  return url.toString();
}

/** Picks the test database: TEST_* if set, else the dev URLs with `_test` added to the name. */
export function testDatabaseUrls(env: Record<string, string | undefined> = process.env): TestDatabaseUrls {
  const ownerUrl = toTestUrl(env.TEST_DATABASE_URL ?? env.DATABASE_URL ?? DEFAULT_OWNER_URL);
  const appUrl = toTestUrl(env.TEST_DATABASE_APP_ROLE_URL ?? env.DATABASE_APP_ROLE_URL ?? DEFAULT_APP_URL);
  if (databaseName(new URL(ownerUrl)) !== databaseName(new URL(appUrl))) {
    throw new Error("Test owner and app URLs must name the same database");
  }
  return { ownerUrl, appUrl };
}

/** Env for the vitest `test.env` option, so every integration test connects to the test database. */
export function testDatabaseEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const { ownerUrl, appUrl } = testDatabaseUrls(env);
  return { DATABASE_URL: ownerUrl, DATABASE_APP_ROLE_URL: appUrl };
}

const DUPLICATE_DATABASE = "42P04";

/** Creates the test database when missing. Tests migrate and seed it themselves. */
export async function ensureTestDatabase(ownerUrl: string): Promise<void> {
  const target = new URL(ownerUrl);
  const name = databaseName(target);
  if (!name.endsWith(TEST_SUFFIX)) throw new Error(`Refusing to use "${name}" as a test database`);
  const maintenance = new URL(ownerUrl);
  maintenance.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (found.rowCount) return;
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
  } catch (err) {
    if ((err as { code?: string }).code !== DUPLICATE_DATABASE) throw err;
  } finally {
    await client.end();
  }
}
