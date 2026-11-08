import { sql } from "drizzle-orm";
import type pg from "pg";
import { withTenant, type PoolLike } from "./tenant.js";

/** One result from a rated answer, as general signals; see migration 0027. */
export interface StoredRankingExample {
  readonly group: string;
  readonly serverId: string;
  readonly position: number;
  readonly scoreRatio: number;
  /** Whole days; anything finer is rounded. */
  readonly ageDays: number | null;
  readonly label: 0 | 1;
}

export interface StoredRanker {
  /** Unvalidated: the caller checks its shape before using it. */
  readonly model: unknown;
  readonly metrics: unknown;
  readonly trainedAt: Date;
}

/** One answer's results at most; more in one call means a bug. */
const MAX_EXAMPLES_PER_CALL = 20;
/** Ratings older than this are no longer learned from, and are deleted when training runs. */
export const RANKING_EXAMPLE_DAYS = 180;

export async function recordRankingExamples(pool: PoolLike, tenantId: string, rows: readonly StoredRankingExample[]): Promise<void> {
  if (rows.length === 0) return;
  if (rows.length > MAX_EXAMPLES_PER_CALL) throw new Error(`At most ${MAX_EXAMPLES_PER_CALL} examples at once`);
  const values = sql.join(
    rows.map((r) => sql`(${tenantId}, ${r.group}, ${r.serverId}, ${r.position}, ${r.scoreRatio}, ${r.ageDays === null ? null : Math.round(r.ageDays)}, ${r.label})`),
    sql`, `,
  );
  const groups = [...new Set(rows.map((r) => r.group))];
  if (groups.length !== 1) throw new Error("Examples are saved one answer at a time");
  const group = groups[0]!;
  await withTenant(pool, tenantId, async (db) => {
    // An answer is learned from once, by its first rating: later ratings, retries and a second
    // request at the same moment add nothing (the lock makes the check and the insert one step).
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ranking|${tenantId}|${group}`}, 0))`);
    const { rows: saved } = await db.execute(sql`SELECT 1 FROM ranking_examples WHERE tenant_id = ${tenantId} AND answer_group = ${group} LIMIT 1`);
    if (saved.length > 0) return;
    await db.execute(sql`INSERT INTO ranking_examples (tenant_id, answer_group, server_id, position, score_ratio, age_days, label)
      VALUES ${values} ON CONFLICT (tenant_id, answer_group, position) DO NOTHING`);
  });
}

export function getTenantRanker(pool: PoolLike, tenantId: string): Promise<StoredRanker | null> {
  return withTenant(pool, tenantId, async (db) => {
    const { rows } = await db.execute(sql`SELECT model, metrics, trained_at FROM tenant_rankers WHERE tenant_id = ${tenantId}`);
    const row = rows[0] as { model: unknown; metrics: unknown; trained_at: Date | string } | undefined;
    return row ? { model: row.model, metrics: row.metrics, trainedAt: new Date(row.trained_at) } : null;
  });
}

// Training is an operator's job across companies, so these take a client whose role bypasses
// row-level security (the owner), never the app's pool.

/** Companies with ratings to learn from. */
export async function companiesWithRankingExamples(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM ranking_examples ORDER BY tenant_id");
  return rows.map((row) => row.tenant_id);
}

/** Deletes every company's ratings older than the limit. Returns how many went. */
export async function purgeOldRankingExamples(client: pg.ClientBase): Promise<number> {
  const result = await client.query("DELETE FROM ranking_examples WHERE saved_on < current_date - $1::integer", [RANKING_EXAMPLE_DAYS]);
  return result.rowCount ?? 0;
}

/** The company's saved ratings, in a fixed order so training is repeatable. */
export async function loadRankingExamples(client: pg.ClientBase, tenantId: string): Promise<StoredRankingExample[]> {
  const { rows } = await client.query<{ answer_group: string; server_id: string; position: number; score_ratio: number; age_days: number | null; label: number }>(
    "SELECT answer_group, server_id, position, score_ratio, age_days, label FROM ranking_examples WHERE tenant_id = $1 ORDER BY answer_group, position",
    [tenantId],
  );
  return rows.map((row) => ({
    group: row.answer_group,
    serverId: row.server_id,
    position: row.position,
    scoreRatio: Number(row.score_ratio),
    ageDays: row.age_days === null ? null : Number(row.age_days),
    label: row.label === 1 ? 1 : 0,
  }));
}

/** Saves the outcome of training; a null model keeps today's order for that company. */
export async function saveTenantRanker(client: pg.ClientBase, tenantId: string, model: unknown, metrics: unknown): Promise<void> {
  await client.query(
    `INSERT INTO tenant_rankers (tenant_id, model, metrics, trained_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id) DO UPDATE SET model = EXCLUDED.model, metrics = EXCLUDED.metrics, trained_at = now()`,
    [tenantId, model === null ? null : JSON.stringify(model), JSON.stringify(metrics)],
  );
}
