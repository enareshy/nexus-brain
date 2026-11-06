// Approval flow: API -> Postgres RLS -> OAuth + MCP against a local mock server (FR-WR-01..05).
import { createSecretBox } from "@brain/core";
import { mockSearch, type WriteAdapter } from "@brain/connectors";
import { applyMigrations, createAppPool, loadMigrations, MIGRATIONS_DIR, seed } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { createRegistry } from "@brain/mcp-client";
import { simulateConsent, startMockMcpServer, type MockMcpServer } from "@brain/mcp-client/testing";
import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createJwtVerifier } from "../auth/jwt-verifier.js";
import { createDbUserDirectory } from "../auth/user-directory.js";
import { ConnectionsService } from "../connections/connections.service.js";
import { unusedAgents, unusedAudit, unusedConversations } from "../test-support/fake-proposals.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { ProposalsService } from "./proposals.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const ACME = TENANTS.acme.id;
const SERVER = "mockwrites";
const ORIGIN = "https://acme.atlassian.net";

/** Calls create_issue, or for FR-WR-03 tests the tool named by a special project key. */
const TOOL_BY_PROJECT: Readonly<Record<string, string>> = { DEL: "delete_issue", GONE: "removed_tool" };
const mockWrites: WriteAdapter = {
  serverId: SERVER,
  manifest: { create_issue: "write", edit_issue: "write", delete_issue: "write", removed_tool: "write" },
  targets: async () => [{ siteId: "site", siteOrigin: ORIGIN, projects: [] }],
  draft: async (_session, request) => {
    if (request.action === "update_issue") {
      const fields = { ...(request.summary ? { summary: request.summary } : {}) };
      return { action: request.action, toolName: "edit_issue", args: { key: request.issueKey, fields }, siteOrigin: ORIGIN };
    }
    return {
      action: request.action,
      toolName: (request.action === "create_issue" && TOOL_BY_PROJECT[request.projectKey]) || "create_issue",
      args: { summary: request.action === "create_issue" ? request.summary : "other" },
      siteOrigin: ORIGIN,
    };
  },
  outcome: (draft, text) => {
    const key = (JSON.parse(text) as { key: string }).key;
    return { externalId: key, url: `${draft.siteOrigin}/browse/${key}` };
  },
  // Like the Jira adapter: only edits can be undone, by setting the same fields back.
  readState: async (session, draft) => {
    if (draft.toolName !== "edit_issue") return null;
    const fields = Object.keys(draft.args.fields as object);
    const result = await session.callTool("get_issue", { key: draft.args.key, fields });
    if (result.isError) throw new Error("could not read the issue");
    return (JSON.parse(result.text) as { fields: Record<string, unknown> }).fields;
  },
  undoDraft: (draft, before) => ({
    action: "undo_update",
    toolName: "edit_issue",
    args: { key: draft.args.key, fields: before },
    siteOrigin: ORIGIN,
  }),
};

let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let mock: MockMcpServer;
let keys: TestKeys;

interface InjectResult {
  readonly statusCode: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions over JSON
  json(): any;
}
type Caller = (method: "GET" | "POST", url: string, body?: object) => Promise<InjectResult>;

async function as(user: "patAcme" | "bob"): Promise<Caller> {
  const token = await keys.sign({ tenant_id: ACME }, { subject: seedUser(user).subject });
  return ((method, url, body) =>
    app.getHttpAdapter().getInstance().inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    })) as Caller;
}

const createRequest = (summary: string) => ({
  serverId: SERVER,
  request: { action: "create_issue", siteId: "site", projectKey: "ENG", issueType: "Task", summary },
});

async function propose(caller: Caller, summary: string) {
  const res = await caller("POST", "/proposals", createRequest(summary));
  expect(res.statusCode).toBe(201);
  return res.json().data as { id: string; argsHash: string; status: string };
}

const createdCount = () => mock.createdIssues.length;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  for (const table of ["write_proposals", "mcp_connections", "oauth_states", "mcp_client_registrations"]) {
    await owner.query(`DELETE FROM ${table} WHERE server_id = $1`, [SERVER]);
  }

  mock = await startMockMcpServer({ id: SERVER, issuesByIdentity: { "pat-jira": [] } });
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  keys = await createTestKeys();
  const logger = createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) });
  const connections = new ConnectionsService({
    pool,
    box: createSecretBox(randomBytes(32).toString("base64")),
    registry: createRegistry([mock.definition]),
    adapters: new Map([[SERVER, { ...mockSearch, serverId: SERVER }]]),
    client: { redirectUrl: "http://127.0.0.1:3001/oauth/callback", clientName: "Nexus Brain (int test)" },
  });
  app = await createApp({
    logger,
    directory: createDbUserDirectory(pool),
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
    answers: { answer: async () => {} },
    connections,
    audit: unusedAudit,
    conversations: unusedConversations,
    agents: unusedAgents,
    proposals: new ProposalsService({ pool, logger, sessions: connections, adapters: new Map([[SERVER, mockWrites]]) }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const pat = await as("patAcme");
  mock.setNextIdentity("pat-jira");
  const started = await pat("POST", `/connections/${SERVER}/authorize`);
  const consent = await simulateConsent(started.json().data.authorizationUrl);
  expect((await pat("POST", "/connections/complete", consent)).statusCode).toBe(200);
});

beforeEach(async () => {
  // A clean slate for the pending and per-minute caps.
  await owner.query("DELETE FROM write_proposals WHERE server_id = $1", [SERVER]);
});

afterAll(async () => {
  await owner?.query("DELETE FROM write_proposals WHERE server_id = $1", [SERVER]);
  await owner?.end();
  await app?.close();
  await pool?.end();
  await mock?.close();
});

describe("proposing and approving a change", () => {
  it("changes nothing until approved, then writes exactly once with the approved arguments", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const proposal = await propose(pat, "Fix login");
    expect(proposal.status).toBe("pending");
    expect(createdCount()).toBe(before);

    const approved = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data).toMatchObject({
      status: "succeeded",
      externalId: expect.stringMatching(/^NEW-/),
      url: expect.stringContaining(`${ORIGIN}/browse/NEW-`),
    });
    expect(mock.createdIssues.at(-1)).toEqual({ identity: "pat-jira", summary: "Fix login" });
    expect(createdCount()).toBe(before + 1);
  });

  it("records a subtask under an issue for approval, refusing any field beyond the subtask's own (FR-AST-06)", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const subtask = { action: "create_subtask", siteId: "site", parentKey: "ENG-1", summary: "Write the fix" };
    const res = await pat("POST", "/proposals", { serverId: SERVER, request: subtask });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ action: "create_subtask", status: "pending" });
    for (const extra of [{ parent: "OTHER-9" }, { issueType: "Bug" }, { projectKey: "OPS" }]) {
      expect((await pat("POST", "/proposals", { serverId: SERVER, request: { ...subtask, ...extra } })).statusCode).toBe(400);
    }
    expect(createdCount()).toBe(before);
  });

  it("does not write twice when an approval is replayed, in sequence or at the same time", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const proposal = await propose(pat, "Replay");
    const body = { argsHash: proposal.argsHash };
    const results = await Promise.all([
      pat("POST", `/proposals/${proposal.id}/approve`, body),
      pat("POST", `/proposals/${proposal.id}/approve`, body),
      pat("POST", `/proposals/${proposal.id}/approve`, body),
    ]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const again = await pat("POST", `/proposals/${proposal.id}/approve`, body);
    expect(again.json().data.status).toBe("succeeded");
    expect(createdCount()).toBe(before + 1);
  });

  it("refuses an approval for different arguments", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const proposal = await propose(pat, "Bound");
    const res = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: "0".repeat(64) });
    expect(res.statusCode).toBe(400);
    expect(createdCount()).toBe(before);
  });

  it("detects arguments changed in the database after they were shown", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const proposal = await propose(pat, "Tampered");
    await owner.query(`UPDATE write_proposals SET args = '{"summary":"evil"}' WHERE id = $1`, [proposal.id]);
    const res = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(res.statusCode).toBe(400);
    expect(createdCount()).toBe(before);
  });

  it("refuses an expired change", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const proposal = await propose(pat, "Late");
    await owner.query("UPDATE write_proposals SET expires_at = now() - interval '1 second' WHERE id = $1", [proposal.id]);
    const res = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(res.statusCode).toBe(400);
    expect((await pat("GET", "/proposals")).json().data[0].status).toBe("expired");
    expect(createdCount()).toBe(before);
  });

  it("never runs a rejected change, and a colleague cannot see or act on one", async () => {
    const pat = await as("patAcme");
    const bob = await as("bob");
    const before = createdCount();
    const proposal = await propose(pat, "Private");

    expect((await bob("GET", "/proposals")).json().data).toEqual([]);
    const body = { argsHash: proposal.argsHash };
    expect((await bob("POST", `/proposals/${proposal.id}/approve`, body)).statusCode).toBe(404);
    expect((await bob("POST", `/proposals/${proposal.id}/reject`)).statusCode).toBe(404);

    expect((await pat("POST", `/proposals/${proposal.id}/reject`)).json().data.status).toBe("rejected");
    expect((await pat("POST", `/proposals/${proposal.id}/approve`, body)).json().data.status).toBe("rejected");
    expect(createdCount()).toBe(before);
  });

  it("does not let a request choose a tool or add arguments", async () => {
    const pat = await as("patAcme");
    const hostile = createRequest("x");
    const res = await pat("POST", "/proposals", {
      ...hostile,
      request: { ...hostile.request, toolName: "delete_everything" },
    });
    expect(res.statusCode).toBe(400);
    const unknownAction = await pat("POST", "/proposals", {
      serverId: SERVER,
      request: { action: "delete_issue", siteId: "site", issueKey: "A-1" },
    });
    expect(unknownAction.statusCode).toBe(400);
  });

  it("returns 404 for an unknown change and rejects a bad id", async () => {
    const pat = await as("patAcme");
    const body = { argsHash: "0".repeat(64) };
    expect((await pat("POST", `/proposals/${randomUUID()}/approve`, body)).statusCode).toBe(404);
    expect((await pat("POST", "/proposals/not-a-uuid/approve", body)).statusCode).toBe(400);
  });
});

describe("failures", () => {
  it("reports an unknown outcome and never retries when the call fails after being sent", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const proposal = await propose(pat, "Ambiguous");
    // Fails while the tool call is in flight: initialize, listTools and the notification go first.
    mock.failMcpRequestMatching("create_issue");
    const res = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "unknown", errorCode: "outcome_unknown" });
    const replay = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(replay.json().data.status).toBe("unknown");
    expect(createdCount()).toBe(before);
  });

  it("keeps the approval open when the failure happens before the call is sent", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const proposal = await propose(pat, "Retry safe");
    mock.failNextMcpRequest();
    const failed = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(createdCount()).toBe(before);

    const retried = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(retried.json().data.status).toBe("succeeded");
    expect(createdCount()).toBe(before + 1);
  });

  it.each(["DEL", "GONE"])("never calls a tool that is destructive or no longer listed (%s)", async (projectKey) => {
    const pat = await as("patAcme");
    const before = createdCount();
    const base = createRequest("Never");
    const res = await pat("POST", "/proposals", { ...base, request: { ...base.request, projectKey } });
    const proposal = res.json().data as { id: string; argsHash: string };
    const approved = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(approved.json().data).toMatchObject({ status: "failed", errorCode: "tool_not_allowed" });
    expect(createdCount()).toBe(before);
  });

  it("caps pending changes and approvals per user", async () => {
    const pat = await as("patAcme");
    const pending = [];
    for (let i = 0; i < 20; i += 1) pending.push(await propose(pat, `Cap ${i}`));
    expect((await pat("POST", "/proposals", createRequest("One too many"))).statusCode).toBe(429);

    const before = createdCount();
    const results = [];
    for (const p of pending.slice(0, 11)) {
      results.push(await pat("POST", `/proposals/${p.id}/approve`, { argsHash: p.argsHash }));
    }
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(10);
    expect(results.at(-1)?.statusCode).toBe(429);
    expect(createdCount()).toBe(before + 10);
  });

  it("holds the cap when approvals arrive at the same time", async () => {
    const pat = await as("patAcme");
    const pending = [];
    for (let i = 0; i < 15; i += 1) pending.push(await propose(pat, `Parallel ${i}`));
    const before = createdCount();
    const results = await Promise.all(
      pending.map((p) => pat("POST", `/proposals/${p.id}/approve`, { argsHash: p.argsHash })),
    );
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(5);
    expect(createdCount()).toBe(before + 10);
  });

  it("does not send a change if the approval cannot be audited, and leaves it open", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const proposal = await propose(pat, "Audit first");
    await owner.query("ALTER TABLE audit_log ADD CONSTRAINT test_block CHECK (action <> 'write.approved') NOT VALID");
    try {
      const res = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
      expect(res.statusCode).toBe(503);
      expect(createdCount()).toBe(before);
    } finally {
      await owner.query("ALTER TABLE audit_log DROP CONSTRAINT test_block");
    }
    const retried = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(retried.json().data.status).toBe("succeeded");
    expect(createdCount()).toBe(before + 1);
  });

  it("marks a change stuck mid-write as unknown, audits it, and never reopens it", async () => {
    const pat = await as("patAcme");
    const before = createdCount();
    const proposal = await propose(pat, "Crashed");
    await owner.query(
      "UPDATE write_proposals SET status = 'executing', decided_at = now() - interval '6 minutes' WHERE id = $1",
      [proposal.id],
    );
    const listed = (await pat("GET", "/proposals")).json().data as Array<{ id: string; status: string }>;
    expect(listed.find((p) => p.id === proposal.id)?.status).toBe("unknown");
    const { rows } = await owner.query("SELECT status FROM write_proposals WHERE id = $1", [proposal.id]);
    expect(rows[0].status).toBe("unknown");
    const audit = await owner.query(
      "SELECT 1 FROM audit_log WHERE action = 'write.unknown' AND meta->>'proposalId' = $1",
      [proposal.id],
    );
    expect(audit.rowCount).toBe(1);
    const replay = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(replay.json().data.status).toBe("unknown");
    expect(createdCount()).toBe(before);
  });

  it("writes an audit row for each step without the change's content", async () => {
    const pat = await as("patAcme");
    const proposal = await propose(pat, "Secret summary text");
    await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    const { rows } = await owner.query(
      "SELECT action, meta FROM audit_log WHERE meta->>'proposalId' = $1 ORDER BY id",
      [proposal.id],
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual(["write.proposed", "write.approved", "write.succeeded"]);
    expect(JSON.stringify(rows)).not.toContain("Secret summary text");
    expect(rows[0].meta.argsHash).toBe(proposal.argsHash);
  });
});

describe("undo (FR-WR-06)", () => {
  const KEY = "UNDO-1";
  const editRequest = (summary: string) => ({
    serverId: SERVER,
    request: { action: "update_issue", siteId: "site", issueKey: KEY, summary },
  });

  async function edit(caller: Caller, summary: string) {
    const res = await caller("POST", "/proposals", editRequest(summary));
    expect(res.statusCode).toBe(201);
    const proposal = res.json().data as { id: string; argsHash: string };
    const approved = await caller("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(approved.json().data.status).toBe("succeeded");
    return approved.json().data as { id: string; canUndo: boolean };
  }

  async function approve(caller: Caller, proposal: { id: string; argsHash: string }) {
    return (await caller("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash })).json().data;
  }

  beforeEach(() => {
    mock.editableIssues.set(KEY, { summary: "Original title", description: "Untouched" });
  });

  it("records what an edit replaced and puts it back only after the undo is approved", async () => {
    const pat = await as("patAcme");
    const done = await edit(pat, "New title");
    expect(done.canUndo).toBe(true);
    expect(mock.editableIssues.get(KEY)).toMatchObject({ summary: "New title" });
    const { rows } = await owner.query("SELECT before_state, after_state FROM write_proposals WHERE id = $1", [done.id]);
    expect(rows[0]).toEqual({ before_state: { summary: "Original title" }, after_state: { summary: "New title" } });

    const undo = await pat("POST", `/proposals/${done.id}/undo`);
    expect(undo.statusCode).toBe(201);
    const pending = undo.json().data;
    expect(pending).toMatchObject({ status: "pending", action: "undo_update", undoOf: done.id });
    expect(pending.args).toEqual({ key: KEY, fields: { summary: "Original title" } });
    expect(mock.editableIssues.get(KEY)).toMatchObject({ summary: "New title" });

    expect((await approve(pat, pending)).status).toBe("succeeded");
    expect(mock.editableIssues.get(KEY)).toEqual({ summary: "Original title", description: "Untouched" });
  });

  it("offers one undo at a time and none once it is undone", async () => {
    const pat = await as("patAcme");
    const done = await edit(pat, "Twice");
    const first = (await pat("POST", `/proposals/${done.id}/undo`)).json().data;
    const again = (await pat("POST", `/proposals/${done.id}/undo`)).json().data;
    expect(again.id).toBe(first.id);
    await approve(pat, first);
    expect((await pat("POST", `/proposals/${done.id}/undo`)).json().data.id).toBe(first.id);
    const rows = await owner.query("SELECT count(*)::int AS n FROM write_proposals WHERE undo_of = $1", [done.id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("allows a new undo after one was rejected", async () => {
    const pat = await as("patAcme");
    const done = await edit(pat, "Rejected undo");
    const first = (await pat("POST", `/proposals/${done.id}/undo`)).json().data;
    await pat("POST", `/proposals/${first.id}/reject`);
    const second = (await pat("POST", `/proposals/${done.id}/undo`)).json().data;
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
  });

  it("does not overwrite an edit someone made after Brain's change", async () => {
    const pat = await as("patAcme");
    const done = await edit(pat, "Brain's title");
    const pending = (await pat("POST", `/proposals/${done.id}/undo`)).json().data;
    mock.editableIssues.set(KEY, { summary: "A colleague's title", description: "Untouched" });
    const result = await approve(pat, pending);
    expect(result).toMatchObject({ status: "failed", errorCode: "changed_since" });
    expect(mock.editableIssues.get(KEY)).toMatchObject({ summary: "A colleague's title" });
  });

  it("refuses to undo what cannot be undone: a new issue, a pending change, or someone else's change", async () => {
    const pat = await as("patAcme");
    const bob = await as("bob");
    const created = await propose(pat, "New issue");
    expect((await pat("POST", `/proposals/${created.id}/undo`)).statusCode).toBe(400);
    const approved = await approve(pat, created);
    expect(approved.canUndo).toBe(false);
    expect((await pat("POST", `/proposals/${created.id}/undo`)).statusCode).toBe(400);

    const done = await edit(pat, "Mine");
    expect((await bob("POST", `/proposals/${done.id}/undo`)).statusCode).toBe(404);
    expect((await pat("POST", "/proposals/not-a-uuid/undo")).statusCode).toBe(400);
  });

  it("does not send an edit whose previous state could not be read, and leaves it open", async () => {
    const pat = await as("patAcme");
    mock.editableIssues.delete(KEY);
    const res = await pat("POST", "/proposals", editRequest("No issue"));
    const proposal = res.json().data;
    const failed = await pat("POST", `/proposals/${proposal.id}/approve`, { argsHash: proposal.argsHash });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect((await pat("GET", `/proposals/${proposal.id}`)).json().data.status).toBe("pending");
  });

  it("still reports a change as done when its result cannot be saved for undo", async () => {
    const pat = await as("patAcme");
    await owner.query("ALTER TABLE write_proposals ADD CONSTRAINT test_block_after CHECK (after_state IS NULL) NOT VALID");
    try {
      const done = await edit(pat, "Saved anyway");
      expect(done.canUndo).toBe(false);
      expect(mock.editableIssues.get(KEY)).toMatchObject({ summary: "Saved anyway" });
    } finally {
      await owner.query("ALTER TABLE write_proposals DROP CONSTRAINT test_block_after");
    }
  });

  it("cannot set the saved states or the undo link through the app role", async () => {
    const pat = await as("patAcme");
    const done = await edit(pat, "Locked");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
        ACME,
        seedUser("patAcme").id,
      ]);
      await expect(
        client.query("UPDATE write_proposals SET expected_state = '{}'::jsonb WHERE id = $1", [done.id]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
