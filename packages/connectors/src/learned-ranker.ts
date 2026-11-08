/**
 * A company's learned ranker (FR-RET-08). It learns from ratings of answers which kinds of results
 * people find useful, from general signals only: place in the list, match score, how recent it is
 * and which service it came from. It stores no ids, titles or text, so it reveals nothing about any
 * document, and it only reorders results a person's own search already returned.
 */

/** One result from a rated answer, as saved. `group` ties the results of one rating together. */
export interface RankingExample {
  readonly group: string;
  readonly serverId: string;
  readonly position: number;
  /** Its match score divided by the best one in the list, 0 to 1. */
  readonly scoreRatio: number;
  /** Days since it changed, or null when the service gave no date. */
  readonly ageDays: number | null;
  readonly label: 0 | 1;
}

export type RankingSignals = Omit<RankingExample, "group" | "label">;

export interface RankerModel {
  readonly version: 1;
  readonly bias: number;
  readonly weights: { readonly position: number; readonly score: number; readonly recency: number; readonly undated: number };
  /** Learned per service; a service not seen in training counts as zero. */
  readonly sources: Readonly<Record<string, number>>;
}

export interface TrainingMetrics {
  readonly examples: number;
  readonly answers: number;
  /** Mean reciprocal rank of the cited result in held-out answers: with the model, and in list order. */
  readonly holdoutMrr: number;
  readonly baselineMrr: number;
  readonly active: boolean;
  readonly reason: "too_few" | "no_gain" | "better";
}

/**
 * When a trained ranker may be used. It needs enough rated answers to learn from, enough held back
 * to check it on (answers with a cited result), and it must beat the search's own order on those by
 * a clear margin, so a lucky split or one person's ratings cannot switch it on.
 */
export interface RankerLimits {
  readonly minAnswers: number;
  readonly minHeldOutAnswers: number;
  readonly minGain: number;
}
export const RANKER_LIMITS: RankerLimits = { minAnswers: 150, minHeldOutAnswers: 30, minGain: 0.02 };
/** One answer in five is held back to check the model on answers it did not learn from. */
const HOLDOUT_EVERY = 5;
/** No signal may count for more than this, whatever the ratings say. */
const MAX_WEIGHT = 3;
const EPOCHS = 400;
const LEARNING_RATE = 0.5;
/** Keeps weights small, so a few odd ratings cannot swing the ranking. */
const L2 = 0.01;
const RECENCY_DAYS = 90;
const DAY_MS = 86_400_000;

function features(signals: RankingSignals): { readonly position: number; readonly score: number; readonly recency: number; readonly undated: number } {
  return {
    position: 1 / (1 + signals.position),
    score: Math.max(0, Math.min(1, signals.scoreRatio)),
    recency: signals.ageDays === null ? 0 : Math.exp(-Math.max(0, signals.ageDays) / RECENCY_DAYS),
    undated: signals.ageDays === null ? 1 : 0,
  };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** How likely a result with these signals is to be a useful one, 0 to 1. */
export function predict(model: RankerModel, signals: RankingSignals): number {
  const f = features(signals);
  const w = model.weights;
  // Only the model's own entries: an id like "constructor" must not reach the object's prototype.
  const source = Object.hasOwn(model.sources, signals.serverId) ? (model.sources[signals.serverId] ?? 0) : 0;
  const p = sigmoid(model.bias + w.position * f.position + w.score * f.score + w.recency * f.recency + w.undated * f.undated + source);
  return Number.isFinite(p) ? p : 0;
}

/** A stable split, so the same ratings always train and check the same way. */
function heldOut(group: string): boolean {
  let hash = 0;
  for (let i = 0; i < group.length; i += 1) hash = (hash * 31 + group.charCodeAt(i)) >>> 0;
  return hash % HOLDOUT_EVERY === 0;
}

/** Logistic regression by plain gradient descent: small, deterministic and enough for four signals. */
function fit(rows: readonly RankingExample[]): RankerModel {
  const sources = [...new Set(rows.map((r) => r.serverId))].sort();
  let bias = 0;
  let w = { position: 0, score: 0, recency: 0, undated: 0 };
  let s = Object.fromEntries(sources.map((id) => [id, 0])) as Record<string, number>;
  const encoded = rows.map((row) => ({ row, f: features(row) }));
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    let gb = 0;
    const gw = { position: 0, score: 0, recency: 0, undated: 0 };
    const gs = Object.fromEntries(sources.map((id) => [id, 0])) as Record<string, number>;
    for (const { row, f } of encoded) {
      const p = sigmoid(bias + w.position * f.position + w.score * f.score + w.recency * f.recency + w.undated * f.undated + (s[row.serverId] ?? 0));
      const err = p - row.label;
      gb += err;
      gw.position += err * f.position;
      gw.score += err * f.score;
      gw.recency += err * f.recency;
      gw.undated += err * f.undated;
      gs[row.serverId] = (gs[row.serverId] ?? 0) + err;
    }
    const n = encoded.length;
    const step = (value: number, grad: number) => Math.max(-MAX_WEIGHT, Math.min(MAX_WEIGHT, value - LEARNING_RATE * (grad / n + L2 * value)));
    bias = Math.max(-MAX_WEIGHT, Math.min(MAX_WEIGHT, bias - LEARNING_RATE * (gb / n)));
    w = {
      position: step(w.position, gw.position),
      score: step(w.score, gw.score),
      recency: step(w.recency, gw.recency),
      undated: step(w.undated, gw.undated),
    };
    s = Object.fromEntries(sources.map((id) => [id, step(s[id] ?? 0, gs[id] ?? 0)]));
  }
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    version: 1,
    bias: round(bias),
    weights: { position: round(w.position), score: round(w.score), recency: round(w.recency), undated: round(w.undated) },
    sources: Object.fromEntries(Object.entries(s).map(([id, v]) => [id, round(v)])),
  };
}

/** Mean reciprocal rank of the first good result in each answer that has one, ordered by `score`. */
function mrr(groups: readonly (readonly RankingExample[])[], score: (row: RankingExample) => number): number {
  if (groups.length === 0) return 0;
  const ranks = groups.map((rows) => {
    const ordered = [...rows].sort((a, b) => score(b) - score(a) || a.position - b.position);
    return 1 / (ordered.findIndex((r) => r.label === 1) + 1);
  });
  return ranks.reduce((a, b) => a + b, 0) / ranks.length;
}

/**
 * Trains on four answers in five and checks on the fifth. The model is used only if, on those
 * held-back answers, it puts the cited result higher than the search's own order did by at least
 * `limits.minGain`; otherwise ranking stays as it is.
 */
export function trainRanker(
  examples: readonly RankingExample[],
  limits: RankerLimits = RANKER_LIMITS,
): { model: RankerModel | null; metrics: TrainingMetrics } {
  const byGroup = new Map<string, RankingExample[]>();
  for (const e of examples) byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e]);
  const scorable = [...byGroup].filter(([group, rows]) => heldOut(group) && rows.some((r) => r.label === 1)).map(([, rows]) => rows);
  const base = { examples: examples.length, answers: byGroup.size };
  if (byGroup.size < limits.minAnswers || scorable.length < limits.minHeldOutAnswers) {
    return { model: null, metrics: { ...base, holdoutMrr: 0, baselineMrr: 0, active: false, reason: "too_few" } };
  }
  const model = fit(examples.filter((e) => !heldOut(e.group)));
  const holdoutMrr = mrr(scorable, (row) => predict(model, row));
  const baselineMrr = mrr(scorable, (row) => -row.position);
  const better = holdoutMrr >= baselineMrr + limits.minGain;
  const metrics: TrainingMetrics = { ...base, holdoutMrr, baselineMrr, active: better, reason: better ? "better" : "no_gain" };
  // Once checked, it learns from every answer.
  return { model: better ? fit(examples) : null, metrics };
}

/** Reorders a person's results by what their company's ratings taught; never adds or drops one. */
export function applyLearnedRanker<T extends RankableHit>(
  hits: readonly T[],
  model: RankerModel,
  now: number = Date.now(),
): T[] {
  const best = Math.max(0, ...hits.map(finiteScore));
  return hits
    .map((hit, position) => ({ hit, position, p: predict(model, signalsOf(hit, position, best, now)) }))
    .sort((a, b) => b.p - a.p || a.position - b.position)
    .map(({ hit }) => hit);
}

/** A result as a search returns it. `searchRank` is its place before any personal reordering. */
export interface RankableHit {
  readonly serverId: string;
  readonly score?: number;
  readonly updatedAt: string | null;
  readonly searchRank?: number;
}

const finiteScore = (hit: RankableHit) => (typeof hit.score === "number" && Number.isFinite(hit.score) ? Math.max(0, hit.score) : 0);

function signalsOf(hit: RankableHit, position: number, best: number, now: number): RankingSignals {
  const changed = hit.updatedAt ? Date.parse(hit.updatedAt) : Number.NaN;
  return {
    serverId: hit.serverId,
    position,
    scoreRatio: best > 0 ? Math.min(1, finiteScore(hit) / best) : 0,
    ageDays: Number.isFinite(changed) ? Math.max(0, (now - changed) / DAY_MS) : null,
  };
}

/**
 * What one rating teaches: for an answer rated up, its cited results were useful and the others in
 * its list were not; for one rated down, only that its cited results were not. Citations are the
 * 1-based source numbers of the answer. Keeps general signals only, never ids.
 */
export function examplesFromAnswer(
  answer: { readonly hits: readonly RankableHit[]; readonly cited: readonly number[] },
  rating: "up" | "down",
  group: string,
  now: number = Date.now(),
): RankingExample[] {
  const cited = new Set(answer.cited);
  if (cited.size === 0 || answer.hits.length === 0) return [];
  const best = Math.max(0, ...answer.hits.map(finiteScore));
  return answer.hits.flatMap((hit, index): RankingExample[] => {
    const isCited = cited.has(index + 1);
    if (rating === "down" && !isCited) return [];
    const label: 0 | 1 = rating === "up" && isCited ? 1 : 0;
    // The place the search itself gave it, as the ranker sees results before reordering them;
    // the place shown may already include the ranker's own reordering.
    const signals = signalsOf(hit, hit.searchRank ?? index, best, now);
    return [{ group, ...signals, ageDays: signals.ageDays === null ? null : Math.round(signals.ageDays), label }];
  });
}
