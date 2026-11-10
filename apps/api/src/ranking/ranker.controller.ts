import { AppError, ok, type ApiSuccess } from "@brain/core";
import { Controller, Get, Inject } from "@nestjs/common";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { RANKER } from "../tokens.js";
import type { RankerStatus, RankerStatusApi } from "./ranker.service.js";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Whether the company's learned ranker is in use (FR-RET-08). Admins only; read-only. */
@Controller("admin/ranker")
export class RankerController {
  constructor(@Inject(RANKER) private readonly ranker: RankerStatusApi) {}

  @Get()
  async status(@Ctx() ctx: RequestContext): Promise<ApiSuccess<RankerStatus>> {
    if (!ADMIN_ROLES.has(ctx.role)) throw new AppError("FORBIDDEN", "Only an admin can see the company's ranking status");
    return ok(await this.ranker.status(ctx.tenantId), { requestId: ctx.requestId });
  }
}
