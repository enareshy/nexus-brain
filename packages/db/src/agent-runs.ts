import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentRuns, agentSteps } from "./schema.js";
import { withUser, type PoolLike, type UserScope } from "./tenant.js";

export type AgentRunStatus = "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
export type StoredAgentRun = typeof agentRuns.$inferSelect;
export type StoredAgentStep = typeof agentSteps.$inferSelect;

export interface AgentRunLimits {
  readonly maxWorking: number;
  readonly maxRecent: number;
  readonly recentSince: Date;
  /** Applies only to runs started by a trigger, which spend money with nobody watching. */
  readonly maxTriggeredRecent?: number;
  readonly triggeredSince?: Date;
  /** Working runs a trigger may hold, so a person always has a slot for their own. */
  readonly maxTriggeredWorking?: number;
}

/** The limits are checked under a per-user lock, so parallel starts cannot pass them together. */
export function createAgentRun(
  pool: PoolLike,
  scope: UserScope,
  run: {
    readonly id: string;
    readonly goalCiphertext: string;
    readonly stateCiphertext: string;
    readonly deadlineAt: Date;
    readonly triggerId?: string | undefined;
  },
  limits: AgentRunLimits,
): Promise<"created" | "too_many_working" | "too_many_recent" | "too_many_triggered"> {
  return withUser(pool, scope, async (db) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent|${scope.tenantId}|${scope.userId}`}, 0))`);
    const [working] = await db.select({ value: count() }).from(agentRuns).where(eq(agentRuns.status, "running"));
    if ((working?.value ?? 0) >= limits.maxWorking) return "too_many_working";
    const [recent] = await db.select({ value: count() }).from(agentRuns).where(gt(agentRuns.createdAt, limits.recentSince));
    if ((recent?.value ?? 0) >= limits.maxRecent) return "too_many_recent";
    if (run.triggerId && limits.maxTriggeredWorking !== undefined) {
      const [busy] = await db
        .select({ value: count() })
        .from(agentRuns)
        .where(and(isNotNull(agentRuns.triggerId), eq(agentRuns.status, "running")));
      if ((busy?.value ?? 0) >= limits.maxTriggeredWorking) return "too_many_working";
    }
    if (run.triggerId && limits.maxTriggeredRecent !== undefined && limits.triggeredSince) {
      const [triggered] = await db
        .select({ value: count() })
        .from(agentRuns)
        .where(and(isNotNull(agentRuns.triggerId), gt(agentRuns.createdAt, limits.triggeredSince)));
      if ((triggered?.value ?? 0) >= limits.maxTriggeredRecent) return "too_many_triggered";
    }
    await db.insert(agentRuns).values({ ...run, status: "running", tenantId: scope.tenantId, userId: scope.userId });
    return "created";
  });
}

export function getAgentRun(pool: PoolLike, scope: UserScope, id: string): Promise<StoredAgentRun | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    return row ?? null;
  });
}

export function listAgentRuns(pool: PoolLike, scope: UserScope, limit: number): Promise<StoredAgentRun[]> {
  return withUser(pool, scope, (db) => db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(limit));
}

/**
 * Takes the run if nothing is advancing it. Only one caller can win, so two processes never work
 * on one run. Runs already finished cannot be claimed.
 */
export function claimAgentRun(pool: PoolLike, scope: UserScope, id: string, leaseMs: number): Promise<StoredAgentRun | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db
      .update(agentRuns)
      .set({ leaseToken: randomUUID(), leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})` })
      .where(
        and(
          eq(agentRuns.id, id),
          inArray(agentRuns.status, ["running", "waiting_approval"]),
          or(isNull(agentRuns.leaseUntil), lt(agentRuns.leaseUntil, sql`now()`)),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export interface AgentRunProgress {
  readonly stateCiphertext: string;
  readonly status: AgentRunStatus;
  readonly turnCount: number;
  readonly costUsd: number;
  readonly waitingProposalId?: string | null;
  readonly resultCiphertext?: string | null;
  readonly errorCode?: string | null;
  /** Null gives the run up, so another process can pick it up later. */
  readonly leaseMs: number | null;
}

/** Saves progress. False means the run was cancelled or another worker took it, so this one must stop. */
export function saveAgentRun(
  pool: PoolLike,
  scope: UserScope,
  id: string,
  leaseToken: string,
  progress: AgentRunProgress,
): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const { leaseMs, costUsd, ...rest } = progress;
    const rows = await db
      .update(agentRuns)
      .set({
        ...rest,
        costUsd: costUsd.toFixed(6),
        updatedAt: sql`now()`,
        leaseUntil: leaseMs === null ? null : sql`now() + make_interval(secs => ${leaseMs / 1000})`,
      })
      .where(and(eq(agentRuns.id, id), eq(agentRuns.leaseToken, leaseToken), inArray(agentRuns.status, ["running", "waiting_approval"])))
      .returning({ id: agentRuns.id });
    return rows.length > 0;
  });
}

export function cancelAgentRun(pool: PoolLike, scope: UserScope, id: string): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const rows = await db
      .update(agentRuns)
      .set({ status: "cancelled", errorCode: "cancelled", leaseUntil: null, updatedAt: sql`now()` })
      .where(and(eq(agentRuns.id, id), inArray(agentRuns.status, ["running", "waiting_approval"])))
      .returning({ id: agentRuns.id });
    return rows.length > 0;
  });
}

/** A repeated step after a restart keeps the first record. */
export function addAgentStep(
  pool: PoolLike,
  scope: UserScope,
  step: {
    readonly runId: string;
    readonly seq: number;
    readonly toolName: string;
    readonly argsHash: string;
    readonly outcome: string;
    readonly detailCiphertext: string;
  },
): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db
      .insert(agentSteps)
      .values({ ...step, tenantId: scope.tenantId, userId: scope.userId })
      .onConflictDoNothing();
  });
}

/** Steps for many runs at once, by run, in order. */
export async function listAgentStepsForRuns(pool: PoolLike, scope: UserScope, runIds: readonly string[]): Promise<Map<string, StoredAgentStep[]>> {
  const byRun = new Map<string, StoredAgentStep[]>();
  if (runIds.length === 0) return byRun;
  const rows = await withUser(pool, scope, (db) =>
    db.select().from(agentSteps).where(inArray(agentSteps.runId, [...runIds])).orderBy(asc(agentSteps.runId), asc(agentSteps.seq)),
  );
  for (const row of rows) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
  return byRun;
}

export function listAgentSteps(pool: PoolLike, scope: UserScope, runId: string): Promise<StoredAgentStep[]> {
  return withUser(pool, scope, (db) =>
    db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(asc(agentSteps.seq)),
  );
}
