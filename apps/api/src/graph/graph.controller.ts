import { AppError, ok, type ApiSuccess } from "@brain/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { WORK_GRAPH } from "../tokens.js";
import type { GraphItemView, WorkGraphApi } from "./graph.service.js";

/** The same bounds the graph stores ids under. */
const ItemSchema = z.strictObject({
  serverId: z.string().regex(/^[a-z0-9-]{1,40}$/),
  // eslint-disable-next-line no-control-regex -- control characters are never stored, so never asked for
  itemId: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/),
});

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

/** Always the signed-in person's own work graph (FR-RET-09). There is deliberately no admin route. */
@Controller("me/work-graph")
export class GraphController {
  constructor(@Inject(WORK_GRAPH) private readonly graph: WorkGraphApi) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<ApiSuccess<readonly GraphItemView[]>> {
    return ok(await this.graph.list(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  /**
   * The person opened one of their search results (FR-RET-09). It is recorded in their own graph
   * only, which only ever reorders their own results, so a made-up id can change nothing but their
   * own order. A problem recording it is reported, never shown: the link already opened.
   */
  @Post("opened")
  @HttpCode(200)
  async opened(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<{ recorded: true }>> {
    const parsed = ItemSchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid request parameters");
    await this.graph.opened(scopeOf(ctx), { serverId: parsed.data.serverId, externalId: parsed.data.itemId });
    return ok({ recorded: true as const }, { requestId: ctx.requestId });
  }

  /** POST with a body, as an item id can hold characters a URL path would need escaping for. */
  @Post("forget")
  @HttpCode(200)
  async forget(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<{ forgotten: number }>> {
    const parsed = ItemSchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid request parameters");
    return ok(await this.graph.forget(scopeOf(ctx), parsed.data), { requestId: ctx.requestId });
  }

  @Delete()
  async clear(@Ctx() ctx: RequestContext): Promise<ApiSuccess<{ deleted: number }>> {
    return ok(await this.graph.clear(scopeOf(ctx)), { requestId: ctx.requestId });
  }
}
