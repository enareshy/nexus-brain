import { examplesFromAnswer, trainRanker, type RankingExample, type TrainingMetrics } from "@brain/connectors";
import { corpusRetriever, corpusSearch, type Corpus, type Rewrites } from "./corpus.js";
import { runEval, type EvalReport, type GoldenCase, type GoldenSet } from "./harness.js";

/** Tags that are not about ranking quality, so they are neither learned from nor scored. */
const NOT_RANKING = /^(perm-|no-answer)/;
/** One question in five is kept back from training, to score on. */
const TEST_EVERY = 5;

export interface LearnedReplay {
  readonly training: TrainingMetrics;
  /** The held-back questions, without and with the trained ranker (identical when it stayed off). */
  readonly withoutRanker: EvalReport;
  readonly withRanker: EvalReport;
}

function heldBack(id: string): boolean {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % TEST_EVERY === 0;
}

/**
 * Offline replay of the learned ranker (FR-RET-08). For four ranking questions in five, the ratings
 * a person would give are made up: the answer cited the right document and was rated up. A ranker is
 * trained from those exactly as in production, then scored on the fifth, which it never saw. The
 * documents and ratings are invented, so this shows that learning and gating work, not what real
 * ratings would teach.
 */
export async function replayLearnedRanker(golden: GoldenSet, corpus: Corpus, k: number, rewrites?: Rewrites): Promise<LearnedReplay> {
  const ranking = golden.cases.filter((c) => c.expected.length === 1 && !c.tags.some((tag) => NOT_RANKING.test(tag)));
  const search = corpusSearch(corpus, { rerank: true, ...(rewrites ? { rewrites } : {}) });
  const examples: RankingExample[] = [];
  for (const c of ranking.filter((x) => !heldBack(x.id))) {
    const hits = await search(c.asUser, c.query, k);
    const cited = hits.findIndex((hit) => hit.externalId === c.expected[0]);
    if (cited < 0) continue;
    examples.push(...examplesFromAnswer({ hits, cited: [cited + 1] }, "up", c.id));
  }
  const { model, metrics } = trainRanker(examples);
  const test: GoldenSet = { ...golden, minRecallAtK: 0, cases: ranking.filter((c): c is GoldenCase => heldBack(c.id)) };
  const base = { rerank: true, ...(rewrites ? { rewrites } : {}) };
  const noFloor = { minRecallAtK: 0 };
  return {
    training: metrics,
    withoutRanker: await runEval(test, corpusRetriever(corpus, base), k, noFloor),
    withRanker: await runEval(test, corpusRetriever(corpus, { ...base, ...(model ? { learned: model } : {}) }), k, noFloor),
  };
}
