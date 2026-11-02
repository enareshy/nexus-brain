import { AGENT_SYSTEM, MODELS } from "@brain/llm-gateway";
import { createHash } from "node:crypto";
import { AGENT_TOOLS } from "./tools.js";

/** Identifies what the agent evals measured. When this changes, the recording no longer applies. */
export function agentFingerprint(): string {
  return createHash("sha256")
    .update(JSON.stringify({ system: AGENT_SYSTEM, tools: AGENT_TOOLS, model: MODELS.agent }))
    .digest("hex");
}
