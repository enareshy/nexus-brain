import { and, asc, count, desc, eq, isNull, or, sql } from "drizzle-orm";
import { skills, users } from "./schema.js";
import { withUser, type PoolLike, type TenantDb, type UserScope } from "./tenant.js";

export interface StoredSkill {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly nameCiphertext: string;
  readonly instructionsCiphertext: string;
  readonly tools: readonly string[];
  readonly shared: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SkillFields {
  readonly nameCiphertext: string;
  readonly instructionsCiphertext: string;
  readonly tools: readonly string[];
  readonly shared: boolean;
}

const columns = {
  id: skills.id,
  ownerId: skills.userId,
  ownerName: users.displayName,
  nameCiphertext: skills.nameCiphertext,
  instructionsCiphertext: skills.instructionsCiphertext,
  tools: skills.tools,
  shared: skills.shared,
  createdAt: skills.createdAt,
  updatedAt: skills.updatedAt,
};

/**
 * Row-level security already limits this to the person's own skills and their colleagues' shared ones.
 * A colleague who has been turned off no longer offers theirs.
 */
function usable(scope: UserScope) {
  return or(eq(skills.userId, scope.userId), isNull(users.deactivatedAt));
}

function selectSkills(db: TenantDb) {
  return db
    .select(columns)
    .from(skills)
    .innerJoin(users, and(eq(users.tenantId, skills.tenantId), eq(users.id, skills.userId)));
}

/** The person's own skills first, then shared ones, oldest first within each, at most `limit`. */
export function listSkills(pool: PoolLike, scope: UserScope, limit = 200): Promise<StoredSkill[]> {
  return withUser(pool, scope, (db) =>
    selectSkills(db)
      .where(usable(scope))
      .orderBy(desc(sql`${skills.userId} = ${scope.userId}`), asc(skills.createdAt), asc(skills.id))
      .limit(limit),
  );
}

/** One skill the person can use, or null when they cannot see it. */
export function getSkill(pool: PoolLike, scope: UserScope, id: string): Promise<StoredSkill | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await selectSkills(db).where(and(eq(skills.id, id), usable(scope)));
    return row ?? null;
  });
}

/** False when the person already has `max`. Counted under a per-person lock, so parallel adds cannot pass it. */
export function addSkill(pool: PoolLike, scope: UserScope, skill: SkillFields & { readonly id: string }, max: number): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill|${scope.tenantId}|${scope.userId}`}, 0))`);
    const [existing] = await db.select({ value: count() }).from(skills).where(eq(skills.userId, scope.userId));
    if ((existing?.value ?? 0) >= max) return false;
    await db.insert(skills).values({ ...skill, tools: [...skill.tools], tenantId: scope.tenantId, userId: scope.userId });
    return true;
  });
}

/** Only the owner's own skill changes; for anyone else this finds nothing. */
export function updateSkill(pool: PoolLike, scope: UserScope, id: string, fields: SkillFields): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const changed = await db
      .update(skills)
      .set({ ...fields, tools: [...fields.tools], updatedAt: sql`now()` })
      .where(and(eq(skills.id, id), eq(skills.userId, scope.userId)))
      .returning({ id: skills.id });
    return changed.length > 0;
  });
}

export function deleteSkill(pool: PoolLike, scope: UserScope, id: string): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const removed = await db
      .delete(skills)
      .where(and(eq(skills.id, id), eq(skills.userId, scope.userId)))
      .returning({ id: skills.id });
    return removed.length > 0;
  });
}
