// Deletes a whole company and all its data (FR-ADM-03, GDPR). For operators: needs the owner role.
// Turn everyone off first in the People page, which revokes their connections.
// Usage: pnpm --filter @brain/db delete-tenant <tenant-id> "<exact company name>"
import { UuidSchema } from "@brain/core";
import pg from "pg";
import { loadDbEnv } from "../config.js";
import { deleteTenant } from "../tenant-delete.js";

const [tenantId = "", name = ""] = process.argv.slice(2);
if (!UuidSchema.safeParse(tenantId).success || !name) throw new Error('Usage: delete-tenant <tenant-id> "<exact company name>"');

const pool = new pg.Pool({ connectionString: loadDbEnv().DATABASE_URL, max: 1 });
try {
  const result = await deleteTenant(pool, tenantId, name);
  // The company's own audit trail goes with it, so the operator's output is the lasting record.
  if (result.deleted) {
    process.stdout.write(`${new Date().toISOString()} company ${tenantId} deleted, with all its data in this database.\n`);
    process.stdout.write("Remove its people's sign-in accounts from the identity provider separately.\n");
  }
  else {
    const why = {
      not_found: "No company has that id.",
      name_mismatch: "That is not the company's name. Nothing was deleted.",
      people_active: `${result.active ?? 0} people are still active. Turn them off first, which revokes their connections.`,
    }[result.reason];
    process.stderr.write(`${why}\n`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
