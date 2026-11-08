import { describe, expect, it, vi } from "vitest";
import { GraphService, type GraphStore } from "./graph.service.js";

const scope = { tenantId: "t1", userId: "u1" };
const hit = (serverId: string, externalId: string) => ({ serverId, externalId, title: externalId });

function setup(store: Partial<GraphStore> = {}) {
  const record = vi.fn<GraphStore["record"]>(async () => {});
  const links = vi.fn<GraphStore["links"]>(async () => []);
  const exportAll = vi.fn<GraphStore["exportAll"]>(async () => []);
  const onError = vi.fn();
  const service = new GraphService({ store: { record, links, exportAll, ...store }, onError });
  return { service, record, links, onError };
}

describe("GraphService", () => {
  it("lifts a result the person found helpful above an otherwise better match", async () => {
    const { service, links } = setup();
    links.mockResolvedValue([{ key: "atlassian:B", kind: "cited_up", via: "direct", weight: 20, ageDays: 0 }]);
    const ranked = await service.rank(scope, [hit("atlassian", "A"), hit("atlassian", "B")]);
    expect(ranked.map((h) => h.externalId)).toEqual(["B", "A"]);
    expect(links).toHaveBeenCalledWith(scope, ["atlassian:A", "atlassian:B"]);
  });

  it("keeps the search's own order when the graph cannot be read, and reports it", async () => {
    const { service, onError } = setup({ links: async () => { throw new Error("db down"); } });
    const hits = [hit("atlassian", "A"), hit("atlassian", "B")];
    expect(await service.rank(scope, hits)).toEqual(hits);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(await service.rank(scope, [])).toEqual([]);
  });

  it("does not let a slow graph hold up a search", async () => {
    const { service, onError } = setup({ links: () => new Promise(() => {}) });
    const hits = [hit("atlassian", "A"), hit("atlassian", "B")];
    const started = Date.now();
    expect(await service.rank(scope, hits)).toEqual(hits);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/too long/) }));
  });

  it("looks up only ids it could have stored, and reports a caller's failure without throwing", async () => {
    const { service, links, onError } = setup();
    await service.rank(scope, [hit("atlassian", "line\nbreak"), hit("atlassian", "OK")]);
    expect(links).toHaveBeenCalledWith(scope, ["atlassian:OK"]);
    service.report(new Error("caller failed"));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "caller failed" }));
  });

  it("records an opened item, without letting a failure stop the read", async () => {
    const { service, record } = setup();
    await service.opened(scope, { serverId: "atlassian", externalId: "ENG-1" });
    expect(record).toHaveBeenCalledWith(scope, [{ source: "me", target: "atlassian:ENG-1", kind: "opened" }]);
    const failing = setup({ record: async () => { throw new Error("db down"); } });
    await expect(failing.service.opened(scope, { serverId: "atlassian", externalId: "ENG-1" })).resolves.toBeUndefined();
    expect(failing.onError).toHaveBeenCalled();
  });

  it("links the person to each source of an answer they rated up, and those sources to each other", async () => {
    const { service, record } = setup();
    await service.answerHelpful(scope, {
      hits: [hit("atlassian", "A"), hit("github", "B"), hit("atlassian", "C")],
      parts: [{ kind: "text" }, { kind: "cite", source: 1 }, { kind: "cite", source: 2 }, { kind: "cite", source: 1 }, { kind: "cite", source: 9 }],
    });
    const edges = record.mock.calls[0]?.[1] ?? [];
    expect(edges.filter((e) => e.source === "me")).toEqual([
      { source: "me", target: "atlassian:A", kind: "cited_up" },
      { source: "me", target: "github:B", kind: "cited_up" },
    ]);
    expect(edges.filter((e) => e.kind === "co_cited")).toEqual([
      { source: "atlassian:A", target: "github:B", kind: "co_cited" },
      { source: "github:B", target: "atlassian:A", kind: "co_cited" },
    ]);
  });

  it("records nothing for an answer without citations, and caps how many sources one answer links", async () => {
    const { service, record } = setup();
    await service.answerHelpful(scope, { hits: [hit("atlassian", "A")], parts: [{ kind: "text" }] });
    expect(record).not.toHaveBeenCalled();
    const many = Array.from({ length: 10 }, (_, i) => hit("atlassian", `D${i}`));
    await service.answerHelpful(scope, { hits: many, parts: many.map((_, i) => ({ kind: "cite", source: i + 1 })) });
    const edges = record.mock.calls[0]?.[1] ?? [];
    expect(edges.filter((e) => e.source === "me")).toHaveLength(5);
    expect(edges.length).toBeLessThanOrEqual(50);
  });

  it("skips ids that could not be stored rather than failing the rating", async () => {
    const { service, record } = setup();
    await service.answerHelpful(scope, {
      hits: [hit("Bad Server", "A"), hit("atlassian", "x".repeat(300)), hit("atlassian", "OK")],
      parts: [1, 2, 3].map((source) => ({ kind: "cite", source })),
    });
    expect(record.mock.calls[0]?.[1]).toEqual([{ source: "me", target: "atlassian:OK", kind: "cited_up" }]);
  });
});
