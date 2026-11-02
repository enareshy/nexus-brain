import { AppError, ok, type ApiSuccess } from "@brain/core";
import type { FederatedResult } from "@brain/connectors";
import type { ToolInfo } from "@brain/mcp-client";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { Public } from "../auth/auth.guard.js";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { CONNECTIONS, WEB_APP_URL } from "../tokens.js";
import type { ConnectionsApi, ConnectionView } from "./connections.service.js";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

const ServerIdSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
const CompleteBodySchema = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(128),
});

const AllowedSchema = z.strictObject({ allowed: z.boolean() });

const ServerAppSchema = z.strictObject({
  clientId: z.string().trim().regex(/^[\w.-]{1,200}$/),
  clientSecret: z.string().trim().regex(/^\S{1,500}$/),
});

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("VALIDATION", "Invalid request parameters");
  return result.data;
}

function scopeOf(ctx: RequestContext) {
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

@Controller("connections")
export class ConnectionsController {
  constructor(@Inject(CONNECTIONS) private readonly connections: ConnectionsApi) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<ApiSuccess<readonly ConnectionView[]>> {
    return ok(await this.connections.list(scopeOf(ctx)), { requestId: ctx.requestId });
  }

  @Post(":serverId/authorize")
  @HttpCode(200)
  async authorize(
    @Ctx() ctx: RequestContext,
    @Param("serverId") serverId: string,
  ): Promise<ApiSuccess<{ authorizationUrl: string }>> {
    const id = parse(ServerIdSchema, serverId);
    return ok(await this.connections.authorize(scopeOf(ctx), id), { requestId: ctx.requestId });
  }

  /** Completes consent for the signed-in user (the web app forwards code + state here). */
  @Post("complete")
  @HttpCode(200)
  async complete(
    @Ctx() ctx: RequestContext,
    @Body() body: unknown,
  ): Promise<ApiSuccess<{ serverId: string }>> {
    const { code, state } = parse(CompleteBodySchema, body);
    return ok(await this.connections.complete(scopeOf(ctx), code, state), {
      requestId: ctx.requestId,
    });
  }

  /** Sets up this company's sign-in app for a service. Admins only. Takes effect immediately. */
  @Post(":serverId/app")
  @HttpCode(200)
  async saveApp(
    @Ctx() ctx: RequestContext,
    @Param("serverId") serverId: string,
    @Body() body: unknown,
  ): Promise<ApiSuccess<{ saved: true }>> {
    if (!ADMIN_ROLES.has(ctx.role)) throw new AppError("FORBIDDEN", "Only an admin can set up a service");
    const id = parse(ServerIdSchema, serverId);
    const app = parse(ServerAppSchema, body);
    return ok(await this.connections.saveApp(scopeOf(ctx), id, app), { requestId: ctx.requestId });
  }

  /** Allows or turns off a service for everyone in the company. Admins only. Takes effect immediately. */
  @Post(":serverId/allowed")
  @HttpCode(200)
  async setAllowed(
    @Ctx() ctx: RequestContext,
    @Param("serverId") serverId: string,
    @Body() body: unknown,
  ): Promise<ApiSuccess<{ allowed: boolean }>> {
    if (!ADMIN_ROLES.has(ctx.role)) throw new AppError("FORBIDDEN", "Only an admin can change which services are allowed");
    const id = parse(ServerIdSchema, serverId);
    const { allowed } = parse(AllowedSchema, body);
    return ok(await this.connections.setAllowed(scopeOf(ctx), id, allowed), { requestId: ctx.requestId });
  }

  @Delete(":serverId")
  async disconnect(
    @Ctx() ctx: RequestContext,
    @Param("serverId") serverId: string,
  ): Promise<ApiSuccess<{ disconnected: boolean; revoked: boolean }>> {
    const id = parse(ServerIdSchema, serverId);
    return ok(await this.connections.disconnect(scopeOf(ctx), id), { requestId: ctx.requestId });
  }

  /** Live tools/list for the connected account; used to record ADR 0001. */
  @Get(":serverId/tools")
  async tools(
    @Ctx() ctx: RequestContext,
    @Param("serverId") serverId: string,
  ): Promise<ApiSuccess<readonly ToolInfo[]>> {
    const id = parse(ServerIdSchema, serverId);
    return ok(await this.connections.tools(scopeOf(ctx), id), { requestId: ctx.requestId });
  }
}

@Controller("search")
export class SearchController {
  constructor(@Inject(CONNECTIONS) private readonly connections: ConnectionsApi) {}

  @Get()
  async search(
    @Ctx() ctx: RequestContext,
    @Query() query: unknown,
  ): Promise<ApiSuccess<FederatedResult>> {
    const { q, limit } = parse(SearchQuerySchema, query);
    return ok(await this.connections.search(scopeOf(ctx), q, limit), { requestId: ctx.requestId });
  }
}

/**
 * OAuth redirect target. It does NOT complete the connection: it hands code and state
 * to the web app, which posts them to /connections/complete with the user's token.
 * The code is useless without the server-held PKCE verifier and the same signed-in user.
 */
@Controller("oauth")
export class OAuthCallbackController {
  constructor(@Inject(WEB_APP_URL) private readonly webAppUrl: string) {}

  @Public()
  @Get("callback")
  async callback(@Query() query: Record<string, unknown>, @Res() reply: FastifyReply): Promise<void> {
    const target = new URL("/connections/complete", this.webAppUrl);
    const code = typeof query.code === "string" ? query.code : "";
    const state = typeof query.state === "string" ? query.state : "";
    if (typeof query.error === "string" || !code || !state) {
      target.searchParams.set("status", "error");
    } else {
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
    }
    await reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .redirect(target.toString(), 302);
  }
}
