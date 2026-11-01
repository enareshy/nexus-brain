import { isAppError } from "@brain/core";
import { toKeywords, toTextSearchTerm } from "./atlassian.js";
import type { SearchHit } from "./types.js";

// BM25 standard term-saturation value.
const K1 = 1.2;
/** A word in a title says more about a document than the same word in a snippet. */
const TITLE_WEIGHT = 3;
const MIN_STEM_CHARS = 4;

/** Light suffix stripping, so "keys" and "key", or "rotating" and "rotate", match. English only. */
export function stem(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length < MIN_STEM_CHARS) return lower;
  const singular = lower.replace(/(?<!s)s$/, "");
  const withoutEnding = singular.replace(/(?:ing|ed)$/, "");
  // Words like "need" and "king" are not "ne" and "k" with an ending.
  const base = withoutEnding.length >= MIN_STEM_CHARS ? withoutEnding : singular;
  return base.length > MIN_STEM_CHARS ? base.replace(/e$/, "") : base;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem);
}

function queryTerms(query: string): string[] {
  try {
    return [...new Set(toKeywords(toTextSearchTerm(query)).map(stem))];
  } catch (err) {
    // A question with nothing searchable in it leaves the order as it is.
    if (isAppError(err)) return [];
    throw err;
  }
}

function weightedCounts(hit: SearchHit): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words(hit.title)) counts.set(word, (counts.get(word) ?? 0) + TITLE_WEIGHT);
  for (const word of words(hit.snippet)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

/**
 * Orders hits by how well their title and snippet match the question (BM25, scored within these
 * results). It runs locally, costs nothing, and only reorders. Ties keep the incoming order,
 * which is the merged order from the sources.
 */
export function rerankHits<T extends SearchHit>(query: string, hits: readonly T[]): T[] {
  const terms = queryTerms(query);
  const counted = hits.map(weightedCounts);
  const idf = new Map(
    terms.map((term) => {
      const containing = counted.filter((counts) => counts.has(term)).length;
      return [term, Math.log(1 + (hits.length - containing + 0.5) / (containing + 0.5))] as const;
    }),
  );
  const score = (counts: Map<string, number>) =>
    terms.reduce((sum, term) => {
      const tf = counts.get(term) ?? 0;
      return sum + ((idf.get(term) ?? 0) * (tf * (K1 + 1))) / (tf + K1);
    }, 0);

  return hits
    .map((hit, index) => ({ hit, index, score: score(counted[index]!) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.hit);
}
