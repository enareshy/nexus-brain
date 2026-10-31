import { AppError, expandPrincipals } from "@brain/core";
import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ContextRequest } from "../context/request-context.js";
import { IDENTITY_VERIFIER, USER_DIRECTORY } from "../tokens.js";
import type { IdentityVerifier } from "./jwt-verifier.js";
import type { UserDirectory } from "./user-directory.js";

const IS_PUBLIC = "brain:isPublic";

/** Marks a route as reachable without authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Global guard: verifies the bearer token, resolves the user inside the token's
 * tenant with fresh group memberships, and attaches an immutable request context.
 * Tenant never comes from headers, query or body.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IDENTITY_VERIFIER) private readonly verifier: IdentityVerifier,
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<ContextRequest>();
    const identity = await this.verifier.verify(bearerToken(request.headers.authorization));

    const user = await this.directory.findBySubject(identity.tenantId, identity.subject);
    if (!user) {
      throw new AppError("FORBIDDEN", "User is not provisioned in this workspace");
    }

    request.ctx = Object.freeze({
      requestId: String(request.id),
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
      principals: expandPrincipals({
        userId: user.userId,
        groupIds: user.groupIds,
        role: user.role,
      }),
    });
    return true;
  }
}

function bearerToken(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header ?? "");
  if (!match?.[1]) {
    throw new AppError("UNAUTHENTICATED", "Missing bearer token");
  }
  return match[1];
}
