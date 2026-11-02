import { AppError, ok, UuidSchema, type ApiSuccess } from "@brain/core";
import { Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { PEOPLE } from "../tokens.js";
import type { DeactivationView, PeopleApi, PersonView } from "./people.service.js";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

function requireAdmin(ctx: RequestContext): { tenantId: string; userId: string } {
  if (!ADMIN_ROLES.has(ctx.role)) throw new AppError("FORBIDDEN", "Only an admin can manage people");
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

function personId(value: string): string {
  if (!UuidSchema.safeParse(value).success) throw new AppError("VALIDATION", "Invalid request parameters");
  return value;
}

/** Who can use the workspace. The tenant always comes from the signed-in admin. */
@Controller("admin/people")
export class PeopleController {
  constructor(@Inject(PEOPLE) private readonly people: PeopleApi) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<ApiSuccess<readonly PersonView[]>> {
    return ok(await this.people.list(requireAdmin(ctx)), { requestId: ctx.requestId });
  }

  @Post(":id/deactivate")
  @HttpCode(200)
  async deactivate(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<DeactivationView>> {
    return ok(await this.people.deactivate(requireAdmin(ctx), personId(id)), { requestId: ctx.requestId });
  }

  @Post(":id/reactivate")
  @HttpCode(200)
  async reactivate(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<{ changed: boolean }>> {
    return ok(await this.people.reactivate(requireAdmin(ctx), personId(id)), { requestId: ctx.requestId });
  }
}
