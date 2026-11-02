import { AppError } from "@brain/core";
import { and, count, desc, eq, gt, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { writeProposals, type ProposalStatus } from "./schema.js";
import { withUser, type PoolLike, type UserScope } from "./tenant.js";

export type StoredProposal = typeof writeProposals.$inferSelect;

export interface NewProposal {
  readonly id: string;
  readonly serverId: string;
  readonly action: string;
  readonly toolName: string;
  readonly toolClass: "write" | "external-effect";
  readonly args: Record<string, unknown>;
  readonly argsHash: string;
  readonly siteOrigin: string;
  readonly expiresAt: Date;
  /** The agent run that drafted this, if any. */
  readonly agentRunId?: string;
}

export interface ProposalResult {
  readonly status: Extract<ProposalStatus, "succeeded" | "failed" | "unknown">;
  readonly externalId?: string | null;
  readonly resultUrl?: string | null;
  readonly errorCode?: string | null;
}

/** The limit is checked under a per-user lock, so parallel requests cannot pass it together. */
export function createProposal(pool: PoolLike, scope: UserScope, proposal: NewProposal, maxPending?: number): Promise<StoredProposal> {
  return withUser(pool, scope, async (db) => {
    if (maxPending !== undefined) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`proposal|${scope.tenantId}|${scope.userId}`}, 0))`);
      const [same] = await db.select().from(writeProposals).where(eq(writeProposals.id, proposal.id)).limit(1);
      if (same) return same;
      const [pending] = await db
        .select({ value: count() })
        .from(writeProposals)
        .where(and(eq(writeProposals.status, "pending"), gt(writeProposals.expiresAt, sql`now()`)));
      if ((pending?.value ?? 0) >= maxPending) {
        throw new AppError("RATE_LIMITED", "Too many changes are waiting. Approve or reject some first");
      }
    }
    const [row] = await db
      .insert(writeProposals)
      .values({ ...proposal, tenantId: scope.tenantId, userId: scope.userId, status: "pending" })
      .onConflictDoNothing({ target: writeProposals.id })
      .returning();
    if (row) return row;
    // The same id again means a repeated agent step after a restart: it is the same proposal.
    const [existing] = await db.select().from(writeProposals).where(eq(writeProposals.id, proposal.id)).limit(1);
    if (!existing) throw new Error("A proposal with this id belongs to someone else");
    return existing;
  });
}

export function listProposals(pool: PoolLike, scope: UserScope, limit: number): Promise<StoredProposal[]> {
  return withUser(pool, scope, (db) =>
    db.select().from(writeProposals).orderBy(desc(writeProposals.createdAt)).limit(limit),
  );
}

export function getProposal(pool: PoolLike, scope: UserScope, id: string): Promise<StoredProposal | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db.select().from(writeProposals).where(eq(writeProposals.id, id)).limit(1);
    return row ?? null;
  });
}

export function countPendingProposals(pool: PoolLike, scope: UserScope): Promise<number> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db
      .select({ value: count() })
      .from(writeProposals)
      .where(and(eq(writeProposals.status, "pending"), gt(writeProposals.expiresAt, sql`now()`)));
    return row?.value ?? 0;
  });
}

/**
 * Moves a pending, unexpired proposal with exactly these arguments to executing.
 * Only one caller can ever get the row back, which is what prevents a duplicate write.
 * The per-user cap (FR-WR-05) is checked under a per-user lock, so parallel approvals cannot pass it together.
 */
export function claimProposal(
  pool: PoolLike,
  scope: UserScope,
  id: string,
  argsHash: string,
  maxPerMinute: number,
): Promise<StoredProposal | "rate_limited" | null> {
  return withUser(pool, scope, async (db) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.tenantId}|${scope.userId}`}, 0))`);
    const [recent] = await db
      .select({ value: count() })
      .from(writeProposals)
      .where(
        and(
          isNotNull(writeProposals.decidedAt),
          ne(writeProposals.status, "rejected"),
          gt(writeProposals.decidedAt, sql`now() - interval '1 minute'`),
        ),
      );
    if ((recent?.value ?? 0) >= maxPerMinute) return "rate_limited";
    const [row] = await db
      .update(writeProposals)
      .set({ status: "executing", decidedAt: sql`now()` })
      .where(
        and(
          eq(writeProposals.id, id),
          eq(writeProposals.status, "pending"),
          eq(writeProposals.argsHash, argsHash),
          gt(writeProposals.expiresAt, sql`now()`),
        ),
      )
      .returning();
    return row ?? null;
  });
}

/** Returns a claim to pending. Only for when the tool was definitely never called. */
export function releaseProposal(pool: PoolLike, scope: UserScope, id: string): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db
      .update(writeProposals)
      .set({ status: "pending", decidedAt: null })
      .where(and(eq(writeProposals.id, id), eq(writeProposals.status, "executing")));
  });
}

/** A slow call can report back after being marked unknown, and what it reports is more accurate. */
export function finishProposal(pool: PoolLike, scope: UserScope, id: string, result: ProposalResult): Promise<StoredProposal | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db
      .update(writeProposals)
      .set({
        status: result.status,
        externalId: result.externalId ?? null,
        resultUrl: result.resultUrl ?? null,
        errorCode: result.errorCode ?? null,
        completedAt: sql`now()`,
      })
      .where(and(eq(writeProposals.id, id), inArray(writeProposals.status, ["executing", "unknown"])))
      .returning();
    return row ?? null;
  });
}

/** Claims older than this mean the process stopped mid-write. They are never reopened. */
export function markStuckProposalsUnknown(pool: PoolLike, scope: UserScope, olderThan: Date): Promise<StoredProposal[]> {
  return withUser(pool, scope, (db) =>
    db
      .update(writeProposals)
      .set({ status: "unknown", errorCode: "outcome_unknown", completedAt: sql`now()` })
      .where(and(eq(writeProposals.status, "executing"), lt(writeProposals.decidedAt, olderThan)))
      .returning(),
  );
}

export function rejectProposal(pool: PoolLike, scope: UserScope, id: string): Promise<StoredProposal | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db
      .update(writeProposals)
      .set({ status: "rejected", decidedAt: sql`now()` })
      .where(and(eq(writeProposals.id, id), eq(writeProposals.status, "pending")))
      .returning();
    return row ?? null;
  });
}
