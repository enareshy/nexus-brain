import { AppError } from "@brain/core";
import type { LlmGateway } from "@brain/llm-gateway";
import { describe, expect, it, vi } from "vitest";
import { QueryRewriter, withExpandedTerms } from "./query-rewriter.js";

const SCOPE = { tenantId: "0a000000-0000-4000-8000-000000000001", userId: "0a000000-0000-4000-8000-0000000000a1" };
const OTHER_USER = "0a000000-0000-4000-8000-0000000000a2";
const signal = new AbortController().signal;
const USAGE = { model: "m", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, estimated: false };

function setup(rewrite: LlmGateway["rewriteQuery"] = async (_q, _s, onUsage) => {
  onUsage(USAGE);
  return ["credentials", "rotation"];
}) {
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  const gateway = { streamAnswer: vi.fn(), rewriteQuery: vi.fn(rewrite) } as unknown as LlmGateway;
  const logger = { error: vi.fn() };
  let time = 1_000;
  const rewriter = new QueryRewriter({ pool: pool as never, gateway, logger, now: () => time });
  return { rewriter, gateway, logger, client, advance: (ms: number) => (time += ms) };
}

describe("QueryRewriter", () => {
  it("returns the model's words and meters the call", async () => {
    const { rewriter, client } = setup();
    expect(await rewriter.expand(SCOPE, "how do we change passwords", signal)).toEqual(["credentials", "rotation"]);
    await vi.waitFor(() => {
      expect(JSON.stringify(client.query.mock.calls)).toMatch(/insert into .{0,4}usage_ledger/i);
    });
  });

  it("reuses a result for the same person and question, and not across people", async () => {
    const { rewriter, gateway, advance } = setup();
    await rewriter.expand(SCOPE, "Question", signal);
    await rewriter.expand(SCOPE, "Question", signal);
    expect(gateway.rewriteQuery).toHaveBeenCalledTimes(1);
    await rewriter.expand({ ...SCOPE, userId: OTHER_USER }, "Question", signal);
    expect(gateway.rewriteQuery).toHaveBeenCalledTimes(2);
    advance(6 * 60 * 1000);
    await rewriter.expand(SCOPE, "Question", signal);
    expect(gateway.rewriteQuery).toHaveBeenCalledTimes(3);
  });

  it("treats the same follow-up after different questions as different", async () => {
    const { rewriter, gateway } = setup();
    await rewriter.expand(SCOPE, "who owns it", signal, ["login bug"]);
    await rewriter.expand(SCOPE, "who owns it", signal, ["billing export"]);
    await rewriter.expand(SCOPE, "who owns it", signal, ["login bug"]);
    expect(gateway.rewriteQuery).toHaveBeenCalledTimes(2);
  });

  it("counts repeats of one question towards the limit, because each repeat can search again", async () => {
    const { rewriter, gateway } = setup();
    for (let i = 0; i < 30; i += 1) expect(await rewriter.expand(SCOPE, "same", signal)).toHaveLength(2);
    expect(await rewriter.expand(SCOPE, "same", signal)).toEqual([]);
    expect(gateway.rewriteQuery).toHaveBeenCalledOnce();
  });

  it("logs the reason for a failure, never the provider's text", async () => {
    const { rewriter, logger } = setup(async () => {
      throw new AppError("UNAVAILABLE", "the question was: secret plans", { reason: "provider_500" });
    });
    await rewriter.expand(SCOPE, "secret plans", signal);
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain("provider_500");
    expect(logged).not.toContain("secret plans");
  });

  it("carries on with no extra words when the model fails, and does not cache that", async () => {
    const failing = vi.fn(async () => {
      throw new AppError("UNAVAILABLE", "down");
    });
    const { rewriter, logger, gateway } = setup(failing);
    expect(await rewriter.expand(SCOPE, "q", signal)).toEqual([]);
    expect(logger.error).toHaveBeenCalledOnce();
    await rewriter.expand(SCOPE, "q", signal);
    expect(gateway.rewriteQuery).toHaveBeenCalledTimes(2);
  });

  it("stops spending at the per-user limit, without affecting other people", async () => {
    const { rewriter, gateway, advance } = setup();
    for (let i = 0; i < 35; i += 1) await rewriter.expand(SCOPE, `q${i}`, signal);
    expect(gateway.rewriteQuery).toHaveBeenCalledTimes(30);
    await rewriter.expand({ ...SCOPE, userId: OTHER_USER }, "q", signal);
    expect(gateway.rewriteQuery).toHaveBeenCalledTimes(31);
    advance(61_000);
    await rewriter.expand(SCOPE, "again", signal);
    expect(gateway.rewriteQuery).toHaveBeenCalledTimes(32);
  });

  it("does nothing without a configured model", async () => {
    const rewriter = new QueryRewriter({ pool: { connect: vi.fn() } as never, gateway: null, logger: { error: vi.fn() } });
    expect(await rewriter.expand(SCOPE, "q", signal)).toEqual([]);
  });

  it("still returns the words if metering fails", async () => {
    const { rewriter, client, logger } = setup();
    client.query.mockRejectedValue(new Error("db down"));
    expect(await rewriter.expand(SCOPE, "q", signal)).toEqual(["credentials", "rotation"]);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
  });
});

describe("withExpandedTerms", () => {
  it("puts the new words first, so they survive the keyword limit", () => {
    expect(withExpandedTerms("how do we change it", ["rotation", "secrets"])).toBe("rotation secrets how do we change it");
    expect(withExpandedTerms("as is", [])).toBe("as is");
  });
});
