import { beforeEach, describe, expect, it, vi } from "vitest";

// The database is faked; the real queries and row-level security are tested against Postgres.
const db = vi.hoisted(() => ({
  MAX_AUTOMATIC_RUNS_PER_DAY: 10,
  getAiSettings: vi.fn(),
  saveAiSettings: vi.fn(),
  getAiPreferences: vi.fn(),
  setModelPreference: vi.fn(),
  effectiveModel: (s: { modelChoice: string; peopleChooseModel: boolean }, personal: string | null) =>
    s.peopleChooseModel && personal ? personal : s.modelChoice,
}));
vi.mock("@brain/db", () => db);

const { AiSettingsService } = await import("./ai-settings.service.js");
const { AiSettingsController } = await import("./ai-settings.controller.js");

const scope = { tenantId: "t1", userId: "u1" };
const ctx = (role: string) => ({ ...scope, requestId: "r", role, principals: [] }) as never;
const settings = { modelChoice: "standard", agentsEnabled: true, automaticAgentsEnabled: false, automaticRunsPerDay: 4, agentChangesAllowed: true, peopleChooseModel: false } as const;

beforeEach(() => {
  db.getAiSettings.mockReset();
  db.saveAiSettings.mockReset();
  db.getAiPreferences.mockReset();
  db.setModelPreference.mockReset();
});

describe("a person's own model (FR-LLM-07)", () => {
  const controller = () => new AiSettingsController(new AiSettingsService({ pool: {} as never }));

  it("shows what they use, and lets them choose while the company allows it", async () => {
    db.getAiSettings.mockResolvedValue({ ...settings, modelChoice: "premium", peopleChooseModel: true });
    db.getAiPreferences.mockResolvedValueOnce({ mode: "ask", modelChoice: null }).mockResolvedValue({ mode: "ask", modelChoice: "standard" });
    expect((await controller().personalModel(ctx("member"))).data).toEqual({ modelChoice: null, companyModel: "premium", peopleCanChoose: true, inUse: "premium" });
    expect((await controller().setPersonalModel(ctx("member"), { modelChoice: "standard" })).data).toMatchObject({ modelChoice: "standard", inUse: "standard" });
    expect(db.setModelPreference).toHaveBeenCalledWith({}, scope, "standard");
  });

  it("refuses a choice while the company uses one model, but always lets them go back to it", async () => {
    db.getAiSettings.mockResolvedValue({ ...settings, modelChoice: "premium", peopleChooseModel: false });
    db.getAiPreferences.mockResolvedValue({ mode: "ask", modelChoice: "standard" });
    expect((await controller().personalModel(ctx("member"))).data).toMatchObject({ modelChoice: "standard", inUse: "premium" });
    await expect(controller().setPersonalModel(ctx("member"), { modelChoice: "standard" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.setModelPreference).not.toHaveBeenCalled();
    await controller().setPersonalModel(ctx("member"), { modelChoice: null });
    expect(db.setModelPreference).toHaveBeenCalledWith({}, scope, null);
    for (const bad of [{ modelChoice: "huge" }, { modelChoice: "standard", extra: 1 }, {}, null]) {
      await expect(controller().setPersonalModel(ctx("member"), bad)).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });
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
