import { AppError, ok, UuidSchema, type ApiSuccess } from "@brain/core";
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { SKILLS } from "../tokens.js";
import { MAX_SKILL_INSTRUCTIONS_CHARS, MAX_SKILL_NAME_CHARS, SKILL_TOOLS, type SkillsApi, type SkillView } from "./skills.service.js";

/** The service checks the text itself; this only bounds the request before it gets there. */
const SkillSchema = z.strictObject({
  name: z.string().max(MAX_SKILL_NAME_CHARS * 4),
  instructions: z.string().max(MAX_SKILL_INSTRUCTIONS_CHARS * 2),
  tools: z.array(z.string().max(100)).max(SKILL_TOOLS.length * 2),
  shared: z.boolean(),
});

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION", "Invalid request parameters");
  return result.data;
}

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

/** The signed-in person's own skills and their colleagues' shared ones. Only an owner can change one. */
@Controller("skills")
export class SkillsController {
  constructor(@Inject(SKILLS) private readonly skills: SkillsApi) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<ApiSuccess<readonly SkillView[]>> {
    return ok(await this.skills.list(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  /** The tools a skill may pick from. */
  @Get("tools")
  tools(@Ctx() ctx: RequestContext): ApiSuccess<readonly string[]> {
    return ok(SKILL_TOOLS, { requestId: ctx.requestId });
  }

  @Post()
  @HttpCode(201)
  async add(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<SkillView>> {
    return ok(await this.skills.add(scopeOf(ctx), parse(SkillSchema, body)), { requestId: ctx.requestId });
  }

  @Post(":id")
  @HttpCode(200)
  async update(@Ctx() ctx: RequestContext, @Param("id") id: string, @Body() body: unknown): Promise<ApiSuccess<SkillView>> {
    const skillId = parse(UuidSchema, id);
    return ok(await this.skills.update(scopeOf(ctx), skillId, parse(SkillSchema, body)), { requestId: ctx.requestId });
  }

  @Delete(":id")
  async remove(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<{ deleted: true }>> {
    await this.skills.remove(scopeOf(ctx), parse(UuidSchema, id));
    return ok({ deleted: true as const }, { requestId: ctx.requestId });
  }
}
