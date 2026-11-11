import { AppError } from "@brain/core";
import { and, eq } from "drizzle-orm";
import { auditLog, tenantAiSettings, users } from "./schema.js";
import { withTenant, type PoolLike, type UserScope } from "./tenant.js";

export type ModelChoice = "premium" | "standard";

/** What a company's admins allow its AI to do (FR-ADM-02, FR-LLM-07). */
export interface AiSettings {
  /** The model answers and agents use. */
  readonly modelChoice: ModelChoice;
  /** Off: nobody can start an agent, and runs already going stop before their next step. */
  readonly agentsEnabled: boolean;
  /** Off: automatic agents skip their runs. People can still start agents themselves. */
  readonly automaticAgentsEnabled: boolean;
  /** Automatic runs each person may have in a day, from 1 to 10. */
  readonly automaticRunsPerDay: number;
  /** Off: agents only search and answer, and cannot propose changes for anyone (FR-AGT-04). */
  readonly agentChangesAllowed: boolean;
  /** On: each person may pick their own model; the one above is the default for those who do not. */
  readonly peopleChooseModel: boolean;
}

export const MAX_AUTOMATIC_RUNS_PER_DAY = 10;

export const DEFAULT_AI_SETTINGS: AiSettings = Object.freeze({
  modelChoice: "premium",
  agentsEnabled: true,
  automaticAgentsEnabled: true,
  automaticRunsPerDay: MAX_AUTOMATIC_RUNS_PER_DAY,
  agentChangesAllowed: true,
  peopleChooseModel: false,
});

const COLUMNS = {
  modelChoice: tenantAiSettings.modelChoice,
  agentsEnabled: tenantAiSettings.agentsEnabled,
  automaticAgentsEnabled: tenantAiSettings.automaticAgentsEnabled,
  automaticRunsPerDay: tenantAiSettings.automaticRunsPerDay,
  agentChangesAllowed: tenantAiSettings.agentChangesAllowed,
  peopleChooseModel: tenantAiSettings.peopleChooseModel,
};
const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** The model a person's answers and agents use: their own choice while the company allows it, else the company's. */
export function effectiveModel(settings: Pick<AiSettings, "modelChoice" | "peopleChooseModel">, personal: ModelChoice | null): ModelChoice {
  return settings.peopleChooseModel && personal ? personal : settings.modelChoice;
}

/** The company's settings, or the defaults when its admins have never changed them. */
export async function getAiSettings(pool: PoolLike, tenantId: string): Promise<AiSettings> {
  const [row] = await withTenant(pool, tenantId, (db) => db.select(COLUMNS).from(tenantAiSettings).where(eq(tenantAiSettings.tenantId, tenantId)));
  return row ?? DEFAULT_AI_SETTINGS;
}

/**
 * Only an active admin may change them, read again here so a role removed a moment ago no longer
 * counts. The change and its audit entry, with the old and new values, commit together.
 */
export function saveAiSettings(pool: PoolLike, scope: UserScope, settings: AiSettings): Promise<void> {
  return withTenant(pool, scope.tenantId, async (db) => {
    const [actor] = await db
      .select({ role: users.role, deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, scope.userId)))
      .for("share");
    if (!actor || actor.deactivatedAt || !ADMIN_ROLES.has(actor.role)) {
      throw new AppError("FORBIDDEN", "Only an admin can change the company's AI settings");
    }
    const [before] = await db.select(COLUMNS).from(tenantAiSettings).where(eq(tenantAiSettings.tenantId, scope.tenantId)).for("update");
    const values = { ...settings, updatedBy: scope.userId, updatedAt: new Date() };
    await db
      .insert(tenantAiSettings)
      .values({ ...values, tenantId: scope.tenantId })
      .onConflictDoUpdate({ target: tenantAiSettings.tenantId, set: values });
    await db.insert(auditLog).values({
      tenantId: scope.tenantId,
      userId: scope.userId,
      action: "admin.ai_settings_changed",
      meta: { before: before ?? DEFAULT_AI_SETTINGS, after: settings },
    });
  });
}
