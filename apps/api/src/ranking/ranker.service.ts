import { applyLearnedRanker, examplesFromAnswer, RANKER_LIMITS, type RankerModel } from "@brain/connectors";
import { getTenantRanker, recordRankingExamples, type PoolLike, type StoredRanker, type StoredRankingExample, type UserScope } from "@brain/db";
import { z } from "zod";

// Weights are bounded in training; anything larger did not come from it.
const WEIGHT = z.number().finite().min(-3).max(3);
/** The saved model, checked before use: anything else leaves ranking as it is. */
const ModelSchema = z.object({
  version: z.literal(1),
  bias: WEIGHT,
  weights: z.object({ position: WEIGHT, score: WEIGHT, recency: WEIGHT, undated: WEIGHT }),
  sources: z
    .record(z.string().regex(/^[a-z0-9-]{1,40}$/), WEIGHT)
    .refine((sources) => Object.keys(sources).length <= 100, "too many services"),
});

export interface RankerStore {
  model(tenantId: string): Promise<unknown>;
  record(tenantId: string, rows: readonly StoredRankingExample[]): Promise<void>;
  /** The last training's saved result, for the Admin page. */
  saved(tenantId: string): Promise<StoredRanker | null>;
}

/** What training reports, as saved by `ranker:train`; checked before it is shown. */
const MetricsSchema = z.object({
  examples: z.number().int().nonnegative(),
  answers: z.number().int().nonnegative(),
  holdoutMrr: z.number().finite(),
  baselineMrr: z.number().finite(),
  active: z.boolean(),
  reason: z.enum(["too_few", "no_gain", "better"]),
});

/**
 * Whether a company's learned ranker is in use, and why, for its admins (FR-RET-08). "On" means
 * exactly what searches do: a usable model is saved. `details` is null if the training report saved
 * with it cannot be read. `minAnswers` is what training needs, for the explanation.
 */
export type RankerStatus =
  | { readonly state: "never_trained"; readonly minAnswers: number }
  | {
      readonly state: "on" | "off";
      readonly minAnswers: number;
      readonly trainedAt: string;
      readonly details: {
        readonly reason: "too_few" | "no_gain" | "better";
        readonly answers: number;
        readonly examples: number;
        readonly holdoutMrr: number;
        readonly baselineMrr: number;
      } | null;
    };

export interface RankerStatusApi {
  status(tenantId: string): Promise<RankerStatus>;
}

/** One rated answer: its results and which of them it cited (1-based source numbers). */
export interface RatedAnswer {
  readonly hits: ReadonlyArray<{ readonly serverId: string; readonly score?: number; readonly updatedAt: string | null }>;
  readonly parts: ReadonlyArray<{ readonly kind: string; readonly source?: number }>;
}

export interface LearnedRanking {
  rank<T extends { readonly serverId: string; readonly score?: number; readonly updatedAt: string | null }>(scope: UserScope, hits: readonly T[]): Promise<T[]>;
  /** `messageId` ties the saved rows to one answer, so it is saved once however often it is rated. */
  answerRated(scope: UserScope, answer: RatedAnswer, rating: "up" | "down", messageId: string): Promise<void>;
  /** For callers whose own step for the ranker failed: reported, never thrown. */
  report(err: unknown): void;
}

/** A company's model is read again after this long, so a newly trained one is picked up. */
const MODEL_CACHE_MS = 10 * 60_000;
/** Companies whose model is kept in memory at once. */
const MAX_CACHED = 1_000;
/** How long a search waits to read a model it has not cached; then it keeps its order. */
const LOAD_TIME_LIMIT_MS = 250;
/** After a failed or slow read, searches keep their order this long before trying again. */
const FAILURE_CACHE_MS = 30_000;
const SERVER_ID = /^[a-z0-9-]{1,40}$/;

export function createRankerStore(pool: PoolLike): RankerStore {
  return {
    model: async (tenantId) => (await getTenantRanker(pool, tenantId))?.model ?? null,
    record: (tenantId, rows) => recordRankingExamples(pool, tenantId, rows),
    saved: (tenantId) => getTenantRanker(pool, tenantId),
  };
}

/**
 * A company's learned ranker (FR-RET-08). It is trained offline by an operator from ratings saved
 * as general signals; until a trained model beats today's order, ranking stays as it is. Like the
 * work graph, it only reorders a person's own results, and a problem with it never fails a search
 * or a rating.
 */
export class RankerService implements LearnedRanking, RankerStatusApi {
  private readonly cache = new Map<string, { readonly model: RankerModel | null; readonly until: number }>();
  /** One read per company at a time, shared by searches waiting on it. */
  private readonly loading = new Map<string, Promise<RankerModel | null>>();

  constructor(
    private readonly deps: {
      readonly store: RankerStore;
      readonly onError: (err: unknown) => void;
      /** Keyed hash (the app's key), so an answer's group id cannot be worked back to its message. */
      readonly fingerprint: (value: string) => string;
      readonly now?: () => number;
    },
  ) {}

  async rank<T extends { readonly serverId: string; readonly score?: number; readonly updatedAt: string | null }>(scope: UserScope, hits: readonly T[]): Promise<T[]> {
    if (hits.length < 2) return [...hits];
    try {
      const model = await this.modelFor(scope.tenantId);
      return model ? applyLearnedRanker(hits, model, this.now()) : [...hits];
    } catch (err) {
      this.deps.onError(err);
      return [...hits];
    }
  }

  async answerRated(scope: UserScope, answer: RatedAnswer, rating: "up" | "down", messageId: string): Promise<void> {
    const cited = answer.parts.flatMap((part) => (part.kind === "cite" && part.source !== undefined ? [part.source] : []));
    // Only results the database accepts; at most the answer's first 20.
    const hits = answer.hits.slice(0, 20);
    const rows = examplesFromAnswer({ hits, cited }, rating, this.groupOf(scope, messageId), this.now()).filter(
      (row) => SERVER_ID.test(row.serverId) && row.position <= 99,
    );
    await this.deps.store.record(scope.tenantId, rows).catch((err: unknown) => this.deps.onError(err));
  }

  report(err: unknown): void {
    this.deps.onError(err);
  }

  /**
   * The last training's result. It is "on" exactly when searches would use the saved model, whatever
   * the training report says; a report that cannot be read is reported, and its details left out.
   */
  async status(tenantId: string): Promise<RankerStatus> {
    const minAnswers = RANKER_LIMITS.minAnswers;
    const saved = await this.deps.store.saved(tenantId);
    if (!saved) return { state: "never_trained", minAnswers };
    const usable = saved.model !== null && ModelSchema.safeParse(saved.model).success;
    const metrics = MetricsSchema.safeParse(saved.metrics);
    if (!metrics.success) this.deps.onError(new Error("Saved ranker training result is not valid"));
    const details = metrics.success
      ? (({ active: _active, ...rest }) => rest)(metrics.data)
      : null;
    return { state: usable ? "on" : "off", minAnswers, trainedAt: saved.trainedAt.toISOString(), details };
  }

  /** The same answer always gets the same group, so saving it again adds nothing. */
  private groupOf(scope: UserScope, messageId: string): string {
    const hex = this.deps.fingerprint(`ranking-answer|${scope.tenantId}|${messageId}`).slice(0, 32).padEnd(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async modelFor(tenantId: string): Promise<RankerModel | null> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.until > this.now()) return cached.model;
    const inFlight = this.loading.get(tenantId);
    if (inFlight) return inFlight;
    const load = this.load(tenantId).finally(() => this.loading.delete(tenantId));
    this.loading.set(tenantId, load);
    return load;
  }

  private remember(tenantId: string, model: RankerModel | null, forMs: number): void {
    if (this.cache.size >= MAX_CACHED) this.cache.clear();
    this.cache.set(tenantId, { model, until: this.now() + forMs });
  }

  private async load(tenantId: string): Promise<RankerModel | null> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Learned ranker took too long to load")), LOAD_TIME_LIMIT_MS);
    });
    try {
      const raw = await Promise.race([this.deps.store.model(tenantId), late]);
      const parsed = raw === null ? null : ModelSchema.safeParse(raw);
      if (parsed && !parsed.success) this.deps.onError(new Error("Saved learned ranker is not valid; ranking left as it is"));
      const model = parsed?.success ? (parsed.data as RankerModel) : null;
      this.remember(tenantId, model, MODEL_CACHE_MS);
      return model;
    } catch (err) {
      // Searches keep their order for a while, rather than each waiting on a struggling database.
      this.remember(tenantId, null, FAILURE_CACHE_MS);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
