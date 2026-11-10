import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RankerService, type RankerStore } from "./ranker.service.js";

const scope = { tenantId: "0a000000-0000-4000-8000-000000000001", userId: "u1" };
const NOW = Date.parse("2026-11-08T00:00:00Z");
/** Prefers results from github, wherever they are. */
const MODEL = { version: 1, bias: -2, weights: { position: 0, score: 0, recency: 0, undated: 0 }, sources: { github: 3, atlassian: 0 } };
const hits = [
  { serverId: "atlassian", externalId: "a", score: 1, updatedAt: null },
  { serverId: "github", externalId: "b", score: 0.5, updatedAt: null },
];
const fingerprint = (value: string) => createHash("sha256").update(`key|${value}`).digest("hex");

function setup(store: Partial<RankerStore> = {}) {
  let clock = NOW;
  const model = vi.fn<RankerStore["model"]>(async () => MODEL);
  const record = vi.fn<RankerStore["record"]>(async () => {});
  const saved = vi.fn<RankerStore["saved"]>(async () => null);
  const onError = vi.fn();
  const service = new RankerService({ store: { model, record, saved, ...store }, onError, fingerprint, now: () => clock });
  return { service, model, record, onError, advance: (ms: number) => (clock += ms) };
}

describe("RankerService.rank", () => {
  it("reorders by the company's model, reading it once and again only after a while", async () => {
    const { service, model, advance } = setup();
    expect((await service.rank(scope, hits)).map((h) => h.externalId)).toEqual(["b", "a"]);
    await service.rank(scope, hits);
    expect(model).toHaveBeenCalledTimes(1);
    advance(11 * 60_000);
    await service.rank(scope, hits);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("reads a company's model once for searches that arrive together", async () => {
    const { service, model } = setup();
    await Promise.all([service.rank(scope, hits), service.rank(scope, hits), service.rank(scope, hits)]);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("keeps the search's order with no model, an invalid one, one with weights beyond bounds, or a failing one", async () => {
    expect(await setup({ model: async () => null }).service.rank(scope, hits)).toEqual(hits);
    const invalid = setup({ model: async () => ({ version: 2 }) });
    expect(await invalid.service.rank(scope, hits)).toEqual(hits);
    expect(invalid.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/not valid/) }));
    const huge = setup({ model: async () => ({ ...MODEL, sources: { github: 50 } }) });
    expect(await huge.service.rank(scope, hits)).toEqual(hits);
    const failing = setup({ model: async () => { throw new Error("db down"); } });
    expect(await failing.service.rank(scope, hits)).toEqual(hits);
    expect(failing.onError).toHaveBeenCalled();
  });

  it("after a slow or failed read, keeps the order for a while instead of waiting on every search", async () => {
    const model = vi.fn<RankerStore["model"]>(() => new Promise<never>(() => {}));
    const { service, onError, advance } = setup({ model });
    expect(await service.rank(scope, hits)).toEqual(hits);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/too long/) }));
    const started = Date.now();
    expect(await service.rank(scope, hits)).toEqual(hits);
    expect(Date.now() - started).toBeLessThan(100);
    expect(model).toHaveBeenCalledTimes(1);
    advance(31_000);
    await service.rank(scope, hits);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("does nothing for fewer than two results", async () => {
    const { service, model } = setup();
    expect(await service.rank(scope, [hits[0]!])).toEqual([hits[0]]);
    expect(model).not.toHaveBeenCalled();
  });
});

describe("RankerService.answerRated", () => {
  it("saves what a rating teaches as general signals for the company, with no ids", async () => {
    const { service, record } = setup();
    await service.answerRated(scope, { hits, parts: [{ kind: "text" }, { kind: "cite", source: 2 }] }, "up", "message-1");
    const [tenantId, rows] = record.mock.calls[0]!;
    expect(tenantId).toBe(scope.tenantId);
    expect(rows.map((r) => [r.serverId, r.position, r.label])).toEqual([["atlassian", 0, 0], ["github", 1, 1]]);
    expect(JSON.stringify(rows)).not.toMatch(/"a"|"b"|u1|message-1/);
  });

  it("gives one answer the same group every time, and different answers different groups", async () => {
    const { service, record } = setup();
    const answer = { hits, parts: [{ kind: "cite", source: 1 }] };
    await service.answerRated(scope, answer, "up", "message-1");
    await service.answerRated(scope, answer, "down", "message-1");
    await service.answerRated(scope, answer, "up", "message-2");
    const groups = record.mock.calls.map(([, rows]) => rows[0]?.group);
    expect(groups[0]).toBe(groups[1]);
    expect(groups[2]).not.toBe(groups[0]);
    expect(groups[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("skips results the database would refuse", async () => {
    const { service, record } = setup();
    const odd = [{ serverId: "Bad Id", score: 1, updatedAt: null }, ...hits];
    await service.answerRated(scope, { hits: odd, parts: [{ kind: "cite", source: 2 }] }, "up", "message-3");
    expect(record.mock.calls[0]?.[1].map((r) => r.serverId)).toEqual(["atlassian", "github"]);
  });

  it("never fails the rating when saving fails", async () => {
    const { service, onError } = setup({ record: async () => { throw new Error("db down"); } });
    await expect(service.answerRated(scope, { hits, parts: [{ kind: "cite", source: 1 }] }, "up", "message-4")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});

describe("RankerService.status", () => {
  const trainedAt = new Date("2026-11-09T08:00:00Z");
  const metrics = { examples: 900, answers: 180, holdoutMrr: 0.74, baselineMrr: 0.61, active: true, reason: "better" };

  it("says when the company's ranker has never been trained, and what training needs", async () => {
    expect(await setup().service.status(scope.tenantId)).toEqual({ state: "never_trained", minAnswers: 150 });
  });

  it("is on exactly when a usable model is saved, as that is what searches use", async () => {
    const on = setup({ saved: async () => ({ model: MODEL, metrics, trainedAt }) });
    expect(await on.service.status(scope.tenantId)).toEqual({
      state: "on",
      minAnswers: 150,
      trainedAt: "2026-11-09T08:00:00.000Z",
      details: { reason: "better", answers: 180, examples: 900, holdoutMrr: 0.74, baselineMrr: 0.61 },
    });
    const broken = setup({ saved: async () => ({ model: { version: 9 }, metrics, trainedAt }) });
    expect(await broken.service.status(scope.tenantId)).toMatchObject({ state: "off", details: { reason: "better" } });
  });

  it("is off, with the reason, when training kept today's order", async () => {
    const off = setup({ saved: async () => ({ model: null, metrics: { ...metrics, active: false, reason: "too_few", answers: 40 }, trainedAt }) });
    expect(await off.service.status(scope.tenantId)).toMatchObject({ state: "off", details: { reason: "too_few", answers: 40 } });
  });

  it("still says it is on when the training report cannot be read, and reports the report", async () => {
    const odd = setup({ saved: async () => ({ model: MODEL, metrics: { answers: "lots" }, trainedAt }) });
    expect(await odd.service.status(scope.tenantId)).toMatchObject({ state: "on", details: null });
    expect(odd.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/not valid/) }));
  });
});
