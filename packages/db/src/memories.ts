import { asc, count, eq, sql } from "drizzle-orm";
import { memories } from "./schema.js";
import { withUser, type PoolLike, type UserScope } from "./tenant.js";

export type StoredMemory = Pick<typeof memories.$inferSelect, "id" | "textCiphertext" | "createdAt" | "updatedAt">;

const columns = {
  id: memories.id,
  textCiphertext: memories.textCiphertext,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
};

/** Oldest first, so the person sees them in the order they added them. */
export function listMemories(pool: PoolLike, scope: UserScope): Promise<StoredMemory[]> {
  return withUser(pool, scope, (db) => db.select(columns).from(memories).orderBy(asc(memories.createdAt), asc(memories.id)));
}

/** False when the person already has `max`. Counted under a per-person lock, so parallel adds cannot pass it. */
export function addMemory(
  pool: PoolLike,
  scope: UserScope,
  memory: { readonly id: string; readonly textCiphertext: string },
  max: number,
): Promise<StoredMemory | null> {
  return withUser(pool, scope, async (db) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory|${scope.tenantId}|${scope.userId}`}, 0))`);
    const [existing] = await db.select({ value: count() }).from(memories);
    if ((existing?.value ?? 0) >= max) return null;
    const [row] = await db
      .insert(memories)
      .values({ ...memory, tenantId: scope.tenantId, userId: scope.userId })
      .returning(columns);
    return row ?? null;
  });
}

export function updateMemory(pool: PoolLike, scope: UserScope, id: string, textCiphertext: string): Promise<StoredMemory | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db
      .update(memories)
      .set({ textCiphertext, updatedAt: sql`now()` })
      .where(eq(memories.id, id))
      .returning(columns);
    return row ?? null;
  });
}

/** Returns true when a memory was removed. */
export function deleteMemory(pool: PoolLike, scope: UserScope, id: string): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const removed = await db.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id });
    return removed.length > 0;
  });
}

/** Removes every memory the person has. Returns how many there were. */
export function deleteAllMemories(pool: PoolLike, scope: UserScope): Promise<number> {
  return withUser(pool, scope, async (db) => {
    const removed = await db.delete(memories).returning({ id: memories.id });
    return removed.length;
  });
}
