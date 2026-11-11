import { AppError, ok, type ApiSuccess } from "@brain/core";
import { MAX_AUTOMATIC_RUNS_PER_DAY, type AiSettings } from "@brain/db";
import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { AI_SETTINGS } from "../tokens.js";
import type { AiSettingsApi } from "./ai-settings.service.js";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const AiSettingsSchema = z.strictObject({
  modelChoice: z.enum(["premium", "standard"]),
  agentsEnabled: z.boolean(),
  automaticAgentsEnabled: z.boolean(),
  automaticRunsPerDay: z.number().int().min(1).max(MAX_AUTOMATIC_RUNS_PER_DAY),
  agentChangesAllowed: z.boolean(),
});

/** The company's AI settings (FR-ADM-02). */
@Controller()
export class AiSettingsController {
  constructor(@Inject(AI_SETTINGS) private readonly settings: AiSettingsApi) {}

  /** Everyone may see them, so the Agents page can say when agents are turned off. */
  @Get("ai-settings")
  async get(@Ctx() ctx: RequestContext): Promise<ApiSuccess<AiSettings>> {
    return ok(await this.settings.get(ctx.tenantId), { requestId: ctx.requestId });
  }

  @Post("admin/ai-settings")
  @HttpCode(200)
  async set(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<AiSettings>> {
    if (!ADMIN_ROLES.has(ctx.role)) throw new AppError("FORBIDDEN", "Only an admin can change the company's AI settings");
    const parsed = AiSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION", `Choose a model, and allow 1 to ${MAX_AUTOMATIC_RUNS_PER_DAY} automatic runs a day`);
    }
    return ok(await this.settings.set({ tenantId: ctx.tenantId, userId: ctx.userId }, parsed.data), { requestId: ctx.requestId });
  }
}
