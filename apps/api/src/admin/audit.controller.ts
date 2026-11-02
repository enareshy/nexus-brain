import { AppError, ok, UuidSchema, type ApiSuccess } from "@brain/core";
import { Controller, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { AUDIT } from "../tokens.js";
import type { AuditApi, AuditView } from "./audit.service.js";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  before: z.coerce.number().int().positive().optional(),
  action: z.string().regex(/^[a-z._]{1,60}$/).optional(),
  userId: UuidSchema.optional(),
});

@Controller("admin/audit")
export class AuditController {
  constructor(@Inject(AUDIT) private readonly audit: AuditApi) {}

  /** The company's audit trail. The tenant always comes from the signed-in user. */
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<ApiSuccess<AuditView>> {
    if (!ADMIN_ROLES.has(ctx.role)) throw new AppError("FORBIDDEN", "Only an admin can view the audit trail");
    const parsed = AuditQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid request parameters");
    const scope = { tenantId: ctx.tenantId, userId: ctx.userId };
    return ok(await this.audit.list(scope, parsed.data), { requestId: ctx.requestId });
  }
}
