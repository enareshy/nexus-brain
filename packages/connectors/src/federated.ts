import { isAppError } from "@brain/core";
import type { SearchHit } from "./types.js";

/** Reciprocal-rank-fusion constant (standard value). */
const RRF_K = 60;
const DEFAULT_BUDGET_MS = 3_000;

export interface FederatedSource {
  readonly id: string;
  run(): Promise<readonly SearchHit[]>;
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
  options: { readonly limit: number; readonly budgetMs?: number },
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

  const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, options.limit);
  return { hits, sources: outcomes.map((o) => o.status) };
}

async function runWithBudget(
  source: FederatedSource,
  budgetMs: number,
): Promise<{ hits: readonly SearchHit[]; status: SourceStatus }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("TIMEOUT")), budgetMs);
  });
  try {
    const hits = await Promise.race([source.run(), timeout]);
    return { hits, status: { id: source.id, ok: true, hits: hits.length, ms: Date.now() - started } };
  } catch (err) {
    const error = isAppError(err) ? err.code : err instanceof Error && err.message === "TIMEOUT" ? "TIMEOUT" : "ERROR";
    return { hits: [], status: { id: source.id, ok: false, hits: 0, ms: Date.now() - started, error } };
  } finally {
    clearTimeout(timer);
  }
}
