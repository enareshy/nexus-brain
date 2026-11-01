import { federatedSearch, stem, toKeywords, toTextSearchTerm, type FederatedSource, type SearchHit } from "@brain/connectors";
import { z } from "zod";
import { DEFAULT_THRESHOLDS, runEval, type EvalReport, type GoldenSet, type Retriever } from "./harness.js";

/** What one simulated source returns at most, like the limit sent to a real service. */
const SOURCE_LIMIT = 20;
const SNIPPET_CHARS = 300;

const DocumentSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  updated: z.string(),
  /** Seed user keys who may see it. The real services enforce this with each user's token. */
  visibleTo: z.array(z.string()),
});
export const CorpusSchema = z.object({
  version: z.number().int().positive(),
  description: z.string(),
  documents: z.array(DocumentSchema),
});
export type Corpus = z.infer<typeof CorpusSchema>;
type Document = z.infer<typeof DocumentSchema>;

function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem));
}

function keywordsOf(query: string): string[] {
  try {
    return toKeywords(toTextSearchTerm(query)).map(stem);
  } catch {
    return [];
  }
}

function toHit(doc: Document): SearchHit {
  return {
    serverId: doc.source,
    externalId: doc.id,
    title: doc.title,
    url: `https://eval.example/${encodeURIComponent(doc.id)}`,
    snippet: doc.body.slice(0, SNIPPET_CHARS),
    updatedAt: doc.updated,
  };
}

/**
 * Behaves like the connected services: each source returns its keyword matches, newest first, for
 * what this user may see. The merging and reranking after that are the production code. It measures
 * ranking on made-up documents, so it cannot show how well real searches or answers work.
 */
export function corpusRetriever(
  corpus: Corpus,
  options: { readonly rerank: boolean; readonly rewrites?: Rewrites },
): Retriever {
  const indexed = corpus.documents.map((doc) => ({ doc, words: wordsOf(`${doc.title} ${doc.body}`) }));
  const sourceIds = [...new Set(corpus.documents.map((doc) => doc.source))];
  return {
    async retrieve({ asUser, query: asked, k }) {
      // Same as production: new words go first, because only the first few keywords are kept.
      const query = [...(options.rewrites?.[asked] ?? []), asked].join(" ");
      const keywords = keywordsOf(query);
      const sources: FederatedSource[] = sourceIds.map((id) => ({
        id,
        run: async () =>
          indexed
            .filter(({ doc, words }) => doc.source === id && doc.visibleTo.includes(asUser) && keywords.some((w) => words.has(w)))
            .map(({ doc }) => doc)
            .sort((a, b) => b.updated.localeCompare(a.updated))
            .slice(0, SOURCE_LIMIT)
            .map(toHit),
      }));
      const { hits } = await federatedSearch(sources, { limit: k, ...(options.rerank ? { rerankQuery: query } : {}) });
      return hits.map((hit) => hit.externalId);
    },
  };
}

export const RewritesSchema = z.record(z.string(), z.array(z.string()));
export type Rewrites = z.infer<typeof RewritesSchema>;

export interface RankingComparison {
  readonly baseline: EvalReport;
  readonly reranked: EvalReport;
  /** With recorded model rewrites, when supplied. */
  readonly rewritten?: EvalReport;
  readonly passed: boolean;
}

/**
 * Fails on any leak, on recall under the set's floor, or if reranking makes ranking worse. With
 * rewrites, recall must also meet the target, so stale recordings fail rather than pass quietly.
 */
export async function compareRanking(
  golden: GoldenSet,
  corpus: Corpus,
  k = 10,
  rewrites?: Rewrites,
): Promise<RankingComparison> {
  const baseline = await runEval(golden, corpusRetriever(corpus, { rerank: false }), k);
  const reranked = await runEval(golden, corpusRetriever(corpus, { rerank: true }), k);
  const rewritten = rewrites ? await runEval(golden, corpusRetriever(corpus, { rerank: true, rewrites }), k) : undefined;
  return {
    baseline,
    reranked,
    ...(rewritten ? { rewritten } : {}),
    passed:
      baseline.leakCount === 0 &&
      reranked.passed &&
      reranked.ndcgAtK >= baseline.ndcgAtK &&
      (rewritten
        ? rewritten.leakCount === 0 &&
          rewritten.recallAtK >= reranked.recallAtK &&
          rewritten.recallAtK >= DEFAULT_THRESHOLDS.minRecallAtK
        : true),
  };
}
