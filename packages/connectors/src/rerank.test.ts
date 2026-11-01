import { describe, expect, it } from "vitest";
import { federatedSearch } from "./federated.js";
import { rerankHits, stem } from "./rerank.js";
import type { SearchHit } from "./types.js";

const hit = (externalId: string, title: string, snippet = "", serverId = "a"): SearchHit => ({
  serverId,
  externalId,
  title,
  url: `https://x.example/${externalId}`,
  snippet,
  updatedAt: null,
});
const ids = (hits: readonly SearchHit[]) => hits.map((h) => h.externalId);

describe("rerankHits", () => {
  it("puts the result that matches more of the question first", () => {
    const hits = [hit("1", "Weekly notes", "login mentioned"), hit("2", "Login bug on SSO", "login fails on sso")];
    expect(ids(rerankHits("login bug sso", hits))).toEqual(["2", "1"]);
  });

  it("values a word in the title above the same word in the snippet", () => {
    const hits = [hit("body", "Notes", "rotation"), hit("title", "Rotation", "notes")];
    expect(ids(rerankHits("rotation", hits))).toEqual(["title", "body"]);
  });

  it("values a rare word above a common one", () => {
    const hits = [
      hit("common1", "project", ""),
      hit("common2", "project", ""),
      hit("common3", "project", ""),
      hit("rare", "kubernetes", ""),
    ];
    expect(ids(rerankHits("project kubernetes", hits))[0]).toBe("rare");
  });

  it("matches simple word forms", () => {
    const hits = [hit("other", "Budget"), hit("forms", "Rotating signing keys")];
    expect(ids(rerankHits("rotate key", hits))[0]).toBe("forms");
    expect(stem("keys")).toBe(stem("key"));
    expect(stem("rotating")).toBe(stem("rotate"));
    expect(stem("as")).toBe("as");
    expect(stem("meetings")).toBe(stem("meeting"));
    expect(stem("settings")).toBe(stem("setting"));
    expect(stem("needs")).toBe(stem("need"));
    expect(stem("need")).toBe("need");
    expect(stem("seeds")).toBe(stem("seed"));
    expect(stem("king")).toBe("king");
  });

  it("matches a plural in the question to a singular in the title", () => {
    const hits = [hit("weak", "Team lunch"), hit("match", "Team meeting notes")];
    expect(ids(rerankHits("team meetings", hits))[0]).toBe("match");
  });

  it("keeps the original order when nothing separates results", () => {
    const hits = [hit("1", "alpha"), hit("2", "beta"), hit("3", "gamma")];
    expect(ids(rerankHits("delta", hits))).toEqual(["1", "2", "3"]);
    expect(ids(rerankHits("?!", hits))).toEqual(["1", "2", "3"]);
    expect(ids(rerankHits("\u0000", hits))).toEqual(["1", "2", "3"]);
  });

  it("only reorders: it adds, removes and changes nothing, and leaves its input alone", () => {
    const hits = [hit("1", "alpha one", "x"), hit("2", "beta two", "y")];
    const copy = [...hits];
    const result = rerankHits("two", hits);
    expect(hits).toEqual(copy);
    expect([...result].sort((a, b) => a.externalId.localeCompare(b.externalId))).toEqual(copy);
    expect(rerankHits("two", [])).toEqual([]);
  });
});

describe("federatedSearch with reranking", () => {
  const sources = [
    { id: "a", run: async () => [hit("recent", "Team lunch"), hit("wanted", "Key rotation runbook")] },
    { id: "b", run: async () => [hit("other", "Holiday list", "", "b")] },
  ];

  it("reranks when given the question, before applying the limit", async () => {
    const { hits } = await federatedSearch(sources, { limit: 1, rerankQuery: "key rotation" });
    expect(ids(hits)).toEqual(["wanted"]);
  });

  it("keeps the merged order without a question", async () => {
    const { hits } = await federatedSearch(sources, { limit: 3 });
    expect(ids(hits)).toEqual(["recent", "other", "wanted"]);
  });
});
