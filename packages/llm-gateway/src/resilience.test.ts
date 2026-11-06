import { AppError } from "@brain/core";
import { describe, expect, it, vi } from "vitest";
import { withAnswerCache } from "./answer-cache.js";
import { isProviderOutage, withCircuitBreaker } from "./breaker.js";
import type { AnswerEvent, AnswerOutcome, LlmGateway } from "./gateway.js";
import { MODELS, TASK_TIERS, TIERS } from "./models.js";

const signal = new AbortController().signal;
const outcome: AnswerOutcome = {
  model: "m",
  stopReason: "end_turn",
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
};
const down = () => new AppError("UNAVAILABLE", "down", { reason: "provider_connection_ECONNRESET" });

function fakeGateway(impl?: Partial<LlmGateway>): LlmGateway & { calls: () => number } {
  let count = 0;
  const gateway: LlmGateway = {
    streamAnswer: async (_input, onEvent, _signal, onUsage) => {
      count += 1;
      onEvent({ type: "text", text: "Rotate monthly." });
      onEvent({ type: "citation", documentIndex: 0, citedText: "monthly" });
      onUsage({ ...outcome, estimated: false });
      return outcome;
    },
    agentTurn: async () => {
      count += 1;
      return { content: [], text: "ok", toolCall: null, stopReason: "end_turn" };
    },
    rewriteQuery: async () => {
      count += 1;
      return [];
    },
    ...impl,
  };
  return { ...gateway, calls: () => count };
}

describe("model tiers", () => {
  it("names every task's model through a tier in one place", () => {
    expect(MODELS.answer).toBe(TIERS[TASK_TIERS.answer]);
    expect(MODELS.agent).toBe(TIERS[TASK_TIERS.agent]);
    expect(MODELS.rewrite).toBe(TIERS[TASK_TIERS.rewrite]);
    expect(TASK_TIERS.rewrite).toBe("fast");
  });
});

describe("withCircuitBreaker", () => {
  const failing = vi.fn(async () => {
    throw down();
  });

  it("stops calling after repeated failures, answers at once, then lets one trial through", async () => {
    let clock = 0;
    let isHealthy = false;
    const inner = fakeGateway({
      rewriteQuery: async () => {
        if (!isHealthy) throw down();
        return ["ok"];
      },
    });
    const states: string[] = [];
    const gateway = withCircuitBreaker(inner, { failureThreshold: 3, openMs: 30_000, now: () => clock, onStateChange: (_task, s) => states.push(s) });
    const call = () => gateway.rewriteQuery("q", signal, () => {});

    for (let i = 0; i < 3; i += 1) await expect(call()).rejects.toMatchObject({ details: { reason: "provider_connection_ECONNRESET" } });
    await expect(call()).rejects.toMatchObject({ code: "UNAVAILABLE", details: { reason: "circuit_open" } });
    expect(states).toEqual(["open"]);

    clock = 31_000;
    // The trial fails, so calls stop again for another period.
    await expect(call()).rejects.toMatchObject({ details: { reason: "provider_connection_ECONNRESET" } });
    await expect(call()).rejects.toMatchObject({ details: { reason: "circuit_open" } });

    clock = 62_000;
    isHealthy = true;
    await expect(call()).resolves.toEqual(["ok"]);
    await expect(call()).resolves.toEqual(["ok"]);
    expect(states).toEqual(["open", "closed"]);
  });

  it("lets only one trial call through at a time", async () => {
    let clock = 0;
    let release!: () => void;
    const inner = fakeGateway({ rewriteQuery: failing });
    const gateway = withCircuitBreaker(inner, { failureThreshold: 1, openMs: 10, now: () => clock });
    await expect(gateway.rewriteQuery("q", signal, () => {})).rejects.toBeTruthy();
    clock = 20;
    failing.mockImplementationOnce(() => new Promise((_, reject) => (release = () => reject(down()))));
    const trial = gateway.rewriteQuery("q", signal, () => {});
    await expect(gateway.rewriteQuery("q", signal, () => {})).rejects.toMatchObject({ details: { reason: "circuit_open" } });
    release();
    await expect(trial).rejects.toBeTruthy();
  });

  it("stays stopped when the trial call is cancelled, since that proves nothing", async () => {
    let clock = 0;
    let next: AppError = down();
    const inner = fakeGateway({
      rewriteQuery: async () => {
        throw next;
      },
    });
    const gateway = withCircuitBreaker(inner, { failureThreshold: 1, openMs: 10, now: () => clock });
    const call = () => gateway.rewriteQuery("q", signal, () => {});
    await expect(call()).rejects.toBeTruthy();
    clock = 20;
    next = new AppError("UNAVAILABLE", "x", { reason: "aborted" });
    await expect(call()).rejects.toMatchObject({ details: { reason: "aborted" } });
    next = down();
    // The next call is another trial, not a burst of calls.
    await expect(call()).rejects.toMatchObject({ details: { reason: "provider_connection_ECONNRESET" } });
    await expect(call()).rejects.toMatchObject({ details: { reason: "circuit_open" } });
  });

  it("does not let a call that started before calls stopped switch them back on", async () => {
    let finishSlow!: () => void;
    let isSlow = true;
    const inner = fakeGateway({
      rewriteQuery: async () => {
        if (isSlow) {
          isSlow = false;
          await new Promise<void>((resolve) => (finishSlow = resolve));
          return ["late"];
        }
        throw down();
      },
    });
    const gateway = withCircuitBreaker(inner, { failureThreshold: 1, openMs: 30_000, now: () => 0 });
    const slow = gateway.rewriteQuery("q", signal, () => {});
    await expect(gateway.rewriteQuery("q", signal, () => {})).rejects.toBeTruthy();
    finishSlow();
    await slow;
    await expect(gateway.rewriteQuery("q", signal, () => {})).rejects.toMatchObject({ details: { reason: "circuit_open" } });
  });

  it("keeps each task separate, so failing search words do not stop answers", async () => {
    const inner = fakeGateway({ rewriteQuery: async () => Promise.reject(down()) });
    const gateway = withCircuitBreaker(inner, { failureThreshold: 1, openMs: 30_000, now: () => 0 });
    await expect(gateway.rewriteQuery("q", signal, () => {})).rejects.toBeTruthy();
    await expect(gateway.rewriteQuery("q", signal, () => {})).rejects.toMatchObject({ details: { reason: "circuit_open" } });
    await expect(gateway.streamAnswer({ question: "q", documents: [] }, () => {}, signal, () => {})).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("ignores our own failures, reported as provider_unknown, such as a closed connection to the browser", async () => {
    const inner = fakeGateway({ rewriteQuery: async () => Promise.reject(new AppError("UNAVAILABLE", "x", { reason: "provider_unknown" })) });
    const gateway = withCircuitBreaker(inner, { failureThreshold: 1, openMs: 30_000, now: () => 0 });
    for (let i = 0; i < 3; i += 1) {
      await expect(gateway.rewriteQuery("q", signal, () => {})).rejects.toMatchObject({ details: { reason: "provider_unknown" } });
    }
  });

  it("ignores cancellations and invalid requests, which say nothing about the provider", async () => {
    let attempt = 0;
    const errors = [
      new AppError("UNAVAILABLE", "x", { reason: "aborted" }),
      new AppError("UNAVAILABLE", "x", { reason: "provider_400" }),
      new AppError("VALIDATION", "x"),
    ];
    const inner = fakeGateway({
      rewriteQuery: async () => {
        throw errors[attempt++ % errors.length];
      },
    });
    const gateway = withCircuitBreaker(inner, { failureThreshold: 2, openMs: 30_000, now: () => 0 });
    for (let i = 0; i < 6; i += 1) {
      await expect(gateway.rewriteQuery("q", signal, () => {})).rejects.not.toMatchObject({ details: { reason: "circuit_open" } });
    }
  });

  it("counts provider overload and server errors, and resets after a success", async () => {
    let next: AppError | null = new AppError("RATE_LIMITED", "busy", { reason: "provider_429" });
    const inner = fakeGateway({
      agentTurn: async () => {
        if (next) throw next;
        return { content: [], text: "", toolCall: null, stopReason: "end_turn" };
      },
    });
    const gateway = withCircuitBreaker(inner, { failureThreshold: 2, openMs: 30_000, now: () => 0 });
    const turn = () => gateway.agentTurn({ messages: [], tools: [] }, signal, () => {});
    await expect(turn()).rejects.toBeTruthy();
    next = null;
    await turn();
    next = new AppError("UNAVAILABLE", "x", { reason: "provider_529" });
    await expect(turn()).rejects.toMatchObject({ details: { reason: "provider_529" } });
    await expect(turn()).rejects.toMatchObject({ details: { reason: "provider_529" } });
    await expect(turn()).rejects.toMatchObject({ details: { reason: "circuit_open" } });
  });
});

describe("isProviderOutage (NFR-AVAIL-01)", () => {
  it("counts a provider that is down, busy or paused, and not our own mistakes or a cancel", () => {
    const err = (code: "UNAVAILABLE" | "RATE_LIMITED" | "INTERNAL", reason?: string) => new AppError(code, "x", reason ? { reason } : undefined);
    expect([err("UNAVAILABLE", "provider_503"), err("UNAVAILABLE", "provider_connection_ECONNRESET"), err("RATE_LIMITED", "provider_429"), err("UNAVAILABLE", "circuit_open")].map(isProviderOutage)).toEqual([true, true, true, true]);
    expect(
      [err("UNAVAILABLE", "provider_auth"), err("UNAVAILABLE", "provider_404"), err("UNAVAILABLE", "provider_400"), err("UNAVAILABLE", "aborted"), err("UNAVAILABLE", "provider_unknown"), err("INTERNAL"), new Error("x")].map(isProviderOutage),
    ).toEqual([false, false, false, false, false, false, false]);
  });
});

describe("withAnswerCache", () => {
  const documents = [{ title: "Runbook", text: "Rotate keys monthly." }];
  const base = { question: "How often?", documents, cacheScope: "tenant-a" };
  const options = { ttlMs: 60_000, maxEntries: 2, maxEventChars: 10_000 };
  const ask = async (gateway: LlmGateway, input: Parameters<LlmGateway["streamAnswer"]>[0], abort = signal) => {
    const events: AnswerEvent[] = [];
    const onUsage = vi.fn();
    const result = await gateway.streamAnswer(input, (e) => events.push(e), abort, onUsage);
    return { events, result, onUsage };
  };

  it("replays an identical answer with its citations, at no cost and with no usage reported", async () => {
    const inner = fakeGateway();
    const gateway = withAnswerCache(inner, options);
    const first = await ask(gateway, base);
    const second = await ask(gateway, base);
    expect(inner.calls()).toBe(1);
    expect(second.events).toEqual(first.events);
    expect(second.result).toMatchObject({ cached: true, costUsd: 0, inputTokens: 0, stopReason: "end_turn" });
    expect(second.onUsage).not.toHaveBeenCalled();
  });

  it("never shares across companies, or when the documents, question or conversation differ", async () => {
    const inner = fakeGateway();
    const gateway = withAnswerCache(inner, options);
    await ask(gateway, base);
    await ask(gateway, { ...base, cacheScope: "tenant-b" });
    await ask(gateway, { ...base, documents: [{ title: "Runbook", text: "Rotate keys weekly." }] });
    await ask(gateway, { ...base, documents: [] });
    await ask(gateway, { ...base, question: "How often? " });
    await ask(gateway, { ...base, history: [{ role: "user", text: "earlier" }] });
    await ask(gateway, { ...base, modelChoice: "standard" });
    expect(inner.calls()).toBe(7);
  });

  it("does not cache without a scope, an unfinished answer, an aborted one, or a very large one", async () => {
    const cut = fakeGateway({
      streamAnswer: async (_i, onEvent) => {
        onEvent({ type: "text", text: "partial" });
        return { ...outcome, stopReason: "max_tokens" };
      },
    });
    const gateway = withAnswerCache(cut, options);
    const noScope = { question: base.question, documents };
    await ask(gateway, noScope);
    await ask(gateway, noScope);
    await ask(gateway, base);
    await ask(gateway, base);

    const inner = fakeGateway();
    const small = withAnswerCache(inner, { ...options, maxEventChars: 5 });
    await ask(small, base);
    await ask(small, base);
    const controller = new AbortController();
    const aborting = withAnswerCache(
      fakeGateway({
        streamAnswer: async (_i, onEvent) => {
          onEvent({ type: "text", text: "x" });
          controller.abort();
          return outcome;
        },
      }),
      options,
    );
    await ask(aborting, base, controller.signal);
    const replay = await ask(aborting, base);
    expect(replay.result.cached).toBeUndefined();
    expect(inner.calls()).toBe(2);
  });

  it("never caches an answer shaped by someone's memories, so it cannot reach anyone else", async () => {
    const inner = fakeGateway();
    const gateway = withAnswerCache(inner, options);
    await ask(gateway, { ...base, memories: ["My team is Payments"] });
    await ask(gateway, base);
    await ask(gateway, { ...base, memories: ["My team is Payments"] });
    expect(inner.calls()).toBe(3);
  });

  it("forgets answers after their time and keeps only the most recent few", async () => {
    let clock = 0;
    const inner = fakeGateway();
    const gateway = withAnswerCache(inner, { ...options, now: () => clock });
    await ask(gateway, base);
    clock = 61_000;
    await ask(gateway, base);
    expect(inner.calls()).toBe(2);
    await ask(gateway, { ...base, question: "b" });
    await ask(gateway, { ...base, question: "c" });
    await ask(gateway, base);
    expect(inner.calls()).toBe(5);
  });
});
