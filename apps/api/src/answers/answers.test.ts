import type { RankedHit } from "@brain/connectors";
import { AppError } from "@brain/core";
import type { PoolLike } from "@brain/db";
import type { AnswerOutcome, LlmGateway } from "@brain/llm-gateway";
import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createJwtVerifier } from "../auth/jwt-verifier.js";
import type { GatheredDocuments } from "../connections/connections.service.js";
import { createFakeConnections } from "../test-support/fake-connections.js";
import { AUDIENCE, createTestKeys, ISSUER } from "../test-support/tokens.js";
import { AnswersService, type AnswersApi, type AnswerStreamEvent } from "./answers.service.js";

const scope = { tenantId: "0a000000-0000-4000-8000-000000000001", userId: "0a000000-0000-4000-8000-0000000000a4" };
const signal = new AbortController().signal;

const hit = (n: number, over: Partial<RankedHit> = {}): RankedHit => ({
  serverId: "atlassian",
  externalId: `confluence:${n}`,
  title: `Doc ${n}`,
  url: `https://acme.atlassian.net/wiki/p/${n}`,
  snippet: `snippet ${n}`,
  updatedAt: null,
  score: 1 / n,
  ...over,
});

const OUTCOME: AnswerOutcome = {
  model: "claude-opus-5-5",
  stopReason: "end_turn",
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0006,
};

/** Pool whose transactions succeed and record inserted values. */
function fakePool() {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (q: unknown) => {
      const text = typeof q === "string" ? q : String((q as { text?: string }).text ?? "");
      queries.push(text);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as PoolLike, queries };
}

function setup(opts: { hits?: RankedHit[]; bodies?: Map<string, string>; gateway?: LlmGateway | null; outcome?: Partial<AnswerOutcome>; now?: () => number; logger?: { error: ReturnType<typeof vi.fn> }; pool?: PoolLike } = {}) {
  const gathered: GatheredDocuments = {
    hits: opts.hits ?? [hit(1), hit(2)],
    sources: [{ id: "atlassian", ok: true, hits: 2, ms: 10 }],
    bodies: opts.bodies ?? new Map([[hit(1).url, "full text one"]]),
  };
  const gatherDocuments = vi.fn(async () => gathered);
  const streamAnswer = vi.fn<LlmGateway["streamAnswer"]>(async (_input, onEvent, _signal, onUsage) => {
    onEvent({ type: "text", text: "Answer." });
    onEvent({ type: "citation", documentIndex: 0, citedText: "full text one" });
    const outcome = { ...OUTCOME, ...opts.outcome };
    onUsage({ ...outcome, estimated: false });
    return outcome;
  });
  const { pool, queries } = fakePool();
  const service = new AnswersService({
    pool: opts.pool ?? pool,
    box: { fingerprint: () => "f".repeat(64) },
    logger: opts.logger ?? { error: vi.fn() },
    documents: { gatherDocuments },
    gateway: opts.gateway === undefined ? { streamAnswer } : opts.gateway,
    now: opts.now,
  });
  const events: AnswerStreamEvent[] = [];
  return { service, events, emit: (e: AnswerStreamEvent) => events.push(e), streamAnswer, gatherDocuments, queries };
}

describe("AnswersService", () => {
  it("sends sources first, then text and citations, then done", async () => {
    const { service, events, emit } = setup();
    await service.answer(scope, "q", emit, signal);
    expect(events.map((e) => e.type)).toEqual(["sources", "text", "citation", "done"]);
    expect(events[2]).toEqual({ type: "citation", source: 1, citedText: "full text one" });
    expect(events[3]).toEqual({ type: "done", outcome: "answered", grounded: true, truncatedDocuments: 0 });
  });

  it("prefers full text, falling back to snippet then title", async () => {
    const { service, emit, streamAnswer } = setup({ hits: [hit(1), hit(2), hit(3, { snippet: "" })] });
    await service.answer(scope, "q", emit, signal);
    expect(streamAnswer.mock.calls[0]![0].documents).toEqual([
      { title: "Doc 1", text: "full text one" },
      { title: "Doc 2", text: "snippet 2" },
      { title: "Doc 3", text: "Doc 3" },
    ]);
  });

  it("makes no paid call when no documents were found", async () => {
    const { service, events, emit, streamAnswer, queries } = setup({ hits: [] });
    await service.answer(scope, "q", emit, signal);
    expect(streamAnswer).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes("usage_ledger"))).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", outcome: "no_documents", grounded: false, truncatedDocuments: 0 });
  });

  it("limits documents and reports truncation", async () => {
    const hits = [1, 2, 3, 4, 5, 6, 7].map((n) => hit(n));
    const { service, events, emit, streamAnswer } = setup({ hits, bodies: new Map([[hit(1).url, "x".repeat(40_000)]]) });
    await service.answer(scope, "q", emit, signal);
    const docs = streamAnswer.mock.calls[0]![0].documents;
    expect(docs).toHaveLength(5);
    expect(docs[0]!.text).toHaveLength(30_000);
    expect(events.at(-1)).toMatchObject({ truncatedDocuments: 1 });
  });

  it("drops citations to documents it never sent and marks the answer ungrounded", async () => {
    const gateway: LlmGateway = {
      streamAnswer: async (_i, onEvent) => {
        onEvent({ type: "text", text: "Made up." });
        onEvent({ type: "citation", documentIndex: 99, citedText: "x" });
        return OUTCOME;
      },
    };
    const { service, events, emit } = setup({ gateway });
    await service.answer(scope, "q", emit, signal);
    expect(events.some((e) => e.type === "citation")).toBe(false);
    expect(events.at(-1)).toMatchObject({ outcome: "answered", grounded: false });
  });

  it.each([
    ["refusal", "refused"],
    ["max_tokens", "incomplete"],
    [null, "incomplete"],
  ])("maps stop reason %s to %s", async (stopReason, outcome) => {
    const { service, events, emit } = setup({ outcome: { stopReason } });
    await service.answer(scope, "q", emit, signal);
    expect(events.at(-1)).toMatchObject({ outcome });
  });

  it("writes usage and audit rows, never the raw question", async () => {
    const { service, emit, queries } = setup();
    await service.answer(scope, "secret question text", emit, signal);
    expect(queries.some((q) => q.includes("usage_ledger"))).toBe(true);
    expect(queries.some((q) => q.includes("audit_log"))).toBe(true);
    expect(queries.join(" ")).not.toContain("secret question text");
  });

  it("records usage and audit when the stream fails, then rethrows", async () => {
    const gateway: LlmGateway = {
      streamAnswer: async (_i, _e, _s, onUsage) => {
        onUsage({ ...OUTCOME, outputTokens: 3, estimated: true });
        throw new AppError("UNAVAILABLE", "The answer was cancelled");
      },
    };
    const { service, events, emit, queries } = setup({ gateway });
    await expect(service.answer(scope, "q", emit, signal)).rejects.toThrow(/cancelled/);
    expect(queries.some((q) => q.includes("usage_ledger"))).toBe(true);
    expect(queries.some((q) => q.includes("audit_log"))).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("makes no paid call if the caller left during the search", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const { service, events, emit, streamAnswer, gatherDocuments } = setup();
    await service.answer(scope, "q", emit, aborted.signal);
    expect(gatherDocuments).toHaveBeenCalledOnce();
    expect(streamAnswer).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("still finishes the answer when bookkeeping fails, and logs it", async () => {
    const logger = { error: vi.fn() };
    const broken = { connect: async () => { throw new Error("db down"); } } as unknown as PoolLike;
    const { service, events, emit } = setup({ logger, pool: broken });
    await expect(service.answer(scope, "q", emit, signal)).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "answered" });
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("caps concurrent answers per user and frees the slot afterwards", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const gateway: LlmGateway = {
      streamAnswer: async () => {
        await gate;
        return OUTCOME;
      },
    };
    const { service, emit } = setup({ gateway });
    const first = service.answer(scope, "q", emit, signal);
    const second = service.answer(scope, "q", emit, signal);
    await expect(service.answer(scope, "q", emit, signal)).rejects.toMatchObject({ code: "RATE_LIMITED", message: expect.stringContaining("still running") });
    release();
    await Promise.all([first, second]);
    await expect(service.answer(scope, "q", emit, signal)).resolves.toBeUndefined();
  });

  it("reports when no API key is configured, before any search", async () => {
    const { service, emit, gatherDocuments } = setup({ gateway: null });
    await expect(service.answer(scope, "q", emit, signal)).rejects.toThrow(/not configured/);
    expect(gatherDocuments).not.toHaveBeenCalled();
  });

  it("limits answers per user within the window, then recovers", async () => {
    let now = 1_000_000;
    const { service, emit } = setup({ now: () => now });
    for (let i = 0; i < 10; i += 1) await service.answer(scope, "q", emit, signal);
    await expect(service.answer(scope, "q", emit, signal)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(service.answer({ ...scope, userId: "0a000000-0000-4000-8000-0000000000a2" }, "q", emit, signal)).resolves.toBeUndefined();
    now += 61_000;
    await expect(service.answer(scope, "q", emit, signal)).resolves.toBeUndefined();
  });
});

describe("POST /answers", () => {
  const SUBJECT = "5a000000-0000-4000-8000-0000000000a4";
  let app: NestFastifyApplication;
  let token: string;
  let behaviour: AnswersApi["answer"];

  beforeAll(async () => {
    const keys = await createTestKeys();
    app = await createApp({
      logger: createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) }),
      directory: {
        findBySubject: async (tenantId, subject) =>
          subject === SUBJECT ? { userId: scope.userId, tenantId, role: "member", groupIds: [] } : null,
      },
      connections: createFakeConnections(),
      answers: { answer: (...args) => behaviour(...args) },
      webAppUrl: "http://localhost:3000",
      verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    token = await keys.sign({ tenant_id: scope.tenantId }, { subject: SUBJECT });
  });

  afterAll(async () => {
    await app?.close();
  });

  function post(body: object, auth = true, headers: Record<string, string> = {}) {
    return app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/answers",
      payload: body,
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
  }

  it("requires authentication", async () => {
    expect((await post({ q: "x" }, false)).statusCode).toBe(401);
  });

  it("rejects an invalid question before streaming", async () => {
    behaviour = vi.fn();
    expect((await post({ q: "" })).statusCode).toBe(400);
    expect((await post({ q: "x".repeat(501) })).statusCode).toBe(400);
    expect(behaviour).not.toHaveBeenCalled();
  });

  it("streams events as SSE in the caller's scope, keeping CORS headers", async () => {
    behaviour = async (s, _q, emit) => {
      expect(s).toEqual(scope);
      emit({ type: "text", text: "Hi" });
      emit({ type: "done", outcome: "answered", grounded: true, truncatedDocuments: 0 });
    };
    const res = await post({ q: " hello " }, true, { origin: "http://localhost:3000" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.body).toContain('event: text\ndata: {"type":"text","text":"Hi"}\n\n');
    expect(res.body).toContain("event: done");
  });

  it("sends a safe error event for AppErrors", async () => {
    behaviour = async () => {
      throw new AppError("RATE_LIMITED", "Too many answers", { reason: "internal detail" });
    };
    const res = await post({ q: "x" });
    expect(res.body).toContain('"code":"RATE_LIMITED"');
    expect(res.body).not.toContain("internal detail");
  });

  it("hides unexpected errors", async () => {
    behaviour = async () => {
      throw new Error("postgres://secret");
    };
    const res = await post({ q: "x" });
    expect(res.body).toContain('"code":"INTERNAL"');
    expect(res.body).not.toContain("postgres://");
  });
});
