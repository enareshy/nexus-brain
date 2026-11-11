import { AppError, isAppError } from "@brain/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Controller, Delete, Get, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { bearerToken, Public } from "../auth/auth.guard.js";
import type { IdentityVerifier } from "../auth/jwt-verifier.js";
import type { UserDirectory } from "../auth/user-directory.js";
import { MCP, USER_DIRECTORY } from "../tokens.js";
import type { McpCaller, McpToolsApi } from "./mcp.service.js";

export interface McpEndpointDeps {
  /** Accepts only tokens issued for this endpoint, not ones for the web app (FR-MCP-03). */
  readonly verifier: IdentityVerifier;
  readonly tools: McpToolsApi;
  /** This endpoint's public URL, which clients also use to identify it. */
  readonly resourceUrl: string;
  readonly issuer: string;
}

const MAX_BODY_DEPTH = 32;
const FORWARDED_HEADERS =["accept", "content-type", "mcp-protocol-version", "mcp-session-id"] as const;

/** Checked level by level, since recursive code further on would run out of stack on such input. */
function isNestedTooDeeply(body: unknown): boolean {
  let level: readonly unknown[] = [body];
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth > MAX_BODY_DEPTH) return true;
    level = level.flatMap((value) => (value && typeof value === "object" ? Object.values(value) : []));
  }
  return false;
}

function buildServer(caller: McpCaller, tools: McpToolsApi): Server {
  const server = new Server({ name: "nexus-brain", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...(await tools.list(caller))] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await tools.call(caller, request.params.name, request.params.arguments ?? {});
    return { content: [{ type: "text" as const, text: result.text }], isError: result.isError };
  });
  return server;
}

/**
 * Brain as an MCP server (FR-MCP-01), for AI tools the person connects themselves.
 * Stateless: every request is authenticated on its own and shares nothing with any other.
 * The person's tokens for connected services are never passed to or from the caller (FR-MCP-03).
 */
@Public()
@Controller()
export class McpController {
  constructor(
    @Inject(MCP) private readonly mcp: McpEndpointDeps,
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectory,
  ) {}

  private get metadataUrl(): string {
    const { origin, pathname } = new URL(this.mcp.resourceUrl);
    return `${origin}/.well-known/oauth-protected-resource${pathname}`;
  }

  @Get(".well-known/oauth-protected-resource/mcp")
  metadata(): Record<string, unknown> {
    return {
      resource: this.mcp.resourceUrl,
      authorization_servers: [this.mcp.issuer],
      bearer_methods_supported: ["header"],
    };
  }

  @Post("mcp")
  async handle(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    // A web page cannot be allowed to reach this through someone's browser.
    if (request.headers.origin) throw new AppError("FORBIDDEN", "Browser requests are not allowed here");
    // One request, one message: a batch would run many tool calls for one count against the rate limit.
    if (Array.isArray(request.body)) throw new AppError("VALIDATION", "Batch requests are not supported");
    if (isNestedTooDeeply(request.body)) throw new AppError("VALIDATION", "Request is nested too deeply");

    let caller: McpCaller;
    try {
      caller = await this.authenticate(request.headers.authorization);
    } catch (err) {
      if (isAppError(err) && err.code === "UNAUTHENTICATED") {
        // Tells the client where to sign in.
        void reply.header("www-authenticate", `Bearer resource_metadata="${this.metadataUrl}"`);
      }
      throw err;
    }

    const server = buildServer(caller, this.mcp.tools);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const name of FORWARDED_HEADERS) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const response = await transport.handleRequest(
        new Request(this.mcp.resourceUrl, { method: "POST", headers, body: JSON.stringify(request.body) }),
        { parsedBody: request.body },
      );
      const body = await response.text();
      const contentType = response.headers.get("content-type");
      if (contentType) void reply.header("content-type", contentType);
      await reply.status(response.status).send(body);
    } finally {
      await server.close();
    }
  }

  /** No sessions and no server-sent messages, so there is nothing to open or close. */
  @Get("mcp")
  listen(@Res() reply: FastifyReply): Promise<void> {
    return this.notAllowed(reply);
  }

  @Delete("mcp")
  close(@Res() reply: FastifyReply): Promise<void> {
    return this.notAllowed(reply);
  }

  private async notAllowed(reply: FastifyReply): Promise<void> {
    await reply.status(405).header("allow", "POST").send();
  }

  private async authenticate(header: string | undefined): Promise<McpCaller> {
    const identity = await this.mcp.verifier.verify(bearerToken(header));
    const user = await this.directory.findBySubject(identity.tenantId, identity.subject);
    if (!user) throw new AppError("FORBIDDEN", "User is not provisioned in this workspace");
    return { tenantId: user.tenantId, userId: user.userId, clientId: identity.clientId ?? null };
  }
}
