import { isAppError } from "@brain/core";
import { appendUsage, type PoolLike, type UserScope } from "@brain/db";
import type { LlmGateway, UsageReport } from "@brain/llm-gateway";
import type { Logger } from "@brain/telemetry";
import { TtlCache } from "../connections/ttl-cache.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED = 500;
const RATE_WINDOW_MS = 60_000;
/** In-process cost guard per user; plan budgets come with FR-MET-02/03. */
const MAX_REWRITES_PER_WINDOW = 30;

export interface QueryExpander {
  /** Extra search words for a question. Empty means search with the question alone. */
  expand(
    scope: UserScope,
    question: string,
    signal: AbortSignal,
    previousQuestions?: readonly string[],
  ): Promise<readonly string[]>;
}

/** New words go first, because searches keep only the first few keywords. */
export function withExpandedTerms(question: string, terms: readonly string[]): string {
  return [...terms, question].join(" ");
}

export interface QueryRewriterDeps {
  readonly pool: PoolLike;
  /** Null when no API key is configured. */
  readonly gateway: LlmGateway | null;
  readonly logger: Pick<Logger, "error">;
  readonly now?: () => number;
}

/** Asks the model for better search words. It never fails a search: on any problem, it adds none. */
export class QueryRewriter implements QueryExpander {
  private readonly now: () => number;
  private readonly cache: TtlCache<readonly string[]>;
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly deps: QueryRewriterDeps) {
    this.now = deps.now ?? Date.now;
    this.cache = new TtlCache(MAX_CACHED, this.now);
  }

  async expand(
    scope: UserScope,
    question: string,
    signal: AbortSignal,
    previousQuestions: readonly string[] = [],
  ): Promise<readonly string[]> {
    const gateway = this.deps.gateway;
    if (!gateway) return [];
    const userKey = `${scope.tenantId}|${scope.userId}`;
    // A follow-up means something different after different questions.
    const cacheKey = `${userKey}|${JSON.stringify(previousQuestions)}|${question.trim()}`;
    // Before the cache: a repeated empty search also costs a second search of every source.
    if (!this.allow(userKey)) return [];
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const onUsage = (usage: UsageReport) => {
        const { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, estimated } = usage;
        // Bookkeeping only, so a failed write must not lose the result. Not awaited for speed.
        void appendUsage(this.deps.pool, scope, {
          feature: estimated ? "query_rewrite_estimated" : "query_rewrite",
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          costUsd,
        }).catch((err: unknown) => this.deps.logger.error({ err, tenant_id: scope.tenantId }, "Usage ledger write failed"));
      };
      const terms = await gateway.rewriteQuery(question, signal, onUsage, previousQuestions);
      this.cache.set(cacheKey, terms, CACHE_TTL_MS);
      return terms;
    } catch (err) {
      // Only the reason: provider error text can quote the question.
      const reason = isAppError(err) ? err.details?.reason : "unexpected";
      this.deps.logger.error({ reason, tenant_id: scope.tenantId }, "Query rewrite failed");
      return [];
    }
  }

  private allow(userKey: string): boolean {
    const now = this.now();
    // Drop users with no recent calls so the map cannot grow without bound.
    for (const [other, times] of this.recent) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) this.recent.delete(other);
    }
    const inWindow = (this.recent.get(userKey) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (inWindow.length >= MAX_REWRITES_PER_WINDOW) return false;
    this.recent.set(userKey, [...inWindow, now]);
    return true;
  }
}
