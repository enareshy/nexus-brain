import { isAppError } from "@brain/core";
import { rerankHits } from "./rerank.js";
import type { SearchHit } from "./types.js";

/** Reciprocal-rank-fusion constant (standard value). */
const RRF_K = 60;
// Measured against live Atlassian (2026-11-01): connect 0.4-1 s, sites 0.8-1.2 s, JQL/CQL 1.1-2.1 s.
// The 3 s target in FR-MCP-05 needs reused sessions and cached sites; until then allow 10 s.
const DEFAULT_BUDGET_MS = 10_000;

export interface FederatedSource {
  readonly id: string;
  /** `signal` aborts when the budget runs out; stop work and release resources. */
  run(signal: AbortSignal): Promise<readonly SearchHit[]>;
}

export interface SourceStatus {
  readonly id: string;
  readonly ok: boolean;
  readonly hits: number;
  readonly ms: number;
  /** Error code only (never raw server text). */
  readonly error?: string;
}

export interface RankedHit extends SearchHit {
  readonly score: number;
}

export interface FederatedResult {
  readonly hits: readonly RankedHit[];
  readonly sources: readonly SourceStatus[];
}

/**
 * Fans a query out to every source in parallel within a time budget (FR-MCP-05),
 * merges with reciprocal rank fusion and dedupes by URL. A slow or failing source
 * never fails the whole search; its status is reported instead.
 */
export async function federatedSearch(
  sources: readonly FederatedSource[],
  options: {
    readonly limit: number;
    readonly budgetMs?: number;
    /** The user's question. When given, results are reranked against it before the limit applies. */
    readonly rerankQuery?: string;
  },
): Promise<FederatedResult> {
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const outcomes = await Promise.all(sources.map((s) => runWithBudget(s, budget)));

  const merged = new Map<string, RankedHit>();
  for (const outcome of outcomes) {
    outcome.hits.forEach((hit, rank) => {
      const score = 1 / (RRF_K + rank + 1);
      const existing = merged.get(hit.url);
      merged.set(hit.url, existing ? { ...existing, score: existing.score + score } : { ...hit, score });
    });
  }

  const fused = [...merged.values()].sort((a, b) => b.score - a.score);
  const ordered = options.rerankQuery === undefined ? fused : rerankHits(options.rerankQuery, fused);
  return { hits: ordered.slice(0, options.limit), sources: outcomes.map((o) => o.status) };
}

async function runWithBudget(
  source: FederatedSource,
  budgetMs: number,
): Promise<{ hits: readonly SearchHit[]; status: SourceStatus }> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("TIMEOUT"));
    }, budgetMs);
  });
  try {
    const hits = await Promise.race([source.run(controller.signal), timeout]);
    return { hits, status: { id: source.id, ok: true, hits: hits.length, ms: Date.now() - started } };
  } catch (err) {
    const error = isAppError(err) ? err.code : err instanceof Error && err.message === "TIMEOUT" ? "TIMEOUT" : "ERROR";
    return { hits: [], status: { id: source.id, ok: false, hits: 0, ms: Date.now() - started, error } };
  } finally {
    clearTimeout(timer);
  }
}
