import { auditLog } from "./schema.js";
import { withTenant, type PoolLike } from "./tenant.js";

export interface AuditEntry {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly action: string;
  readonly resource?: string;
  /** Must not contain secrets, tokens or raw document text. */
  readonly meta?: Record<string, unknown>;
}

/** Appends to the tenant's audit log (FR-ADM-01). The app role cannot update or delete. */
export function appendAudit(pool: PoolLike, entry: AuditEntry): Promise<void> {
  return withTenant(pool, entry.tenantId, async (db) => {
    await db.insert(auditLog).values({
      tenantId: entry.tenantId,
      userId: entry.userId,
      action: entry.action,
      resource: entry.resource ?? null,
      meta: entry.meta ?? {},
    });
  });
}
