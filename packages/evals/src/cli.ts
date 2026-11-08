import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentRecordingSchema, AGENT_TARGETS, AgentTasksSchema, scoreRecording } from "./agent-eval.js";
import { compareRanking, CorpusSchema, MAX_UNRELATED_COST, RewritesSchema } from "./corpus.js";
import { GoldenSetSchema, type EvalReport } from "./harness.js";

const [goldenFile, corpusFile, rewritesFile, agentTasksFile, agentResultsFile] = process.argv.slice(2);
if (!goldenFile || !corpusFile) {
  process.stderr.write("usage: eval <golden.json> <corpus.json> [rewrites.json] [agent-tasks.json agent-results.json]\n");
  process.exit(2);
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(resolve(file), "utf8"));
const golden = GoldenSetSchema.parse(await readJson(goldenFile));
const corpus = CorpusSchema.parse(await readJson(corpusFile));
const rewrites = rewritesFile ? RewritesSchema.parse(await readJson(rewritesFile)) : undefined;
const { baseline, reranked, rewritten, personal, learned, passed } = await compareRanking(golden, corpus, 10, rewrites);

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
    `work graph: ${personal.withGraph.cases.length} short questions with an earlier history, derived from the set above (invented documents)`,
    ...[
      ["personal-used", "history matches"],
      ["personal-unrelated", "history unrelated"],
    ].map(([tag, label]) => {
      const before = personal.withoutGraph.byTag[tag!];
      const after = personal.withGraph.byTag[tag!];
      return `${label!.padEnd(18)} mrr ${before?.mrr.toFixed(3) ?? "-"} without graph, ${after?.mrr.toFixed(3) ?? "-"} with  (${after?.cases ?? 0} questions)`;
    }),
    `if half of histories matched (an assumption): mrr ${personal.withoutGraph.mrr.toFixed(3)} without graph, ${personal.withGraph.mrr.toFixed(3)} with; unrelated history may cost at most ${MAX_UNRELATED_COST}`,
    `learned ranker: ${learned.training.answers} made-up rated answers from four questions in five; ${
      learned.training.active
        ? "switched on"
        : learned.training.reason === "too_few"
          ? "too few to train, so switching it on is not exercised here (the unit and integration tests cover it)"
          : "trained, but no clear gain over the search's own order, so it stays off"
    }`,
    `held-back questions mrr ${learned.withoutRanker.mrr.toFixed(3)} without ranker, ${learned.withRanker.mrr.toFixed(3)} with  (${learned.withRanker.cases.length} questions; must not get worse)`,
    passed ? "PASS" : "FAIL",
    "",
  ].join("\n"),
);
let agentsPassed = true;
if (agentTasksFile && agentResultsFile) {
  const { tasks } = AgentTasksSchema.parse(await readJson(agentTasksFile));
  const report = scoreRecording(tasks, AgentRecordingSchema.parse(await readJson(agentResultsFile)));
  agentsPassed = report.passed;
  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
  process.stdout.write(
    [
      "",
      `agents: ${tasks.length} tasks from a recording of the real model`,
      `completed ${pct(report.completion)} (target ${pct(AGENT_TARGETS.completion)}), valid tool calls ${pct(report.toolAccuracy)} (target ${pct(AGENT_TARGETS.toolAccuracy)})`,
      `attacks resisted ${pct(report.injectionResisted)} of ${report.injectionTasks} (target ${pct(AGENT_TARGETS.injectionResisted)})`,
      `cost per run: mean $${report.meanCostUsd.toFixed(3)}, highest $${report.maxCostUsd.toFixed(3)} (target mean $${AGENT_TARGETS.meanCostUsd.toFixed(2)})`,
      ...Object.entries(report.completionByCategory).map(([category, value]) => `  ${category.padEnd(10)} ${pct(value)}`),
      ...report.stale.map((problem) => `  out of date: ${problem}`),
      ...report.scores.filter((s) => s.problems.length > 0).map((s) => `  ${s.id}: ${s.problems.join("; ")}`),
      report.passed ? "PASS" : "FAIL",
      "",
    ].join("\n"),
  );
}
process.exit(passed && agentsPassed ? 0 : 1);
