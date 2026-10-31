import { z } from "zod";
import { leakedIds, mean, ndcgAtK, reciprocalRank, recallAtK } from "./metrics.js";

export const GoldenCaseSchema = z.object({
  id: z.string().min(1),
  /** Seed user key from @brain/db seed-data, e.g. "patAcme". */
  asUser: z.string().min(1),
  query: z.string().min(1),
  expected: z.array(z.string()).default([]),
  /** Documents this user must never receive (permission-sensitive cases). */
  forbidden: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  /** Harness self-test only: canned results used by the fixture retriever. */
  fixtureResults: z.array(z.string()).optional(),
});
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

export const GoldenSetSchema = z.object({
  version: z.number().int().positive(),
  description: z.string(),
  cases: z.array(GoldenCaseSchema).min(1),
});
export type GoldenSet = z.infer<typeof GoldenSetSchema>;

export interface Retriever {
  retrieve(input: { asUser: string; query: string; k: number }): Promise<readonly string[]>;
}

export interface CaseResult {
  readonly id: string;
  readonly recall: number;
  readonly mrr: number;
  readonly ndcg: number;
  readonly leaked: readonly string[];
}

export interface EvalReport {
  readonly k: number;
  readonly cases: readonly CaseResult[];
  readonly recallAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
  readonly leakCount: number;
  readonly passed: boolean;
}

export interface Thresholds {
  readonly minRecallAtK: number;
}

/** NFR-QUAL-01 target. Leaks always fail regardless of thresholds. */
export const DEFAULT_THRESHOLDS: Thresholds = { minRecallAtK: 0.85 };

export async function runEval(
  golden: GoldenSet,
  retriever: Retriever,
  k = 10,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Promise<EvalReport> {
  const cases: CaseResult[] = [];
  for (const c of golden.cases) {
    const ranked = await retriever.retrieve({ asUser: c.asUser, query: c.query, k });
    cases.push({
      id: c.id,
      recall: recallAtK(ranked, c.expected, k),
      mrr: reciprocalRank(ranked, c.expected),
      ndcg: ndcgAtK(ranked, c.expected, k),
      leaked: leakedIds(ranked, c.forbidden),
    });
  }

  const recall = mean(cases.map((c) => c.recall));
  const leakCount = cases.reduce((n, c) => n + c.leaked.length, 0);
  return {
    k,
    cases,
    recallAtK: recall,
    mrr: mean(cases.map((c) => c.mrr)),
    ndcgAtK: mean(cases.map((c) => c.ndcg)),
    leakCount,
    passed: leakCount === 0 && recall >= thresholds.minRecallAtK,
  };
}

/** Returns each case's canned `fixtureResults`. Proves the harness, not retrieval quality. */
export function fixtureRetriever(golden: GoldenSet): Retriever {
  const byKey = new Map(golden.cases.map((c) => [`${c.asUser}|${c.query}`, c.fixtureResults ?? []]));
  return {
    retrieve: async ({ asUser, query, k }) => (byKey.get(`${asUser}|${query}`) ?? []).slice(0, k),
  };
}
