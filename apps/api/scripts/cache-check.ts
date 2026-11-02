// Checks that prompt caching works on real agent turns (FR-LLM-05), and what it saves.
// Runs two short agent conversations with the real instructions and tools on invented search results.
// Nothing reaches a connected service. Spends a few cents. Prints token counts, not text.
// Re-run after changing how agent requests are built: a silent cache miss only shows up on the bill.
//   node --env-file-if-exists=../../.env --import tsx scripts/cache-check.ts
import { createAnthropicGateway, PRICES, type AgentMessage, type UsageReport } from "@brain/llm-gateway";
import { AGENT_TOOLS, untrusted } from "../src/agents/tools.js";
import { loadApiEnv } from "../src/config.js";

const MAX_TURNS = 4;
const INVENTED_RESULT = Array.from(
  { length: 40 },
  (_, i) => `Step ${i + 1}: check service ${i} health, drain its traffic, deploy build ${1000 + i}, then confirm the dashboard is green.`,
).join("\n");

const env = loadApiEnv();
if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
const gateway = createAnthropicGateway({ apiKey: env.ANTHROPIC_API_KEY });

/** What the turn would have cost with every input token at the full price. */
function uncachedCost(usage: UsageReport): number {
  const price = PRICES[usage.model];
  if (!price) return NaN;
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return (input * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}

async function run(label: string, goal: string): Promise<{ paid: number; uncached: number }> {
  let messages: AgentMessage[] = [{ role: "user", content: goal }];
  let paid = 0;
  let uncached = 0;
  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    let usage: UsageReport | null = null;
    const result = await gateway.agentTurn({ messages, tools: AGENT_TOOLS }, AbortSignal.timeout(120_000), (u) => (usage = u));
    const u = usage as UsageReport | null;
    if (u) {
      paid += u.costUsd ?? 0;
      uncached += uncachedCost(u);
      console.log(
        `${label} turn ${turn}: input ${u.inputTokens}, cache write ${u.cacheWriteTokens}, cache read ${u.cacheReadTokens}, output ${u.outputTokens}`,
      );
    }
    if (!result.toolCall) break;
    messages = [
      ...messages,
      { role: "assistant", content: result.content },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: result.toolCall.id, content: untrusted("Invented runbook", INVENTED_RESULT) }],
      },
    ];
  }
  return { paid, uncached };
}

const first = await run("run A", "Search for our deploy runbook, then search for the rollback steps, then summarise both in three lines.");
const second = await run("run B", "Search for the on-call rota, then search for the escalation policy, then summarise both in three lines.");
const paid = first.paid + second.paid;
const uncached = first.uncached + second.uncached;
console.log(`paid $${paid.toFixed(4)}; without caching $${uncached.toFixed(4)}; saved ${((1 - paid / uncached) * 100).toFixed(0)}%`);
