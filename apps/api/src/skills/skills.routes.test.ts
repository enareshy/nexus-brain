import { createSecretBox } from "@brain/core";
import type { StoredSkill } from "@brain/db";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The database calls are faked here; row-level security itself is tested against Postgres.
const db = vi.hoisted(() => ({
  rows: [] as StoredSkill[],
  addSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  appendAudit: vi.fn(),
}));
vi.mock("@brain/db", () => ({
  listSkills: async () => db.rows,
  getSkill: async (_pool: unknown, _scope: unknown, id: string) => db.rows.find((row) => row.id === id) ?? null,
  addSkill: db.addSkill,
  updateSkill: db.updateSkill,
  deleteSkill: db.deleteSkill,
  appendAudit: db.appendAudit,
}));

const { SkillsController } = await import("./skills.controller.js");
const { SkillsService } = await import("./skills.service.js");

const scope = { tenantId: "t1", userId: "u1" };
const ctx = { ...scope, requestId: "r", role: "member", principals: [] } as never;
const box = createSecretBox(randomBytes(32).toString("base64"));
const logger = { error: vi.fn() };
const ID = "00000000-0000-4000-8000-000000000001";
const input = { name: "Weekly", instructions: "Do it", tools: ["search_documents"], shared: true };

function storeRow(id: string, owner = "u1"): StoredSkill {
  const row: StoredSkill = {
    id,
    ownerId: owner,
    ownerName: "Bob",
    nameCiphertext: box.seal("Weekly", `skill|t1|${id}|name`),
    instructionsCiphertext: box.seal("Do it", `skill|t1|${id}|instructions`),
    tools: ["search_documents"],
    shared: true,
    createdAt: new Date("2026-11-05T00:00:00Z"),
    updatedAt: new Date("2026-11-05T00:00:00Z"),
  };
  db.rows = [...db.rows.filter((r) => r.id !== id), row];
  return row;
}

beforeEach(() => {
  db.rows = [];
  for (const fn of [db.addSkill, db.updateSkill, db.deleteSkill, db.appendAudit]) fn.mockReset();
  db.appendAudit.mockResolvedValue(undefined);
});

describe("the skills service and routes", () => {
  const service = new SkillsService({ pool: {} as never, box, logger });
  const controller = new SkillsController(service);

  it("adds a sealed skill, audits it without its text, and returns it", async () => {
    db.addSkill.mockImplementation(async (_pool, _scope, skill: { id: string }) => {
      storeRow(skill.id);
      return true;
    });
    const added = await controller.add(ctx, input);
    expect(added.data).toMatchObject({ name: "Weekly", instructions: "Do it", mine: true, readable: true });
    const stored = db.addSkill.mock.calls[0]![2] as { nameCiphertext: string };
    expect(stored.nameCiphertext).not.toContain("Weekly");
    expect(JSON.stringify(db.appendAudit.mock.calls)).not.toMatch(/Weekly|Do it/);
  });

  it("refuses an add over the limit, and bad requests before the service", async () => {
    db.addSkill.mockResolvedValue(false);
    await expect(controller.add(ctx, input)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(controller.add(ctx, { ...input, extra: 1 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(controller.update(ctx, "not-a-uuid", input)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("updates and deletes only what the owner can change", async () => {
    storeRow(ID);
    db.updateSkill.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await controller.update(ctx, ID, input)).data.id).toBe(ID);
    await expect(controller.update(ctx, ID, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    db.deleteSkill.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await controller.remove(ctx, ID)).data).toEqual({ deleted: true });
    await expect(controller.remove(ctx, ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists skills and the tools a skill may use", async () => {
    storeRow(ID, "someone-else");
    expect((await controller.list(ctx)).data).toEqual([expect.objectContaining({ id: ID, mine: false, ownerName: "Bob" })]);
    expect(controller.tools(ctx).data).toContain("search_documents");
  });

  it("gives a run the skill only at the version the person read", async () => {
    storeRow(ID, "someone-else");
    await expect(service.forRun(scope, ID, "2026-11-05T00:00:00.000Z")).resolves.toMatchObject({ id: ID, mine: false, tools: ["search_documents"] });
    await expect(service.forRun(scope, ID, "2026-11-04T00:00:00.000Z")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.forRun(scope, "00000000-0000-4000-8000-000000000009", "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("logs rather than fails when the audit write fails", async () => {
    storeRow(ID);
    db.deleteSkill.mockResolvedValue(true);
    db.appendAudit.mockRejectedValue(new Error("down"));
    await service.remove(scope, ID);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ action: "skill.deleted" }), "Audit write failed");
  });
});
