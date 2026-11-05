import { AppError, creditsFor, planLabel } from "@brain/core";
import {
  addTopUp,
  creditMonth,
  getBudget,
  getPlan,
  monthSpend,
  saveBudget,
  usageSummary,
  type Budget,
  type CreditMonth,
  type PoolLike,
  type UsageSummary,
  type UserScope,
} from "@brain/db";
import { randomUUID } from "node:crypto";

export type BudgetLevel = "ok" | "warn" | "stop";

/**
 * What a person may know about their own budget. Other people's spending is never included: for the
 * company's limit they see only whether it is nearly or fully used, never how much.
 */
export interface BudgetStatus {
  readonly level: BudgetLevel;
  /** Which limit is closest to being reached, if any. Credits only pause agents and other metered work. */
  readonly limit: "company" | "person" | "credits" | null;
  /** How much of the person's own limit is used. Null for the company's limit. */
  readonly percentUsed: number | null;
}

/** The company's credits this month (FR-MET-02). One credit is one cent of AI cost. */
export interface CreditsView {
  readonly plan: string;
  readonly planLabel: string;
  readonly monthlyCredits: number;
  readonly topUpCredits: number;
  readonly usedCredits: number;
  /** Never below zero, though work already running can use a little more than is left. */
  readonly leftCredits: number;
  readonly level: BudgetLevel;
  readonly topUps: ReadonlyArray<{ readonly id: string; readonly credits: number; readonly addedByEmail: string | null; readonly createdAt: string }>;
}

export interface UsageView {
  readonly summary: UsageSummary;
  readonly budget: Budget | null;
  readonly companyLevel: BudgetLevel;
  /** Null when the company has no plan, and so no credit pool. */
  readonly credits: CreditsView | null;
}

/**
 * What a check is for. Chat on the standard models is "chat": it counts toward spending limits but
 * not credits. Agents and other automatic work are "metered", and stop when credits run out too.
 */
export type WorkKind = "chat" | "metered";

/** Checked before anything that costs money. Throws BUDGET_EXCEEDED when a limit is used up. */
export interface BudgetGuard {
  require(scope: UserScope, work?: WorkKind): Promise<void>;
}

export interface UsageApi extends BudgetGuard {
  /** For showing, not enforcing: may be a few seconds old. */
  status(scope: UserScope): Promise<BudgetStatus>;
  /** Callers must have checked the user is an admin. */
  overview(scope: UserScope): Promise<UsageView>;
  /** Callers must have checked the user is an admin. */
  setBudget(scope: UserScope, budget: Budget): Promise<Budget>;
  /** Callers must have checked the user is an admin. Adds credits for this month. */
  addCredits(scope: UserScope, credits: number): Promise<CreditsView>;
}

/** How long a status shown on screen may be reused. Enforcement always reads afresh. */
const STATUS_TTL_MS = 15_000;
/** The warning level when a company has set no budget of its own. */
const DEFAULT_WARN_AT = 80;

const STOPPED_MESSAGE: Readonly<Record<Measure["limit"], string>> = {
  person: "You have used your AI budget for this month. Ask an admin to raise it.",
  company: "Your company has used its AI budget for this month. Ask an admin to raise it.",
  credits: "Your company has used this month's AI credits, so agents are paused. Ask an admin to add credits.",
};
const MAX_CACHED_STATUSES = 5_000;

interface Measure {
  readonly limit: "company" | "person" | "credits";
  readonly percent: number;
}

/** A pool of zero stops metered work, like a limit of zero. */
function creditsView(month: CreditMonth, warnAt: number): CreditsView {
  const topUpCredits = month.topUps.reduce((sum, topUp) => sum + topUp.credits, 0);
  const total = month.plan.monthlyCredits + topUpCredits;
  const usedCredits = creditsFor(month.meteredUsd);
  return {
    plan: month.plan.plan,
    planLabel: planLabel(month.plan.plan),
    monthlyCredits: month.plan.monthlyCredits,
    topUpCredits,
    usedCredits,
    leftCredits: Math.max(0, total - usedCredits),
    level: levelOf(total <= 0 ? 100 : (usedCredits / total) * 100, warnAt),
    topUps: month.topUps.map((t) => ({ id: t.id, credits: t.credits, addedByEmail: t.addedByEmail, createdAt: t.createdAt.toISOString() })),
  };
}

/**
 * The limit that matters most. A spending limit that is used up stops all AI work, so it is named
 * before used-up credits, which only pause agents: adding credits would not help.
 */
function closer(a: Measure, b: Measure): Measure {
  const stopsAll = (m: Measure) => m.percent >= 100 && m.limit !== "credits";
  if (stopsAll(a) !== stopsAll(b)) return stopsAll(a) ? a : b;
  return b.percent > a.percent ? b : a;
}

const creditPercent = (credits: CreditsView) => {
  const total = credits.monthlyCredits + credits.topUpCredits;
  return total <= 0 ? 100 : (credits.usedCredits / total) * 100;
};

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

  /** Per company, for showing only, so many people's banners share one count of the ledger. */
  private readonly creditCache = new Map<string, { readonly credits: CreditsView | null; readonly at: number }>();

  constructor(private readonly deps: { readonly pool: PoolLike; readonly now?: () => number }) {}

  private credits(scope: UserScope, warnAt: number): Promise<CreditsView | null> {
    return creditMonth(this.deps.pool, scope.tenantId).then((month) => (month ? creditsView(month, warnAt) : null));
  }

  private async cachedCredits(scope: UserScope, warnAt: number): Promise<CreditsView | null> {
    const now = (this.deps.now ?? Date.now)();
    const hit = this.creditCache.get(scope.tenantId);
    if (hit && now - hit.at < STATUS_TTL_MS) return hit.credits;
    const credits = await this.credits(scope, warnAt);
    if (this.creditCache.size >= MAX_CACHED_STATUSES) this.creditCache.clear();
    this.creditCache.set(scope.tenantId, { credits, at: now });
    return credits;
  }

  /** `fresh` is for enforcing; showing may reuse a company's credit count for a few seconds. */
  private async measure(scope: UserScope, work: WorkKind, fresh = true): Promise<{ readonly closest: Measure | null; readonly warnAt: number }> {
    const budget = await getBudget(this.deps.pool, scope.tenantId);
    const warnAt = budget?.warnAtPercent ?? DEFAULT_WARN_AT;
    const measures: Measure[] = [];
    if (budget && (budget.monthlyLimitUsd !== null || budget.perPersonLimitUsd !== null)) {
      const spent = await monthSpend(this.deps.pool, scope);
      if (budget.monthlyLimitUsd !== null) measures.push({ limit: "company", percent: percentOf(spent.company, budget.monthlyLimitUsd) });
      if (budget.perPersonLimitUsd !== null) measures.push({ limit: "person", percent: percentOf(spent.person, budget.perPersonLimitUsd) });
    }
    if (work === "metered") {
      const credits = fresh ? await this.credits(scope, warnAt) : await this.cachedCredits(scope, warnAt);
      if (credits) measures.push({ limit: "credits", percent: creditPercent(credits) });
    }
    if (measures.length === 0) return { closest: null, warnAt };
    return { closest: measures.reduce(closer), warnAt };
  }

  async status(scope: UserScope): Promise<BudgetStatus> {
    const now = (this.deps.now ?? Date.now)();
    const key = `${scope.tenantId}|${scope.userId}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < STATUS_TTL_MS) return hit.status;

    // Credits are included, so the banner can say when agents are paused.
    const { closest, warnAt } = await this.measure(scope, "metered", false);
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

  async require(scope: UserScope, work: WorkKind = "chat"): Promise<void> {
    const { closest } = await this.measure(scope, work);
    if (!closest || closest.percent < 100) return;
    throw new AppError("BUDGET_EXCEEDED", STOPPED_MESSAGE[closest.limit], { limit: closest.limit });
  }

  async overview(scope: UserScope): Promise<UsageView> {
    const [summary, budget] = await Promise.all([usageSummary(this.deps.pool, scope.tenantId), getBudget(this.deps.pool, scope.tenantId)]);
    const companyLevel =
      budget?.monthlyLimitUsd == null ? "ok" : levelOf(percentOf(summary.totalUsd, budget.monthlyLimitUsd), budget.warnAtPercent);
    const credits = await this.credits(scope, budget?.warnAtPercent ?? DEFAULT_WARN_AT);
    return { summary, budget, companyLevel, credits };
  }

  async addCredits(scope: UserScope, credits: number): Promise<CreditsView> {
    if (!(await getPlan(this.deps.pool, scope.tenantId))) throw new AppError("VALIDATION", "Your company has no plan to add credits to");
    await addTopUp(this.deps.pool, scope, { id: randomUUID(), credits });
    this.forgetStatuses(scope);
    const budget = await getBudget(this.deps.pool, scope.tenantId);
    const after = await this.credits(scope, budget?.warnAtPercent ?? DEFAULT_WARN_AT);
    if (!after) throw new AppError("INTERNAL", "Credits could not be read back");
    return after;
  }

  private forgetStatuses(scope: UserScope): void {
    const prefix = `${scope.tenantId}|`;
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key);
    this.creditCache.delete(scope.tenantId);
  }

  async setBudget(scope: UserScope, budget: Budget): Promise<Budget> {
    await saveBudget(this.deps.pool, scope, budget);
    // Banners for everyone in the company should reflect the new limits straight away.
    this.forgetStatuses(scope);
    return budget;
  }
}
