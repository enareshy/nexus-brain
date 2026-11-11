import { sql } from "drizzle-orm";
import type { ModelChoice } from "./ai-settings.js";
import { auditLog } from "./schema.js";
import { withUser, type PoolLike, type UserScope } from "./tenant.js";

/** "ask": the person's agents may propose changes for them to approve. "read_only": they may not. */
export type AgentMode = "ask" | "read_only";

/** A person's own AI choices (FR-AGT-04, FR-LLM-07). Row-level security keeps them theirs. */
export interface AiPreferences {
  readonly mode: AgentMode;
  /** Null: the company's model. Used only while the company lets people choose. */
  readonly modelChoice: ModelChoice | null;
}

export async function getAiPreferences(pool: PoolLike, scope: UserScope): Promise<AiPreferences> {
  const rows = await withUser(pool, scope, async (db) => {
    const result = await db.execute(sql`
      SELECT read_only, model_choice FROM agent_preferences WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}`);
    return result.rows as Array<{ read_only: boolean; model_choice: ModelChoice | null }>;
  });
  return { mode: rows[0]?.read_only ? "read_only" : "ask", modelChoice: rows[0]?.model_choice ?? null };
}

/** "ask" until the person changes it. */
export async function getAgentMode(pool: PoolLike, scope: UserScope): Promise<AgentMode> {
  return (await getAiPreferences(pool, scope)).mode;
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

/** Null goes back to the company's model. The change and its audit entry commit together. */
export async function setModelPreference(pool: PoolLike, scope: UserScope, modelChoice: ModelChoice | null): Promise<void> {
  await withUser(pool, scope, async (db) => {
    await db.execute(sql`
      INSERT INTO agent_preferences (tenant_id, user_id, model_choice)
      VALUES (${scope.tenantId}, ${scope.userId}, ${modelChoice})
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET model_choice = EXCLUDED.model_choice, updated_at = now()`);
    await db.insert(auditLog).values({ tenantId: scope.tenantId, userId: scope.userId, action: "ai.model_preference_changed", meta: { modelChoice } });
  });
}
