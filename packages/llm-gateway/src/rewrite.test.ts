import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createGateway, type MessagesClient, type UsageReport } from "./gateway.js";
import { MODELS } from "./models.js";

const signal = new AbortController().signal;

function reply(text: string, overrides: Record<string, unknown> = {}) {
  return {
    model: MODELS.rewrite,
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    ...overrides,
  };
}

function gatewayReplying(message: unknown) {
  const create = vi.fn(async (_params: Record<string, unknown>, _options: Record<string, unknown>) => message);
  return { gateway: createGateway({ create } as unknown as MessagesClient), create };
}

describe("rewriteQuery", () => {
  it("uses the low-cost model with no tools, and asks for structured output", async () => {
    const { gateway, create } = gatewayReplying(reply('{"keywords":["rotation","credentials"]}'));
    const words = await gateway.rewriteQuery("how do we change passwords", signal, () => {});
    expect(words).toEqual(["rotation", "credentials"]);
    const [params, options] = create.mock.calls[0]!;
    expect(params.model).toBe(MODELS.rewrite);
    expect(params).not.toHaveProperty("tools");
    expect(params.output_config).toMatchObject({ format: { type: "json_schema" } });
    expect(options.signal).toBe(signal);
    expect(options.maxRetries).toBe(1);
    expect(JSON.stringify(params.messages)).toContain("how do we change passwords");
  });

  it("reports usage and cost", async () => {
    const { gateway } = gatewayReplying(reply('{"keywords":["a1"]}'));
    const reports: UsageReport[] = [];
    await gateway.rewriteQuery("q", signal, (usage) => reports.push(usage));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ model: MODELS.rewrite, inputTokens: 100, outputTokens: 20, estimated: false });
    expect(reports[0]?.costUsd).toBeCloseTo((100 * 0.1 + 20 * 0.5) / 1_000_000);
  });

  it("keeps only plain single words, at most four, once each", async () => {
    const words = ["rotation", "ROTATION", "two words", "from:boss", "'; drop", "x".repeat(41), "", "a", "b", "c", "d", "e", "f"];
    const { gateway } = gatewayReplying(reply(JSON.stringify({ keywords: [...words, 3] })));
    expect(await gateway.rewriteQuery("q", signal, () => {})).toEqual(["rotation", "a", "b", "c"]);
  });

  it.each([
    ["invalid JSON", reply("not json")],
    ["the wrong shape", reply('{"words":["a"]}')],
    ["a refusal", reply("", { stop_reason: "refusal", content: [] })],
  ])("returns no words for %s, and still reports usage", async (_name, message) => {
    const { gateway } = gatewayReplying(message);
    const onUsage = vi.fn();
    expect(await gateway.rewriteQuery("q", signal, onUsage)).toEqual([]);
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it("records an estimate when it stops waiting, because that call may still be billed", async () => {
    const create = vi.fn(async () => {
      throw new Anthropic.APIUserAbortError();
    });
    const gateway = createGateway({ create } as unknown as MessagesClient);
    const onUsage = vi.fn();
    await expect(gateway.rewriteQuery("q", signal, onUsage)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ estimated: true, model: MODELS.rewrite }));
  });

  it("keeps the network error's code for the logs, not its message", async () => {
    const network = Object.assign(new Error("connect failed asking about secret plans"), { code: "ECONNRESET" });
    const wrapped = new TypeError("fetch failed", { cause: network });
    const create = vi.fn(async () => {
      throw new Anthropic.APIConnectionError({ message: "Connection error.", cause: wrapped });
    });
    const gateway = createGateway({ create } as unknown as MessagesClient);
    const error = await gateway.rewriteQuery("q", signal, () => {}).catch((err: unknown) => err);
    expect(error).toMatchObject({ details: { reason: "provider_connection_ECONNRESET" } });
    expect(JSON.stringify(error)).not.toContain("secret plans");
  });

  it("records nothing for an error the provider cannot have billed, and hides its details", async () => {
    const error = new Anthropic.AuthenticationError(401, { error: "secret detail" }, "secret detail", new Headers());
    const create = vi.fn(async () => {
      throw error;
    });
    const gateway = createGateway({ create } as unknown as MessagesClient);
    const onUsage = vi.fn();
    await expect(gateway.rewriteQuery("q", signal, onUsage)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "The AI service is not available",
    });
    expect(onUsage).not.toHaveBeenCalled();
  });
});
