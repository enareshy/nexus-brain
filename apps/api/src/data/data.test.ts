import { beforeEach, describe, expect, it, vi } from "vitest";

// The database is faked; the real queries and row-level security are tested against Postgres.
const db = vi.hoisted(() => ({
  PurgeAuditError: class PurgeAuditError extends Error {
    constructor(
      readonly results: readonly unknown[],
      readonly tenantIds: readonly string[],
    ) {
      super("audit failed");
    }
  },
  getRetention: vi.fn(),
  saveRetention: vi.fn(),
  purgeExpired: vi.fn(),
  getProfile: vi.fn(),
  appendAudit: vi.fn(),
}));
vi.mock("@brain/db", () => db);

const { RetentionService } = await import("./retention.service.js");
const { ExportService } = await import("./export.service.js");
const { DataController } = await import("./data.controller.js");

const scope = { tenantId: "t1", userId: "u1" };
const ctx = (role: string) => ({ ...scope, requestId: "r", role, principals: [] }) as never;
const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  for (const fn of Object.values(db)) if (vi.isMockFunction(fn)) fn.mockReset();
  logger.info.mockReset();
  logger.error.mockReset();
});

describe("RetentionService", () => {
  it("keeps everything for a company that never set anything, and logs only counts when sweeping", async () => {
    const service = new RetentionService({ pool: {} as never, logger });
    db.getRetention.mockResolvedValue(null);
    expect(await service.get(scope)).toEqual({ conversationDays: null, agentRunDays: null });
    db.purgeExpired.mockResolvedValue([{ tenantId: "t1", conversations: 2, agentRuns: 1, notifications: 0 }]);
    await service.sweep();
    expect(logger.info).toHaveBeenCalledWith({ tenant_id: "t1", conversations: 2, agentRuns: 1, notifications: 0 }, "Expired data removed");
  });

  it("keeps going in rounds while there is more, and reports removals whose audit entry failed", async () => {
    const service = new RetentionService({ pool: {} as never, logger });
    const full = { tenantId: "t1", conversations: 1_000, agentRuns: 0, notifications: 0 };
    db.purgeExpired
      .mockResolvedValueOnce([full])
      .mockRejectedValueOnce(new db.PurgeAuditError([full], ["t1"]))
      .mockResolvedValueOnce([{ ...full, conversations: 3 }]);
    const removed = await service.sweep();
    expect(removed.map((r) => r.conversations)).toEqual([1_000, 1_000, 3]);
    expect(logger.error).toHaveBeenCalledWith({ tenant_ids: ["t1"] }, "Expired data removed without an audit entry");
    db.purgeExpired.mockResolvedValue([full]);
    expect(await service.sweep()).toHaveLength(20);
  });

  it("sweeps at start and then on a timer, and reports a failed sweep without stopping", async () => {
    vi.useFakeTimers();
    try {
      db.purgeExpired.mockRejectedValueOnce(new Error("down")).mockResolvedValue([]);
      const service = new RetentionService({ pool: {} as never, logger });
      service.start();
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith({ errorType: "Error" }, "Removing expired data failed");
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(db.purgeExpired).toHaveBeenCalledTimes(2);
      service.stop();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(db.purgeExpired).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ExportService and the data routes", () => {
  const sources = {
    conversations: { exportAll: async () => [{ id: "c1" }] },
    memories: { list: async () => [{ text: "m" }] },
    skills: { list: async () => [{ mine: true, name: "mine" }, { mine: false, name: "theirs" }] },
    agentRuns: { exportAll: async () => [] },
    automaticAgents: { list: async () => [] },
    changes: { exportAll: async (_s: unknown, limit: number) => Array.from({ length: limit }, () => ({})) },
    connections: { list: async () => [{ serverId: "s", displayName: "S", status: "connected", lastUsedAt: null, setup: "ready" }] },
    workGraph: { exportAll: async () => [{ source: "me", target: "s:1", kind: "opened", weight: 1, lastSeenAt: "2026-11-08T00:00:00.000Z" }] },
  };

  it("exports only the person's own skills and no connection details beyond status, once a minute", async () => {
    let now = 1_000_000;
    const service = new ExportService({ pool: {} as never, sources, logger, now: () => now });
    db.getProfile.mockResolvedValue({ email: "b@x", displayName: "B", role: "member" });
    db.appendAudit.mockResolvedValue(undefined);
    const data = await service.exportFor(scope);
    expect(data.skills).toEqual([{ mine: true, name: "mine" }]);
    expect(data.connections).toEqual([{ serverId: "s", displayName: "S", status: "connected", lastUsedAt: null }]);
    // As many changes as an export holds means some may be missing, and it says so.
    expect(data.truncated).toBe(true);
    await expect(service.exportFor(scope)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    now += 60_000;
    db.getProfile.mockResolvedValue(null);
    await expect(service.exportFor(scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("gives nothing out when the export cannot be recorded, and lets the person try again at once", async () => {
    const service = new ExportService({ pool: {} as never, sources, logger, now: () => 5 });
    db.getProfile.mockResolvedValue({ email: "b@x", displayName: "B", role: "member" });
    db.appendAudit.mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    await expect(service.exportFor(scope)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), "Audit write failed");
    expect((await service.exportFor(scope)).profile.email).toBe("b@x");
  });

  it("runs one export at a time per person, however long it takes", async () => {
    let finish = () => {};
    const slow = { ...sources, memories: { list: () => new Promise<never[]>((r) => { finish = () => r([]); }) } };
    let now = 0;
    const service = new ExportService({ pool: {} as never, sources: slow, logger, now: () => now });
    db.getProfile.mockResolvedValue({ email: "b@x", displayName: "B", role: "member" });
    db.appendAudit.mockResolvedValue(undefined);
    const first = service.exportFor(scope);
    await vi.waitFor(() => expect(db.getProfile).toHaveBeenCalled());
    now += 5 * 60_000;
    await expect(service.exportFor(scope)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    finish();
    await first;
    now += 60_000;
    db.getProfile.mockClear();
    const next = service.exportFor(scope);
    await vi.waitFor(() => expect(db.getProfile).toHaveBeenCalled());
    finish();
    await expect(next).resolves.toMatchObject({ profile: { email: "b@x" } });
  });

  it("lets only admins change retention, and passes reads and exports through", async () => {
    const retention = { get: vi.fn(async () => ({ conversationDays: null, agentRunDays: null })), set: vi.fn(async (_s, r) => r) };
    const exports = { exportFor: vi.fn(async () => ({ exportedAt: "x" }) as never) };
    const controller = new DataController(retention, exports);
    const body = { conversationDays: 30, agentRunDays: null };
    await expect(controller.setRetention(ctx("member"), body)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(controller.setRetention(ctx("admin"), { conversationDays: 0, agentRunDays: null })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await controller.setRetention(ctx("owner"), body)).data).toEqual(body);
    expect((await controller.getRetention(ctx("member"))).data).toEqual({ conversationDays: null, agentRunDays: null });
    expect((await controller.exportMine(ctx("member"))).data).toEqual({ exportedAt: "x" });
  });
});
