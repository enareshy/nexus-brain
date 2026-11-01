import { z } from "zod";
import { HitSchema, SourceStatusSchema, type Hit, type SourceStatus } from "./api";

export const AnswerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sources"), hits: z.array(HitSchema), sources: z.array(SourceStatusSchema) }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("citation"), source: z.number().int().positive(), citedText: z.string() }),
  z.object({
    type: z.literal("done"),
    outcome: z.enum(["answered", "no_documents", "refused", "incomplete"]),
    grounded: z.boolean(),
    truncatedDocuments: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type AnswerEvent = z.infer<typeof AnswerEventSchema>;

export type AnswerPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "cite"; readonly source: number };

export interface AnswerState {
  readonly status: "streaming" | "done" | "error";
  readonly parts: readonly AnswerPart[];
  readonly hits: readonly Hit[];
  readonly sources: readonly SourceStatus[];
  readonly outcome: Extract<AnswerEvent, { type: "done" }>["outcome"] | null;
  readonly grounded: boolean;
  readonly truncatedDocuments: number;
  readonly error: string | null;
}

export const INITIAL_ANSWER: AnswerState = Object.freeze({
  status: "streaming",
  parts: [],
  hits: [],
  sources: [],
  outcome: null,
  grounded: false,
  truncatedDocuments: 0,
  error: null,
});

/** Pure state transition, so streaming behaviour can be tested without a network. */
export function reduceAnswer(state: AnswerState, event: AnswerEvent): AnswerState {
  switch (event.type) {
    case "sources":
      return { ...state, hits: event.hits, sources: event.sources };
    case "text": {
      const last = state.parts.at(-1);
      return last?.kind === "text"
        ? { ...state, parts: [...state.parts.slice(0, -1), { kind: "text", text: last.text + event.text }] }
        : { ...state, parts: [...state.parts, { kind: "text", text: event.text }] };
    }
    case "citation": {
      // Repeated citations of one source in a row read better as a single marker.
      const last = state.parts.at(-1);
      if (last?.kind === "cite" && last.source === event.source) return state;
      return { ...state, parts: [...state.parts, { kind: "cite", source: event.source }] };
    }
    case "done":
      return {
        ...state,
        status: "done",
        outcome: event.outcome,
        grounded: event.grounded,
        truncatedDocuments: event.truncatedDocuments,
      };
    case "error":
      return { ...state, status: "error", error: event.message };
  }
}

/**
 * Parses server-sent events from a response body. Invalid events are skipped rather than
 * rendered, and a body that ends without `done` or `error` is reported by the caller.
 */
export async function readAnswerStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AnswerEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (!data) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = AnswerEventSchema.safeParse(json);
    if (parsed.success) onEvent(parsed.data);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    blocks.forEach(flush);
  }
  flush(buffer + decoder.decode());
}
