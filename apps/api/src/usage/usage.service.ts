import { AppError } from "@brain/core";
import { getBudget, monthSpend, saveBudget, usageSummary, type Budget, type PoolLike, type UsageSummary, type UserScope } from "@brain/db";

export type BudgetLevel = "ok" | "warn" | "stop";

/**
 * What a person may know about their own budget. Other people's spending is never included: for the
 * company's limit they see only whether it is nearly or fully used, never how much.
 */
export interface BudgetStatus {
  readonly level: BudgetLevel;
  /** Which limit is closest to being reached, if any. */
  readonly limit: "company" | "person" | null;
  /** How much of the person's own limit is used. Null for the company's limit. */
  readonly percentUsed: number | null;
}

export interface UsageView {
  readonly summary: UsageSummary;
  readonly budget: Budget | null;
  readonly companyLevel: BudgetLevel;
}

/** Checked before anything that costs money. Throws BUDGET_EXCEEDED when a limit is used up. */
export interface BudgetGuard {
  require(scope: UserScope): Promise<void>;
}

export interface UsageApi extends BudgetGuard {
  /** For showing, not enforcing: may be a few seconds old. */
  status(scope: UserScope): Promise<BudgetStatus>;
  /** Callers must have checked the user is an admin. */
  overview(scope: UserScope): Promise<UsageView>;
  /** Callers must have checked the user is an admin. */
  setBudget(scope: UserScope, budget: Budget): Promise<Budget>;
}

/** How long a status shown on screen may be reused. Enforcement always reads afresh. */
const STATUS_TTL_MS = 15_000;
const MAX_CACHED_STATUSES = 5_000;

interface Measure {
  readonly limit: "company" | "person";
  readonly percent: number;
}

function levelOf(percent: number, warnAt: number): BudgetLevel {
  if (percent >= 100) return "stop";
  return percent >= warnAt ? "warn" : "ok";
}

/** A limit of zero stops everything; otherwise the share used, as a percentage. */
function percentOf(spent: number, limitUsd: number): number {
  return limitUsd <= 0 ? 100 : (spent / limitUsd) * 100;
}

/**
 * Monthly AI spending limits for the company and for each person (FR-MET-03). Spend comes from the
 * usage ledger, so a call is counted once it finishes. Calls already running when a limit is reached
 * still complete, for everyone in the company: the overshoot is at most the calls in flight at that
 * moment. Months are calendar months in UTC.
 */
export class UsageService implements UsageApi {
  private readonly cache = new Map<string, { readonly status: BudgetStatus; readonly at: number }>();

  constructor(private readonly deps: { readonly pool: PoolLike; readonly now?: () => number }) {}

  private async measure(scope: UserScope): Promise<{ readonly closest: Measure | null; readonly warnAt: number }> {
    const budget = await getBudget(this.deps.pool, scope.tenantId);
    if (!budget || (budget.monthlyLimitUsd === null && budget.perPersonLimitUsd === null)) return { closest: null, warnAt: 100 };
    const spent = await monthSpend(this.deps.pool, scope);
    const measures: Measure[] = [];
    if (budget.monthlyLimitUsd !== null) measures.push({ limit: "company", percent: percentOf(spent.company, budget.monthlyLimitUsd) });
    if (budget.perPersonLimitUsd !== null) measures.push({ limit: "person", percent: percentOf(spent.person, budget.perPersonLimitUsd) });
    return { closest: measures.reduce((a, b) => (b.percent > a.percent ? b : a)), warnAt: budget.warnAtPercent };
  }

  async status(scope: UserScope): Promise<BudgetStatus> {
    const now = (this.deps.now ?? Date.now)();
    const key = `${scope.tenantId}|${scope.userId}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < STATUS_TTL_MS) return hit.status;

    const { closest, warnAt } = await this.measure(scope);
    const status: BudgetStatus = closest
      ? {
          level: levelOf(closest.percent, warnAt),
          limit: closest.limit,
          // Rounded down, so "100%" only ever shows once the limit is actually reached.
          percentUsed: closest.limit === "person" ? Math.floor(closest.percent) : null,
        }
      : { level: "ok", limit: null, percentUsed: null };
    if (this.cache.size >= MAX_CACHED_STATUSES) this.cache.clear();
    this.cache.set(key, { status, at: now });
    return status;
  }

  async require(scope: UserScope): Promise<void> {
    const { closest } = await this.measure(scope);
    if (!closest || closest.percent < 100) return;
    throw new AppError(
      "BUDGET_EXCEEDED",
      closest.limit === "person"
        ? "You have used your AI budget for this month. Ask an admin to raise it."
        : "Your company has used its AI budget for this month. Ask an admin to raise it.",
      { limit: closest.limit },
    );
  }

  async overview(scope: UserScope): Promise<UsageView> {
    const [summary, budget] = await Promise.all([usageSummary(this.deps.pool, scope.tenantId), getBudget(this.deps.pool, scope.tenantId)]);
    const companyLevel =
      budget?.monthlyLimitUsd == null ? "ok" : levelOf(percentOf(summary.totalUsd, budget.monthlyLimitUsd), budget.warnAtPercent);
    return { summary, budget, companyLevel };
  }

  async setBudget(scope: UserScope, budget: Budget): Promise<Budget> {
    await saveBudget(this.deps.pool, scope, budget);
    // Banners for everyone in the company should reflect the new limits straight away.
    const prefix = `${scope.tenantId}|`;
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key);
    return budget;
  }
}
