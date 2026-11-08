import { applyLearnedRanker, examplesFromAnswer, type RankerModel } from "@brain/connectors";
import { getTenantRanker, recordRankingExamples, type PoolLike, type StoredRankingExample, type UserScope } from "@brain/db";
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
  };
}

/**
 * A company's learned ranker (FR-RET-08). It is trained offline by an operator from ratings saved
 * as general signals; until a trained model beats today's order, ranking stays as it is. Like the
 * work graph, it only reorders a person's own results, and a problem with it never fails a search
 * or a rating.
 */
export class RankerService implements LearnedRanking {
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
