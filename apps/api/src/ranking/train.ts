import { trainRanker, type TrainingMetrics } from "@brain/connectors";
import {
  companiesToTrain,
  companiesWithRankingExamples,
  loadRankingExamples,
  purgeOldRankingExamples,
  saveTenantRanker,
  saveTrainedRanker,
  trainingExamples,
  type PoolLike,
  type StoredRankingExample,
} from "@brain/db";
import type pg from "pg";

export interface CompanyTraining {
  readonly tenantId: string;
  readonly metrics: TrainingMetrics;
}

/** Where training reads ratings and saves results: the app's scoped functions, or an operator's role. */
export interface TrainingStore {
  companies(): Promise<readonly string[]>;
  examples(tenantId: string): Promise<readonly StoredRankingExample[]>;
  save(tenantId: string, model: unknown, metrics: TrainingMetrics): Promise<void>;
}

/** The app's own pool, through functions that work on one company at a time (migration 0028). */
export function appTrainingStore(pool: PoolLike): TrainingStore {
  return {
    companies: () => companiesToTrain(pool),
    examples: (tenantId) => trainingExamples(pool, tenantId),
    save: (tenantId, model, metrics) => saveTrainedRanker(pool, tenantId, model, metrics),
  };
}

/** An operator's client whose role can read every company's ratings (the owner). */
export function operatorTrainingStore(client: pg.ClientBase): TrainingStore {
  let purged = false;
  return {
    async companies() {
      if (!purged) await purgeOldRankingExamples(client);
      purged = true;
      return companiesWithRankingExamples(client);
    },
    examples: (tenantId) => loadRankingExamples(client, tenantId),
    save: (tenantId, model, metrics) => saveTenantRanker(client, tenantId, model, metrics),
  };
}

/**
 * Trains every company's learned ranker from its saved ratings (FR-RET-08). A company's model is
 * replaced each time; if it does not beat today's order on held-back ratings, it is cleared, so
 * ranking for that company stays as it is. One company failing does not stop the others; failures
 * are passed to `onFailure` with the company's id only. Reports counts and scores, never ratings.
 */
export async function trainCompanies(
  store: TrainingStore,
  onFailure: (tenantId: string, err: unknown) => void = (_tenantId, err) => {
    throw err;
  },
): Promise<CompanyTraining[]> {
  const results: CompanyTraining[] = [];
  for (const tenantId of await store.companies()) {
    try {
      const { model, metrics } = trainRanker(await store.examples(tenantId));
      await store.save(tenantId, model, metrics);
      results.push({ tenantId, metrics });
    } catch (err) {
      onFailure(tenantId, err);
    }
  }
  return results;
}

/** For the operator command: trains every company with the owner's client. */
export function trainCompanyRankers(client: pg.ClientBase): Promise<CompanyTraining[]> {
  return trainCompanies(operatorTrainingStore(client));
}
