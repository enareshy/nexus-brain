import type { ClientBase } from "pg";
import { GROUPS, TENANTS, USERS, seedUser } from "./seed-data.js";
import { rollbackQuietly } from "./tx.js";

type Query = Pick<ClientBase, "query">;

/**
 * Idempotent demo seed. Sets `app.tenant_id` before each tenant's rows so it passes
 * the forced RLS policies even when the owner role is not a superuser.
 */
export async function seed(client: Query): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const [key, tenant] of Object.entries(TENANTS)) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
      await seedTenant(client, key as keyof typeof TENANTS);
    }
    await client.query("COMMIT");
  } catch (err) {
    await rollbackQuietly(client);
    throw err;
  }
}

async function seedTenant(client: Query, key: keyof typeof TENANTS): Promise<void> {
  const tenant = TENANTS[key];
  await client.query(
    "INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [tenant.id, tenant.name],
  );
  for (const user of USERS.filter((u) => u.tenant === key)) {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, display_name, role, external_subject)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [user.id, tenant.id, user.email, user.displayName, user.role, user.subject],
    );
  }
  for (const group of GROUPS.filter((g) => g.tenant === key)) {
    await client.query(
      "INSERT INTO groups (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [group.id, tenant.id, group.name],
    );
    for (const member of group.members) {
      await client.query(
        `INSERT INTO group_members (tenant_id, group_id, user_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [tenant.id, group.id, seedUser(member).id],
      );
    }
  }
}
