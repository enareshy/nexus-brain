import type { Role } from "@brain/core";
import { deactivateUser, isDeadlockError, listPeople, reactivateUser, type PoolLike, type RemovedConnection, type UserScope } from "@brain/db";
import type { Logger } from "@brain/telemetry";

export interface PersonView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly active: boolean;
  readonly deactivatedAt: string | null;
}

export interface DeactivationView {
  readonly changed: boolean;
  readonly connectionsRemoved: number;
  /** Grants also revoked at the provider. The rest only lost their stored tokens here. */
  readonly connectionsRevoked: number;
  readonly triggersPaused: number;
  readonly runsCancelled: number;
  readonly proposalsRejected: number;
  readonly changesInProgress: number;
}

/** Callers must have checked the user is an admin; the database checks again under a lock. */
export interface PeopleApi {
  list(scope: UserScope): Promise<readonly PersonView[]>;
  deactivate(scope: UserScope, personId: string): Promise<DeactivationView>;
  reactivate(scope: UserScope, personId: string): Promise<{ changed: boolean }>;
}

export interface PeopleDeps {
  readonly pool: PoolLike;
  readonly logger: Logger;
  readonly connections: {
    revokeRemoved(scope: UserScope, removed: readonly RemovedConnection[]): Promise<number>;
  };
}

const DEADLOCK_ATTEMPTS = 3;

/**
 * Turning someone off locks their row before their work, while work for them locks the other way
 * round, so Postgres may pick this as a deadlock victim. It rolled back whole, so it can run again.
 */
async function withDeadlockRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      if (attempt >= DEADLOCK_ATTEMPTS || !isDeadlockError(err)) throw err;
    }
  }
}

export function createPeopleService(deps: PeopleDeps): PeopleApi {
  return {
    async list(scope) {
      const people = await listPeople(deps.pool, scope.tenantId);
      return people.map((p) => ({
        id: p.id,
        email: p.email,
        displayName: p.displayName,
        role: p.role,
        active: p.deactivatedAt === null,
        deactivatedAt: p.deactivatedAt?.toISOString() ?? null,
      }));
    },

    async deactivate(scope, personId) {
      const result = await withDeadlockRetry(() => deactivateUser(deps.pool, scope, personId));
      // After the commit: the person is already locked out whether or not the providers answer.
      const connectionsRevoked = await deps.connections.revokeRemoved(
        { tenantId: scope.tenantId, userId: personId },
        result.removedConnections,
      );
      deps.logger.info(
        { tenant_id: scope.tenantId, user_id: scope.userId, target_user_id: personId, changed: result.changed },
        "Person turned off",
      );
      return {
        changed: result.changed,
        connectionsRemoved: result.removedConnections.length,
        connectionsRevoked,
        triggersPaused: result.triggersPaused,
        runsCancelled: result.runsCancelled,
        proposalsRejected: result.proposalsRejected,
        changesInProgress: result.changesInProgress,
      };
    },

    reactivate: (scope, personId) => reactivateUser(deps.pool, scope, personId),
  };
}
