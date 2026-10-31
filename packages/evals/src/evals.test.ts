import { describe, expect, it } from "vitest";
import { fixtureRetriever, GoldenSetSchema, runEval, type GoldenSet } from "./harness.js";
import { leakedIds, mean, ndcgAtK, reciprocalRank, recallAtK } from "./metrics.js";

describe("metrics", () => {
  it("recallAtK counts expected IDs within the top k", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 2)).toBe(0.5);
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 3)).toBe(1);
    expect(recallAtK([], [], 5)).toBe(1);
  });

  it("reciprocalRank uses the first relevant hit", () => {
    expect(reciprocalRank(["x", "a"], ["a"])).toBe(0.5);
    expect(reciprocalRank(["x"], ["a"])).toBe(0);
  });

  it("ndcgAtK is 1 for an ideal ranking and lower otherwise", () => {
    expect(ndcgAtK(["a", "b"], ["a", "b"], 2)).toBeCloseTo(1);
    expect(ndcgAtK(["x", "a"], ["a"], 2)).toBeCloseTo(1 / Math.log2(3));
    expect(ndcgAtK([], [], 3)).toBe(1);
  });

  it("leakedIds returns forbidden IDs that were retrieved", () => {
    expect(leakedIds(["a", "secret"], ["secret"])).toEqual(["secret"]);
  });

  it("mean handles empty input", () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 0])).toBe(0.5);
  });
});

describe("runEval", () => {
  const golden: GoldenSet = GoldenSetSchema.parse({
    version: 1,
    description: "test",
    cases: [
      { id: "c1", asUser: "u", query: "q1", expected: ["a"], fixtureResults: ["a", "b"] },
      { id: "c2", asUser: "u", query: "q2", expected: ["c"], fixtureResults: ["c"] },
    ],
  });

  it("aggregates metrics and passes above threshold", async () => {
    const report = await runEval(golden, fixtureRetriever(golden));
    expect(report.recallAtK).toBe(1);
    expect(report.mrr).toBe(1);
    expect(report.passed).toBe(true);
  });

  it("fails on any leak even with perfect recall", async () => {
    const leaky = GoldenSetSchema.parse({
      ...golden,
      cases: [{ ...golden.cases[0], forbidden: ["b"] }],
    });
    const report = await runEval(leaky, fixtureRetriever(leaky));
    expect(report.leakCount).toBe(1);
    expect(report.passed).toBe(false);
  });

  it("fails below the recall threshold", async () => {
    const miss = GoldenSetSchema.parse({
      ...golden,
      cases: [{ ...golden.cases[0], expected: ["z"] }],
    });
    const report = await runEval(miss, fixtureRetriever(miss));
    expect(report.passed).toBe(false);
  });

  it("returns no results for unknown queries", async () => {
    const retriever = fixtureRetriever(golden);
    await expect(retriever.retrieve({ asUser: "u", query: "unknown", k: 5 })).resolves.toEqual([]);
  });
});
