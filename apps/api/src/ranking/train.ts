import { trainRanker, type TrainingMetrics } from "@brain/connectors";
import { companiesWithRankingExamples, loadRankingExamples, purgeOldRankingExamples, saveTenantRanker } from "@brain/db";
import type pg from "pg";

export interface CompanyTraining {
  readonly tenantId: string;
  readonly metrics: TrainingMetrics;
}

/**
 * Trains every company's learned ranker from its saved ratings (FR-RET-08). A company's model is
 * replaced each time; if it does not beat today's order on held-back ratings, it is cleared, so
 * ranking for that company stays as it is. Needs a client whose role can read every company's
 * ratings (the owner). Reports counts and scores only.
 */
export async function trainCompanyRankers(client: pg.ClientBase): Promise<CompanyTraining[]> {
  const results: CompanyTraining[] = [];
  await purgeOldRankingExamples(client);
  for (const tenantId of await companiesWithRankingExamples(client)) {
    const examples = await loadRankingExamples(client, tenantId);
    const { model, metrics } = trainRanker(examples);
    await saveTenantRanker(client, tenantId, model, metrics);
    results.push({ tenantId, metrics });
  }
  return results;
}
