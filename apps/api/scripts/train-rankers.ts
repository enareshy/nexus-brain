// Trains each company's learned ranker from its saved ratings (FR-RET-08). Offline, by an operator.
//   pnpm --filter @brain/api ranker:train
// Reading every company's ratings needs a role that bypasses row-level security (DATABASE_URL, the
// owner); the app's role cannot. Calls no model and nothing outside the database. Prints counts and
// scores only. A company's ranker turns on only if it beats today's order on held-back ratings.
import { loadDbEnv } from "@brain/db";
import pg from "pg";
import { trainCompanyRankers } from "../src/ranking/train.js";

const env = loadDbEnv();
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  const role = await client.query<{ allowed: boolean }>("SELECT rolsuper OR rolbypassrls AS allowed FROM pg_roles WHERE rolname = current_user");
  if (!role.rows[0]?.allowed) throw new Error("This needs a database role that can read every company's ratings");
  const results = await trainCompanyRankers(client);
  if (results.length === 0) process.stdout.write("No ratings saved yet; nothing to train.\n");
  for (const { tenantId, metrics: m } of results) {
    const state = m.active ? "on" : `off (${m.reason === "too_few" ? "too few ratings" : "no better than today's order"})`;
    process.stdout.write(
      `${tenantId}: ${m.examples} results from ${m.answers} rated answers; held-back MRR ${m.holdoutMrr.toFixed(3)} vs ${m.baselineMrr.toFixed(3)} in list order; ${state}\n`,
    );
  }
} finally {
  await client.end();
}
