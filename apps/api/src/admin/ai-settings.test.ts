import { beforeEach, describe, expect, it, vi } from "vitest";

// The database is faked; the real queries and row-level security are tested against Postgres.
const db = vi.hoisted(() => ({
  MAX_AUTOMATIC_RUNS_PER_DAY: 10,
  getAiSettings: vi.fn(),
  saveAiSettings: vi.fn(),
}));
vi.mock("@brain/db", () => db);

const { AiSettingsService } = await import("./ai-settings.service.js");
const { AiSettingsController } = await import("./ai-settings.controller.js");

const scope = { tenantId: "t1", userId: "u1" };
const ctx = (role: string) => ({ ...scope, requestId: "r", role, principals: [] }) as never;
const settings = { modelChoice: "standard", agentsEnabled: true, automaticAgentsEnabled: false, automaticRunsPerDay: 4, agentChangesAllowed: true } as const;

beforeEach(() => {
  db.getAiSettings.mockReset();
  db.saveAiSettings.mockReset();
});

describe("AI settings (FR-ADM-02)", () => {
  it("reads the company's settings and saves an admin's change", async () => {
    const controller = new AiSettingsController(new AiSettingsService({ pool: {} as never }));
    db.getAiSettings.mockResolvedValue(settings);
    expect((await controller.get(ctx("member"))).data).toEqual(settings);
    expect(db.getAiSettings).toHaveBeenCalledWith({}, "t1");

    expect((await controller.set(ctx("admin"), settings)).data).toEqual(settings);
    expect(db.saveAiSettings).toHaveBeenCalledWith({}, scope, settings);
  });

  it("refuses members and anything outside the allowed values, before touching the database", async () => {
    const controller = new AiSettingsController(new AiSettingsService({ pool: {} as never }));
    await expect(controller.set(ctx("member"), settings)).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const bad of [{ ...settings, automaticRunsPerDay: 11 }, { ...settings, modelChoice: "huge" }, { ...settings, extra: true }, null]) {
      await expect(controller.set(ctx("owner"), bad)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(db.saveAiSettings).not.toHaveBeenCalled();
  });
});
