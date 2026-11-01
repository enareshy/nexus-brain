import { describe, expect, it } from "vitest";
import { argsHash, canonicalJson, classifyTool, isApprovable } from "./write-policy.js";

const manifest = { create: "write", comment: "external-effect" } as const;
const tool = (name: string, annotations: Record<string, unknown> = {}) => ({ name, annotations });

describe("classifyTool (FR-WR-01)", () => {
  it("uses the manifest for listed tools", () => {
    expect(classifyTool(manifest, tool("create"))).toBe("write");
    expect(classifyTool(manifest, tool("comment"))).toBe("external-effect");
  });

  it("treats a read-only tool as read", () => {
    expect(classifyTool(manifest, tool("get", { readOnlyHint: true }))).toBe("read");
  });

  it("treats anything unknown as destructive", () => {
    expect(classifyTool(manifest, tool("unknown"))).toBe("destructive");
    expect(classifyTool(manifest, tool("unknown", { destructiveHint: false }))).toBe("destructive");
  });

  it("lets a server's destructive hint override the manifest", () => {
    expect(classifyTool(manifest, tool("create", { destructiveHint: true }))).toBe("destructive");
    expect(classifyTool(manifest, tool("get", { readOnlyHint: true, destructiveHint: true }))).toBe("destructive");
  });

  it("does not resolve tool names through the object prototype", () => {
    expect(classifyTool(manifest, tool("constructor"))).toBe("destructive");
  });
});

describe("isApprovable (FR-WR-03)", () => {
  it("allows only write and external-effect tools", () => {
    expect(isApprovable("write")).toBe(true);
    expect(isApprovable("external-effect")).toBe(true);
    expect(isApprovable("destructive")).toBe(false);
    expect(isApprovable("read")).toBe(false);
  });
});

describe("argsHash (FR-WR-02)", () => {
  it("does not depend on key order", () => {
    expect(argsHash({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      argsHash({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }),
    );
  });

  it("changes when any value changes", () => {
    expect(argsHash({ summary: "a" })).not.toBe(argsHash({ summary: "b" }));
    expect(argsHash({ list: [1, 2] })).not.toBe(argsHash({ list: [2, 1] }));
  });

  it("writes sorted JSON", () => {
    expect(canonicalJson({ b: 1, a: ["x", null] })).toBe('{"a":["x",null],"b":1}');
  });
});
