// Sets a company's plan and monthly credits (FR-MET-02). For operators: needs the owner role, which
// the app never has. Usage: pnpm --filter @brain/db set-plan <tenant-id> <plan> [monthly-credits]
import pg from "pg";
import { loadDbEnv } from "../config.js";
import { setPlan } from "../credits.js";
import { parsePlanArgs } from "../plan-args.js";

const { tenantId, plan } = parsePlanArgs(process.argv.slice(2));
const env = loadDbEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
try {
  // An unknown company fails the plan's foreign key, so nothing is written for it.
  await setPlan(pool, tenantId, plan).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "23503") throw new Error("No company has that id");
    throw err;
  });
  process.stdout.write(`Plan set: ${plan.plan}, ${plan.monthlyCredits} credits a month\n`);
} finally {
  await pool.end();
}
