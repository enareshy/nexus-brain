import { describe, expect, it } from "vitest";
import { compareRanking, corpusRetriever, CorpusSchema, graphHelps, type Corpus } from "./corpus.js";
import { GoldenSetSchema, runEval } from "./harness.js";
import { replayLearnedRanker } from "./learned.js";
import { buildPersonalSet, historyLinks } from "./personal.js";

const corpus: Corpus = CorpusSchema.parse({
  version: 1,
  description: "test",
  documents: [
    { id: "jira:1", source: "jira", title: "Team lunch", body: "rotation of the lunch rota", updated: "2026-10-30", visibleTo: ["alice", "bob"] },
    { id: "jira:2", source: "jira", title: "Key rotation runbook", body: "how to rotate keys", updated: "2026-01-01", visibleTo: ["alice", "bob"] },
    { id: "wiki:1", source: "wiki", title: "Rotation policy", body: "keys", updated: "2026-02-01", visibleTo: ["alice"] },
    { id: "secret:1", source: "wiki", title: "Secret key rotation", body: "private", updated: "2026-10-31", visibleTo: ["gus"] },
  ],
});

describe("corpusRetriever", () => {
  it("returns only what the user may see, and only keyword matches", async () => {
    const retriever = corpusRetriever(corpus, { rerank: false });
    const forBob = await retriever.retrieve({ asUser: "bob", query: "key rotation", k: 10 });
    expect(forBob).toContain("jira:2");
    expect(forBob).not.toContain("wiki:1");
    expect(forBob).not.toContain("secret:1");
    expect(await retriever.retrieve({ asUser: "bob", query: "payroll", k: 10 })).toEqual([]);
    expect(await retriever.retrieve({ asUser: "stranger", query: "key rotation", k: 10 })).toEqual([]);
  });

  it("orders each source by recency without reranking, like the real services", async () => {
    const plain = corpusRetriever(corpus, { rerank: false });
    expect((await plain.retrieve({ asUser: "bob", query: "rotation", k: 10 }))[0]).toBe("jira:1");
  });

  it("moves the better match up with reranking", async () => {
    const reranked = corpusRetriever(corpus, { rerank: true });
    expect((await reranked.retrieve({ asUser: "bob", query: "key rotation runbook", k: 10 }))[0]).toBe("jira:2");
  });
});

describe("runEval", () => {
  it("does not let unanswerable questions raise recall", async () => {
    const golden = GoldenSetSchema.parse({
      version: 1,
      description: "t",
      cases: [
        { id: "answerable", asUser: "bob", query: "payroll", expected: ["jira:2"] },
        { id: "unanswerable", asUser: "bob", query: "payroll", expected: [] },
      ],
    });
    const report = await runEval(golden, corpusRetriever(corpus, { rerank: false }));
    expect(report.recallAtK).toBe(0);
    expect(report.mrr).toBe(0);
    expect(report.ndcgAtK).toBe(0);
  });

  it("counts questions with nothing to find that still return results", async () => {
    const golden = GoldenSetSchema.parse({
      version: 1,
      description: "t",
      cases: [
        { id: "noisy", asUser: "bob", query: "rotation", expected: [] },
        { id: "quiet", asUser: "bob", query: "payroll", expected: [] },
        { id: "permission", asUser: "bob", query: "rotation", expected: [], forbidden: ["secret:1"] },
      ],
    });
    const report = await runEval(golden, corpusRetriever(corpus, { rerank: false }));
    expect(report.noAnswerWithResults).toBe(1);
  });

  it("uses the set's own recall floor", async () => {
    const golden = GoldenSetSchema.parse({
      version: 1,
      description: "t",
      minRecallAtK: 0.5,
      cases: [
        { id: "hit", asUser: "bob", query: "runbook", expected: ["jira:2"] },
        { id: "miss", asUser: "bob", query: "payroll", expected: ["jira:1"] },
      ],
    });
    const report = await runEval(golden, corpusRetriever(corpus, { rerank: false }));
    expect(report.recallAtK).toBe(0.5);
    expect(report.passed).toBe(true);
  });

  it("reports by tag", async () => {
    const golden = GoldenSetSchema.parse({
      version: 1,
      description: "t",
      cases: [
        { id: "a", asUser: "bob", query: "runbook", expected: ["jira:2"], tags: ["good"] },
        { id: "b", asUser: "bob", query: "payroll", expected: ["jira:1"], tags: ["bad"] },
      ],
    });
    const report = await runEval(golden, corpusRetriever(corpus, { rerank: false }));
    expect(report.byTag.good?.recallAtK).toBe(1);
    expect(report.byTag.bad?.recallAtK).toBe(0);
  });
});

describe("compareRanking", () => {
  const golden = GoldenSetSchema.parse({
    version: 1,
    description: "t",
    minRecallAtK: 0.5,
    cases: [{ id: "a", asUser: "bob", query: "key rotation runbook", expected: ["jira:2"] }],
  });

  it("runs both ways and passes when reranking is at least as good", async () => {
    const result = await compareRanking(golden, corpus);
    expect(result.reranked.ndcgAtK).toBeGreaterThanOrEqual(result.baseline.ndcgAtK);
    expect(result.passed).toBe(true);
  });

  it("replays recorded rewrites, which find a differently worded question", async () => {
    const reworded = GoldenSetSchema.parse({
      version: 1,
      description: "t",
      minRecallAtK: 0,
      cases: [{ id: "a", asUser: "bob", query: "change credentials", expected: ["jira:2"] }],
    });
    const result = await compareRanking(reworded, corpus, 10, { "change credentials": ["runbook"] });
    expect(result.reranked.recallAtK).toBe(0);
    expect(result.rewritten?.recallAtK).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("fails if rewriting finds less than searching as asked", async () => {
    // Enough unrelated words to push the question's own words past the keyword limit.
    const unrelated = ["payroll", "invoice", "lunch", "garage", "parking", "pension", "holiday", "travel"];
    const result = await compareRanking(golden, corpus, 10, { "key rotation runbook": unrelated });
    expect(result.reranked.recallAtK).toBe(1);
    expect(result.rewritten?.recallAtK).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("fails on any leak", async () => {
    const leaky = GoldenSetSchema.parse({
      ...golden,
      cases: [{ id: "a", asUser: "bob", query: "runbook", expected: [], forbidden: ["jira:2"] }],
    });
    const result = await compareRanking(leaky, corpus);
    expect(result.reranked.leakCount).toBe(1);
    expect(result.passed).toBe(false);
  });
});

describe("work graph questions (FR-RET-09)", () => {
  const golden = GoldenSetSchema.parse({
    version: 1,
    description: "test",
    cases: [
      { id: "lunch", asUser: "bob", query: "rotation of the lunch rota", expected: ["jira:1"], tags: ["keyword"] },
      { id: "runbook", asUser: "bob", query: "rotation runbook keys", expected: ["jira:2"], tags: ["keyword"] },
      { id: "secret", asUser: "gus", query: "rotation", expected: [], forbidden: ["jira:1"], tags: ["perm-private"] },
    ],
  });

  it("asks each ranking question shortly, once with the right answer in the history and once with another result", async () => {
    const set = await buildPersonalSet(golden, corpusRetriever(corpus, { rerank: true }), 10);
    expect(set.cases.map((c) => c.id)).toEqual(["lunch-used", "lunch-unrelated", "runbook-used", "runbook-unrelated"]);
    // Cut to two keywords, so each question matches more documents.
    expect(set.cases.map((c) => c.query)).toEqual(["rotation lunch", "rotation lunch", "rotation runbook", "rotation runbook"]);
    expect(set.cases[0]?.history).toEqual({ opened: ["jira:1"], helpful: [] });
    expect(set.cases[1]?.history).toEqual({ opened: ["jira:2"], helpful: [] });
    // Every other one is a rated-up answer that cited the right result with another.
    expect(set.cases[2]?.history).toEqual({ opened: [], helpful: [["jira:2", "jira:1"]] });
    expect(set.cases[3]?.history).toEqual({ opened: ["jira:1"], helpful: [] });
  });

  it("lifts what the person used only when the graph is on, and never adds a result", async () => {
    const history = { opened: ["jira:2"], helpful: [] };
    const plain = await corpusRetriever(corpus, { rerank: true }).retrieve({ asUser: "bob", query: "rotation", k: 10, history });
    const personal = await corpusRetriever(corpus, { rerank: true, graph: true }).retrieve({ asUser: "bob", query: "rotation", k: 10, history });
    expect(personal.indexOf("jira:2")).toBeLessThanOrEqual(plain.indexOf("jira:2"));
    expect([...personal].sort()).toEqual([...plain].sort());
  });

  it("turns a history into the links the production graph would hold", () => {
    const sources = new Map([["jira:1", "jira"], ["wiki:1", "wiki"]]);
    const links = historyLinks({ opened: ["jira:1"], helpful: [["jira:1", "wiki:1"]] }, sources);
    expect(links.map((l) => `${l.kind}:${l.via}:${l.key}`)).toEqual([
      "opened:direct:jira:jira:1",
      "cited_up:direct:jira:jira:1",
      "cited_up:direct:wiki:wiki:1",
      "co_cited:neighbour:wiki:wiki:1",
      "co_cited:neighbour:jira:jira:1",
    ]);
  });
});

describe("graphHelps", () => {
  const report = (used: number, unrelated: number) =>
    ({ mrr: (used + unrelated) / 2, byTag: { "personal-used": { mrr: used }, "personal-unrelated": { mrr: unrelated } } }) as never;

  it("passes a graph that lifts used answers at little cost to unrelated ones", () => {
    expect(graphHelps({ withoutGraph: report(0.79, 0.79), withGraph: report(0.83, 0.785) })).toBe(true);
  });

  it("fails a graph strong enough to push good answers down when the history is unrelated", () => {
    expect(graphHelps({ withoutGraph: report(0.79, 0.79), withGraph: report(0.95, 0.7) })).toBe(false);
  });

  it("fails a graph that does nothing where it could have helped", () => {
    expect(graphHelps({ withoutGraph: report(0.79, 0.79), withGraph: report(0.79, 0.79) })).toBe(false);
    expect(graphHelps({ withoutGraph: report(1, 1), withGraph: report(1, 1) })).toBe(true);
  });
});

describe("replayLearnedRanker (FR-RET-08)", () => {
  it("trains only on questions it is not scored on, and leaves ranking unchanged when it learns nothing", async () => {
    const golden = GoldenSetSchema.parse({
      version: 1,
      description: "t",
      cases: Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, asUser: "bob", query: "key rotation runbook", expected: ["jira:2"], tags: ["keyword"] })),
    });
    const replay = await replayLearnedRanker(golden, corpus, 10);
    expect(replay.training).toMatchObject({ active: false, reason: "too_few" });
    expect(replay.withRanker.mrr).toBe(replay.withoutRanker.mrr);
    expect(replay.withRanker.cases.length + replay.training.answers).toBeLessThanOrEqual(10);
    expect(replay.withRanker.cases.length).toBeGreaterThan(0);
  });
});
