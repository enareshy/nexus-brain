import type { ToolInfo } from "@brain/mcp-client";
import { createHash } from "node:crypto";

/** FR-WR-01. Unknown tools are destructive, and destructive tools can never be called. */
export type ToolClass = "read" | "write" | "external-effect" | "destructive";

export type WriteManifest = Readonly<Record<string, "write" | "external-effect">>;

/** A server's destructive hint always wins; its other hints never upgrade a tool to callable. */
export function classifyTool(manifest: WriteManifest, tool: Pick<ToolInfo, "name" | "annotations">): ToolClass {
  if (tool.annotations.destructiveHint === true) return "destructive";
  if (Object.hasOwn(manifest, tool.name)) return manifest[tool.name]!;
  return tool.annotations.readOnlyHint === true ? "read" : "destructive";
}

export function isApprovable(toolClass: ToolClass): toolClass is "write" | "external-effect" {
  return toolClass === "write" || toolClass === "external-effect";
}

/** JSON with sorted object keys, so a value hashes the same after a database round trip. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What an approval binds to (FR-WR-02): any change to the arguments changes the hash. */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}
