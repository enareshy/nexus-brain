import { AppError, ok, UuidSchema, type ApiSuccess } from "@brain/core";
import type { WriteRequest, WriteTarget } from "@brain/connectors";
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { PROPOSALS } from "../tokens.js";
import type { ProposalsApi, ProposalView } from "./proposals.service.js";

const ServerIdSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
const SiteId = z.string().min(1).max(100);
const IssueKey = z.string().min(1).max(100);
const Summary = z.string().trim().min(1).max(255);
const LongText = z.string().trim().min(1).max(32_000);

// Strict: a request names an action and its fields, and can never name a tool or add arguments.
const WriteRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create_issue"),
    siteId: SiteId,
    projectKey: z.string().min(1).max(100),
    issueType: z.string().trim().min(1).max(100),
    summary: Summary,
    description: LongText.optional(),
  }),
  z.strictObject({
    action: z.literal("update_issue"),
    siteId: SiteId,
    issueKey: IssueKey,
    summary: Summary.optional(),
    description: LongText.optional(),
  }),
  z.strictObject({ action: z.literal("add_comment"), siteId: SiteId, issueKey: IssueKey, body: LongText }),
  z.strictObject({
    action: z.literal("create_subtask"),
    siteId: SiteId,
    parentKey: IssueKey,
    summary: Summary,
    description: LongText.optional(),
  }),
]);
const ProposeBodySchema = z.object({ serverId: ServerIdSchema, request: WriteRequestSchema });
const ApproveBodySchema = z.object({ argsHash: z.string().regex(/^[a-f0-9]{64}$/) });

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION", "Invalid request parameters");
  return result.data;
}

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

@Controller("proposals")
export class ProposalsController {
  constructor(@Inject(PROPOSALS) private readonly proposals: ProposalsApi) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<ApiSuccess<readonly ProposalView[]>> {
    return ok(await this.proposals.list(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Get(":id")
  async get(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<ProposalView>> {
    return ok(await this.proposals.get(scopeOf(ctx), parse(UuidSchema, id)), { requestId: ctx.requestId });
  }

  @Get("targets/:serverId")
  async targets(
    @Ctx() ctx: RequestContext,
    @Param("serverId") serverId: string,
  ): Promise<ApiSuccess<readonly WriteTarget[]>> {
    const id = parse(ServerIdSchema, serverId);
    return ok(await this.proposals.targets(scopeOf(ctx), id), { requestId: ctx.requestId });
  }

  /** Records a change for review. Nothing happens in the connected service. */
  @Post()
  @HttpCode(201)
  async propose(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ApiSuccess<ProposalView>> {
    const { serverId, request } = parse(ProposeBodySchema, body);
    return ok(await this.proposals.propose(scopeOf(ctx), serverId, request as WriteRequest), {
      requestId: ctx.requestId,
    });
  }

  @Post(":id/approve")
  @HttpCode(200)
  async approve(
    @Ctx() ctx: RequestContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ApiSuccess<ProposalView>> {
    const proposalId = parse(UuidSchema, id);
    const { argsHash } = parse(ApproveBodySchema, body);
    return ok(await this.proposals.approve(scopeOf(ctx), proposalId, argsHash), { requestId: ctx.requestId });
  }

  @Post(":id/reject")
  @HttpCode(200)
  async reject(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<ProposalView>> {
    return ok(await this.proposals.reject(scopeOf(ctx), parse(UuidSchema, id)), { requestId: ctx.requestId });
  }

  /** Proposes putting back what this change replaced. Nothing happens until that is approved too. */
  @Post(":id/undo")
  @HttpCode(201)
  async undo(@Ctx() ctx: RequestContext, @Param("id") id: string): Promise<ApiSuccess<ProposalView>> {
    return ok(await this.proposals.undo(scopeOf(ctx), parse(UuidSchema, id)), { requestId: ctx.requestId });
  }
}
