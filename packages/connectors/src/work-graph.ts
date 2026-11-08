/**
 * Ranking with a person's own work graph (FR-RET-09). The graph only reorders results the person's
 * own search already returned: it never adds an item, so it cannot show anyone something new.
 */

export type GraphEdgeKind = "opened" | "cited_up" | "co_cited";

/** One link that touches a search result: directly from the person, or through an item they used. */
export interface GraphLink {
  /** The search result it touches, as `itemKey` gives it. */
  readonly key: string;
  readonly kind: GraphEdgeKind;
  /** Direct: from the person to this result. Neighbour: from an item the person used to this result. */
  readonly via: "direct" | "neighbour";
  readonly weight: number;
  /** How long ago it last happened. */
  readonly ageDays: number;
}

/** How much each kind of link counts: finding an item helpful counts twice opening it. */
const KIND_WEIGHT: Readonly<Record<GraphEdgeKind, number>> = { opened: 1, cited_up: 2, co_cited: 1 };
/** A link through another item counts half as much as one straight from the person. */
const NEIGHBOUR_FACTOR = 0.5;
/** Links lose half their strength every 30 days, so the graph follows what the person does now. */
const HALF_LIFE_DAYS = 30;
/** Older links are ignored, and dropped from storage. */
export const MAX_LINK_AGE_DAYS = 90;
/**
 * How far the graph can lift a result: at most half as much again as its rank score. Chosen with
 * `pnpm eval`: at 0.5 a history that matches the question lifts the right answer, and one that does
 * not barely costs anything; at 1.0 it helps more but costs more than it gains unless at least about
 * a third of histories match. How often real histories match is not known yet, so the safer one.
 */
const MAX_LIFT = 0.5;
/**
 * Rank smoothing. Small, so the top places stay well apart: the strongest link moves a result up
 * about two or three places near the top, and a little further down the list.
 */
const RANK_K = 2;

export function itemKey(serverId: string, externalId: string): string {
  return `${serverId}:${externalId}`;
}

/** How strongly the person is linked to each result, from 0 (not at all) upwards. */
export function graphStrengths(links: readonly GraphLink[]): ReadonlyMap<string, number> {
  const strengths = new Map<string, number>();
  for (const link of links) {
    if (link.ageDays > MAX_LINK_AGE_DAYS || link.weight <= 0) continue;
    const decay = 0.5 ** (Math.max(0, link.ageDays) / HALF_LIFE_DAYS);
    const factor = link.via === "neighbour" ? NEIGHBOUR_FACTOR : 1;
    // Repeats count, but with diminishing returns.
    const amount = KIND_WEIGHT[link.kind] * Math.log2(1 + link.weight) * decay * factor;
    strengths.set(link.key, (strengths.get(link.key) ?? 0) + amount);
  }
  return strengths;
}

/**
 * Reorders hits, already in their best order, by lifting those the person is linked to. Each hit's
 * rank score is 1 / (k + rank), raised by up to `MAX_LIFT` of itself as its link strength grows, so
 * a strong link moves a result up a few places but not past much better matches. Hits with no link
 * keep their order.
 */
export function applyGraphBoost<T extends { readonly serverId: string; readonly externalId: string }>(
  hits: readonly T[],
  strengths: ReadonlyMap<string, number>,
): T[] {
  if (strengths.size === 0) return [...hits];
  return hits
    .map((hit, rank) => {
      const strength = strengths.get(itemKey(hit.serverId, hit.externalId)) ?? 0;
      const lift = MAX_LIFT * (strength / (1 + strength));
      return { hit, rank, score: (1 / (RANK_K + rank + 1)) * (1 + lift) };
    })
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .map(({ hit }) => hit);
}
