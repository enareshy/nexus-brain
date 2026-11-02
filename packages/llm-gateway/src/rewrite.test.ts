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
  const stream = vi.fn((_params: Record<string, unknown>, _options: Record<string, unknown>) => ({
    finalMessage: async () => message,
  }));
  return { gateway: createGateway({ create, stream } as unknown as MessagesClient), create, stream };
}

describe("agentTurn", () => {
  const tools = [{ name: "search_documents", description: "Search", inputSchema: { type: "object", properties: {} } }];
  const messages = [{ role: "user" as const, content: "do it" }];

  it("offers only the given tools, one call at a time, and returns the call", async () => {
    const content = [{ type: "tool_use", id: "t1", name: "search_documents", input: { query: "x" } }];
    const { gateway, stream } = gatewayReplying(reply("", { model: MODELS.agent, content, stop_reason: "tool_use" }));
    const turn = await gateway.agentTurn({ messages, tools }, signal, () => {});
    expect(turn.toolCall).toEqual({ id: "t1", name: "search_documents", input: { query: "x" } });
    expect(turn.content).toEqual(content);
    const [params, options] = stream.mock.calls[0]!;
    expect(params.model).toBe(MODELS.agent);
    expect(params.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect((params.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["search_documents"]);
    expect(options.maxRetries).toBe(3);
    expect(String(params.system)).toContain("<untrusted>");
  });

  it("keeps only the tool call it returns, because each one kept needs a result", async () => {
    const content = [
      { type: "text", text: "Looking" },
      { type: "tool_use", id: "t1", name: "search_documents", input: {} },
      { type: "tool_use", id: "t2", name: "search_documents", input: {} },
    ];
    const { gateway } = gatewayReplying(reply("", { model: MODELS.agent, content, stop_reason: "tool_use" }));
    const turn = await gateway.agentTurn({ messages, tools }, signal, () => {});
    expect(turn.toolCall?.id).toBe("t1");
    expect(turn.content).toEqual(content.slice(0, 2));
  });

  it("returns the final text, and reports usage", async () => {
    const { gateway } = gatewayReplying(reply("All done.", { model: MODELS.agent }));
    const onUsage = vi.fn();
    const turn = await gateway.agentTurn({ messages, tools }, signal, onUsage);
    expect(turn).toMatchObject({ text: "All done.", toolCall: null, stopReason: "end_turn" });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ model: MODELS.agent, estimated: false }));
  });

  it("records an estimate when it stops waiting, and hides provider details", async () => {
    const stream = vi.fn(() => ({
      finalMessage: async () => {
        throw new Anthropic.APIUserAbortError();
      },
    }));
    const gateway = createGateway({ stream } as unknown as MessagesClient);
    const onUsage = vi.fn();
    await expect(gateway.agentTurn({ messages, tools }, signal, onUsage)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ estimated: true, model: MODELS.agent }));
  });
});

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

  it("gives the model earlier questions, so a follow-up can be understood", async () => {
    const { gateway, create } = gatewayReplying(reply('{"keywords":["a1"]}'));
    await gateway.rewriteQuery("who owns it", signal, () => {}, ["status of the login bug"]);
    const sent = JSON.stringify(create.mock.calls[0]![0].messages);
    expect(sent).toContain("status of the login bug");
    expect(sent).toContain("who owns it");
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
