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
  /** Overrides the default recall floor, e.g. to catch regressions below a target not yet met. */
  minRecallAtK: z.number().min(0).max(1).optional(),
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
  readonly returned: number;
}

export interface TagReport {
  readonly cases: number;
  readonly recallAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
}

export interface EvalReport {
  readonly k: number;
  readonly cases: readonly CaseResult[];
  readonly recallAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
  readonly leakCount: number;
  /** Questions with nothing to find that still returned something. Reported, not a failure. */
  readonly noAnswerWithResults: number;
  readonly byTag: Readonly<Record<string, TagReport>>;
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
      returned: ranked.length,
    });
  }

  // A question with nothing to find scores a perfect 1, so it must not raise the averages.
  const answerable = cases.filter((_, i) => golden.cases[i]!.expected.length > 0);
  const quality = summarize(answerable);
  const leakCount = cases.reduce((n, c) => n + c.leaked.length, 0);
  const floor = golden.minRecallAtK ?? thresholds.minRecallAtK;
  return {
    k,
    cases,
    ...quality,
    leakCount,
    noAnswerWithResults: cases.filter((c, i) => {
      const goldenCase = golden.cases[i]!;
      return goldenCase.expected.length === 0 && goldenCase.forbidden.length === 0 && c.returned > 0;
    }).length,
    byTag: reportByTag(golden, cases),
    passed: leakCount === 0 && quality.recallAtK >= floor,
  };
}

function summarize(cases: readonly CaseResult[]): Omit<TagReport, "cases"> {
  return {
    recallAtK: mean(cases.map((c) => c.recall)),
    mrr: mean(cases.map((c) => c.mrr)),
    ndcgAtK: mean(cases.map((c) => c.ndcg)),
  };
}

function reportByTag(golden: GoldenSet, cases: readonly CaseResult[]): Record<string, TagReport> {
  const groups = new Map<string, CaseResult[]>();
  golden.cases.forEach((goldenCase, i) => {
    if (goldenCase.expected.length === 0) return;
    for (const tag of goldenCase.tags) groups.set(tag, [...(groups.get(tag) ?? []), cases[i]!]);
  });
  return Object.fromEntries(
    [...groups].map(([tag, group]) => [tag, { cases: group.length, ...summarize(group) }]),
  );
}

/** Returns each case's canned `fixtureResults`. Proves the harness, not retrieval quality. */
export function fixtureRetriever(golden: GoldenSet): Retriever {
  const byKey = new Map(golden.cases.map((c) => [`${c.asUser}|${c.query}`, c.fixtureResults ?? []]));
  return {
    retrieve: async ({ asUser, query, k }) => (byKey.get(`${asUser}|${query}`) ?? []).slice(0, k),
  };
}
