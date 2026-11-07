import { describe, expect, it } from "vitest";
import { appendCitation, appendText, MAX_QUOTE_CHARS, MAX_QUOTES_PER_MARKER } from "./answer-parts.js";

describe("appendText", () => {
  it("joins text that arrives in pieces", () => {
    expect(appendText(appendText([], "a"), "b")).toEqual([{ kind: "text", text: "ab" }]);
  });
});

describe("appendCitation", () => {
  it("keeps the cited text with the marker, so a person can see what supports the claim", () => {
    expect(appendCitation([], 1, "  Passwords   rotate\nmonthly. ")).toEqual([
      { kind: "cite", source: 1, quotes: ["Passwords rotate monthly."] },
    ]);
  });

  it("merges repeated citations of one source in a row, keeping each distinct quote", () => {
    let parts = appendCitation([], 1, "a");
    parts = appendCitation(parts, 1, "b");
    parts = appendCitation(parts, 1, "a");
    parts = appendCitation(parts, 2, "c");
    expect(parts).toEqual([
      { kind: "cite", source: 1, quotes: ["a", "b"] },
      { kind: "cite", source: 2, quotes: ["c"] },
    ]);
  });

  it("bounds what is kept", () => {
    let parts = appendCitation([], 1, "x".repeat(MAX_QUOTE_CHARS + 50));
    expect((parts[0] as { quotes: readonly string[] }).quotes[0]).toHaveLength(MAX_QUOTE_CHARS);
    expect((parts[0] as { quotes: readonly string[] }).quotes[0]?.endsWith("…")).toBe(true);
    for (let i = 0; i < MAX_QUOTES_PER_MARKER + 3; i += 1) parts = appendCitation(parts, 1, `q${i}`);
    expect((parts[0] as { quotes: readonly string[] }).quotes).toHaveLength(MAX_QUOTES_PER_MARKER);
  });

  it("never splits a character such as an emoji when shortening", () => {
    const parts = appendCitation([], 1, `${"x".repeat(MAX_QUOTE_CHARS - 2)}😀😀😀`);
    const quote = (parts[0] as { quotes: readonly string[] }).quotes[0] ?? "";
    expect(Array.from(quote)).toHaveLength(MAX_QUOTE_CHARS);
    expect(quote.endsWith("😀…")).toBe(true);
  });

  it("keeps a marker with no quote when the cited text is empty", () => {
    expect(appendCitation([], 3, "   ")).toEqual([{ kind: "cite", source: 3, quotes: [] }]);
  });

  it("does not change the parts it was given", () => {
    const before = Object.freeze([Object.freeze({ kind: "cite" as const, source: 1, quotes: Object.freeze(["a"]) })]);
    const after = appendCitation(before, 1, "b");
    expect(before[0]?.quotes).toEqual(["a"]);
    expect(after).not.toBe(before);
  });
});
