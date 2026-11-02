import { AppError, ok, UuidSchema, type ApiSuccess } from "@brain/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { MEMORY } from "../tokens.js";
import { MAX_MEMORY_CHARS, type MemoryApi, type MemoryView } from "./memory.service.js";

/** The service checks the text itself; this only bounds the request before it gets there. */
const MemorySchema = z.strictObject({ text: z.string().max(MAX_MEMORY_CHARS * 4) });

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION", `A memory is one line of up to ${MAX_MEMORY_CHARS} characters`);
  return result.data;
}

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

/** Always the signed-in person's own memories. There is deliberately no admin route. */
@Controller("memories")
export class MemoryController {
  constructor(@Inject(MEMORY) private readonly memory: MemoryApi) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<ApiSuccess<readonly MemoryView[]>> {
    return ok(await this.memory.list(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Post()
  @HttpCode(200)
  async add(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<MemoryView>> {
    return ok(await this.memory.add(scopeOf(ctx), parse(MemorySchema, body).text), { requestId: ctx.requestId });
  }

  @Post(":id")
  @HttpCode(200)
  async update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body() body: unknown): Promise<ApiSuccess<MemoryView>> {
    const memoryId = parse(UuidSchema, id);
    return ok(await this.memory.update(scopeOf(ctx), memoryId, parse(MemorySchema, body).text), { requestId: ctx.requestId });
  }

  @Delete()
  async removeAll(@Ctx() ctx: RequestContext): Promise<ApiSuccess<{ deleted: number }>> {
    return ok(await this.memory.removeAll(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Delete(":id")
  async remove(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<{ deleted: true }>> {
    await this.memory.remove(scopeOf(ctx), parse(UuidSchema, id));
    return ok({ deleted: true as const }, { requestId: ctx.requestId });
  }
}
