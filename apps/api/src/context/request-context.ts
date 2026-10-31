import { AppError, type Principal, type Role } from "@brain/core";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

export interface RequestContext {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: Role;
  readonly principals: readonly Principal[];
}

export type ContextRequest = FastifyRequest & { ctx?: RequestContext };

/** Injects the authenticated request context. Throws if the auth guard did not run. */
export const Ctx = createParamDecorator((_data: unknown, host: ExecutionContext) => {
  const request = host.switchToHttp().getRequest<ContextRequest>();
  if (!request.ctx) {
    throw new AppError("UNAUTHENTICATED", "Authentication required");
  }
  return request.ctx;
});
