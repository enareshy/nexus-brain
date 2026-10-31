import { ok, type ApiSuccess } from "@brain/core";
import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/auth.guard.js";
import { Ctx, type RequestContext } from "./context/request-context.js";

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  health(): ApiSuccess<{ status: "ok" }> {
    return ok({ status: "ok" });
  }
}

@Controller("me")
export class MeController {
  /** Echoes the resolved identity; used by the UI and to verify tenant context end to end. */
  @Get()
  me(@Ctx() ctx: RequestContext): ApiSuccess<Omit<RequestContext, "requestId">> {
    return ok(
      { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role, principals: ctx.principals },
      { requestId: ctx.requestId },
    );
  }
}
