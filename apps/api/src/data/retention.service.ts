import {
  forgetStaleGraphLinks,
  getRetention,
  PurgeAuditError,
  purgeExpired,
  saveRetention,
  type PoolLike,
  type PurgeResult,
  type Retention,
  type UserScope,
} from "@brain/db";
import type { Logger } from "@brain/telemetry";

/** Once an hour is plenty for settings counted in days. */
const SWEEP_MS = 60 * 60 * 1000;
/** Per kind and company per round, so each database call stays short. */
const SWEEP_BATCH = 1_000;
/** Rounds per sweep: a large backlog is cleared within a few sweeps, not one batch an hour. */
const MAX_ROUNDS = 20;
const KEEP_EVERYTHING: Retention = { conversationDays: null, agentRunDays: null };

export interface RetentionApi {
  get(scope: UserScope): Promise<Retention>;
  /** Callers must have checked the person is an admin. */
  set(scope: UserScope, retention: Retention): Promise<Retention>;
}

/**
 * How long a company keeps chats and agent runs (FR-ADM-03). Expired ones are removed by a sweep that
 * sees across people only through one database function, which can delete nothing else.
 */
export class RetentionService implements RetentionApi {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: { readonly pool: PoolLike; readonly logger: Pick<Logger, "info" | "error"> }) {}

  async get(scope: UserScope): Promise<Retention> {
    return (await getRetention(this.deps.pool, scope.tenantId)) ?? KEEP_EVERYTHING;
  }

  async set(scope: UserScope, retention: Retention): Promise<Retention> {
    await saveRetention(this.deps.pool, scope, retention);
    return retention;
  }

  /** Removes what has expired, in rounds until done. Reports counts only, never what was removed. */
  async sweep(): Promise<readonly PurgeResult[]> {
    const all: PurgeResult[] = [];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const results = await purgeExpired(this.deps.pool, SWEEP_BATCH).catch((err: unknown) => {
        if (!(err instanceof PurgeAuditError)) throw err;
        this.deps.logger.error({ tenant_ids: err.tenantIds }, "Expired data removed without an audit entry");
        return err.results;
      });
      for (const { tenantId, ...removed } of results) this.deps.logger.info({ tenant_id: tenantId, ...removed }, "Expired data removed");
      all.push(...results);
      const more = results.some((r) => r.conversations >= SWEEP_BATCH || r.agentRuns >= SWEEP_BATCH || r.notifications >= SWEEP_BATCH);
      if (!more) break;
    }
    return all;
  }

  /**
   * Removes everyone's work graph links not seen for 90 days (FR-RET-09), so someone who stops using
   * Brain does not keep theirs. Logs the count only.
   */
  async forgetStaleLinks(): Promise<number> {
    let removed = 0;
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const batch = await forgetStaleGraphLinks(this.deps.pool, SWEEP_BATCH);
        removed += batch;
        if (batch < SWEEP_BATCH) break;
      }
    } finally {
      // Also when a later batch fails, so what was removed is still on record.
      if (removed > 0) this.deps.logger.info({ removed }, "Old work graph links removed");
    }
    return removed;
  }

  start(): void {
    if (this.timer) return;
    const errorType = (err: unknown) => (err instanceof Error ? err.name : typeof err);
    // Each on its own, so one failing never stops the other.
    const run = () => {
      void this.sweep().catch((err: unknown) => this.deps.logger.error({ errorType: errorType(err) }, "Removing expired data failed"));
      void this.forgetStaleLinks().catch((err: unknown) =>
        this.deps.logger.error({ errorType: errorType(err) }, "Removing old work graph links failed"),
      );
    };
    this.timer = setInterval(run, SWEEP_MS);
    this.timer.unref?.();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
