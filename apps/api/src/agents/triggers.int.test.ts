// Automatic agents: the real scheduler, database rules and agent code, with a scripted model (FR-AGT-05).
import { AppError, createSecretBox } from "@brain/core";
import { applyMigrations, createAppPool, findDueAgentWork, loadMigrations, MIGRATIONS_DIR, seed, type UserScope } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import type { AgentTurn, LlmGateway } from "@brain/llm-gateway";
import { createLogger } from "@brain/telemetry";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsService } from "./agents.service.js";
import { TriggersService, type AssignedIssue } from "./triggers.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";

const scopeOf = (person: "bob" | "alice" | "patGlobex"): UserScope => {
  const user = seedUser(person);
  return { tenantId: TENANTS[user.tenant].id, userId: user.id };
};
const bob = scopeOf("bob");
const alice = scopeOf("alice");
const globex = scopeOf("patGlobex");
const people = [bob, alice, globex];

let pool: pg.Pool;
let owner: pg.Client;
let assigned: AssignedIssue[] | Error = [];
const agentTurn = vi.fn<LlmGateway["agentTurn"]>();
const say = (text: string): AgentTurn => ({ content: [{ type: "text", text }], text, toolCall: null, stopReason: "end_turn" });
const usage = { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, estimated: false };

const proposal = (id: string, status: "pending" | "rejected") => ({ id, status, externalId: null, url: null });
let decision: "pending" | "rejected" = "pending";
let agents: AgentsService;
let triggers: TriggersService;

// Shared, as every server in one deployment has the same key.
const box = createSecretBox(randomBytes(32).toString("base64"));

function build() {
  const logger = createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) });
  const gateway: LlmGateway = { streamAnswer: vi.fn(), rewriteQuery: vi.fn(), agentTurn };
  const service: AgentsService = new AgentsService({
    pool,
    box,
    gateway,
    logger,
    documents: { gatherDocuments: async () => ({ hits: [], sources: [], bodies: new Map() }) },
    proposals: {
      targets: async () => [],
      reject: async (_s, id) => proposal(id, "rejected") as never,
      proposeForAgent: async (_s, _server, _request, origin) => proposal(origin.id, "pending") as never,
      get: async (_s, id) => proposal(id, decision) as never,
    },
    notify: (scope, notification) => scheduler.notify(scope, notification),
  });
  const scheduler: TriggersService = new TriggersService({
    pool,
    box,
    logger,
    agents: service,
    assignments: {
      list: async () => {
        if (assigned instanceof Error) throw assigned;
        return assigned;
      },
    },
  });
  return { service, scheduler };
}

/** Sets every enabled trigger of the person as due now. */
const makeDue = (scope: UserScope) => owner.query("UPDATE agent_triggers SET next_run_at = now() - interval '1 second' WHERE user_id = $1", [scope.userId]);
const runsOf = (scope: UserScope) => agents.list(scope);
const tickAndSettle = async () => {
  await triggers.tick();
  await agents.settled();
};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
});

beforeEach(async () => {
  const ids = people.map((p) => p.userId);
  await owner.query("DELETE FROM agent_triggers WHERE user_id = ANY($1)", [ids]);
  await owner.query("DELETE FROM agent_runs WHERE user_id = ANY($1)", [ids]);
  await owner.query("DELETE FROM notifications WHERE user_id = ANY($1)", [ids]);
  agentTurn.mockReset();
  agentTurn.mockImplementation(async (_input, _signal, onUsage) => {
    onUsage(usage);
    return say("Done.");
  });
  assigned = [];
  decision = "pending";
  ({ service: agents, scheduler: triggers } = build());
});

afterAll(async () => {
  await agents?.settled();
  const ids = people.map((p) => p.userId);
  await owner?.query("DELETE FROM agent_triggers WHERE user_id = ANY($1)", [ids]);
  await owner?.query("DELETE FROM agent_runs WHERE user_id = ANY($1)", [ids]);
  await owner?.query("DELETE FROM notifications WHERE user_id = ANY($1)", [ids]);
  await owner?.end();
  await pool?.end();
});

describe("a schedule", () => {
  it("waits for its first time, then starts a run as its owner and tells them", async () => {
    const trigger = await triggers.create(bob, { kind: "schedule", goal: "Summarise my week", schedule: "daily" });
    expect(new Date(trigger.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    await tickAndSettle();
    expect(await runsOf(bob)).toEqual([]);

    await makeDue(bob);
    await tickAndSettle();
    const runs = await runsOf(bob);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ goal: "Summarise my week", automatic: true, status: "completed" });

    const { items, unread } = await triggers.notifications(bob);
    expect(unread).toBe(1);
    expect(items[0]).toMatchObject({ kind: "run_finished", title: "Summarise my week", runId: runs[0]!.id });
    const [{ next_run_at: next }] = (await owner.query("SELECT next_run_at FROM agent_triggers WHERE id = $1", [trigger.id])).rows;
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it("fires once when two servers notice it at the same time", async () => {
    await triggers.create(bob, { kind: "schedule", goal: "Once", schedule: "hourly" });
    await makeDue(bob);
    const other = build();
    await Promise.all([triggers.tick(), other.scheduler.tick()]);
    await agents.settled();
    await other.service.settled();
    expect(await runsOf(bob)).toHaveLength(1);
  });

  it("stops when removed, and leaves the runs it already made", async () => {
    const trigger = await triggers.create(bob, { kind: "schedule", goal: "Stop me", schedule: "hourly" });
    await makeDue(bob);
    await tickAndSettle();
    await triggers.remove(bob, trigger.id);
    await tickAndSettle();
    expect(await runsOf(bob)).toHaveLength(1);
    await expect(triggers.remove(bob, trigger.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is limited to a few for each person, even in parallel", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => triggers.create(bob, { kind: "schedule", goal: "Many", schedule: "weekly" })),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(5);
  });

  it("stops at the daily limit on automatic runs, and says so once", async () => {
    const trigger = await triggers.create(bob, { kind: "schedule", goal: "Too keen", schedule: "hourly" });
    await owner.query(
      `INSERT INTO agent_runs (id, tenant_id, user_id, status, goal_ciphertext, state_ciphertext, deadline_at, trigger_id)
       SELECT gen_random_uuid(), $1, $2, 'completed', 'x', 'x', now() + interval '1 day', $3 FROM generate_series(1, 10)`,
      [bob.tenantId, bob.userId, trigger.id],
    );
    for (let i = 0; i < 2; i += 1) {
      await makeDue(bob);
      await tickAndSettle();
    }
    expect(agentTurn).not.toHaveBeenCalled();
    const { items } = await triggers.notifications(bob);
    expect(items.map((n) => n.kind)).toEqual(["trigger_skipped"]);
    await owner.query("DELETE FROM agent_runs WHERE user_id = $1", [bob.userId]);
  });

  it("tries again soon when the person's runs are busy, rather than losing that time", async () => {
    const trigger = await triggers.create(bob, { kind: "schedule", goal: "Later", schedule: "weekly" });
    await owner.query(
      `INSERT INTO agent_runs (id, tenant_id, user_id, status, goal_ciphertext, state_ciphertext, deadline_at, lease_until)
       SELECT gen_random_uuid(), $1, $2, 'running', 'x', 'x', now() + interval '1 day', now() + interval '1 hour' FROM generate_series(1, 2)`,
      [bob.tenantId, bob.userId],
    );
    await makeDue(bob);
    await tickAndSettle();
    const [{ next_run_at: next }] = (await owner.query("SELECT next_run_at FROM agent_triggers WHERE id = $1", [trigger.id])).rows;
    expect(new Date(next).getTime()).toBeLessThan(Date.now() + 10 * 60 * 1000);
    await owner.query("UPDATE agent_runs SET status = 'cancelled' WHERE user_id = $1", [bob.userId]);
  });
});

describe("a Jira assignment", () => {
  const issue = (key: string): AssignedIssue => ({ key, siteId: "site-1" });

  it("ignores what is already assigned, then starts one run for each new issue", async () => {
    assigned = [issue("ENG-1"), issue("ENG-2")];
    await triggers.create(bob, { kind: "jira_assigned", goal: "Summarise it" });
    await tickAndSettle();
    expect(await runsOf(bob)).toEqual([]);

    assigned = [issue("ENG-3"), issue("ENG-1"), issue("ENG-2")];
    await makeDue(bob);
    await tickAndSettle();
    const runs = await runsOf(bob);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.goal).toContain("Summarise it");
    expect(runs[0]!.goal).toContain("ENG-3");

    await makeDue(bob);
    await tickAndSettle();
    expect(await runsOf(bob)).toHaveLength(1);
    const { items } = await triggers.notifications(bob);
    expect(items[0]!.kind).toBe("run_finished");
  });

  it("starts only a few runs from one check, and leaves the rest for later checks", async () => {
    await triggers.create(bob, { kind: "jira_assigned", goal: "Burst" });
    await tickAndSettle();
    assigned = ["A-1", "A-2", "A-3", "A-4", "A-5"].map(issue);
    await makeDue(bob);
    await triggers.tick();
    await agents.settled();
    // Two run at once, so the third start is told to wait and that issue is kept for later.
    const first = (await runsOf(bob)).length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(3);
    for (let i = 0; i < 4; i += 1) {
      await makeDue(bob);
      await tickAndSettle();
    }
    expect(await runsOf(bob)).toHaveLength(5);
  });

  it("allows one Jira trigger per person, so one assignment cannot start several runs", async () => {
    await triggers.create(bob, { kind: "jira_assigned", goal: "First" });
    await expect(triggers.create(bob, { kind: "jira_assigned", goal: "Second" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("always leaves the person a working slot of their own", async () => {
    await triggers.create(bob, { kind: "jira_assigned", goal: "Busy" });
    await tickAndSettle();
    // Never finishes, so the automatic run keeps its slot.
    agentTurn.mockImplementation(() => new Promise(() => {}));
    assigned = ["B-1", "B-2", "B-3"].map(issue);
    await makeDue(bob);
    await triggers.tick();
    expect((await runsOf(bob)).filter((run) => run.status === "running")).toHaveLength(1);
    const mine = await agents.start(bob, "My own task");
    expect(mine.status).toBe("running");
    await owner.query("UPDATE agent_runs SET status = 'cancelled' WHERE user_id = $1", [bob.userId]);
  });

  it("keeps an issue for later when its run could not start, whatever the reason", async () => {
    await triggers.create(bob, { kind: "jira_assigned", goal: "Retry me" });
    await tickAndSettle();
    assigned = [issue("ENG-20")];
    const start = vi.spyOn(agents, "start").mockRejectedValueOnce(new Error("database went away"));
    await makeDue(bob);
    await tickAndSettle();
    expect(await runsOf(bob)).toEqual([]);
    start.mockRestore();
    await makeDue(bob);
    await tickAndSettle();
    expect(await runsOf(bob)).toHaveLength(1);
  });

  it("does not wait forever on a service that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      await triggers.create(bob, { kind: "jira_assigned", goal: "Slow" });
      const hang = vi.fn(() => new Promise<AssignedIssue[]>(() => {}));
      const slow = new TriggersService({
        pool,
        box,
        agents,
        logger: { error: () => {} },
        assignments: { list: hang },
      });
      const tick = slow.tick();
      await vi.waitFor(() => expect(hang).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(31_000);
      await tick;
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses and says so when the connection needs renewing", async () => {
    const trigger = await triggers.create(bob, { kind: "jira_assigned", goal: "Needs Jira" });
    assigned = new AppError("RECONNECT_REQUIRED", "Reconnect");
    await tickAndSettle();
    expect((await triggers.list(bob))[0]).toMatchObject({ id: trigger.id, enabled: false, pausedReason: "reconnect_jira" });
    expect((await triggers.notifications(bob)).items[0]!.kind).toBe("trigger_paused");
    await makeDue(bob);
    await tickAndSettle();
    expect(await runsOf(bob)).toEqual([]);
  });

  it("pauses, saying why, when the company turns the service off", async () => {
    await triggers.create(bob, { kind: "jira_assigned", goal: "Turned off" });
    assigned = new AppError("FORBIDDEN", "Turned off", { reason: "service_turned_off" });
    await tickAndSettle();
    expect((await triggers.list(bob))[0]).toMatchObject({ enabled: false, pausedReason: "service_turned_off" });
  });

  it("tries again next time on a passing failure, without losing any issue", async () => {
    await triggers.create(bob, { kind: "jira_assigned", goal: "Flaky" });
    await tickAndSettle();
    assigned = new AppError("UNAVAILABLE", "Down");
    await makeDue(bob);
    await tickAndSettle();
    expect((await triggers.list(bob))[0]!.enabled).toBe(true);
    assigned = [issue("ENG-9")];
    await makeDue(bob);
    await tickAndSettle();
    expect(await runsOf(bob)).toHaveLength(1);
  });
});

describe("work nobody is watching", () => {
  it("picks up a run whose server stopped, without anyone opening it", async () => {
    const { id } = await agents.start(bob, "Left behind");
    await agents.settled();
    await owner.query("UPDATE agent_runs SET status = 'running', lease_until = now() - interval '1 minute' WHERE id = $1", [id]);
    const fresh = build();
    await fresh.scheduler.tick();
    await fresh.service.settled();
    expect((await fresh.service.get(bob, id)).status).toBe("completed");
  });

  it("continues a run once its proposal is decided, without anyone opening it", async () => {
    agentTurn.mockReset();
    agentTurn.mockImplementationOnce(async (_input, _signal, onUsage) => {
      onUsage(usage);
      const toolCall = {
        id: "call-1",
        name: "propose_jira_comment",
        input: { siteId: "s", issueKey: "ENG-1", body: "Hello" },
      };
      return { content: [{ type: "tool_use", ...toolCall }], text: "", toolCall, stopReason: "tool_use" };
    });
    agentTurn.mockImplementationOnce(async (_input, _signal, onUsage) => {
      onUsage(usage);
      return say("You rejected it.");
    });
    const { id } = await agents.start(bob, "Comment on it");
    await agents.settled();
    const waitingRow = (await owner.query("SELECT waiting_proposal_id FROM agent_runs WHERE id = $1", [id])).rows[0];
    const proposalId = waitingRow.waiting_proposal_id as string;
    expect((await triggers.notifications(bob)).items[0]).toMatchObject({ kind: "run_needs_decision", runId: id });

    // The sweep looks at the real proposals table, so it needs a real row showing a decision.
    await owner.query(
      `INSERT INTO write_proposals (id, tenant_id, user_id, server_id, action, tool_name, tool_class, args, args_hash, site_origin, status, expires_at)
       VALUES ($1, $2, $3, 'leaktest', 'add_comment', 't', 'write', '{}', 'h', 'https://x.example', 'rejected', now() + interval '1 hour')`,
      [proposalId, bob.tenantId, bob.userId],
    );
    decision = "rejected";
    await tickAndSettle();
    const rows = await owner.query("SELECT status FROM agent_runs WHERE id = $1", [id]);
    expect(rows.rows[0].status).toBe("completed");
    await owner.query("DELETE FROM write_proposals WHERE id = $1", [proposalId]);
  });

  it("marks a notification read when its run is opened", async () => {
    const trigger = await triggers.create(bob, { kind: "schedule", goal: "Tell me", schedule: "hourly" });
    await makeDue(bob);
    await tickAndSettle();
    const { items } = await triggers.notifications(bob);
    expect(items).toHaveLength(1);
    await agents.get(bob, items[0]!.runId!);
    await agents.settled();
    expect((await triggers.notifications(bob)).unread).toBe(0);
    await triggers.remove(bob, trigger.id);
  });

  it("keeps one person's failure from stopping another's work", async () => {
    await triggers.create(bob, { kind: "jira_assigned", goal: "Breaks" });
    await triggers.create(alice, { kind: "schedule", goal: "Still runs", schedule: "hourly" });
    await makeDue(alice);
    assigned = new Error("connection text with secret");
    await tickAndSettle();
    expect(await runsOf(alice)).toHaveLength(1);
  });
});

describe("privacy", () => {
  it("hides triggers and notifications from colleagues and other companies", async () => {
    const trigger = await triggers.create(bob, { kind: "schedule", goal: "Private goal", schedule: "hourly" });
    await makeDue(bob);
    await tickAndSettle();
    for (const other of [alice, globex]) {
      expect(await triggers.list(other)).toEqual([]);
      expect((await triggers.notifications(other)).items).toEqual([]);
      await expect(triggers.remove(other, trigger.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("stores goals and titles encrypted", async () => {
    await triggers.create(bob, { kind: "schedule", goal: "zanzibar goal", schedule: "hourly" });
    await makeDue(bob);
    await tickAndSettle();
    const dump = await owner.query(
      "SELECT (SELECT json_agg(t) FROM agent_triggers t WHERE user_id = $1) AS t, (SELECT json_agg(n) FROM notifications n WHERE user_id = $1) AS n",
      [bob.userId],
    );
    expect(JSON.stringify(dump.rows)).not.toContain("zanzibar");
  });

  it("gives the scheduler identifiers only, and nothing else across people", async () => {
    await triggers.create(bob, { kind: "schedule", goal: "Secret", schedule: "hourly" });
    await makeDue(bob);
    const work = await findDueAgentWork(pool, 10);
    const mine = work.find((item) => item.userId === bob.userId);
    expect(Object.keys(mine!).sort()).toEqual(["id", "kind", "tenantId", "userId"]);

    const client = await pool.connect();
    try {
      // With no person set, the app still sees nothing directly, and cannot become the finder role.
      expect((await client.query("SELECT * FROM agent_triggers")).rows).toEqual([]);
      await expect(client.query("SET ROLE brain_work_finder")).rejects.toThrow(/permission denied/);
    } finally {
      client.release();
    }
  });

  it("keeps the finder role away from goals, state and results", async () => {
    await owner.query("BEGIN");
    try {
      await owner.query("SET LOCAL ROLE brain_work_finder");
      await expect(owner.query("SELECT goal_ciphertext FROM agent_triggers")).rejects.toThrow(/permission denied/);
    } finally {
      await owner.query("ROLLBACK");
    }
    await owner.query("BEGIN");
    try {
      await owner.query("SET LOCAL ROLE brain_work_finder");
      await expect(owner.query("SELECT state_ciphertext FROM agent_runs")).rejects.toThrow(/permission denied/);
    } finally {
      await owner.query("ROLLBACK");
    }
    await owner.query("BEGIN");
    try {
      await owner.query("SET LOCAL ROLE brain_work_finder");
      await expect(owner.query("SELECT args FROM write_proposals")).rejects.toThrow(/permission denied/);
    } finally {
      await owner.query("ROLLBACK");
    }
  });
});
