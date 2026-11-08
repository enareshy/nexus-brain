import { applyGraphBoost, graphStrengths, itemKey, type GraphLink } from "@brain/connectors";
import { exportGraph, graphLinksFor, recordGraphEdges, type GraphEdge, type PoolLike, type UserScope } from "@brain/db";

/** One answer's sources and where they were cited, as saved with the answer. */
export interface RatedAnswer {
  readonly hits: ReadonlyArray<{ readonly serverId: string; readonly externalId: string }>;
  readonly parts: ReadonlyArray<{ readonly kind: string; readonly source?: number }>;
}

export interface GraphStore {
  record(scope: UserScope, edges: readonly GraphEdge[]): Promise<void>;
  links(scope: UserScope, keys: readonly string[]): Promise<readonly GraphLink[]>;
  exportAll(scope: UserScope): Promise<readonly unknown[]>;
}

/** What other services use: reorder results, and note what the person found useful. */
export interface WorkGraph {
  rank<T extends { readonly serverId: string; readonly externalId: string }>(scope: UserScope, hits: readonly T[]): Promise<T[]>;
  opened(scope: UserScope, item: { readonly serverId: string; readonly externalId: string }): Promise<void>;
  answerHelpful(scope: UserScope, answer: RatedAnswer): Promise<void>;
  /** For callers whose own graph step failed: reported like the graph's own problems, never thrown. */
  report(err: unknown): void;
}

/** The sources of one answer that are linked, most cited first: 5 sources make 5 + 20 links. */
const MAX_SOURCES_PER_ANSWER = 5;
/** Ids the database accepts, so one odd id never fails a rating. */
const SERVER_ID = /^[a-z0-9-]{1,40}$/;
const MAX_EXTERNAL_ID = 200;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * How long a search waits for the graph. It is one small query, so this only matters when the
 * database is slow; then the results keep their search order rather than wait.
 */
const RANK_TIME_LIMIT_MS = 250;

export function createGraphStore(pool: PoolLike): GraphStore {
  return {
    record: (scope, edges) => recordGraphEdges(pool, scope, edges),
    links: (scope, keys) => graphLinksFor(pool, scope, keys),
    exportAll: (scope) => exportGraph(pool, scope),
  };
}

function storable(item: { readonly serverId: string; readonly externalId: string }): boolean {
  const id = item.externalId;
  return SERVER_ID.test(item.serverId) && id.length > 0 && id.length <= MAX_EXTERNAL_ID && !CONTROL.test(id);
}

/**
 * Each person's own work graph (FR-RET-09). It learns only from what the person does (items they
 * open, answers they rate up) and only reorders results their own search returned. Ranking and
 * recording never fail what the person asked for: a problem with the graph is reported and skipped.
 */
export class GraphService implements WorkGraph {
  constructor(private readonly deps: { readonly store: GraphStore; readonly onError: (err: unknown) => void }) {}

  async rank<T extends { readonly serverId: string; readonly externalId: string }>(scope: UserScope, hits: readonly T[]): Promise<T[]> {
    if (hits.length === 0) return [];
    const keys = hits.filter(storable).map((hit) => itemKey(hit.serverId, hit.externalId));
    if (keys.length === 0) return [...hits];
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Work graph took too long")), RANK_TIME_LIMIT_MS);
    });
    try {
      const links = await Promise.race([this.deps.store.links(scope, keys), late]);
      return applyGraphBoost(hits, graphStrengths(links));
    } catch (err) {
      this.deps.onError(err);
      return [...hits];
    } finally {
      clearTimeout(timer);
    }
  }

  report(err: unknown): void {
    this.deps.onError(err);
  }

  async opened(scope: UserScope, item: { readonly serverId: string; readonly externalId: string }): Promise<void> {
    if (!storable(item)) return;
    await this.record(scope, [{ source: "me", target: itemKey(item.serverId, item.externalId), kind: "opened" }]);
  }

  async answerHelpful(scope: UserScope, answer: RatedAnswer): Promise<void> {
    const keys = this.citedKeys(answer);
    if (keys.length === 0) return;
    const edges: GraphEdge[] = keys.map((target) => ({ source: "me", target, kind: "cited_up" }));
    for (const from of keys) {
      for (const to of keys) if (from !== to) edges.push({ source: from, target: to, kind: "co_cited" });
    }
    await this.record(scope, edges);
  }

  async exportAll(scope: UserScope): Promise<readonly unknown[]> {
    return this.deps.store.exportAll(scope);
  }

  /** The answer's cited sources, most cited first, each once. */
  private citedKeys(answer: RatedAnswer): string[] {
    const counts = new Map<string, number>();
    for (const part of answer.parts) {
      if (part.kind !== "cite" || part.source === undefined) continue;
      const hit = answer.hits[part.source - 1];
      if (!hit || !storable(hit)) continue;
      const key = itemKey(hit.serverId, hit.externalId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SOURCES_PER_ANSWER)
      .map(([key]) => key);
  }

  private async record(scope: UserScope, edges: readonly GraphEdge[]): Promise<void> {
    await this.deps.store.record(scope, edges).catch((err: unknown) => this.deps.onError(err));
  }
}
