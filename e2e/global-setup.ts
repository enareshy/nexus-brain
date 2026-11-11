import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SETUP_ENV } from "./test-env.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Brings the test database up to date and seeds the demo companies and people the tests sign in as.
 * The database must exist; integration tests use the same one.
 */
export default function globalSetup(): void {
  for (const script of ["db:migrate", "db:seed"]) {
    try {
      execSync(`pnpm ${script}`, { cwd: ROOT, env: SETUP_ENV, stdio: "inherit" });
    } catch {
      throw new Error(
        `pnpm ${script} failed on the test database. Is Postgres up (pnpm infra:up)? If brain_test does not exist yet: ` +
          "docker exec brain-local-postgres-1 createdb -U brain brain_test",
      );
    }
  }
}
