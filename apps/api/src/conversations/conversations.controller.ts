import { AppError, ok, UuidSchema, type ApiSuccess } from "@brain/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { CONVERSATIONS } from "../tokens.js";
import type { ConversationsApi, ConversationSummary } from "./conversations.service.js";

const FeedbackSchema = z.strictObject({
  rating: z.enum(["up", "down"]),
  reason: z.string().trim().max(500).optional(),
});

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION", "Invalid request parameters");
  return result.data;
}

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

/** Always the signed-in person's own conversations. There is deliberately no admin route. */
@Controller("conversations")
export class ConversationsController {
  constructor(@Inject(CONVERSATIONS) private readonly conversations: ConversationsApi) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<ApiSuccess<readonly ConversationSummary[]>> {
    return ok(await this.conversations.list(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Get(":id")
  async get(@Ctx() ctx: RequestContext, @Param("id") id: string) {
    return ok(await this.conversations.get(scopeOf(ctx), parse(UuidSchema, id)), { requestId: ctx.requestId });
  }

  @Delete(":id")
  async remove(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<{ deleted: true }>> {
    await this.conversations.remove(scopeOf(ctx), parse(UuidSchema, id));
    return ok({ deleted: true as const }, { requestId: ctx.requestId });
  }

  @Post(":id/messages/:messageId/feedback")
  @HttpCode(200)
  async feedback(
    @Ctx() ctx: RequestContext,
    @Param("id") id: string,
    @Param("messageId") messageId: string,
    @Body() body: unknown,
  ): Promise<ApiSuccess<{ saved: true }>> {
    await this.conversations.feedback(
      scopeOf(ctx),
      parse(UuidSchema, id),
      parse(UuidSchema, messageId),
      parse(FeedbackSchema, body),
    );
    return ok({ saved: true as const }, { requestId: ctx.requestId });
  }
}
