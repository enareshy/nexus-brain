import { describe, expect, it, vi } from "vitest";
import { INITIAL_ANSWER, readAnswerStream, reduceAnswer, type AnswerEvent, type AnswerState } from "./answer";
import { ApiError, createApiClient } from "./api";

function run(events: AnswerEvent[]): AnswerState {
  return events.reduce(reduceAnswer, INITIAL_ANSWER);
}

const done = { type: "done", outcome: "answered", grounded: true, truncatedDocuments: 0 } as const;

describe("reduceAnswer", () => {
  it("merges adjacent text and keeps citations in position", () => {
    const state = run([
      { type: "text", text: "Rotate " },
      { type: "text", text: "monthly." },
      { type: "citation", source: 1, citedText: "x" },
      { type: "text", text: " Yes." },
    ]);
    expect(state.parts).toEqual([
      { kind: "text", text: "Rotate monthly." },
      { kind: "cite", source: 1 },
      { kind: "text", text: " Yes." },
    ]);
  });

  it("collapses repeated citations of the same source only when adjacent", () => {
    const state = run([
      { type: "citation", source: 1, citedText: "a" },
      { type: "citation", source: 1, citedText: "b" },
      { type: "citation", source: 2, citedText: "c" },
    ]);
    expect(state.parts).toEqual([{ kind: "cite", source: 1 }, { kind: "cite", source: 2 }]);
  });

  it("records sources, completion and errors, without mutating the initial state", () => {
    const hit = { serverId: "s", externalId: "e", title: "t", url: "https://x.example", snippet: "", updatedAt: null, score: 1 };
    const state = run([{ type: "sources", hits: [hit], sources: [] }, { ...done, truncatedDocuments: 2 }]);
    expect(state).toMatchObject({ status: "done", outcome: "answered", grounded: true, truncatedDocuments: 2 });
    expect(state.hits).toHaveLength(1);
    expect(run([{ type: "error", code: "X", message: "nope" }])).toMatchObject({ status: "error", error: "nope" });
    expect(INITIAL_ANSWER.parts).toEqual([]);
  });
});

function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      chunks.forEach((c) => controller.enqueue(encoder.encode(c)));
      controller.close();
    },
  });
}

const sse = (event: object) => `event: x\ndata: ${JSON.stringify(event)}\n\n`;

describe("readAnswerStream", () => {
  it("parses events split across chunks", async () => {
    const text = sse({ type: "text", text: "Hello" });
    const events: AnswerEvent[] = [];
    await readAnswerStream(bodyOf(text.slice(0, 10), text.slice(10), sse(done)), (e) => events.push(e));
    expect(events).toEqual([{ type: "text", text: "Hello" }, done]);
  });

  it("handles a final event without a trailing blank line", async () => {
    const events: AnswerEvent[] = [];
    await readAnswerStream(bodyOf(`data: ${JSON.stringify(done)}`), (e) => events.push(e));
    expect(events).toEqual([done]);
  });

  it("skips malformed, unknown and comment-only blocks", async () => {
    const events: AnswerEvent[] = [];
    await readAnswerStream(
      bodyOf("data: {not json\n\n", sse({ type: "unknown" }), ": ping\n\n", sse({ type: "citation", source: -1, citedText: "x" })),
      (e) => events.push(e),
    );
    expect(events).toEqual([]);
  });
});

describe("openAnswerStream", () => {
  const signal = new AbortController().signal;

  it("posts the question in the body, never the URL, and returns the stream", async () => {
    const fetchImpl = vi.fn(async (_u: URL | RequestInfo, _i?: RequestInit) => new Response(bodyOf(sse(done))));
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as typeof fetch);
    const body = await api.openAnswerStream("secret question", signal);
    expect(body).toBeInstanceOf(ReadableStream);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test/answers");
    expect(init?.body).toBe(JSON.stringify({ q: "secret question" }));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it("requires a token", async () => {
    const api = createApiClient("http://api.test", () => null, vi.fn() as unknown as typeof fetch);
    await expect(api.openAnswerStream("q", signal)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("asks for a summary of one result by its reference, sending only what is needed to read it", async () => {
    const fetchImpl = vi.fn(async (_u: URL | RequestInfo, _i?: RequestInit) => new Response(bodyOf(sse(done))));
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as typeof fetch);
    const hit = { serverId: "atlassian", externalId: "KAN-1", title: "Login bug", url: "https://a.example/KAN-1", snippet: "secret", updatedAt: null, score: 1, siteId: "s1" };
    await api.openSummaryStream(hit, signal);
    await api.openSummaryStream({ ...hit, siteId: undefined }, signal);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test/answers/summary");
    expect(JSON.parse(String(init?.body))).toEqual({ serverId: "atlassian", externalId: "KAN-1", url: "https://a.example/KAN-1", title: "Login bug", siteId: "s1" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body))).not.toHaveProperty("siteId");
  });

  it("maps HTTP errors, unknown failures, network errors and aborts", async () => {
    const withFetch = (f: () => Promise<Response>) =>
      createApiClient("http://api.test", () => "tok", (async () => f()) as typeof fetch);
    const failure = new Response(JSON.stringify({ success: false, data: null, error: { code: "FORBIDDEN", message: "no" } }), { status: 403 });
    await expect(withFetch(async () => failure).openAnswerStream("q", signal)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(withFetch(async () => new Response("oops", { status: 500 })).openAnswerStream("q", signal)).rejects.toMatchObject({ code: "BAD_RESPONSE" });

    const offline = withFetch(async () => {
      throw new TypeError("offline");
    });
    await expect(offline.openAnswerStream("q", signal)).rejects.toBeInstanceOf(ApiError);
    await expect(offline.openAnswerStream("q", signal)).rejects.toMatchObject({ code: "NETWORK" });

    const aborted = new AbortController();
    aborted.abort();
    await expect(offline.openAnswerStream("q", aborted.signal)).rejects.toMatchObject({ code: "ABORTED" });
  });
});
