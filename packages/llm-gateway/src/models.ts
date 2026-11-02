/**
 * The only place model IDs live. Change the answer model here to trade quality for cost,
 * for example "claude-sonnet-5-5" ($2/$10 per MTok) or "claude-haiku-5-5" ($0.10/$0.50).
 */
export const MODELS = Object.freeze({ answer: "claude-opus-5-5", rewrite: "claude-haiku-5-5", agent: "claude-opus-5-5" });

export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
}

// Anthropic first-party rates from the API reference (cached 2026-10-06). The usage ledger
// holds estimates; reconcile with invoices (FR-MET-04). Includes likely refusal fallbacks.
export const PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  // Rewrites use no caching, so its cache rates are never charged here.
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
});

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Estimated cost in USD, or null when the serving model has no known price. */
export function estimateCostUsd(model: string, tokens: TokenCounts): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (
    (tokens.inputTokens * price.inputPerMTok +
      tokens.outputTokens * price.outputPerMTok +
      tokens.cacheReadTokens * price.cacheReadPerMTok +
      tokens.cacheWriteTokens * price.cacheWritePerMTok) /
    1_000_000
  );
}
