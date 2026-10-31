import { AppError, UuidSchema } from "@brain/core";
import { errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export interface VerifiedIdentity {
  readonly subject: string;
  readonly tenantId: string;
}

export interface IdentityVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

export interface JwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly keySet: JWTVerifyGetKey;
}

const ALLOWED_ALGORITHMS = ["RS256", "ES256"];
const CLOCK_TOLERANCE_SECONDS = 30;

const claimsSchema = z.object({
  sub: z.string().min(1),
  tenant_id: UuidSchema,
});

/**
 * Verifies OIDC access tokens (signature, issuer, audience, expiry) and extracts
 * the subject and tenant. The tenant only ever comes from a verified token.
 */
export function createJwtVerifier(options: JwtVerifierOptions): IdentityVerifier {
  return {
    async verify(token: string): Promise<VerifiedIdentity> {
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, options.keySet, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ALLOWED_ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ["exp", "iat", "sub"],
        }));
      } catch (err) {
        throw toAuthError(err);
      }

      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) {
        throw new AppError("UNAUTHENTICATED", "Token is missing required claims");
      }
      return Object.freeze({ subject: claims.data.sub, tenantId: claims.data.tenant_id });
    },
  };
}

/**
 * Token problems are 401. Failures to reach the identity provider (JWKS timeout,
 * network error) are 503 so clients retry instead of logging the user out.
 * Clients see a generic message; the cause is kept for server-side logs only.
 */
function toAuthError(err: unknown): AppError {
  if (err instanceof errors.JWKSTimeout || !(err instanceof errors.JOSEError)) {
    const reason = err instanceof Error ? err.name : "unknown";
    return new AppError("UNAVAILABLE", "Identity provider unavailable", { reason });
  }
  return new AppError("UNAUTHENTICATED", "Invalid or expired token", { reason: err.code });
}
