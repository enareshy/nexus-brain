import { AppError, ok, UuidSchema, type ApiSuccess } from "@brain/core";
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { AGENTS } from "../tokens.js";
import type { AgentModeView, AgentRunSummary, AgentRunView, AgentsApi } from "./agents.service.js";

/** A skill comes with the version the person read, so one changed since is refused rather than followed unseen. */
const StartSchema = z
  .strictObject({ goal: z.string().trim().min(1).max(2_000), skillId: UuidSchema.optional(), skillVersion: z.string().max(40).optional() })
  .refine((body) => !body.skillId === !body.skillVersion);

const ModeSchema = z.strictObject({ mode: z.enum(["ask", "read_only"]) });

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION", "Invalid request parameters");
  return result.data;
}

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

/** Always the signed-in person's own runs. A run acts as them, with their connections. */
@Controller("agent-runs")
export class AgentsController {
  constructor(@Inject(AGENTS) private readonly agents: AgentsApi) {}

  /** The person's own choice of whether their agents may propose changes (FR-AGT-04). */
  @Get("mode")
  async mode(@Ctx() ctx: RequestContext): Promise<ApiSuccess<AgentModeView>> {
    return ok(await this.agents.mode(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Post("mode")
  @HttpCode(200)
  async setMode(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<AgentModeView>> {
    return ok(await this.agents.setMode(scopeOf(ctx), parse(ModeSchema, body).mode), { requestId: ctx.requestId });
  }

  @Post()
  @HttpCode(201)
  async start(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<AgentRunSummary>> {
    const { goal, skillId, skillVersion } = parse(StartSchema, body);
    const skill = skillId && skillVersion ? { skill: { id: skillId, version: skillVersion } } : {};
    return ok(await this.agents.start(scopeOf(ctx), goal, skill), { requestId: ctx.requestId });
  }

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<ApiSuccess<readonly AgentRunSummary[]>> {
    return ok(await this.agents.list(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Get(":id")
  async get(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<AgentRunView>> {
    return ok(await this.agents.get(scopeOf(ctx), parse(UuidSchema, id)), { requestId: ctx.requestId });
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<{ cancelled: true }>> {
    await this.agents.cancel(scopeOf(ctx), parse(UuidSchema, id));
    return ok({ cancelled: true as const }, { requestId: ctx.requestId });
  }
}
