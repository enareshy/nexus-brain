// Chat: API -> Postgres RLS and encrypted history, with a mock service and model (FR-AST-01..04).
import { createSecretBox } from "@brain/core";
import type { SearchAdapter } from "@brain/connectors";
import { applyMigrations, createAppPool, loadMigrations, MIGRATIONS_DIR, seed } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import type { AnswerOutcome, LlmGateway } from "@brain/llm-gateway";
import { createRegistry } from "@brain/mcp-client";
import { simulateConsent, startMockMcpServer, type MockMcpServer } from "@brain/mcp-client/testing";
import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryRewriter } from "../answers/query-rewriter.js";
import { AnswersService } from "../answers/answers.service.js";
import { createApp } from "../app.js";
import { createJwtVerifier } from "../auth/jwt-verifier.js";
import { createDbUserDirectory } from "../auth/user-directory.js";
import { ConnectionsService } from "../connections/connections.service.js";
import { unusedAgents, unusedAudit, unusedProposals } from "../test-support/fake-proposals.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { MemoryService } from "../memory/memory.service.js";
import { ConversationsService } from "./conversations.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain";
const SERVER = "mockchat";
const SECRET_QUESTION = "what is the zanzibar launch date";

let app: NestFastifyApplication;
let pool: pg.Pool;
let owner: pg.Client;
let mock: MockMcpServer;
let keys: TestKeys;
let connections: ConnectionsService;
let clock = 0;

const OUTCOME: AnswerOutcome = {
  model: "m",
  stopReason: "end_turn",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};
const streamAnswer = vi.fn<LlmGateway["streamAnswer"]>(async (_input, onEvent, _signal, onUsage) => {
  onEvent({ type: "text", text: "It launches " });
  onEvent({ type: "citation", documentIndex: 0, citedText: "launch" });
  onEvent({ type: "text", text: "in May." });
  onUsage({ ...OUTCOME, estimated: false });
  return OUTCOME;
});
const rewriteQuery = vi.fn<LlmGateway["rewriteQuery"]>(async () => []);

type Caller = (method: "GET" | "POST" | "DELETE", url: string, body?: object) => Promise<{
  statusCode: number;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions over JSON
  json(): any;
}>;

async function as(user: "bob" | "alice" | "patGlobex"): Promise<Caller> {
  const seeded = seedUser(user);
  const token = await keys.sign({ tenant_id: TENANTS[seeded.tenant].id }, { subject: seeded.subject });
  return ((method, url, body) =>
    app.getHttpAdapter().getInstance().inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    })) as Caller;
}

/** Matches on a keyword, like the real connectors. */
const keywordSearch: SearchAdapter = {
  serverId: SERVER,
  search: async (_session, query) =>
    /launch/i.test(query)
      ? [{ serverId: SERVER, externalId: "Z-1", title: "launch date", url: "https://acme.example/browse/Z-1", snippet: "launch in May", updatedAt: null }]
      : [],
  readDocuments: async (_session, hits) => new Map(hits.map((h) => [h.url, "launch in May"])),
};

/** Sends a question and returns the parsed stream events. */
async function ask(caller: Caller, q: string, conversationId?: string) {
  const res = await caller("POST", "/answers", { q, ...(conversationId ? { conversationId } : {}) });
  expect(res.statusCode).toBe(200);
  return res.body
    .split("\n\n")
    .flatMap((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : [];
    });
}
const eventOf = (events: Array<Record<string, unknown>>, type: string) => events.find((e) => e.type === type);

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  await owner.query("DELETE FROM mcp_connections WHERE server_id = $1", [SERVER]);
  await owner.query("DELETE FROM mcp_client_registrations WHERE server_id = $1", [SERVER]);

  mock = await startMockMcpServer({
    id: SERVER,
    issuesByIdentity: {
      "bob-account": [{ key: "Z-1", summary: "launch date", url: "https://acme.example/browse/Z-1", updated: "2026-10-30" }],
    },
  });
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  keys = await createTestKeys();
  const box = createSecretBox(randomBytes(32).toString("base64"));
  const logger = createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) });
  connections = new ConnectionsService({
    pool,
    box,
    registry: createRegistry([mock.definition]),
    adapters: new Map([[SERVER, keywordSearch]]),
    client: { redirectUrl: "http://127.0.0.1:3001/oauth/callback", clientName: "Nexus Brain (chat test)" },
  });
  const gateway: LlmGateway = { streamAnswer, rewriteQuery, agentTurn: vi.fn() };
  const conversations = new ConversationsService({ pool, box });
  const memory = new MemoryService({ pool, box, logger });
  app = await createApp({
    memory,
    logger,
    directory: createDbUserDirectory(pool),
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
    connections,
    proposals: unusedProposals,
    audit: unusedAudit,
    agents: unusedAgents,
    conversations,
    answers: new AnswersService({
      pool,
      box,
      logger,
      documents: connections,
      gateway,
      expander: new QueryRewriter({ pool, gateway, logger }),
      conversations,
      memories: memory,
      items: connections,
      // Each answer a minute apart, so these tests stay clear of the per-person answer limit.
      now: () => (clock += 61_000),
    }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const bob = await as("bob");
  mock.setNextIdentity("bob-account");
  const started = await bob("POST", `/connections/${SERVER}/authorize`);
  const consent = await simulateConsent(started.json().data.authorizationUrl);
  expect((await bob("POST", "/connections/complete", consent)).statusCode).toBe(200);
});

beforeEach(() => {
  streamAnswer.mockClear();
  rewriteQuery.mockReset();
  rewriteQuery.mockResolvedValue(["launch"]);
});

afterAll(async () => {
  await owner?.query("DELETE FROM mcp_connections WHERE server_id = $1", [SERVER]);
  await owner?.query("DELETE FROM conversations WHERE user_id = ANY($1)", [[seedUser("bob").id, seedUser("alice").id]]);
  await owner?.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)", [TENANTS.acme.id, seedUser("bob").id]);
  await owner?.query("DELETE FROM memories WHERE user_id = $1", [seedUser("bob").id]);
  await owner?.end();
  connections?.close();
  await app?.close();
  await pool?.end();
  await mock?.close();
});

describe("memory (FR-AST-07)", () => {
  const SECRET_MEMORY = "I lead the zanzibar launch";

  it("lets a person add, edit and delete what Brain remembers, and nobody else can see or change it", async () => {
    const bob = await as("bob");
    const added = (await bob("POST", "/memories", { text: `  ${SECRET_MEMORY}  ` })).json().data;
    expect(added).toMatchObject({ id: expect.any(String), text: SECRET_MEMORY });
    const edited = (await bob("POST", `/memories/${added.id}`, { text: "I lead the launch" })).json().data;
    expect(edited.text).toBe("I lead the launch");

    const alice = await as("alice");
    expect((await alice("GET", "/memories")).json().data).toEqual([]);
    expect((await alice("POST", `/memories/${added.id}`, { text: "x" })).statusCode).toBe(404);
    expect((await alice("DELETE", `/memories/${added.id}`)).statusCode).toBe(404);
    expect((await (await as("patGlobex"))("GET", "/memories")).json().data).toEqual([]);

    expect((await bob("DELETE", `/memories/${added.id}`)).statusCode).toBe(200);
    expect((await bob("GET", "/memories")).json().data).toEqual([]);
  });

  it("refuses empty, over-long or multi-line text", async () => {
    const bob = await as("bob");
    for (const text of ["   ", "x".repeat(301), "first line\nsecond line", "hidden ‮reversed", "zero​width"]) {
      expect((await bob("POST", "/memories", { text })).statusCode).toBe(400);
    }
    expect((await bob("POST", "/memories", { text: "ok", extra: true })).statusCode).toBe(400);
  });

  it("stores it sealed and records changes in the audit trail without the words", async () => {
    const bob = await as("bob");
    const added = (await bob("POST", "/memories", { text: SECRET_MEMORY })).json().data;
    await owner.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)", [TENANTS.acme.id, seedUser("bob").id]);
    const raw = await owner.query("SELECT text_ciphertext FROM memories WHERE id = $1", [added.id]);
    expect(raw.rows[0].text_ciphertext).not.toContain("zanzibar");
    const audit = await owner.query("SELECT action, meta::text AS meta FROM audit_log WHERE resource = $1", [added.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["memory.added"]);
    expect(JSON.stringify(audit.rows)).not.toContain("zanzibar");
    expect((await bob("DELETE", "/memories")).json().data).toEqual({ deleted: 1 });
  });

  it("keeps answering when one memory cannot be read, and lets the person delete it", async () => {
    const bob = await as("bob");
    await bob("POST", "/memories", { text: "Keep answers short" });
    const badId = randomUUID();
    await owner.query("SELECT set_config('app.tenant_id', $1, false), set_config('app.user_id', $2, false)", [TENANTS.acme.id, seedUser("bob").id]);
    await owner.query("INSERT INTO memories (id, tenant_id, user_id, text_ciphertext) VALUES ($1, $2, $3, 'damaged')", [badId, TENANTS.acme.id, seedUser("bob").id]);

    const listed = (await bob("GET", "/memories")).json().data as Array<{ id: string; readable: boolean }>;
    expect(listed.find((m) => m.id === badId)).toMatchObject({ readable: false, text: "" });
    await ask(bob, SECRET_QUESTION);
    expect(streamAnswer.mock.calls.at(-1)![0].memories).toEqual(["Keep answers short"]);
    expect((await bob("DELETE", `/memories/${badId}`)).statusCode).toBe(200);
    await bob("DELETE", "/memories");
  });

  it("is sent with the person's next answer, and a deleted memory is gone from the one after", async () => {
    const bob = await as("bob");
    const added = (await bob("POST", "/memories", { text: SECRET_MEMORY })).json().data;
    await ask(bob, SECRET_QUESTION);
    expect(streamAnswer.mock.calls.at(-1)![0].memories).toEqual([SECRET_MEMORY]);

    await bob("DELETE", `/memories/${added.id}`);
    await ask(bob, SECRET_QUESTION);
    expect(streamAnswer.mock.calls.at(-1)![0].memories).toBeUndefined();
  });
});

describe("summaries (FR-AST-06)", () => {
  const item = { serverId: SERVER, externalId: "Z-1", url: "https://acme.example/browse/Z-1", title: "launch date" };
  const summarise = async (caller: Caller, body: object = item) => {
    const res = await caller("POST", "/answers/summary", body);
    return { status: res.statusCode, events: res.body.split("\n\n").flatMap((b) => {
      const line = b.split("\n").find((l) => l.startsWith("data: "));
      return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : [];
    }) };
  };

  it("summarises one item read with the person's own access, citing it, and meters and audits it", async () => {
    const bob = await as("bob");
    const { events } = await summarise(bob);
    expect(eventOf(events, "sources")).toMatchObject({ hits: [{ externalId: "Z-1", title: "launch date" }] });
    expect(eventOf(events, "citation")).toMatchObject({ source: 1 });
    expect(eventOf(events, "done")).toMatchObject({ outcome: "answered", grounded: true, messageId: null });
    const input = streamAnswer.mock.calls.at(-1)![0];
    expect(input.question).toMatch(/^Summarise this/);
    expect(input.documents).toEqual([{ title: "launch date", text: "launch in May" }]);

    const ledger = await owner.query("SELECT count(*)::int AS n FROM usage_ledger WHERE feature = 'summary' AND user_id = $1", [seedUser("bob").id]);
    expect(ledger.rows[0].n).toBeGreaterThan(0);
    const audit = await owner.query("SELECT meta::text AS meta FROM audit_log WHERE action = 'summary' AND user_id = $1 ORDER BY id DESC LIMIT 1", [seedUser("bob").id]);
    expect(audit.rows[0].meta).toContain("Z-1");
    expect(audit.rows[0].meta).not.toContain("launch in May");
  });

  it("removes control characters from the title before the model sees it", async () => {
    const bob = await as("bob");
    await summarise(bob, { ...item, title: "launch\ndate‮" });
    expect(streamAnswer.mock.calls.at(-1)![0].documents[0]!.title).toBe("launch date");
  });

  it("is not saved to the person's chat history", async () => {
    const bob = await as("bob");
    const before = (await bob("GET", "/conversations")).json().data.length;
    await summarise(bob);
    expect((await bob("GET", "/conversations")).json().data.length).toBe(before);
  });

  it("reads nothing and calls no model for someone without access to the item", async () => {
    const alice = await as("alice");
    const { events } = await summarise(alice);
    expect(eventOf(events, "error")).toBeTruthy();
    expect(eventOf(events, "sources")).toBeUndefined();
    expect(streamAnswer).not.toHaveBeenCalled();
  });

  it("refuses links that are not https, unknown fields and missing titles", async () => {
    const bob = await as("bob");
    for (const body of [
      { ...item, url: "http://acme.example/x" },
      { ...item, extra: 1 },
      { ...item, title: " ‮ " },
      { ...item, serverId: "../x" },
      { ...item, siteId: "a/b?c" },
    ]) {
      expect((await bob("POST", "/answers/summary", body)).statusCode).toBe(400);
    }
    expect(streamAnswer).not.toHaveBeenCalled();
  });
});

describe("a conversation", () => {
  it("is created by the first question and keeps the question and answer with citations", async () => {
    const bob = await as("bob");
    const events = await ask(bob, SECRET_QUESTION);
    const conversationId = eventOf(events, "conversation")?.conversationId as string;
    expect(conversationId).toBeTruthy();
    expect(eventOf(events, "done")).toMatchObject({ outcome: "answered", messageId: expect.any(String) });

    const stored = (await bob("GET", `/conversations/${conversationId}`)).json().data;
    expect(stored.title).toBe(SECRET_QUESTION);
    expect(stored.messages[0]).toMatchObject({ role: "user", text: SECRET_QUESTION });
    expect(stored.messages[1].role).toBe("assistant");
    expect(stored.messages[1].answer.parts).toEqual([
      { kind: "text", text: "It launches " },
      { kind: "cite", source: 1 },
      { kind: "text", text: "in May." },
    ]);
    expect(stored.messages[1].answer.hits[0].externalId).toBe("Z-1");

    const listed = (await bob("GET", "/conversations")).json().data;
    expect(listed[0]).toMatchObject({ id: conversationId, title: SECRET_QUESTION });
  });

  it("gives a follow-up the earlier turns, and earlier questions only to the search step", async () => {
    const bob = await as("bob");
    const first = await ask(bob, "launch date please");
    const conversationId = eventOf(first, "conversation")?.conversationId as string;
    streamAnswer.mockClear();
    rewriteQuery.mockClear();

    const second = await ask(bob, "who approved it", conversationId);
    expect(eventOf(second, "conversation")?.conversationId).toBe(conversationId);
    const input = streamAnswer.mock.calls[0]![0];
    expect(input.question).toBe("who approved it");
    expect(input.history).toEqual([
      { role: "user", text: "launch date please" },
      { role: "assistant", text: "It launches in May." },
    ]);
    expect(rewriteQuery.mock.calls[0]![3]).toEqual(["launch date please"]);
    expect(JSON.stringify(rewriteQuery.mock.calls[0])).not.toContain("It launches");
  });

  it("stores text only as ciphertext, and records no text in the audit trail", async () => {
    const bob = await as("bob");
    await ask(bob, SECRET_QUESTION);
    const tables = await owner.query(
      `SELECT (SELECT json_agg(c) FROM conversations c) AS c, (SELECT json_agg(m) FROM conversation_messages m) AS m,
              (SELECT json_agg(a) FROM audit_log a WHERE a.action = 'answer') AS a`,
    );
    const dump = JSON.stringify(tables.rows);
    expect(dump).not.toContain("zanzibar");
    expect(dump).not.toContain("It launches");
  });

  it("saves a question even if the person leaves, and works when nothing is found", async () => {
    const bob = await as("bob");
    rewriteQuery.mockResolvedValue([]);
    const events = await ask(bob, "nothing here matches");
    expect(eventOf(events, "done")).toMatchObject({ outcome: "no_documents" });
    expect(streamAnswer).not.toHaveBeenCalled();
    const id = eventOf(events, "conversation")?.conversationId as string;
    const stored = (await bob("GET", `/conversations/${id}`)).json().data;
    expect(stored.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
  });

  it("marks an answer whose model call failed part-way as incomplete, and keeps what was said", async () => {
    const bob = await as("bob");
    streamAnswer.mockImplementationOnce(async (_i, onEvent) => {
      onEvent({ type: "text", text: "Partly" });
      throw new Error("stream broke");
    });
    const events = await ask(bob, "launch date broken");
    expect(eventOf(events, "error")).toBeTruthy();
    const id = eventOf(events, "conversation")?.conversationId as string;
    const stored = (await bob("GET", `/conversations/${id}`)).json().data;
    expect(stored.messages[1].answer).toMatchObject({ outcome: "incomplete", parts: [{ kind: "text", text: "Partly" }] });
  });
});

describe("privacy (FR-AST-03)", () => {
  it("hides a conversation from colleagues, including admins and other companies", async () => {
    const bob = await as("bob");
    const events = await ask(bob, SECRET_QUESTION);
    const id = eventOf(events, "conversation")?.conversationId as string;
    const messageId = eventOf(events, "done")?.messageId as string;

    for (const other of [await as("alice"), await as("patGlobex")]) {
      expect((await other("GET", `/conversations/${id}`)).statusCode).toBe(404);
      expect((await other("DELETE", `/conversations/${id}`)).statusCode).toBe(404);
      expect((await other("POST", `/conversations/${id}/messages/${messageId}/feedback`, { rating: "down" })).statusCode).toBe(404);
      const listed = (await other("GET", "/conversations")).json().data as Array<{ id: string }>;
      expect(listed.some((c) => c.id === id)).toBe(false);
    }
    // Adding to someone else's conversation is refused too, before anything is spent.
    streamAnswer.mockClear();
    const alice = await as("alice");
    const attempt = await ask(alice, "add to it", id);
    expect(eventOf(attempt, "error")).toMatchObject({ code: "NOT_FOUND" });
    expect(streamAnswer).not.toHaveBeenCalled();
    expect((await bob("GET", `/conversations/${id}`)).json().data.messages).toHaveLength(2);
  });

  it("refuses bad ids", async () => {
    const bob = await as("bob");
    expect((await bob("GET", "/conversations/not-a-uuid")).statusCode).toBe(400);
    expect((await bob("GET", `/conversations/${randomUUID()}`)).statusCode).toBe(404);
    expect((await bob("POST", "/answers", { q: "x", conversationId: "nope" })).statusCode).toBe(400);
  });

  it("deletes the conversation and everything in it for good", async () => {
    const bob = await as("bob");
    const events = await ask(bob, SECRET_QUESTION);
    const id = eventOf(events, "conversation")?.conversationId as string;
    const messageId = eventOf(events, "done")?.messageId as string;
    await bob("POST", `/conversations/${id}/messages/${messageId}/feedback`, { rating: "up" });

    expect((await bob("DELETE", `/conversations/${id}`)).statusCode).toBe(200);
    expect((await bob("GET", `/conversations/${id}`)).statusCode).toBe(404);
    const left = await owner.query(
      "SELECT (SELECT count(*) FROM conversation_messages WHERE conversation_id = $1) AS m, (SELECT count(*) FROM message_feedback WHERE message_id = $2) AS f",
      [id, messageId],
    );
    expect(left.rows[0]).toEqual({ m: "0", f: "0" });
  });
});

describe("storage limits", () => {
  it("refuses a full conversation before anything is spent", async () => {
    const bob = await as("bob");
    const events = await ask(bob, "launch limit test");
    const id = eventOf(events, "conversation")?.conversationId as string;
    await owner.query(
      `INSERT INTO conversation_messages (id, conversation_id, tenant_id, user_id, role, payload_ciphertext)
       SELECT gen_random_uuid(), $1, tenant_id, user_id, 'user', 'x' FROM conversations, generate_series(1, 400) WHERE id = $1`,
      [id],
    );
    streamAnswer.mockClear();
    expect(eventOf(await ask(bob, "one more", id), "error")).toMatchObject({ code: "VALIDATION" });
    expect(streamAnswer).not.toHaveBeenCalled();
    await owner.query("DELETE FROM conversations WHERE id = $1", [id]);
  });

  it("refuses a new conversation at the per-person limit", async () => {
    const alice = await as("alice");
    const user = seedUser("alice");
    await owner.query(
      `INSERT INTO conversations (id, tenant_id, user_id, title_ciphertext)
       SELECT gen_random_uuid(), $1, $2, 'x' FROM generate_series(1, 500)`,
      [TENANTS[user.tenant].id, user.id],
    );
    expect(eventOf(await ask(alice, "over the limit"), "error")).toMatchObject({ code: "VALIDATION" });
    await owner.query("DELETE FROM conversations WHERE user_id = $1", [user.id]);
  });
});

describe("feedback (FR-AST-04)", () => {
  it("stores a rating and a reason, and replaces them when changed", async () => {
    const bob = await as("bob");
    const events = await ask(bob, SECRET_QUESTION);
    const id = eventOf(events, "conversation")?.conversationId as string;
    const messageId = eventOf(events, "done")?.messageId as string;
    const url = `/conversations/${id}/messages/${messageId}/feedback`;

    expect((await bob("POST", url, { rating: "down", reason: "wrong date xyzzy" })).statusCode).toBe(200);
    expect((await bob("POST", url, { rating: "up" })).statusCode).toBe(200);
    const stored = (await bob("GET", `/conversations/${id}`)).json().data;
    expect(stored.messages[1].rating).toBe("up");

    await bob("POST", url, { rating: "down", reason: "wrong date xyzzy" });
    const rows = await owner.query("SELECT rating, reason_ciphertext FROM message_feedback WHERE message_id = $1", [messageId]);
    expect(rows.rows[0].rating).toBe("down");
    expect(JSON.stringify(rows.rows)).not.toContain("xyzzy");
  });

  it("only accepts feedback on an answer, with valid input", async () => {
    const bob = await as("bob");
    const events = await ask(bob, SECRET_QUESTION);
    const id = eventOf(events, "conversation")?.conversationId as string;
    const stored = (await bob("GET", `/conversations/${id}`)).json().data;
    const [question, reply] = stored.messages as Array<{ id: string }>;
    expect((await bob("POST", `/conversations/${id}/messages/${question!.id}/feedback`, { rating: "up" })).statusCode).toBe(404);
    expect((await bob("POST", `/conversations/${randomUUID()}/messages/${reply!.id}/feedback`, { rating: "up" })).statusCode).toBe(404);
    expect((await bob("POST", `/conversations/${id}/messages/${reply!.id}/feedback`, { rating: "meh" })).statusCode).toBe(400);
    expect(
      (await bob("POST", `/conversations/${id}/messages/${reply!.id}/feedback`, { rating: "up", reason: "x".repeat(501) })).statusCode,
    ).toBe(400);
  });
});
