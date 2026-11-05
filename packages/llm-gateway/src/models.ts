/** The only place model IDs live (FR-LLM-03). Each tier trades quality for cost. */
export const TIERS = Object.freeze({
  fast: "claude-haiku-5-5",
  standard: "claude-sonnet-5-5",
  premium: "claude-opus-5-5",
});
export type Tier = keyof typeof TIERS;

/**
 * Which tier each task uses. Answers and agents need the strongest model, because a wrong answer or a
 * badly chosen action costs far more than the call. Turning a question into search words is simple.
 */
export const TASK_TIERS = Object.freeze({ answer: "premium", agent: "premium", rewrite: "fast" } satisfies Record<string, Tier>);

export const MODELS = Object.freeze({
  answer: TIERS[TASK_TIERS.answer],
  rewrite: TIERS[TASK_TIERS.rewrite],
  agent: TIERS[TASK_TIERS.agent],
});

/** Which model a company lets answers and agents use (FR-LLM-07). Search wording always uses the fast one. */
export type ModelChoice = "premium" | "standard";

export function modelFor(task: "answer" | "agent", choice: ModelChoice = "premium"): string {
  return choice === "standard" ? TIERS.standard : MODELS[task];
}

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
