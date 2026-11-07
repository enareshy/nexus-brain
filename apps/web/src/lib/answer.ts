import { z } from "zod";
import { HitSchema, SourceStatusSchema, type Hit, type SavedAnswer, type SourceStatus } from "./api";

export const AnswerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversation"), conversationId: z.string() }),
  z.object({ type: z.literal("sources"), hits: z.array(HitSchema), sources: z.array(SourceStatusSchema) }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("citation"), source: z.number().int().positive(), citedText: z.string() }),
  z.object({ type: z.literal("subtasks"), titles: z.array(z.string().max(200)).max(8) }),
  z.object({
    type: z.literal("done"),
    outcome: z.enum(["answered", "no_documents", "refused", "incomplete", "search_only"]),
    grounded: z.boolean(),
    truncatedDocuments: z.number().int().nonnegative(),
    messageId: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type AnswerEvent = z.infer<typeof AnswerEventSchema>;

export type AnswerPart =
  | { readonly kind: "text"; readonly text: string }
  /** `quotes` is the cited passage; answers saved before it was kept have none. */
  | { readonly kind: "cite"; readonly source: number; readonly quotes?: readonly string[] };

/** Enough to recognise the passage; the source link has the rest. */
const MAX_QUOTE_CHARS = 300;
const MAX_QUOTES_PER_MARKER = 3;

function toQuote(citedText: string): string | null {
  const flat = citedText.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  // Cut by character, not UTF-16 unit, so an emoji is never split in half.
  const chars = Array.from(flat);
  return chars.length > MAX_QUOTE_CHARS ? `${chars.slice(0, MAX_QUOTE_CHARS - 1).join("")}…` : flat;
}

/** Repeated citations of one source in a row read better as a single marker, with each passage kept. */
function appendCitation(parts: readonly AnswerPart[], source: number, citedText: string): readonly AnswerPart[] {
  const quote = toQuote(citedText);
  const last = parts.at(-1);
  if (last?.kind !== "cite" || last.source !== source) {
    return [...parts, { kind: "cite", source, quotes: quote ? [quote] : [] }];
  }
  const quotes = last.quotes ?? [];
  if (!quote || quotes.includes(quote) || quotes.length >= MAX_QUOTES_PER_MARKER) return parts;
  return [...parts.slice(0, -1), { ...last, quotes: [...quotes, quote] }];
}

export interface AnswerState {
  readonly status: "streaming" | "done" | "error";
  readonly parts: readonly AnswerPart[];
  readonly hits: readonly Hit[];
  readonly sources: readonly SourceStatus[];
  readonly outcome: Extract<AnswerEvent, { type: "done" }>["outcome"] | null;
  readonly grounded: boolean;
  readonly truncatedDocuments: number;
  readonly error: string | null;
  /** Suggested subtask titles, when subtasks were asked for. */
  readonly subtasks: readonly string[];
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
  subtasks: [],
});

/** Pure state transition, so streaming behaviour can be tested without a network. */
export function reduceAnswer(state: AnswerState, event: AnswerEvent): AnswerState {
  switch (event.type) {
    case "conversation":
      return state;
    case "sources":
      return { ...state, hits: event.hits, sources: event.sources };
    case "text": {
      const last = state.parts.at(-1);
      return last?.kind === "text"
        ? { ...state, parts: [...state.parts.slice(0, -1), { kind: "text", text: last.text + event.text }] }
        : { ...state, parts: [...state.parts, { kind: "text", text: event.text }] };
    }
    case "citation": {
      const parts = appendCitation(state.parts, event.source, event.citedText);
      return parts === state.parts ? state : { ...state, parts };
    }
    case "subtasks":
      return { ...state, subtasks: event.titles };
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

/** Shows a saved answer through the same panel as a live one. */
export function answerStateFromSaved(answer: SavedAnswer): AnswerState {
  return {
    status: "done",
    parts: answer.parts,
    hits: answer.hits,
    sources: [],
    outcome: answer.outcome,
    grounded: answer.grounded,
    truncatedDocuments: answer.truncatedDocuments,
    error: null,
    subtasks: [],
  };
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
