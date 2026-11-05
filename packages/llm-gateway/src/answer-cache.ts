import { createHash } from "node:crypto";
import type { AnswerEvent, AnswerOutcome, LlmGateway } from "./gateway.js";
import { modelFor } from "./models.js";

export interface AnswerCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  /** Larger answers are not kept. */
  readonly maxEventChars: number;
  readonly now?: () => number;
}

interface Entry {
  readonly events: readonly AnswerEvent[];
  readonly outcome: AnswerOutcome;
  readonly expiresAt: number;
}

/**
 * The key is the company plus everything the answer is made from: the model, the exact documents
 * read with the person's own access, the question and the earlier conversation (FR-LLM-05). The
 * documents are what the person was allowed to see, so they serve as the permission hash: a cached
 * answer is only ever given to someone who has just read exactly the same text themselves.
 */
function keyFor(input: Parameters<LlmGateway["streamAnswer"]>[0]): string | null {
  // An answer shaped by someone's memories is theirs alone, and could repeat what they saved.
  if (!input.cacheScope || input.memories?.length) return null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        scope: input.cacheScope,
        model: modelFor("answer", input.modelChoice),
        question: input.question,
        documents: input.documents,
        history: input.history ?? [],
      }),
    )
    .digest("hex");
}

/**
 * Replays a recent identical answer instead of paying for it again. Only complete answers are kept.
 * The cache is in memory, so it is per process and is emptied on restart.
 */
export function withAnswerCache(gateway: LlmGateway, options: AnswerCacheOptions): LlmGateway {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function remember(key: string, entry: Entry): void {
    entries.delete(key);
    entries.set(key, entry);
    // Oldest first, so the least recently used goes.
    while (entries.size > options.maxEntries) entries.delete(entries.keys().next().value!);
  }

  return {
    ...gateway,
    async streamAnswer(input, onEvent, signal, onUsage) {
      const key = keyFor(input);
      const hit = key ? entries.get(key) : undefined;
      if (key && hit && hit.expiresAt > now()) {
        remember(key, hit);
        for (const event of hit.events) onEvent(event);
        // Nothing was billed, so there is no usage to report.
        return { ...hit.outcome, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, cached: true };
      }
      if (key && hit) entries.delete(key);

      const events: AnswerEvent[] = [];
      let size = 0;
      const outcome = await gateway.streamAnswer(
        input,
        (event) => {
          size += event.type === "text" ? event.text.length : event.citedText.length;
          if (size <= options.maxEventChars) events.push(event);
          onEvent(event);
        },
        signal,
        onUsage,
      );
      if (key && outcome.stopReason === "end_turn" && size <= options.maxEventChars && !signal.aborted) {
        remember(key, { events, outcome, expiresAt: now() + options.ttlMs });
      }
      return outcome;
    },
  };
}
