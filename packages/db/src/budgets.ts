import { and, desc, eq, gte, sql } from "drizzle-orm";
import { auditLog, tenantBudgets, usageLedger, users } from "./schema.js";
import { withTenant, type PoolLike, type UserScope } from "./tenant.js";

export interface Budget {
  /** Null means no limit at that level. */
  readonly monthlyLimitUsd: number | null;
  readonly perPersonLimitUsd: number | null;
  readonly warnAtPercent: number;
}

/** Calendar months in UTC, so every server agrees on when a month starts. */
const MONTH_START = sql`date_trunc('month', now(), 'UTC')`;

/**
 * A call whose model has no known price still costs money. It counts at this much, more than any one
 * call can cost at known prices, so an unpriced model can never slip past a limit unnoticed.
 */
export const UNPRICED_CALL_USD = 0.5;

/** Every call's cost in dollars, with unpriced calls counted cautiously. */
const COUNTED_COST = sql`coalesce(${usageLedger.costUsd}, ${UNPRICED_CALL_USD})`;

const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));
const toColumn = (value: number | null): string | null => (value === null ? null : value.toFixed(2));

/** The company's limits, or null when it has never set any. */
export async function getBudget(pool: PoolLike, tenantId: string): Promise<Budget | null> {
  const [row] = await withTenant(pool, tenantId, (db) =>
    // RLS already scopes to the tenant; the explicit filter is defence in depth.
    db.select().from(tenantBudgets).where(eq(tenantBudgets.tenantId, tenantId)).limit(1),
  );
  if (!row) return null;
  return {
    monthlyLimitUsd: toNumber(row.monthlyLimitUsd),
    perPersonLimitUsd: toNumber(row.perPersonLimitUsd),
    warnAtPercent: row.warnAtPercent,
  };
}

/**
 * Callers must have checked the user is an admin. The change and its audit entry, with the limits
 * before and after, commit together; the lock makes two admins saving at once take turns.
 */
export function saveBudget(pool: PoolLike, scope: UserScope, budget: Budget): Promise<void> {
  return withTenant(pool, scope.tenantId, async (db) => {
    const [before] = await db
      .select()
      .from(tenantBudgets)
      .where(eq(tenantBudgets.tenantId, scope.tenantId))
      .for("update");
    const values = {
      monthlyLimitUsd: toColumn(budget.monthlyLimitUsd),
      perPersonLimitUsd: toColumn(budget.perPersonLimitUsd),
      warnAtPercent: budget.warnAtPercent,
      updatedBy: scope.userId,
      updatedAt: new Date(),
    };
    await db
      .insert(tenantBudgets)
      .values({ ...values, tenantId: scope.tenantId })
      .onConflictDoUpdate({ target: tenantBudgets.tenantId, set: values });
    await db.insert(auditLog).values({
      tenantId: scope.tenantId,
      userId: scope.userId,
      action: "usage.budget_changed",
      meta: {
        before: before
          ? { monthlyLimitUsd: toNumber(before.monthlyLimitUsd), perPersonLimitUsd: toNumber(before.perPersonLimitUsd), warnAtPercent: before.warnAtPercent }
          : null,
        after: budget,
      },
    });
  });
}

/** What the company and this person have spent so far this month, in US dollars. */
export async function monthSpend(pool: PoolLike, scope: UserScope): Promise<{ readonly company: number; readonly person: number }> {
  const [row] = await withTenant(pool, scope.tenantId, (db) =>
    db
      .select({
        company: sql<string>`coalesce(sum(${COUNTED_COST}), 0)`,
        person: sql<string>`coalesce(sum(${COUNTED_COST}) filter (where ${usageLedger.userId} = ${scope.userId}), 0)`,
      })
      .from(usageLedger)
      .where(and(eq(usageLedger.tenantId, scope.tenantId), gte(usageLedger.createdAt, MONTH_START))),
  );
  return { company: Number(row?.company ?? 0), person: Number(row?.person ?? 0) };
}

export interface UsageSummary {
  readonly monthStart: Date;
  /** Includes calls with no known price, counted at UNPRICED_CALL_USD each. */
  readonly totalUsd: number;
  readonly calls: number;
  readonly unpricedCalls: number;
  readonly byFeature: ReadonlyArray<{ readonly feature: string; readonly costUsd: number; readonly calls: number }>;
  readonly byPerson: ReadonlyArray<{ readonly userId: string; readonly email: string | null; readonly costUsd: number; readonly calls: number }>;
  readonly byDay: ReadonlyArray<{ readonly day: string; readonly costUsd: number }>;
}

/** This month's spending for the whole company. Callers must have checked the user is an admin. */
export function usageSummary(pool: PoolLike, tenantId: string): Promise<UsageSummary> {
  return withTenant(pool, tenantId, async (db) => {
    const thisMonth = and(eq(usageLedger.tenantId, tenantId), gte(usageLedger.createdAt, MONTH_START));
    const cost = sql<string>`coalesce(sum(${COUNTED_COST}), 0)`;
    const calls = sql<number>`count(*)::int`;
    const [[start], [totals], byFeature, byPerson, byDay] = await Promise.all([
      db.select({ value: sql<string>`${MONTH_START}::text` }).from(sql`(select 1) as one`),
      db
        .select({ cost, calls, unpriced: sql<number>`count(*) filter (where ${usageLedger.costUsd} is null)::int` })
        .from(usageLedger)
        .where(thisMonth),
      db.select({ feature: usageLedger.feature, cost, calls }).from(usageLedger).where(thisMonth).groupBy(usageLedger.feature).orderBy(desc(cost)),
      db
        .select({ userId: usageLedger.userId, email: users.email, cost, calls })
        .from(usageLedger)
        .leftJoin(users, and(eq(users.id, usageLedger.userId), eq(users.tenantId, usageLedger.tenantId)))
        .where(thisMonth)
        .groupBy(usageLedger.userId, users.email)
        .orderBy(desc(cost)),
      db
        .select({ day: sql<string>`to_char(${usageLedger.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`, cost })
        .from(usageLedger)
        .where(thisMonth)
        .groupBy(sql`1`)
        .orderBy(sql`1`),
    ]);
    return {
      monthStart: new Date(start!.value),
      totalUsd: Number(totals?.cost ?? 0),
      calls: totals?.calls ?? 0,
      unpricedCalls: totals?.unpriced ?? 0,
      byFeature: byFeature.map((r) => ({ feature: r.feature, costUsd: Number(r.cost), calls: r.calls })),
      byPerson: byPerson.map((r) => ({ userId: r.userId, email: r.email, costUsd: Number(r.cost), calls: r.calls })),
      byDay: byDay.map((r) => ({ day: r.day, costUsd: Number(r.cost) })),
    };
  });
}
