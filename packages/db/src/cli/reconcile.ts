// Compares one month of the usage ledger, for all companies, with the provider's bill (FR-MET-04).
// Usage: pnpm --filter @brain/db reconcile <YYYY-MM> <bill.csv>
// The bill is "model,cost_usd" lines. Reading every company's ledger needs a role that bypasses
// row-level security; the app's role cannot. Prints totals only. Exits 1 when not within 3%.
import { readFileSync } from "node:fs";
import pg from "pg";
import { loadDbEnv } from "../config.js";
import { formatReport, parseBill, reconcile } from "../reconcile.js";

const [month = "", billPath = ""] = process.argv.slice(2);
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !billPath) throw new Error("Usage: reconcile <YYYY-MM> <bill.csv>");
const bill = parseBill(readFileSync(billPath, "utf8"));

const env = loadDbEnv();
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  const role = await client.query<{ allowed: boolean }>("SELECT rolsuper OR rolbypassrls AS allowed FROM pg_roles WHERE rolname = current_user");
  if (!role.rows[0]?.allowed) throw new Error("This needs a database role that can read every company's ledger");
  // Both ends in UTC, worked out here, so the database's time zone cannot move them.
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(year, monthNumber - 1, 1)).toISOString();
  const end = new Date(Date.UTC(year, monthNumber, 1)).toISOString();
  const rows = await client.query<{ model: string; cost: string | null; unpriced: number }>(
    `SELECT model, sum(cost_usd)::text AS cost, (count(*) FILTER (WHERE cost_usd IS NULL))::int AS unpriced
       FROM usage_ledger
      WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
      GROUP BY model`,
    [start, end],
  );
  const ledger = rows.rows.map((r) => ({ model: r.model, costUsd: Number(r.cost ?? 0) }));
  const unpriced = rows.rows.reduce((sum, r) => sum + r.unpriced, 0);
  const report = reconcile(ledger, bill, unpriced);
  process.stdout.write(`${formatReport(month, report)}\n`);
  process.exitCode = report.withinTolerance ? 0 : 1;
} finally {
  await client.end();
}
