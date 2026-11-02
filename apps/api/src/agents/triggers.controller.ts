import { AppError, ok, UuidSchema, type ApiSuccess } from "@brain/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { TRIGGERS } from "../tokens.js";
import type { NotificationView, TriggersApi, TriggerView } from "./triggers.service.js";

const Goal = z.string().trim().min(1).max(2_000);
const NewTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("schedule"), goal: Goal, schedule: z.enum(["hourly", "daily", "weekly"]) }),
  z.strictObject({ kind: z.literal("jira_assigned"), goal: Goal }),
]);
const MarkReadSchema = z.strictObject({ ids: z.array(UuidSchema).min(1).max(100).optional() });

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION", "Invalid request parameters");
  return result.data;
}

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

/** Always the signed-in person's own. An automatic agent acts as them, with their connections. */
@Controller()
export class TriggersController {
  constructor(@Inject(TRIGGERS) private readonly triggers: TriggersApi) {}

  @Post("agent-triggers")
  @HttpCode(201)
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<TriggerView>> {
    return ok(await this.triggers.create(scopeOf(ctx), parse(NewTriggerSchema, body)), { requestId: ctx.requestId });
  }

  @Get("agent-triggers")
  async list(@Ctx() ctx: RequestContext): Promise<ApiSuccess<readonly TriggerView[]>> {
    return ok(await this.triggers.list(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Delete("agent-triggers/:id")
  async remove(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<{ deleted: true }>> {
    await this.triggers.remove(scopeOf(ctx), parse(UuidSchema, id));
    return ok({ deleted: true as const }, { requestId: ctx.requestId });
  }

  @Get("notifications")
  async notifications(
    @Ctx() ctx: RequestContext,
  ): Promise<ApiSuccess<{ items: readonly NotificationView[]; unread: number }>> {
    return ok(await this.triggers.notifications(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Post("notifications/read")
  @HttpCode(200)
  async markRead(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<{ read: true }>> {
    const { ids } = parse(MarkReadSchema, body ?? {});
    await this.triggers.markRead(scopeOf(ctx), ids);
    return ok({ read: true as const }, { requestId: ctx.requestId });
  }
}
