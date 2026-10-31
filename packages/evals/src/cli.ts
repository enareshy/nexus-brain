import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixtureRetriever, GoldenSetSchema, runEval } from "./harness.js";

// Phase 0: runs the harness against the fixture retriever. Phase 1 swaps in the real
// federated retriever (packages/retrieval) and the 300-query golden set.
const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: eval <golden.json>\n");
  process.exit(2);
}

const golden = GoldenSetSchema.parse(JSON.parse(await readFile(resolve(file), "utf8")));
const report = await runEval(golden, fixtureRetriever(golden));

process.stdout.write(
  [
    `golden set: ${golden.description} (${golden.cases.length} cases, k=${report.k})`,
    `recall@k ${report.recallAtK.toFixed(3)}  mrr ${report.mrr.toFixed(3)}  ndcg@k ${report.ndcgAtK.toFixed(3)}  leaks ${report.leakCount}`,
    report.passed ? "PASS" : "FAIL",
    "",
  ].join("\n"),
);
process.exit(report.passed ? 0 : 1);
