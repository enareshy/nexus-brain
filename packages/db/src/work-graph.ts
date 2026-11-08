import { sql } from "drizzle-orm";
import { withUser, type PoolLike, type UserScope } from "./tenant.js";

export type GraphEdgeKind = "opened" | "cited_up" | "co_cited";

/** One link in a person's graph. `source` is "me" for links from the person. */
export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: GraphEdgeKind;
}

export interface StoredGraphLink {
  readonly key: string;
  readonly kind: GraphEdgeKind;
  readonly via: "direct" | "neighbour";
  readonly weight: number;
  readonly ageDays: number;
}

/** Links older than this are dropped, and the newest this many are kept per person. */
const MAX_AGE_DAYS = 90;
const MAX_EDGES_PER_PERSON = 5_000;
/** At most this many links are recorded at once (one answer's sources, paired). */
const MAX_EDGES_PER_CALL = 50;
const MAX_KEYS_PER_LOOKUP = 100;

/** Records links, counting repeats, and keeps the person's graph small and recent. */
export async function recordGraphEdges(pool: PoolLike, scope: UserScope, edges: readonly GraphEdge[]): Promise<void> {
  if (edges.length === 0) return;
  if (edges.length > MAX_EDGES_PER_CALL) throw new Error(`At most ${MAX_EDGES_PER_CALL} links at once`);
  // One row per link: a statement may not update the same row twice.
  const unique = [...new Map(edges.map((edge) => [JSON.stringify([edge.source, edge.target, edge.kind]), edge])).values()];
  const rows = sql.join(
    unique.map((edge) => sql`(${scope.tenantId}, ${scope.userId}, ${edge.source}, ${edge.target}, ${edge.kind})`),
    sql`, `,
  );
  await withUser(pool, scope, async (db) => {
    await db.execute(sql`
      INSERT INTO work_graph_edges (tenant_id, user_id, source_key, target_key, kind)
      VALUES ${rows}
      ON CONFLICT (tenant_id, user_id, source_key, target_key, kind)
      DO UPDATE SET weight = LEAST(work_graph_edges.weight + 1, 20), last_seen_at = now()`);
    // Row-level security already limits these to the person; the filters say so and use the index.
    const mine = sql`tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}`;
    await db.execute(sql`DELETE FROM work_graph_edges WHERE ${mine} AND last_seen_at < now() - make_interval(days => ${MAX_AGE_DAYS})`);
    await db.execute(sql`
      DELETE FROM work_graph_edges WHERE ${mine} AND (source_key, target_key, kind) IN (
        SELECT source_key, target_key, kind FROM work_graph_edges WHERE ${mine}
        ORDER BY last_seen_at DESC, source_key, target_key, kind OFFSET ${MAX_EDGES_PER_PERSON})`);
  });
}

/**
 * The person's links that touch these results: straight from them ("direct"), or from an item they
 * opened or found helpful to an item cited alongside it ("neighbour"). Row-level security keeps it
 * to the person's own graph.
 */
export function graphLinksFor(pool: PoolLike, scope: UserScope, keys: readonly string[]): Promise<StoredGraphLink[]> {
  const wanted = [...new Set(keys)].slice(0, MAX_KEYS_PER_LOOKUP);
  if (wanted.length === 0) return Promise.resolve([]);
  // Passed as a Postgres array; a plain list would be sent as a row.
  const keyArray = sql`ARRAY[${sql.join(wanted.map((key) => sql`${key}`), sql`, `)}]::text[]`;
  return withUser(pool, scope, async (db) => {
    const { rows } = await db.execute(sql`
      SELECT target_key AS key, kind, 'direct' AS via, weight,
             EXTRACT(EPOCH FROM now() - last_seen_at) / 86400 AS age_days
        FROM work_graph_edges
       WHERE source_key = 'me' AND target_key = ANY(${keyArray})
      UNION ALL
      -- Through each item the person used, once, by its strongest link: an item both opened and rated
      -- up counts once here, as its own links already count both.
      SELECT c.target_key AS key, c.kind, 'neighbour' AS via, LEAST(c.weight, d.weight) AS weight,
             EXTRACT(EPOCH FROM now() - LEAST(c.last_seen_at, d.last_seen_at)) / 86400 AS age_days
        FROM work_graph_edges c
        JOIN LATERAL (
          SELECT max(u.weight) AS weight, max(u.last_seen_at) AS last_seen_at
            FROM work_graph_edges u
           WHERE u.source_key = 'me' AND u.target_key = c.source_key
        ) d ON d.weight IS NOT NULL
       WHERE c.kind = 'co_cited' AND c.target_key = ANY(${keyArray})`);
    return (rows as Array<{ key: string; kind: GraphEdgeKind; via: "direct" | "neighbour"; weight: number; age_days: string | number }>).map(
      (row) => ({ key: row.key, kind: row.kind, via: row.via, weight: Number(row.weight), ageDays: Number(row.age_days) }),
    );
  });
}

/** Everything in the person's graph, for their data export. */
export function exportGraph(pool: PoolLike, scope: UserScope): Promise<Array<GraphEdge & { weight: number; lastSeenAt: string }>> {
  return withUser(pool, scope, async (db) => {
    const { rows } = await db.execute(sql`
      SELECT source_key, target_key, kind, weight, last_seen_at FROM work_graph_edges ORDER BY last_seen_at DESC`);
    return (rows as Array<{ source_key: string; target_key: string; kind: GraphEdgeKind; weight: number; last_seen_at: Date | string }>).map((row) => ({
      source: row.source_key,
      target: row.target_key,
      kind: row.kind,
      weight: Number(row.weight),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
    }));
  });
}
