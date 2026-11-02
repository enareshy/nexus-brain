import { and, desc, eq, lt } from "drizzle-orm";
import { auditLog, users } from "./schema.js";
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

export interface AuditQuery {
  readonly limit: number;
  /** Only rows older than this id, for paging. */
  readonly before?: number | undefined;
  readonly action?: string | undefined;
  readonly userId?: string | undefined;
}

export interface AuditRow {
  readonly id: number;
  readonly userId: string | null;
  readonly userEmail: string | null;
  readonly action: string;
  readonly resource: string | null;
  readonly meta: Record<string, unknown>;
  readonly createdAt: Date;
}

/** The tenant's audit trail, newest first. RLS keeps it to this tenant whatever the filters say. */
export function listAudit(pool: PoolLike, tenantId: string, query: AuditQuery): Promise<AuditRow[]> {
  return withTenant(pool, tenantId, (db) =>
    db
      .select({
        id: auditLog.id,
        userId: auditLog.userId,
        userEmail: users.email,
        action: auditLog.action,
        resource: auditLog.resource,
        meta: auditLog.meta,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(
        and(
          query.before === undefined ? undefined : lt(auditLog.id, query.before),
          query.action === undefined ? undefined : eq(auditLog.action, query.action),
          query.userId === undefined ? undefined : eq(auditLog.userId, query.userId),
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(query.limit),
  );
}
