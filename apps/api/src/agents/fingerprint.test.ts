import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentFingerprint } from "./fingerprint.js";

describe("the agent eval recording", () => {
  it("matches the current prompt, tools and model", () => {
    const recording = JSON.parse(readFileSync("../../packages/evals/golden/agent-results.json", "utf8")) as { agentFingerprint: string };
    // If this fails, re-run scripts/agent-eval.ts, because the results no longer describe this agent.
    expect(recording.agentFingerprint).toBe(agentFingerprint());
  });
});
