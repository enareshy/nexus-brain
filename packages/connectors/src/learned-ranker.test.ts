import { describe, expect, it } from "vitest";
import { applyLearnedRanker, examplesFromAnswer, predict, RANKER_LIMITS, trainRanker, type RankingExample } from "./learned-ranker.js";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

/**
 * Answers where the cited result is always from "github" and recent, wherever it was in the list:
 * the pattern a ranker should learn and the order of the list alone does not show.
 */
function patterned(groups: number): RankingExample[] {
  const rows: RankingExample[] = [];
  for (let g = 0; g < groups; g += 1) {
    const winner = g % 5;
    for (let position = 0; position < 5; position += 1) {
      const isWinner = position === winner;
      rows.push({
        group: `g${g}`,
        serverId: isWinner ? "github" : "atlassian",
        position,
        scoreRatio: 1 - position * 0.1,
        ageDays: isWinner ? 2 : 200,
        label: isWinner ? 1 : 0,
      });
    }
  }
  return rows;
}

describe("trainRanker", () => {
  it("learns what cited results have in common, and turns on only when it clearly beats the search's order on held-back answers", () => {
    const { model, metrics } = trainRanker(patterned(250));
    expect(metrics).toMatchObject({ examples: 1250, answers: 250, active: true, reason: "better" });
    expect(metrics.holdoutMrr).toBeGreaterThanOrEqual(metrics.baselineMrr + RANKER_LIMITS.minGain);
    const github = predict(model!, { serverId: "github", position: 4, scoreRatio: 0.6, ageDays: 2 });
    const top = predict(model!, { serverId: "atlassian", position: 0, scoreRatio: 1, ageDays: 200 });
    expect(github).toBeGreaterThan(top);
  });

  it("stays off with too few rated answers, however many results they have", () => {
    expect(RANKER_LIMITS).toMatchObject({ minAnswers: 150, minHeldOutAnswers: 30 });
    // 1,200 results, but from only 60 answers: one person rating a handful of long answers is not enough.
    const wide = patterned(60).flatMap((row) => [row, { ...row, position: row.position + 5, label: 0 as const }, { ...row, position: row.position + 10, label: 0 as const }]);
    expect(trainRanker([...wide, ...wide]).metrics).toMatchObject({ active: false, reason: "too_few" });
  });

  it("stays off when it would not clearly beat today's order, or when nothing was ever cited", () => {
    const orderOnly = patterned(250).map((row) => ({ ...row, serverId: "atlassian", ageDays: 10, label: row.position === 0 ? 1 : 0 }) as RankingExample);
    expect(trainRanker(orderOnly)).toMatchObject({ model: null, metrics: { active: false, reason: "no_gain" } });
    const neverCited = patterned(250).map((row) => ({ ...row, label: 0 }) as RankingExample);
    expect(trainRanker(neverCited)).toMatchObject({ model: null, metrics: { reason: "too_few" } });
  });

  it("keeps every weight within bounds, however one-sided the ratings", () => {
    const oneSided = patterned(250).map((row) => ({ ...row, label: row.serverId === "github" ? 1 : 0 }) as RankingExample);
    const { model } = trainRanker(oneSided, { ...RANKER_LIMITS, minGain: 0 });
    const weights = [model!.bias, ...Object.values(model!.weights), ...Object.values(model!.sources)];
    expect(weights.every((w) => Math.abs(w) <= 3)).toBe(true);
  });

  it("gives the same model for the same ratings", () => {
    expect(trainRanker(patterned(250)).model).toEqual(trainRanker(patterned(250)).model);
  });
});

describe("applyLearnedRanker", () => {
  const hits = [
    { serverId: "atlassian", externalId: "a", score: 1, updatedAt: daysAgo(300) },
    { serverId: "atlassian", externalId: "b", score: 0.9, updatedAt: daysAgo(250) },
    { serverId: "github", externalId: "c", score: 0.5, updatedAt: daysAgo(1) },
  ];

  it("reorders by what the company's ratings taught it, never adding or dropping a result", () => {
    const { model } = trainRanker(patterned(250));
    const ranked = applyLearnedRanker(hits, model!, NOW);
    expect(ranked[0]?.externalId).toBe("c");
    expect(ranked.map((h) => h.externalId).sort()).toEqual(["a", "b", "c"]);
    expect(hits.map((h) => h.externalId)).toEqual(["a", "b", "c"]);
  });

  it("treats an unknown service, a missing date, an odd score or an id like a built-in name as neutral", () => {
    const { model } = trainRanker(patterned(250));
    const odd = [
      { serverId: "slack", externalId: "s", score: Number.NaN, updatedAt: null },
      { serverId: "constructor", externalId: "p", score: Number.POSITIVE_INFINITY, updatedAt: "not a date" },
      { serverId: "atlassian", externalId: "n", score: -5, updatedAt: null },
      ...hits,
    ];
    const ranked = applyLearnedRanker(odd, model!, NOW);
    expect(ranked).toHaveLength(6);
    expect(predict(model!, { serverId: "constructor", position: 0, scoreRatio: 1, ageDays: null })).toBeGreaterThan(0);
  });
});

describe("examplesFromAnswer", () => {
  const hits = [
    { serverId: "atlassian", externalId: "a", score: 2, updatedAt: daysAgo(10.4) },
    { serverId: "github", externalId: "b", score: 1, updatedAt: null },
    { serverId: "atlassian", externalId: "c", score: 0.5, updatedAt: "not a date" },
  ];

  it("labels results cited in an answer rated up as good and the rest as not, keeping no ids and whole days only", () => {
    const rows = examplesFromAnswer({ hits, cited: [2] }, "up", "batch-1", NOW);
    expect(rows).toEqual([
      { group: "batch-1", serverId: "atlassian", position: 0, scoreRatio: 1, ageDays: 10, label: 0 },
      { group: "batch-1", serverId: "github", position: 1, scoreRatio: 0.5, ageDays: null, label: 1 },
      { group: "batch-1", serverId: "atlassian", position: 2, scoreRatio: 0.25, ageDays: null, label: 0 },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/"a"|"b"|"c"/);
  });

  it("uses each result's place in the search's own order, not the reordered list shown", () => {
    const reordered = [{ ...hits[2]!, searchRank: 0 }, { ...hits[0]!, searchRank: 1 }];
    expect(examplesFromAnswer({ hits: reordered, cited: [1] }, "up", "batch-5", NOW).map((r) => r.position)).toEqual([0, 1]);
    const shownFirst = [{ ...hits[0]!, searchRank: 3 }];
    expect(examplesFromAnswer({ hits: shownFirst, cited: [1] }, "up", "batch-6", NOW)[0]?.position).toBe(3);
  });

  it("learns only that cited results were wrong from an answer rated down, and nothing from one without citations", () => {
    expect(examplesFromAnswer({ hits, cited: [1] }, "down", "batch-2", NOW)).toEqual([
      { group: "batch-2", serverId: "atlassian", position: 0, scoreRatio: 1, ageDays: 10, label: 0 },
    ]);
    expect(examplesFromAnswer({ hits, cited: [] }, "up", "batch-3", NOW)).toEqual([]);
    expect(examplesFromAnswer({ hits: [], cited: [1] }, "up", "batch-4", NOW)).toEqual([]);
  });
});
