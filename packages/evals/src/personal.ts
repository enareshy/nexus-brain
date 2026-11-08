import { itemKey, toKeywords, toTextSearchTerm, type GraphLink } from "@brain/connectors";
import type { GoldenCase, GoldenSet, History, Retriever } from "./harness.js";

/** Tags that are not about ranking quality, so they make no work graph cases. */
const NOT_RANKING = /^(perm-|no-answer)/;
/** Words kept from each question: short questions match many documents, as real ones often do. */
const SHORT_QUERY_WORDS = 2;

/**
 * The links the production graph would hold after this history, as if all of it happened just now:
 * each opened item, each source of a helpful answer, and each pair of sources cited together.
 */
export function historyLinks(history: History, sourceOf: ReadonlyMap<string, string>): GraphLink[] {
  const key = (id: string) => itemKey(sourceOf.get(id) ?? "unknown", id);
  const links: GraphLink[] = history.opened.map((id) => ({ key: key(id), kind: "opened", via: "direct", weight: 1, ageDays: 0 }));
  for (const cited of history.helpful) {
    for (const id of cited) links.push({ key: key(id), kind: "cited_up", via: "direct", weight: 1, ageDays: 0 });
    for (const from of cited) {
      for (const to of cited) if (from !== to) links.push({ key: key(to), kind: "co_cited", via: "neighbour", weight: 1, ageDays: 0 });
    }
  }
  return links;
}

function shortQuery(query: string): string | null {
  try {
    const words = toKeywords(toTextSearchTerm(query)).slice(0, SHORT_QUERY_WORDS);
    return words.length > 0 ? words.join(" ") : null;
  } catch {
    return null;
  }
}

/**
 * Work graph questions derived from the golden set (FR-RET-09). Each ranking question is cut to its
 * first two words, which match many documents, and asked twice with an earlier history:
 *  - "personal-used": the person used the right answer before (opened it, or, every other time,
 *    rated up an answer citing it with another result). The graph should lift it.
 *  - "personal-unrelated": the person used a different result that also matches. The graph may now
 *    push the right answer down, which is what this measures.
 * Half of each, so the overall numbers answer one question: does the graph help if half the time
 * what someone used before is what they want now? The documents are invented, so this shows the
 * mechanism and its cost, not how often real people come back to what they used.
 */
export async function buildPersonalSet(golden: GoldenSet, retriever: Retriever, k: number): Promise<GoldenSet> {
  const cases: GoldenCase[] = [];
  const seen = new Set<string>();
  for (const c of golden.cases) {
    if (c.expected.length !== 1 || c.tags.some((tag) => NOT_RANKING.test(tag))) continue;
    const query = shortQuery(c.query);
    const target = c.expected[0]!;
    const key = `${c.asUser}|${query}|${target}`;
    if (!query || seen.has(key)) continue;
    seen.add(key);
    const ranked = await retriever.retrieve({ asUser: c.asUser, query, k });
    const others = ranked.filter((id) => id !== target);
    if (!ranked.includes(target) || others.length === 0) continue;
    const pairs = cases.length / 2;
    const other = others[pairs % others.length]!;
    const used: History = pairs % 2 === 0 ? { opened: [target], helpful: [] } : { opened: [], helpful: [[target, other]] };
    const base = { ...c, query, forbidden: c.forbidden };
    cases.push({ ...base, id: `${c.id}-used`, tags: ["personal-used"], history: used });
    cases.push({ ...base, id: `${c.id}-unrelated`, tags: ["personal-unrelated"], history: { opened: [other], helpful: [] } });
  }
  return {
    version: golden.version,
    description: `Work graph questions derived from: ${golden.description}`,
    minRecallAtK: 0,
    cases,
  };
}
