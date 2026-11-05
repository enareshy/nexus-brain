import { AppError, MAX_TOP_UP_CREDITS, ok, type ApiSuccess } from "@brain/core";
import type { Budget } from "@brain/db";
import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { USAGE } from "../tokens.js";
import type { BudgetStatus, CreditsView, UsageApi, UsageView } from "./usage.service.js";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const MAX_LIMIT_USD = 1_000_000;

const limit = z.number().finite().min(0).max(MAX_LIMIT_USD).nullable();
const BudgetSchema = z.strictObject({
  monthlyLimitUsd: limit,
  perPersonLimitUsd: limit,
  warnAtPercent: z.number().int().min(1).max(100),
});

const TopUpSchema = z.strictObject({ credits: z.number().int().min(1).max(MAX_TOP_UP_CREDITS) });

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

function requireAdmin(ctx: RequestContext) {
  if (!ADMIN_ROLES.has(ctx.role)) throw new AppError("FORBIDDEN", "Only an admin can view or change spending");
  return scopeOf(ctx);
}

@Controller()
export class UsageController {
  constructor(@Inject(USAGE) private readonly usage: UsageApi) {}

  /** The signed-in person's own budget status, so the app can warn before they are stopped. */
  @Get("usage/status")
  async status(@Ctx() ctx: RequestContext): Promise<ApiSuccess<BudgetStatus>> {
    return ok(await this.usage.status(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Get("admin/usage")
  async overview(@Ctx() ctx: RequestContext): Promise<ApiSuccess<UsageView>> {
    return ok(await this.usage.overview(requireAdmin(ctx)), { requestId: ctx.requestId });
  }

  /** Adds credits for this month to the company's plan (FR-MET-04). Recorded, never changed afterwards. */
  @Post("admin/credits")
  @HttpCode(200)
  async addCredits(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<CreditsView>> {
    const scope = requireAdmin(ctx);
    const parsed = TopUpSchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION", `Add a whole number of credits, up to ${MAX_TOP_UP_CREDITS.toLocaleString("en-US")}`);
    return ok(await this.usage.addCredits(scope, parsed.data.credits), { requestId: ctx.requestId });
  }

  @Post("admin/budget")
  @HttpCode(200)
  async setBudget(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<Budget>> {
    const scope = requireAdmin(ctx);
    const parsed = BudgetSchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION", "Limits are amounts in dollars, or empty for no limit");
    // Cents only: the database keeps two decimal places.
    const cents = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
    const budget = { ...parsed.data, monthlyLimitUsd: cents(parsed.data.monthlyLimitUsd), perPersonLimitUsd: cents(parsed.data.perPersonLimitUsd) };
    // A tiny amount that rounds to nothing would silently stop all AI work. Zero must be typed as zero.
    const roundedAway = (asked: number | null, kept: number | null) => asked !== null && asked > 0 && kept === 0;
    if (roundedAway(parsed.data.monthlyLimitUsd, budget.monthlyLimitUsd) || roundedAway(parsed.data.perPersonLimitUsd, budget.perPersonLimitUsd)) {
      throw new AppError("VALIDATION", "A limit must be at least $0.01, or 0 to stop all AI work");
    }
    return ok(await this.usage.setBudget(scope, budget), { requestId: ctx.requestId });
  }
}
