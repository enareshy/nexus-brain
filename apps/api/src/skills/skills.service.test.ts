import { createSecretBox } from "@brain/core";
import type { PoolLike, StoredSkill } from "@brain/db";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cleanSkill, MAX_SKILL_INSTRUCTIONS_CHARS, SKILL_TOOLS, SkillsService } from "./skills.service.js";

const good = { name: " Weekly status ", instructions: "Line one\r\n\tLine two ", tools: ["search_documents"], shared: false };

describe("cleanSkill", () => {
  it("trims, keeps line breaks and tabs in instructions, and orders and dedupes tools", () => {
    const tools = [...SKILL_TOOLS].reverse();
    expect(cleanSkill({ ...good, tools: [...tools, tools[0]!] })).toEqual({
      name: "Weekly status",
      instructions: "Line one\n\tLine two",
      tools: SKILL_TOOLS,
      shared: false,
    });
  });

  it("refuses hidden characters, empty or overlong text, and tools outside the agent's own", () => {
    for (const bad of [
      { ...good, name: "a\tb" },
      { ...good, name: "x".repeat(81) },
      { ...good, instructions: "a\u0007b" },
      { ...good, instructions: "a​b" },
      { ...good, instructions: "x".repeat(MAX_SKILL_INSTRUCTIONS_CHARS + 1) },
      { ...good, tools: [] },
      { ...good, tools: ["search_documents", "run_shell"] },
    ]) {
      expect(() => cleanSkill(bad)).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    }
  });
});

describe("a skill that cannot be read", () => {
  it("is listed as unreadable and cannot start a run", async () => {
    const row: StoredSkill = {
      id: "00000000-0000-4000-8000-000000000001",
      ownerId: "u",
      ownerName: "Bob",
      nameCiphertext: "damaged",
      instructionsCiphertext: "damaged",
      tools: ["search_documents", "gone_tool"],
      shared: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
    const pool = { connect: async () => client } as unknown as PoolLike;
    const logger = { error: vi.fn() };
    const service = new SkillsService({ pool, box: createSecretBox(randomBytes(32).toString("base64")), logger });
    const view = (service as unknown as { view(scope: unknown, row: StoredSkill): unknown }).view({ tenantId: "t", userId: "u" }, row);
    expect(view).toMatchObject({ readable: false, name: "", instructions: "", tools: ["search_documents"], mine: true });
    expect(logger.error).toHaveBeenCalled();
  });
});
