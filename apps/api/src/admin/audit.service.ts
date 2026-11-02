import { appendAudit, listAudit, type AuditQuery, type AuditRow, type PoolLike, type UserScope } from "@brain/db";

export interface AuditView {
  readonly entries: readonly AuditRow[];
  /** Pass as `before` for the next page. Null on the last page. */
  readonly nextBefore: number | null;
}

export interface AuditApi {
  /** Callers must have checked the user is an admin. Reading the trail is itself recorded. */
  list(scope: UserScope, query: AuditQuery): Promise<AuditView>;
}

export function createDbAuditApi(pool: PoolLike): AuditApi {
  return {
    async list(scope, query) {
      // One extra row shows whether another page exists.
      const rows = await listAudit(pool, scope.tenantId, { ...query, limit: query.limit + 1 });
      const entries = rows.slice(0, query.limit);
      await appendAudit(pool, { tenantId: scope.tenantId, userId: scope.userId, action: "audit.viewed" });
      return { entries, nextBefore: rows.length > query.limit ? entries.at(-1)!.id : null };
    },
  };
}
