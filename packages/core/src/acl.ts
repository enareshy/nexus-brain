import { createHash } from "node:crypto";
import { AppError } from "./errors.js";
import { UuidSchema, type Role } from "./schemas.js";

export type Principal = `user:${string}` | `group:${string}` | "tenant:all";

export interface PrincipalInput {
  readonly userId: string;
  readonly groupIds: readonly string[];
  readonly role: Role;
}

/**
 * Expands a user into the ACL principals used to filter retrieval.
 * Group membership is resolved at query time (TECH-STACK decision 1), so callers
 * must pass freshly loaded group IDs, never cached ones.
 * Guests never receive `tenant:all`: org-wide content is for members only (FR-ID-01).
 */
export function expandPrincipals(input: PrincipalInput): readonly Principal[] {
  assertUuid(input.userId, "userId");
  input.groupIds.forEach((id) => assertUuid(id, "groupId"));

  const groups = [...new Set(input.groupIds)].sort().map((id): Principal => `group:${id}`);
  const tenantWide: Principal[] = input.role === "guest" ? [] : ["tenant:all"];
  return Object.freeze([`user:${input.userId}`, ...groups, ...tenantWide] as Principal[]);
}

/** True when the user holds at least one principal on the resource ACL. Empty ACL denies. */
export function canAccess(
  resourcePrincipals: readonly string[],
  userPrincipals: readonly Principal[],
): boolean {
  if (resourcePrincipals.length === 0) return false;
  const held = new Set<string>(userPrincipals);
  return resourcePrincipals.some((p) => held.has(p));
}

/**
 * Stable hash of (tenant, principal set). Every cache key for retrieval or LLM
 * answers must include it so users with different access never share entries.
 */
export function permissionHash(tenantId: string, principals: readonly Principal[]): string {
  assertUuid(tenantId, "tenantId");
  const canonical = `${tenantId}|${[...new Set(principals)].sort().join(",")}`;
  return createHash("sha256").update(canonical).digest("hex");
}

function assertUuid(value: string, field: string): void {
  if (!UuidSchema.safeParse(value).success) {
    throw new AppError("VALIDATION", `${field} must be a UUID`);
  }
}
