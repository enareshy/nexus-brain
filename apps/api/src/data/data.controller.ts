import { AppError, ok, type ApiSuccess } from "@brain/core";
import type { Retention } from "@brain/db";
import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { EXPORTS, RETENTION } from "../tokens.js";
import type { ExportApi, PersonalExport } from "./export.service.js";
import type { RetentionApi } from "./retention.service.js";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const days = z.number().int().min(1).max(3650).nullable();
const RetentionSchema = z.strictObject({ conversationDays: days, agentRunDays: days });

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

/** Keeping, exporting and removing data (FR-ADM-03). */
@Controller()
export class DataController {
  constructor(
    @Inject(RETENTION) private readonly retention: RetentionApi,
    @Inject(EXPORTS) private readonly exports: ExportApi,
  ) {}

  /** Everyone may see how long their company keeps chats and runs. */
  @Get("data/retention")
  async getRetention(@Ctx() ctx: RequestContext): Promise<ApiSuccess<Retention>> {
    return ok(await this.retention.get(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Post("admin/retention")
  @HttpCode(200)
  async setRetention(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<Retention>> {
    if (!ADMIN_ROLES.has(ctx.role)) throw new AppError("FORBIDDEN", "Only an admin can change how long data is kept");
    const parsed = RetentionSchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION", "Keep data for 1 to 3,650 days, or leave it empty to keep it");
    return ok(await this.retention.set(scopeOf(ctx), parsed.data), { requestId: ctx.requestId });
  }

  /** The signed-in person's own data, as one file. GET carries nothing secret in its address. */
  @Get("me/export")
  async exportMine(@Ctx() ctx: RequestContext): Promise<ApiSuccess<PersonalExport>> {
    return ok(await this.exports.exportFor(scopeOf(ctx)), { requestId: ctx.requestId });
  }
}
