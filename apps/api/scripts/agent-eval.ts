// Runs the agent eval tasks through the real agent code and the real model, on invented documents.
// Nothing reaches a connected service: search and proposals are simulated, and approvals change nothing.
// Spends money: about $2. Prints scores, not transcripts.
//   node --env-file-if-exists=../../.env --import tsx scripts/agent-eval.ts [taskId ...]
import { AppError, createSecretBox } from "@brain/core";
import type { SearchHit, WriteRequest, WriteTarget } from "@brain/connectors";
import { createAppPool, type UserScope } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import {
  AgentRecordingSchema,
  AgentTasksSchema,
  hashTasks,
  scoreRecording,
  type AgentRunRecord,
  type AgentTask,
} from "@brain/evals";
import { createAnthropicGateway, type LlmGateway } from "@brain/llm-gateway";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { AgentsService, type AgentRunView } from "../src/agents/agents.service.js";
import { agentFingerprint } from "../src/agents/fingerprint.js";
import { loadApiEnv } from "../src/config.js";
import type { ProposalView } from "../src/proposals/proposals.service.js";

const TASKS_FILE = "../../packages/evals/golden/agent-tasks.json";
const RESULTS_FILE = "../../packages/evals/golden/agent-results.json";
const SITE = "site-1";
const ORIGIN = "https://invented.example";
const NEW_ISSUE_KEY = "ENG-900";
const BUDGET_USD = 6;
const ATTEMPTS = 2;
const POLL_MS = 200;

const env = loadApiEnv();
if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
const ownerUrl = process.env.DATABASE_URL;
if (!ownerUrl) throw new Error("DATABASE_URL is not set");

const { tasks } = AgentTasksSchema.parse(JSON.parse(readFileSync(TASKS_FILE, "utf8")));
const only = new Set(process.argv.slice(2));
const selected = only.size > 0 ? tasks.filter((task) => only.has(task.id)) : tasks;

const pool = createAppPool({ connectionString: env.DATABASE_APP_ROLE_URL, onError: () => {} });
const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
const box = createSecretBox(randomBytes(32).toString("base64"));
const realGateway = createAnthropicGateway({ apiKey: env.ANTHROPIC_API_KEY });
const user = seedUser("bob");
const scope: UserScope = { tenantId: TENANTS[user.tenant].id, userId: user.id };
const logger = { error: (fields: unknown, message: string) => process.stderr.write(`${message} ${JSON.stringify(fields)}\n`) };
let spent = 0;

/** A small keyword search: a document matches when any word of the query appears in it. */
function simulatedSearch(task: AgentTask, query: string): SearchHit[] {
  const words = query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
  const score = (doc: AgentTask["documents"][number]) => {
    const text = `${doc.id} ${doc.title} ${doc.body}`.toLowerCase();
    return words.filter((word) => text.includes(word)).length;
  };
  return task.documents
    .map((doc) => ({ doc, matched: score(doc) }))
    .filter(({ matched }) => matched > 0)
    .sort((a, b) => b.matched - a.matched)
    .map(({ doc }) => ({
      serverId: "atlassian",
      externalId: doc.id,
      siteId: SITE,
      title: doc.title,
      url: `${ORIGIN}/${doc.id}`,
      snippet: doc.body.slice(0, 120),
      updatedAt: null,
    }));
}

function simulatedProposals(task: AgentTask) {
  const targets: WriteTarget[] = [
    { siteId: SITE, siteOrigin: ORIGIN, projects: [{ key: "ENG", name: task.projectName ?? "Engineering", issueTypes: ["Task", "Bug"] }] },
  ];
  const made = new Map<string, ProposalView>();
  const view = (id: string, status: ProposalView["status"], request?: WriteRequest): ProposalView => ({
    id,
    serverId: "atlassian",
    action: request?.action ?? "",
    toolName: "simulated",
    toolClass: "write",
    args: {},
    argsHash: "simulated",
    status,
    externalId: status === "succeeded" ? ("issueKey" in (request ?? {}) ? (request as { issueKey: string }).issueKey : NEW_ISSUE_KEY) : null,
    url: null,
    errorCode: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    agentRunId: null,
  });
  const requests = new Map<string, WriteRequest>();
  return {
    targets: async () => targets,
    reject: async (_scope: UserScope, id: string) => view(id, "rejected"),
    proposeForAgent: async (_scope: UserScope, _server: string, request: WriteRequest, origin: { id: string }) => {
      if (request.siteId !== SITE) throw new AppError("VALIDATION", "This site cannot be changed");
      if (request.action === "create_issue") {
        if (request.projectKey !== "ENG") throw new AppError("VALIDATION", "This project cannot be changed");
        if (request.issueType !== "Task" && request.issueType !== "Bug") throw new AppError("VALIDATION", "This issue type does not exist");
      }
      requests.set(origin.id, request);
      const pending = view(origin.id, "pending", request);
      made.set(origin.id, pending);
      return pending;
    },
    // The simulated person decides at once.
    get: async (_scope: UserScope, id: string) => {
      const decided = task.decision === "approve" ? "succeeded" : "rejected";
      return view(id, decided, requests.get(id));
    },
  };
}

async function runTask(task: AgentTask): Promise<AgentRunRecord> {
  const calls: Array<{ id: string; tool: string; args: unknown }> = [];
  let cost = 0;
  const gateway: LlmGateway = {
    ...realGateway,
    agentTurn: async (input, signal, onUsage) => {
      const turn = await realGateway.agentTurn(input, signal, (usage) => {
        cost += usage.costUsd ?? 0;
        onUsage(usage);
      });
      if (turn.toolCall) calls.push({ id: turn.toolCall.id, tool: turn.toolCall.name, args: turn.toolCall.input });
      return turn;
    },
  };
  const documents = {
    gatherDocuments: async (_scope: UserScope, query: string) => {
      const hits = simulatedSearch(task, query).map((hit) => ({ ...hit, score: 1 }));
      const bodies = new Map(task.documents.map((doc) => [`${ORIGIN}/${doc.id}`, doc.body]));
      return { hits, sources: [{ id: "atlassian", ok: true, hits: hits.length, ms: 1 }], bodies };
    },
  };
  const agents = new AgentsService({ pool, box, gateway, documents, proposals: simulatedProposals(task), logger });
  const { id } = await agents.start(scope, task.goal);
  let run: AgentRunView;
  try {
    for (;;) {
      await agents.settled();
      run = await agents.get(scope, id);
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await agents.settled();
  }
  spent += cost;
  const final = run;
  await owner.query("DELETE FROM agent_runs WHERE id = $1", [id]);
  return {
    id: task.id,
    status: final.status,
    errorCode: final.errorCode,
    answer: final.result,
    toolCalls: calls.map((call, index) => ({ tool: call.tool, args: call.args, outcome: final.steps[index]?.outcome ?? "no_step" })),
    turns: final.turnCount,
    costUsd: Number(cost.toFixed(6)),
  };
}

const results: AgentRunRecord[] = [];
let lostToNetwork = 0;
try {
  for (const task of selected) {
    if (spent > BUDGET_USD) throw new Error(`Stopped at the $${BUDGET_USD} budget after ${results.length} tasks; nothing was written`);
    let record = await runTask(task);
    // A dropped connection says nothing about the agent, so that task runs once more.
    for (let attempt = 1; attempt < ATTEMPTS && record.errorCode === "model_unavailable"; attempt += 1) {
      lostToNetwork += 1;
      record = await runTask(task);
    }
    results.push(record);
    process.stdout.write(`${task.id}: ${record.status}, ${record.toolCalls.length} calls, $${record.costUsd.toFixed(3)}\n`);
  }
} finally {
  await owner.end();
  await pool.end();
}

// A partial run only updates its own tasks, and the recording is stale until the whole set matches.
const previous = existsSync(RESULTS_FILE) ? AgentRecordingSchema.parse(JSON.parse(readFileSync(RESULTS_FILE, "utf8"))) : null;
const kept = only.size > 0 ? (previous?.results ?? []).filter((result) => !only.has(result.id)) : [];
const recording = { agentFingerprint: agentFingerprint(), tasksHash: hashTasks(tasks), results: [...kept, ...results] };
writeFileSync(RESULTS_FILE, `${JSON.stringify(recording, null, 2)}\n`);

const report = scoreRecording(tasks, recording);
process.stdout.write(`\nretried after dropped connections: ${lostToNetwork}, this run cost about $${spent.toFixed(2)}\n`);
process.stdout.write(`completion ${report.completion.toFixed(3)}, tools ${report.toolAccuracy.toFixed(3)}, resisted ${report.injectionResisted.toFixed(3)}\n`);
for (const score of report.scores.filter((s) => s.problems.length > 0)) {
  process.stdout.write(`  ${score.id}: ${score.problems.join("; ")}\n`);
}
process.stdout.write(report.passed ? "PASS\n" : "FAIL\n");
