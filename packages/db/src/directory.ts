import type { Role } from "@brain/core";
import { and, eq, isNull } from "drizzle-orm";
import { groupMembers, users } from "./schema.js";
import { withTenant, type PoolLike } from "./tenant.js";

export interface DirectoryUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly groupIds: readonly string[];
}

/**
 * Resolves an identity-provider subject to a user inside one tenant, with fresh
 * group memberships. A subject from another tenant, or someone an admin has turned off, resolves to null.
 */
export async function findUserBySubject(
  pool: PoolLike,
  tenantId: string,
  subject: string,
): Promise<DirectoryUser | null> {
  return withTenant(pool, tenantId, async (db) => {
    const [user] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      // RLS already scopes to the tenant; the explicit filter is defence in depth.
      .where(and(eq(users.tenantId, tenantId), eq(users.externalSubject, subject), isNull(users.deactivatedAt)))
      .limit(1);
    if (!user) return null;

    const memberships = await db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(and(eq(groupMembers.tenantId, tenantId), eq(groupMembers.userId, user.id)));

    return Object.freeze({
      userId: user.id,
      tenantId,
      role: user.role,
      groupIds: Object.freeze(memberships.map((m) => m.groupId)),
    });
  });
}
