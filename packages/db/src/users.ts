import { AppError, type Role } from "@brain/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentRuns, agentTriggers, auditLog, mcpConnections, oauthStates, users, writeProposals } from "./schema.js";
import { withTenant, withUser, type PoolLike, type TenantDb, type UserScope } from "./tenant.js";

const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export interface StoredPerson {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly deactivatedAt: Date | null;
  /** Set once the person has been erased; their name and email are then placeholders. */
  readonly erasedAt: Date | null;
}

/** The signed-in person's own record. */
export async function getProfile(pool: PoolLike, scope: UserScope): Promise<Pick<StoredPerson, "email" | "displayName" | "role"> | null> {
  const [row] = await withTenant(pool, scope.tenantId, (db) =>
    db
      .select({ email: users.email, displayName: users.displayName, role: users.role })
      .from(users)
      .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, scope.userId))),
  );
  return row ?? null;
}

/** Everyone in the company, active or not. Callers must have checked the user is an admin. */
export function listPeople(pool: PoolLike, tenantId: string): Promise<StoredPerson[]> {
  return withTenant(pool, tenantId, (db) =>
    db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        deactivatedAt: users.deactivatedAt,
        erasedAt: users.erasedAt,
      })
      .from(users)
      .orderBy(asc(users.email)),
  );
}

/** A connection deleted when someone was turned off, so its grant can still be revoked at the provider. */
export interface RemovedConnection {
  readonly serverId: string;
  readonly tokensCiphertext: string;
}

export interface Deactivation {
  /** False when the person was already turned off, so nothing changed. */
  readonly changed: boolean;
  readonly removedConnections: readonly RemovedConnection[];
  readonly triggersPaused: number;
  readonly runsCancelled: number;
  readonly proposalsRejected: number;
  /** Changes already approved and being carried out. They finish; turning off cannot recall them. */
  readonly changesInProgress: number;
}

interface LockedPair {
  readonly actor: { readonly role: Role };
  readonly target: { readonly role: Role; readonly deactivatedAt: Date | null; readonly erasedAt: Date | null };
}

/**
 * Locks both people for the rest of the transaction and checks the change is allowed: only an
 * active admin may act, nobody acts on themselves, and only an owner may act on an owner. The
 * actor's role is read again here, so a role removed a moment ago no longer counts.
 */
async function lockPair(db: TenantDb, actorId: string, targetId: string): Promise<LockedPair> {
  if (actorId === targetId) throw new AppError("VALIDATION", "You cannot turn yourself off");
  const rows = await db
    .select({ id: users.id, role: users.role, deactivatedAt: users.deactivatedAt, erasedAt: users.erasedAt })
    .from(users)
    .where(inArray(users.id, [actorId, targetId]))
    // Always the same order, so two admins acting on each other cannot deadlock.
    .orderBy(asc(users.id))
    .for("no key update");
  const actor = rows.find((r) => r.id === actorId);
  const target = rows.find((r) => r.id === targetId);
  if (!actor || actor.deactivatedAt || !ADMIN_ROLES.has(actor.role)) {
    throw new AppError("FORBIDDEN", "Only an admin can change who has access");
  }
  if (!target) throw new AppError("NOT_FOUND", "No such person in this workspace");
  if (target.role === "owner" && actor.role !== "owner") {
    throw new AppError("FORBIDDEN", "Only an owner can change an owner's access");
  }
  return { actor, target };
}

/**
 * Turns someone off in one transaction (FR-CON-02): they cannot sign in, their automatic agents
 * stop, running agents are cancelled, changes waiting for their approval are rejected and their
 * stored tokens are deleted. Their history stays, so turning them back on restores their records
 * but not their connections or schedules. The audit entry is written in the same transaction.
 */
export function deactivateUser(pool: PoolLike, actor: UserScope, targetId: string): Promise<Deactivation> {
  // Scoped to the person being turned off, so their private rows are reachable here and nowhere else.
  return withUser(pool, { tenantId: actor.tenantId, userId: targetId }, async (db) => {
    const { target } = await lockPair(db, actor.userId, targetId);
    if (target.deactivatedAt) {
      return { changed: false, removedConnections: [], triggersPaused: 0, runsCancelled: 0, proposalsRejected: 0, changesInProgress: 0 };
    }
    const now = new Date();
    await db.update(users).set({ deactivatedAt: now }).where(eq(users.id, targetId));
    const triggers = await db
      .update(agentTriggers)
      .set({ enabled: false, pausedReason: "owner_turned_off" })
      .where(eq(agentTriggers.enabled, true))
      .returning({ id: agentTriggers.id });
    // Clearing the lease token as well stops a worker that is mid-turn at its next save.
    const runs = await db
      .update(agentRuns)
      .set({ status: "cancelled", errorCode: "owner_turned_off", leaseUntil: null, leaseToken: null, updatedAt: now })
      .where(inArray(agentRuns.status, ["running", "waiting_approval"]))
      .returning({ id: agentRuns.id });
    const proposals = await db
      .update(writeProposals)
      .set({ status: "rejected", decidedAt: now })
      .where(eq(writeProposals.status, "pending"))
      .returning({ id: writeProposals.id });
    const inProgress = await db
      .select({ id: writeProposals.id })
      .from(writeProposals)
      .where(eq(writeProposals.status, "executing"));
    await db.delete(oauthStates).where(and(eq(oauthStates.tenantId, actor.tenantId), eq(oauthStates.userId, targetId)));
    const removedConnections = await db
      .delete(mcpConnections)
      .returning({ serverId: mcpConnections.serverId, tokensCiphertext: mcpConnections.tokensCiphertext });
    const result = {
      changed: true,
      removedConnections,
      triggersPaused: triggers.length,
      runsCancelled: runs.length,
      proposalsRejected: proposals.length,
      changesInProgress: inProgress.length,
    };
    await db.insert(auditLog).values({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: "user.deactivated",
      resource: targetId,
      meta: {
        connectionsRemoved: removedConnections.length,
        triggersPaused: result.triggersPaused,
        runsCancelled: result.runsCancelled,
        proposalsRejected: result.proposalsRejected,
        changesInProgress: result.changesInProgress,
      },
    });
    return result;
  });
}

export interface Erasure {
  /** False when the person had already been erased, so nothing changed. */
  readonly erased: boolean;
  readonly conversations: number;
  readonly memories: number;
  readonly skills: number;
  readonly agentRuns: number;
  readonly automaticAgents: number;
  readonly changes: number;
  readonly notifications: number;
}

const ERASE_ERRORS: Readonly<Record<string, AppError>> = {
  BR400: new AppError("VALIDATION", "You cannot erase yourself"),
  BR403: new AppError("FORBIDDEN", "Only an admin can erase someone, and only an owner can erase an owner"),
  BR404: new AppError("NOT_FOUND", "No such person in this workspace"),
  BR409: new AppError("VALIDATION", "Turn this person off before erasing them, so their connections are revoked first"),
  BR423: new AppError("CONFLICT", "A change this person approved is still being carried out. Try again in a few minutes"),
};

/**
 * Erases one person (FR-ADM-03): everything they own is deleted and their name, email and sign-in
 * identity are replaced, in one transaction, by a database function that checks every condition itself
 * under a lock. The audit entry is written in the same transaction, with counts only.
 */
export async function eraseUser(pool: PoolLike, actor: UserScope, targetId: string): Promise<Erasure> {
  try {
    return await withUser(pool, actor, async (db) => {
      const result = await db.execute(sql`SELECT * FROM app_erase_person(${actor.userId}::uuid, ${targetId}::uuid)`);
      const row = result.rows[0] as Record<string, unknown>;
      return {
        erased: row.erased === true,
        conversations: Number(row.conversations),
        memories: Number(row.memories),
        skills: Number(row.skills),
        agentRuns: Number(row.agent_runs),
        automaticAgents: Number(row.automatic_agents),
        changes: Number(row.changes),
        notifications: Number(row.notifications),
      };
    });
  } catch (err) {
    const known = Object.entries(ERASE_ERRORS).find(([code]) => hasSqlState(err, code));
    if (known) throw known[1];
    throw err;
  }
}

/** Lets someone sign in again. Connections and schedules are not restored; they set those up again. */
export function reactivateUser(pool: PoolLike, actor: UserScope, targetId: string): Promise<{ changed: boolean }> {
  return withTenant(pool, actor.tenantId, async (db) => {
    const { target } = await lockPair(db, actor.userId, targetId);
    if (target.erasedAt) throw new AppError("VALIDATION", "This person was erased and cannot be turned back on");
    if (!target.deactivatedAt) return { changed: false };
    await db.update(users).set({ deactivatedAt: null }).where(eq(users.id, targetId));
    await db.insert(auditLog).values({ tenantId: actor.tenantId, userId: actor.userId, action: "user.reactivated", resource: targetId });
    return { changed: true };
  });
}

/** Whether a Postgres error with this SQLSTATE is the error or its cause (the ORM wraps driver errors). */
function hasSqlState(err: unknown, code: string): boolean {
  for (let current: unknown = err, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === "object" && "code" in current && (current as { code: unknown }).code === code) return true;
    current = typeof current === "object" && "cause" in current ? (current as { cause: unknown }).cause : null;
  }
  return false;
}

/** True when Postgres chose this transaction as a deadlock victim, so running it again is safe. */
export const isDeadlockError = (err: unknown): boolean => hasSqlState(err, "40P01");

/** True for the database's refusal to do anything for someone who is turned off. */
export const isUserTurnedOffError = (err: unknown): boolean => hasSqlState(err, "BR403");
