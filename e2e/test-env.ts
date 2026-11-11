// Everything the end-to-end run points at, in one place. Values set here win over the repo's `.env`,
// which the API and database scripts only read for what is not already set.

/** Refuses anything but a test database, so a stray override can never reach the dev one. */
function testDatabase(name: string, url: string): string {
  const database = new URL(url).pathname.slice(1);
  if (!database.endsWith("_test")) throw new Error(`${name} must name a database ending in _test, not "${database}"`);
  return url;
}

export const DATABASE_URL = testDatabase("E2E_DATABASE_URL", process.env.E2E_DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test");
export const DATABASE_APP_ROLE_URL = testDatabase(
  "E2E_DATABASE_APP_ROLE_URL",
  process.env.E2E_DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test",
);

/** The local stack only: Keycloak's dev realm, and this run's own API and web app. */
const LOCAL = {
  OIDC_ISSUER: "http://localhost:8081/realms/brain",
  PUBLIC_API_URL: "http://127.0.0.1:3001",
  WEB_APP_URL: "http://localhost:3000",
};

/**
 * Blank, so nothing reaches a paid model or a real outside service even when `.env` has keys: the API
 * treats an empty value as not set.
 */
const NO_OUTSIDE_SERVICES = {
  ANTHROPIC_API_KEY: "",
  GITHUB_MCP_CLIENT_ID: "",
  GITHUB_MCP_CLIENT_SECRET: "",
  GOOGLE_MCP_CLIENT_ID: "",
  GOOGLE_MCP_CLIENT_SECRET: "",
};

function withEnv(extra: Record<string, string>): Record<string, string> {
  const merged = { ...process.env, ...extra };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export const API_ENV = withEnv({ ...LOCAL, ...NO_OUTSIDE_SERVICES, DATABASE_URL, DATABASE_APP_ROLE_URL });
export const WEB_ENV = withEnv({ NEXT_PUBLIC_API_URL: LOCAL.PUBLIC_API_URL, NEXT_PUBLIC_OIDC_ISSUER: LOCAL.OIDC_ISSUER });
export const SETUP_ENV = withEnv({ DATABASE_URL });
