import type { AnswerPart } from "../conversations/conversations.service.js";

/** Enough to recognise the passage; the source link has the rest. */
export const MAX_QUOTE_CHARS = 300;
export const MAX_QUOTES_PER_MARKER = 3;

export function appendText(parts: readonly AnswerPart[], text: string): readonly AnswerPart[] {
  const last = parts.at(-1);
  return last?.kind === "text"
    ? [...parts.slice(0, -1), { kind: "text", text: last.text + text }]
    : [...parts, { kind: "text", text }];
}

function toQuote(citedText: string): string | null {
  const flat = citedText.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  // Cut by character, not UTF-16 unit, so an emoji is never split in half.
  const chars = Array.from(flat);
  return chars.length > MAX_QUOTE_CHARS ? `${chars.slice(0, MAX_QUOTE_CHARS - 1).join("")}…` : flat;
}

/** Repeated citations of one source in a row read better as a single marker, with each passage kept. */
export function appendCitation(parts: readonly AnswerPart[], source: number, citedText: string): readonly AnswerPart[] {
  const quote = toQuote(citedText);
  const last = parts.at(-1);
  if (last?.kind !== "cite" || last.source !== source) {
    return [...parts, { kind: "cite", source, quotes: quote ? [quote] : [] }];
  }
  const quotes = last.quotes ?? [];
  if (!quote || quotes.includes(quote) || quotes.length >= MAX_QUOTES_PER_MARKER) return parts;
  return [...parts.slice(0, -1), { ...last, quotes: [...quotes, quote] }];
}
