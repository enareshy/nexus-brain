import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareRanking, CorpusSchema, RewritesSchema } from "./corpus.js";
import { GoldenSetSchema, type EvalReport } from "./harness.js";

const [goldenFile, corpusFile, rewritesFile] = process.argv.slice(2);
if (!goldenFile || !corpusFile) {
  process.stderr.write("usage: eval <golden.json> <corpus.json> [rewrites.json]\n");
  process.exit(2);
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(resolve(file), "utf8"));
const golden = GoldenSetSchema.parse(await readJson(goldenFile));
const corpus = CorpusSchema.parse(await readJson(corpusFile));
const rewrites = rewritesFile ? RewritesSchema.parse(await readJson(rewritesFile)) : undefined;
const { baseline, reranked, rewritten, passed } = await compareRanking(golden, corpus, 10, rewrites);

const line = (label: string, r: Pick<EvalReport, "recallAtK" | "mrr" | "ndcgAtK">) =>
  `${label.padEnd(16)} recall@k ${r.recallAtK.toFixed(3)}  mrr ${r.mrr.toFixed(3)}  ndcg@k ${r.ndcgAtK.toFixed(3)}`;

const best = rewritten ?? reranked;
const tags = Object.entries(best.byTag)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([tag, r]) => `${line(tag, r)}  (${r.cases} questions)`);

process.stdout.write(
  [
    `golden set: ${golden.description} (${golden.cases.length} cases, k=${reranked.k})`,
    line("merged only", baseline),
    line("reranked", reranked),
    ...(rewritten ? [line("with rewriting", rewritten)] : []),
    `leaks ${best.leakCount}, recall floor ${golden.minRecallAtK ?? "default"}, no-answer questions returning results ${reranked.noAnswerWithResults} as asked${rewritten ? `, ${rewritten.noAnswerWithResults} with rewriting` : ""}`,
    `by tag, ${rewritten ? "with rewriting" : "reranked"}:`,
    ...tags,
    passed ? "PASS" : "FAIL",
    "",
  ].join("\n"),
);
process.exit(passed ? 0 : 1);
