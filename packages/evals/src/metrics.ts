// Retrieval metrics over ranked document IDs. `relevant` is the set of expected IDs.

export function recallAtK(ranked: readonly string[], relevant: readonly string[], k: number): number {
  if (relevant.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

/** Reciprocal rank of the first relevant result; 0 when none is retrieved. */
export function reciprocalRank(ranked: readonly string[], relevant: readonly string[]): number {
  const wanted = new Set(relevant);
  const index = ranked.findIndex((id) => wanted.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Binary-relevance nDCG@k. */
export function ndcgAtK(ranked: readonly string[], relevant: readonly string[], k: number): number {
  if (relevant.length === 0) return 1;
  const wanted = new Set(relevant);
  const dcg = ranked
    .slice(0, k)
    .reduce((sum, id, i) => (wanted.has(id) ? sum + 1 / Math.log2(i + 2) : sum), 0);
  const idealHits = Math.min(relevant.length, k);
  const idcg = Array.from({ length: idealHits }, (_, i) => 1 / Math.log2(i + 2)).reduce(
    (a, b) => a + b,
    0,
  );
  return dcg / idcg;
}

/**
 * Leak check: any retrieved ID the asking user must not see is a hard failure
 * (NFR-SEC-01), independent of ranking quality.
 */
export function leakedIds(ranked: readonly string[], forbidden: readonly string[]): readonly string[] {
  const blocked = new Set(forbidden);
  return ranked.filter((id) => blocked.has(id));
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
