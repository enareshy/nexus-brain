import { and, asc, eq, gte, like, sql } from "drizzle-orm";
import { UNPRICED_CALL_USD } from "./budgets.js";
import { auditLog, creditTopups, tenantPlans, usageLedger, users } from "./schema.js";
import { withTenant, type PoolLike, type UserScope } from "./tenant.js";

export interface Plan {
  readonly plan: string;
  readonly monthlyCredits: number;
}

export interface TopUp {
  readonly id: string;
  readonly credits: number;
  readonly addedByEmail: string | null;
  readonly createdAt: Date;
}

export interface CreditMonth {
  readonly plan: Plan;
  readonly topUps: readonly TopUp[];
  /** Dollars of metered AI work this month; credits are cents of it. */
  readonly meteredUsd: number;
}

/** Calendar months in UTC, the same as budgets. */
const MONTH_START = sql`date_trunc('month', now(), 'UTC')`;

/**
 * What uses credits: agent work, whether started by a person or automatically. Chat never does, even
 * on a fallback model, since answers are checked only against spending limits and could otherwise
 * pause everyone's agents. Unpriced calls count cautiously, as they do for budgets.
 */
const METERED = like(usageLedger.feature, "agent%");

/** The company's plan, or null when it has none, and so no credit pool. */
export async function getPlan(pool: PoolLike, tenantId: string): Promise<Plan | null> {
  const [row] = await withTenant(pool, tenantId, (db) =>
    db.select({ plan: tenantPlans.plan, monthlyCredits: tenantPlans.monthlyCredits }).from(tenantPlans).where(eq(tenantPlans.tenantId, tenantId)),
  );
  return row ?? null;
}

/** This month's plan, top-ups and metered spending, read together. Null without a plan. */
export function creditMonth(pool: PoolLike, tenantId: string): Promise<CreditMonth | null> {
  return withTenant(pool, tenantId, async (db) => {
    const [plan] = await db
      .select({ plan: tenantPlans.plan, monthlyCredits: tenantPlans.monthlyCredits })
      .from(tenantPlans)
      .where(eq(tenantPlans.tenantId, tenantId));
    if (!plan) return null;
    const [topUps, [spent]] = await Promise.all([
      db
        .select({ id: creditTopups.id, credits: creditTopups.credits, addedByEmail: users.email, createdAt: creditTopups.createdAt })
        .from(creditTopups)
        .leftJoin(users, and(eq(users.tenantId, creditTopups.tenantId), eq(users.id, creditTopups.addedBy)))
        .where(and(eq(creditTopups.tenantId, tenantId), gte(creditTopups.createdAt, MONTH_START)))
        .orderBy(asc(creditTopups.createdAt)),
      db
        .select({ usd: sql<string>`coalesce(sum(coalesce(${usageLedger.costUsd}, ${UNPRICED_CALL_USD})), 0)` })
        .from(usageLedger)
        .where(and(eq(usageLedger.tenantId, tenantId), gte(usageLedger.createdAt, MONTH_START), METERED)),
    ]);
    return { plan, topUps, meteredUsd: Number(spent?.usd ?? 0) };
  });
}

/** Callers must have checked the person is an admin. The top-up and its audit entry commit together. */
export function addTopUp(pool: PoolLike, scope: UserScope, topUp: { readonly id: string; readonly credits: number }): Promise<void> {
  return withTenant(pool, scope.tenantId, async (db) => {
    await db.insert(creditTopups).values({ ...topUp, tenantId: scope.tenantId, addedBy: scope.userId });
    await db.insert(auditLog).values({
      tenantId: scope.tenantId,
      userId: scope.userId,
      action: "usage.credits_added",
      resource: topUp.id,
      meta: { credits: topUp.credits },
    });
  });
}

/**
 * For operators only: needs the owner role, as the app's role cannot write plans. Records who ran it
 * as nobody in particular, since it runs outside any person's session.
 */
export function setPlan(pool: PoolLike, tenantId: string, plan: Plan): Promise<void> {
  return withTenant(pool, tenantId, async (db) => {
    const [before] = await db.select().from(tenantPlans).where(eq(tenantPlans.tenantId, tenantId)).for("update");
    const values = { plan: plan.plan, monthlyCredits: plan.monthlyCredits, updatedAt: new Date() };
    await db.insert(tenantPlans).values({ ...values, tenantId }).onConflictDoUpdate({ target: tenantPlans.tenantId, set: values });
    await db.insert(auditLog).values({
      tenantId,
      userId: null,
      action: "usage.plan_changed",
      meta: { before: before ? { plan: before.plan, monthlyCredits: before.monthlyCredits } : null, after: plan },
    });
  });
}
