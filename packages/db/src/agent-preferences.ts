import { sql } from "drizzle-orm";
import { auditLog } from "./schema.js";
import { withUser, type PoolLike, type UserScope } from "./tenant.js";

/** "ask": the person's agents may propose changes for them to approve. "read_only": they may not. */
export type AgentMode = "ask" | "read_only";

/** The person's own choice (FR-AGT-04); "ask" until they change it. Row-level security keeps it theirs. */
export async function getAgentMode(pool: PoolLike, scope: UserScope): Promise<AgentMode> {
  const rows = await withUser(pool, scope, async (db) => {
    const result = await db.execute(sql`
      SELECT read_only FROM agent_preferences WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}`);
    return result.rows as Array<{ read_only: boolean }>;
  });
  return rows[0]?.read_only ? "read_only" : "ask";
}

/** The change and its audit entry commit together. */
export async function setAgentMode(pool: PoolLike, scope: UserScope, mode: AgentMode): Promise<void> {
  await withUser(pool, scope, async (db) => {
    await db.execute(sql`
      INSERT INTO agent_preferences (tenant_id, user_id, read_only)
      VALUES (${scope.tenantId}, ${scope.userId}, ${mode === "read_only"})
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET read_only = EXCLUDED.read_only, updated_at = now()`);
    await db.insert(auditLog).values({ tenantId: scope.tenantId, userId: scope.userId, action: "agent.mode_changed", meta: { mode } });
  });
}
