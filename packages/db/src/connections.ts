import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import { mcpClientRegistrations, mcpConnections, oauthStates } from "./schema.js";
import { inScopedTransaction, withUser, type PoolLike, type UserScope } from "./tenant.js";

export type ConnectionStatus = "active" | "needs_reauth";

export interface ConnectionSummary {
  readonly serverId: string;
  readonly status: ConnectionStatus;
  readonly scopes: string | null;
  readonly expiresAt: Date | null;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface StoredConnection extends ConnectionSummary {
  readonly tokensCiphertext: string;
}

export interface ConnectionWrite {
  readonly serverId: string;
  readonly tokensCiphertext: string;
  readonly scopes: string | null;
  readonly expiresAt: Date | null;
}

const summaryColumns = {
  serverId: mcpConnections.serverId,
  status: mcpConnections.status,
  scopes: mcpConnections.scopes,
  expiresAt: mcpConnections.expiresAt,
  updatedAt: mcpConnections.updatedAt,
  lastUsedAt: mcpConnections.lastUsedAt,
};

/** Lists the calling user's connections. Never returns ciphertext. */
export function listConnections(pool: PoolLike, scope: UserScope): Promise<ConnectionSummary[]> {
  return withUser(pool, scope, (db) => db.select(summaryColumns).from(mcpConnections));
}

export function getConnection(
  pool: PoolLike,
  scope: UserScope,
  serverId: string,
): Promise<StoredConnection | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db
      .select({ ...summaryColumns, tokensCiphertext: mcpConnections.tokensCiphertext })
      .from(mcpConnections)
      .where(eq(mcpConnections.serverId, serverId))
      .limit(1);
    return row ?? null;
  });
}

/** Inserts or replaces the user's tokens for a server and marks the connection active. */
export function saveConnection(
  pool: PoolLike,
  scope: UserScope,
  write: ConnectionWrite,
): Promise<void> {
  return withUser(pool, scope, async (db) => {
    const values = {
      tokensCiphertext: write.tokensCiphertext,
      scopes: write.scopes,
      expiresAt: write.expiresAt,
      status: "active" as const,
      updatedAt: new Date(),
    };
    await db
      .insert(mcpConnections)
      .values({ tenantId: scope.tenantId, userId: scope.userId, serverId: write.serverId, ...values })
      .onConflictDoUpdate({
        target: [mcpConnections.tenantId, mcpConnections.userId, mcpConnections.serverId],
        set: values,
      });
  });
}

export function markConnection(
  pool: PoolLike,
  scope: UserScope,
  serverId: string,
  status: ConnectionStatus,
): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db
      .update(mcpConnections)
      .set({ status, updatedAt: new Date() })
      .where(eq(mcpConnections.serverId, serverId));
  });
}

export function touchConnection(pool: PoolLike, scope: UserScope, serverId: string): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db
      .update(mcpConnections)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpConnections.serverId, serverId));
  });
}

/** Deletes the connection. Returns true when a row was removed. */
export function deleteConnection(
  pool: PoolLike,
  scope: UserScope,
  serverId: string,
): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const removed = await db
      .delete(mcpConnections)
      .where(eq(mcpConnections.serverId, serverId))
      .returning({ serverId: mcpConnections.serverId });
    return removed.length > 0;
  });
}

export interface PendingAuthorization {
  readonly stateHash: string;
  readonly serverId: string;
  readonly verifierCiphertext: string;
  readonly expiresAt: Date;
}

/**
 * Stores a pending authorization, replacing the user's earlier pending one for the same
 * server and purging their expired ones, so pending rows per user stay bounded.
 */
export function savePendingAuthorization(
  pool: PoolLike,
  scope: UserScope,
  pending: PendingAuthorization,
): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db
      .delete(oauthStates)
      .where(or(eq(oauthStates.serverId, pending.serverId), lte(oauthStates.expiresAt, sql`now()`)));
    await db.insert(oauthStates).values({ ...pending, tenantId: scope.tenantId, userId: scope.userId });
  });
}

export interface ConsumedAuthorization {
  readonly serverId: string;
  readonly verifierCiphertext: string;
}

/**
 * Atomically deletes and returns the calling user's unexpired pending authorization.
 * RLS limits this to the user who started it, so another user's state is neither
 * returned nor consumed. Single use: a replayed state finds nothing.
 */
export function consumePendingAuthorization(
  pool: PoolLike,
  scope: UserScope,
  stateHash: string,
): Promise<ConsumedAuthorization | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db
      .delete(oauthStates)
      .where(and(eq(oauthStates.stateHash, stateHash), gt(oauthStates.expiresAt, sql`now()`)))
      .returning({
        serverId: oauthStates.serverId,
        verifierCiphertext: oauthStates.verifierCiphertext,
      });
    return row ?? null;
  });
}

export function getClientRegistration(pool: PoolLike, serverId: string): Promise<string | null> {
  return inScopedTransaction(pool, {}, async (db) => {
    const [row] = await db
      .select({ ciphertext: mcpClientRegistrations.clientInfoCiphertext })
      .from(mcpClientRegistrations)
      .where(eq(mcpClientRegistrations.serverId, serverId))
      .limit(1);
    return row?.ciphertext ?? null;
  });
}

export function saveClientRegistration(
  pool: PoolLike,
  serverId: string,
  ciphertext: string,
): Promise<void> {
  return inScopedTransaction(pool, {}, async (db) => {
    await db
      .insert(mcpClientRegistrations)
      .values({ serverId, clientInfoCiphertext: ciphertext })
      .onConflictDoUpdate({
        target: mcpClientRegistrations.serverId,
        set: { clientInfoCiphertext: ciphertext },
      });
  });
}
