import { describe, expect, it } from "vitest";
import { applyGraphBoost, graphStrengths, itemKey, MAX_LINK_AGE_DAYS, type GraphLink } from "./work-graph.js";

const hit = (id: string) => ({ serverId: "atlassian", externalId: id });
const link = (id: string, over: Partial<GraphLink> = {}): GraphLink => ({
  key: itemKey("atlassian", id),
  kind: "opened",
  via: "direct",
  weight: 1,
  ageDays: 0,
  ...over,
});
const ids = (hits: ReadonlyArray<{ externalId: string }>) => hits.map((h) => h.externalId);

describe("graphStrengths", () => {
  it("counts finding an item helpful more than opening it, and a link through another item less", () => {
    const s = graphStrengths([link("a"), link("b", { kind: "cited_up" }), link("c", { kind: "co_cited", via: "neighbour" })]);
    const a = s.get(itemKey("atlassian", "a")) ?? 0;
    expect(s.get(itemKey("atlassian", "b"))).toBeCloseTo(2 * a);
    expect(s.get(itemKey("atlassian", "c"))).toBeCloseTo(0.5 * a);
  });

  it("fades with age and ignores links older than the limit", () => {
    const s = graphStrengths([link("new"), link("month", { ageDays: 30 }), link("old", { ageDays: MAX_LINK_AGE_DAYS + 1 })]);
    expect(s.get(itemKey("atlassian", "month"))).toBeCloseTo((s.get(itemKey("atlassian", "new")) ?? 0) / 2);
    expect(s.has(itemKey("atlassian", "old"))).toBe(false);
  });

  it("adds up several links to one item, with diminishing returns for repeats", () => {
    const once = graphStrengths([link("a")]).get(itemKey("atlassian", "a")) ?? 0;
    const often = graphStrengths([link("a", { weight: 15 })]).get(itemKey("atlassian", "a")) ?? 0;
    const both = graphStrengths([link("a"), link("a", { kind: "cited_up" })]).get(itemKey("atlassian", "a")) ?? 0;
    expect(often).toBeGreaterThan(once);
    expect(often).toBeLessThan(15 * once);
    expect(both).toBeCloseTo(3 * once);
  });
});

describe("applyGraphBoost", () => {
  const hits = ["1", "2", "3", "4", "5", "6"].map(hit);

  it("keeps the order when the person has no links", () => {
    expect(ids(applyGraphBoost(hits, new Map()))).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("moves a linked result up a few places, but not past much better matches", () => {
    const strong = graphStrengths([link("6", { kind: "cited_up", weight: 20 })]);
    const order = ids(applyGraphBoost(hits, strong));
    expect(order.indexOf("6")).toBeLessThan(5);
    expect(order[0]).toBe("1");
    const far = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"].map(hit);
    expect(ids(applyGraphBoost(far, graphStrengths([link("15", { kind: "cited_up", weight: 20 })]))).indexOf("15")).toBeGreaterThan(3);
  });

  it("never adds or drops a result, and does not change the hits it was given", () => {
    const given = Object.freeze([...hits]);
    const boosted = applyGraphBoost(given, graphStrengths([link("4"), link("missing")]));
    expect([...ids(boosted)].sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(ids(given)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("matches results by service as well as id", () => {
    const other = { serverId: "github", externalId: "2" };
    const order = applyGraphBoost([hit("1"), other], graphStrengths([link("2", { weight: 20, kind: "cited_up" })]));
    expect(order[0]).toEqual(hit("1"));
  });
});
