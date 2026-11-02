// An admin turns someone off, and everything that person had running or connected stops (FR-CON-02).
import { createSecretBox } from "@brain/core";
import {
  addNotification,
  applyMigrations,
  claimProposal,
  createAgentRun,
  createAppPool,
  createProposal,
  createTrigger,
  findDueAgentWork,
  isUserTurnedOffError,
  loadMigrations,
  MIGRATIONS_DIR,
  seed,
} from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { createRegistry } from "@brain/mcp-client";
import { simulateConsent, startMockMcpServer, type MockMcpServer } from "@brain/mcp-client/testing";
import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createJwtVerifier } from "../auth/jwt-verifier.js";
import { createDbUserDirectory } from "../auth/user-directory.js";
import { ConnectionsService } from "../connections/connections.service.js";
import { unusedAgents, unusedAudit, unusedConversations, unusedProposals } from "../test-support/fake-proposals.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { createPeopleService } from "./people.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain";
const SERVER = "atlassian";
const ACME = TENANTS.acme.id;
const BOB = seedUser("bob").id;
const bobScope = { tenantId: ACME, userId: BOB };

let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let mock: MockMcpServer;
let keys: TestKeys;
let connections: ConnectionsService;

type Person = "alice" | "bob" | "patAcme" | "patGlobex";
async function as(person: Person) {
  const seeded = seedUser(person);
  const token = await keys.sign({ tenant_id: TENANTS[seeded.tenant].id }, { subject: seeded.subject });
  return (method: "GET" | "POST", url: string, payload?: object) =>
    app.getHttpAdapter().getInstance().inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}

const everyoneActive = () => owner.query("UPDATE users SET deactivated_at = NULL WHERE tenant_id = ANY($1)", [[ACME, TENANTS.globex.id]]);
const cleanBob = async () => {
  await owner.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)", [ACME, BOB]);
  for (const table of ["write_proposals", "agent_runs", "agent_triggers", "mcp_connections"]) {
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND user_id = $2`, [ACME, BOB]);
  }
};

const newProposal = () => ({
  id: randomUUID(),
  serverId: SERVER,
  action: "add_comment",
  toolName: "addCommentToJiraIssue",
  toolClass: "write" as const,
  args: { issueKey: "KAN-1", body: "hi" },
  argsHash: "h",
  siteOrigin: "https://acme.atlassian.net",
  expiresAt: new Date(Date.now() + 60_000),
});
const newRun = () => ({ id: randomUUID(), goalCiphertext: "g", stateCiphertext: "s", deadlineAt: new Date(Date.now() + 60_000) });
const RUN_LIMITS = { maxWorking: 5, maxRecent: 50, recentSince: new Date(0) };
const newTrigger = () => ({ id: randomUUID(), kind: "schedule" as const, goalCiphertext: "g", intervalMinutes: 60, firstRunInMinutes: 60 });

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  await everyoneActive();
  await cleanBob();
  await owner.query("DELETE FROM mcp_client_registrations WHERE server_id = $1", [SERVER]);

  mock = await startMockMcpServer({ id: SERVER, issuesByIdentity: { "bob-account": [] } });
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  keys = await createTestKeys();
  const logger = createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) });
  connections = new ConnectionsService({
    pool,
    box: createSecretBox(randomBytes(32).toString("base64")),
    registry: createRegistry([mock.definition]),
    adapters: new Map(),
    client: { redirectUrl: "http://127.0.0.1:3001/oauth/callback", clientName: "Nexus Brain (people test)" },
  });
  app = await createApp({
    logger,
    directory: createDbUserDirectory(pool),
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
    connections,
    people: createPeopleService({ pool, logger, connections }),
    proposals: unusedProposals,
    audit: unusedAudit,
    conversations: unusedConversations,
    agents: unusedAgents,
    answers: { answer: async () => {} },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await everyoneActive();
  await cleanBob();
  await owner?.query("DELETE FROM mcp_client_registrations WHERE server_id = $1", [SERVER]);
  await owner?.end();
  connections?.close();
  await app?.close();
  await pool?.end();
  await mock?.close();
});

describe("who may manage people", () => {
  it("lets only an admin see the company's people, and never another company's", async () => {
    expect((await (await as("bob"))("GET", "/admin/people")).statusCode).toBe(403);
    const listed = (await (await as("patAcme"))("GET", "/admin/people")).json().data as Array<{ id: string; active: boolean }>;
    expect(listed.map((p) => p.id)).toContain(BOB);
    expect(listed.map((p) => p.id)).not.toContain(seedUser("gus").id);
    expect(listed.every((p) => p.active)).toBe(true);
  });

  it("refuses members, acting on yourself, an admin acting on an owner, and other companies", async () => {
    expect((await (await as("bob"))("POST", `/admin/people/${seedUser("alice").id}/deactivate`)).statusCode).toBe(403);
    const pat = await as("patAcme");
    expect((await pat("POST", `/admin/people/${seedUser("patAcme").id}/deactivate`)).statusCode).toBe(400);
    expect((await pat("POST", `/admin/people/${seedUser("alice").id}/deactivate`)).statusCode).toBe(403);
    expect((await pat("POST", "/admin/people/not-a-uuid/deactivate")).statusCode).toBe(400);
    expect((await (await as("patGlobex"))("POST", `/admin/people/${BOB}/deactivate`)).statusCode).toBe(404);
    const { rows } = await owner.query("SELECT count(*)::int AS n FROM users WHERE deactivated_at IS NOT NULL");
    expect(rows[0].n).toBe(0);
  });
});

describe("turning someone off", () => {
  it("stops sign-in, automatic agents, running agents, waiting changes and connections in one step", async () => {
    const bob = await as("bob");
    mock.setNextIdentity("bob-account");
    const consent = await simulateConsent((await bob("POST", `/connections/${SERVER}/authorize`)).json().data.authorizationUrl);
    expect((await bob("POST", "/connections/complete", consent)).statusCode).toBe(200);
    await createTrigger(pool, bobScope, newTrigger(), 5);
    const run = newRun();
    await createAgentRun(pool, bobScope, run, RUN_LIMITS);
    const proposal = newProposal();
    await createProposal(pool, bobScope, proposal);
    const revocationsBefore = mock.stats.revocations;

    const response = await (await as("patAcme"))("POST", `/admin/people/${BOB}/deactivate`);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      changed: true,
      connectionsRemoved: 1,
      connectionsRevoked: 1,
      triggersPaused: 1,
      runsCancelled: 1,
      proposalsRejected: 1,
      changesInProgress: 0,
    });
    expect(mock.stats.revocations).toBeGreaterThan(revocationsBefore);

    expect((await bob("GET", "/connections")).statusCode).toBe(403);
    await owner.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)", [ACME, BOB]);
    const state = await owner.query(
      `SELECT (SELECT status FROM agent_runs WHERE id = $1) AS run,
              (SELECT status FROM write_proposals WHERE id = $2) AS proposal,
              (SELECT count(*)::int FROM agent_triggers WHERE user_id = $3 AND enabled) AS triggers,
              (SELECT count(*)::int FROM mcp_connections WHERE user_id = $3) AS connections`,
      [run.id, proposal.id, BOB],
    );
    expect(state.rows[0]).toEqual({ run: "cancelled", proposal: "rejected", triggers: 0, connections: 0 });
    const audit = await owner.query("SELECT user_id, meta FROM audit_log WHERE action = 'user.deactivated' AND resource = $1 ORDER BY id DESC LIMIT 1", [BOB]);
    expect(audit.rows[0]).toMatchObject({ user_id: seedUser("patAcme").id, meta: { connectionsRemoved: 1, runsCancelled: 1 } });
  });

  it("creates nothing new for them, even from work that was already running", async () => {
    for (const attempt of [
      () => createProposal(pool, bobScope, newProposal()),
      () => createAgentRun(pool, bobScope, newRun(), RUN_LIMITS),
      () => createTrigger(pool, bobScope, newTrigger(), 5),
    ]) {
      const err = await attempt().then(() => null, (e: unknown) => e);
      expect(isUserTurnedOffError(err)).toBe(true);
    }
  });

  it("refuses an approval that arrives after they were turned off", async () => {
    await everyoneActive();
    const proposal = newProposal();
    await createProposal(pool, bobScope, proposal);
    await owner.query("UPDATE users SET deactivated_at = now() WHERE id = $1", [BOB]);
    const err = await claimProposal(pool, bobScope, proposal.id, proposal.argsHash, 10).then(() => null, (e: unknown) => e);
    expect(isUserTurnedOffError(err)).toBe(true);
    const notification = await addNotification(pool, bobScope, { id: randomUUID(), kind: "run_finished", dedupeKey: randomUUID(), titleCiphertext: "t" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUserTurnedOffError(notification)).toBe(true);
  });

  it("never schedules their work, even if a trigger is switched back on behind the app's back", async () => {
    await owner.query("UPDATE agent_triggers SET enabled = true, next_run_at = now() - interval '1 minute' WHERE user_id = $1", [BOB]);
    const due = await findDueAgentWork(pool, 100);
    expect(due.some((w) => w.userId === BOB)).toBe(false);
    await owner.query("UPDATE agent_triggers SET enabled = false WHERE user_id = $1", [BOB]);
  });

  it("does nothing twice", async () => {
    const again = await (await as("patAcme"))("POST", `/admin/people/${BOB}/deactivate`);
    expect(again.json().data).toMatchObject({ changed: false, connectionsRemoved: 0 });
  });

  it("lets them sign in again once turned back on, with schedules left paused and connections to redo", async () => {
    const pat = await as("patAcme");
    expect((await pat("POST", `/admin/people/${BOB}/reactivate`)).json().data).toEqual({ changed: true });
    const bob = await as("bob");
    const listed = (await bob("GET", "/connections")).json().data as Array<{ serverId: string; status: string }>;
    expect(listed.find((c) => c.serverId === SERVER)!.status).toBe("not_connected");
    await owner.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)", [ACME, BOB]);
    const paused = await owner.query("SELECT paused_reason FROM agent_triggers WHERE user_id = $1", [BOB]);
    expect(paused.rows.map((r) => r.paused_reason)).toEqual(["owner_turned_off"]);
    expect((await pat("POST", `/admin/people/${BOB}/reactivate`)).json().data).toEqual({ changed: false });
  });

  it("stops a turned-off admin from managing people at once", async () => {
    const alice = await as("alice");
    expect((await alice("POST", `/admin/people/${seedUser("patAcme").id}/deactivate`)).statusCode).toBe(200);
    expect((await (await as("patAcme"))("POST", `/admin/people/${BOB}/deactivate`)).statusCode).toBe(403);
    expect((await alice("POST", `/admin/people/${seedUser("patAcme").id}/reactivate`)).statusCode).toBe(200);
  });
});
