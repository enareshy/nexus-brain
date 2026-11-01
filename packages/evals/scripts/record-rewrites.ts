// Records what the real model rewrites each question to, so `pnpm eval` can replay it in CI with no
// key and no cost. Spends money: about 260 small calls. Prints counts only.
//   node --env-file-if-exists=../../.env --import tsx scripts/record-rewrites.ts
import { createAnthropicGateway, type UsageReport } from "@brain/llm-gateway";
import { readFileSync, writeFileSync } from "node:fs";

const CONCURRENCY = 3;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

const golden = JSON.parse(readFileSync("golden/synthetic.json", "utf8")) as {
  cases: Array<{ query: string; expected: string[]; forbidden: string[] }>;
};
const gateway = createAnthropicGateway({ apiKey });
const questions = [...new Set(golden.cases.map((c) => c.query))];
const rewrites: Record<string, readonly string[]> = {};
let cost = 0;
let failed = 0;
let retries = 0;
let next = 0;

async function worker(): Promise<void> {
  for (let i = next++; i < questions.length; i = next++) {
    const question = questions[i]!;
    // The gateway does not retry, so a short-lived failure is retried here, slowly.
    for (let attempt = 1; attempt <= ATTEMPTS && rewrites[question] === undefined; attempt += 1) {
      try {
        rewrites[question] = await gateway.rewriteQuery(question, new AbortController().signal, (usage: UsageReport) => {
          cost += usage.costUsd ?? 0;
        });
      } catch {
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, attempt * RETRY_DELAY_MS));
      }
    }
    if (rewrites[question] === undefined) failed += 1;
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
// A partly failed run must not replace good recordings with empty ones.
if (failed > 0) throw new Error(`${failed} of ${questions.length} calls failed; nothing was written`);
const sorted = Object.fromEntries(Object.entries(rewrites).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync("golden/rewrites.json", `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${questions.length} questions, ${retries} retries, about $${cost.toFixed(4)}`);
