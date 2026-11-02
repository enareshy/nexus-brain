import { and, count, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { agentTriggerEvents, agentTriggers, notifications } from "./schema.js";
import { withUser, type PoolLike, type UserScope } from "./tenant.js";

export type StoredTrigger = typeof agentTriggers.$inferSelect;
export type StoredNotification = typeof notifications.$inferSelect;

export interface DueAgentWork extends UserScope {
  readonly kind: "trigger" | "run";
  readonly id: string;
}

/**
 * The only way to see across people: identifiers of work that is due, and nothing else.
 * Whatever happens next runs inside that person's own scope.
 */
export async function findDueAgentWork(pool: PoolLike, maxItems: number): Promise<DueAgentWork[]> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ tenant_id: string; user_id: string; kind: "trigger" | "run"; id: string }>(
      "SELECT tenant_id, user_id, kind, id FROM due_agent_work($1)",
      [maxItems],
    );
    return rows.map((row) => ({ tenantId: row.tenant_id, userId: row.user_id, kind: row.kind, id: row.id }));
  } finally {
    client.release();
  }
}

/** The limit is checked under a per-user lock, so parallel requests cannot pass it together. */
export function createTrigger(
  pool: PoolLike,
  scope: UserScope,
  trigger: {
    readonly id: string;
    readonly kind: StoredTrigger["kind"];
    readonly goalCiphertext: string;
    readonly intervalMinutes: number;
    readonly firstRunInMinutes: number;
  },
  maxTriggers: number,
): Promise<"created" | "too_many" | "one_jira_trigger"> {
  return withUser(pool, scope, async (db) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trigger|${scope.tenantId}|${scope.userId}`}, 0))`);
    const [existing] = await db.select({ value: count() }).from(agentTriggers);
    if ((existing?.value ?? 0) >= maxTriggers) return "too_many";
    if (trigger.kind === "jira_assigned") {
      const [jira] = await db.select({ value: count() }).from(agentTriggers).where(eq(agentTriggers.kind, "jira_assigned"));
      if ((jira?.value ?? 0) > 0) return "one_jira_trigger";
    }
    const { firstRunInMinutes, ...values } = trigger;
    await db.insert(agentTriggers).values({
      ...values,
      tenantId: scope.tenantId,
      userId: scope.userId,
      nextRunAt: sql`now() + make_interval(mins => ${firstRunInMinutes})`,
    });
    return "created";
  });
}

export function listTriggers(pool: PoolLike, scope: UserScope): Promise<StoredTrigger[]> {
  return withUser(pool, scope, (db) => db.select().from(agentTriggers).orderBy(desc(agentTriggers.createdAt)));
}

export function deleteTrigger(pool: PoolLike, scope: UserScope, id: string): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const rows = await db.delete(agentTriggers).where(eq(agentTriggers.id, id)).returning({ id: agentTriggers.id });
    return rows.length > 0;
  });
}

/** Moves a due trigger's next run on. Only one caller can win, so one due time fires once. */
export function claimTrigger(pool: PoolLike, scope: UserScope, id: string, nextInMinutes: (trigger: StoredTrigger) => number): Promise<StoredTrigger | null> {
  return withUser(pool, scope, async (db) => {
    const [due] = await db
      .select()
      .from(agentTriggers)
      .where(and(eq(agentTriggers.id, id), eq(agentTriggers.enabled, true), lte(agentTriggers.nextRunAt, sql`now()`)))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!due) return null;
    await db
      .update(agentTriggers)
      .set({ nextRunAt: sql`now() + make_interval(mins => ${nextInMinutes(due)})` })
      .where(eq(agentTriggers.id, id));
    return due;
  });
}

export function rescheduleTrigger(pool: PoolLike, scope: UserScope, id: string, inMinutes: number): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db
      .update(agentTriggers)
      .set({ nextRunAt: sql`now() + make_interval(mins => ${inMinutes})` })
      .where(eq(agentTriggers.id, id));
  });
}

export function pauseTrigger(pool: PoolLike, scope: UserScope, id: string, reason: string): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db.update(agentTriggers).set({ enabled: false, pausedReason: reason }).where(eq(agentTriggers.id, id));
  });
}

export function markTriggerBaselined(pool: PoolLike, scope: UserScope, id: string): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db.update(agentTriggers).set({ baselinedAt: sql`now()` }).where(eq(agentTriggers.id, id));
  });
}

/** True the first time an event is seen. */
export function addTriggerEvent(pool: PoolLike, scope: UserScope, triggerId: string, eventHash: string): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const rows = await db
      .insert(agentTriggerEvents)
      .values({ triggerId, eventHash, tenantId: scope.tenantId, userId: scope.userId })
      .onConflictDoNothing()
      .returning({ eventHash: agentTriggerEvents.eventHash });
    return rows.length > 0;
  });
}

export function removeTriggerEvent(pool: PoolLike, scope: UserScope, triggerId: string, eventHash: string): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db.delete(agentTriggerEvents).where(and(eq(agentTriggerEvents.triggerId, triggerId), eq(agentTriggerEvents.eventHash, eventHash)));
  });
}

export function addNotification(
  pool: PoolLike,
  scope: UserScope,
  notification: {
    readonly id: string;
    readonly kind: string;
    readonly dedupeKey: string;
    readonly titleCiphertext: string;
    readonly agentRunId?: string | undefined;
  },
): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db
      .insert(notifications)
      .values({ ...notification, tenantId: scope.tenantId, userId: scope.userId })
      .onConflictDoNothing();
  });
}

export function listNotifications(pool: PoolLike, scope: UserScope, limit: number): Promise<{ items: StoredNotification[]; unread: number }> {
  return withUser(pool, scope, async (db) => {
    const items = await db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit);
    const [unread] = await db.select({ value: count() }).from(notifications).where(isNull(notifications.readAt));
    return { items, unread: unread?.value ?? 0 };
  });
}

export function markNotificationsRead(pool: PoolLike, scope: UserScope, ids?: readonly string[]): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(isNull(notifications.readAt), ids ? inArray(notifications.id, [...ids]) : undefined));
  });
}

/** Viewing a run answers anything it was waiting to say. */
export function markRunNotificationsRead(pool: PoolLike, scope: UserScope, agentRunId: string): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(isNull(notifications.readAt), eq(notifications.agentRunId, agentRunId)));
  });
}
