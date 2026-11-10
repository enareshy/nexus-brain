import type { RankingExample } from "@brain/connectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrainingStore } from "./train.js";
import { RankerTrainer } from "./trainer.service.js";

/** 250 answers whose cited result is always a recent GitHub item, wherever it sat. */
function learnable(): RankingExample[] {
  const rows: RankingExample[] = [];
  for (let g = 0; g < 250; g += 1) {
    for (let position = 0; position < 5; position += 1) {
      const winner = position === g % 5;
      rows.push({ group: `g${g}`, serverId: winner ? "github" : "atlassian", position, scoreRatio: 1 - position * 0.1, ageDays: winner ? 2 : 200, label: winner ? 1 : 0 });
    }
  }
  return rows;
}

function setup(over: Partial<TrainingStore> = {}, exclusive?: <T>(work: () => Promise<T>) => Promise<T | null>) {
  const save = vi.fn<TrainingStore["save"]>(async () => {});
  const store: TrainingStore = {
    companies: async () => ["t-good", "t-few"],
    examples: async (tenantId) => (tenantId === "t-good" ? learnable() : learnable().slice(0, 50)),
    save,
    ...over,
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { trainer: new RankerTrainer({ store, logger, ...(exclusive ? { exclusive } : {}) }), save, logger };
}

describe("RankerTrainer", () => {
  it("trains every company and saves each result, switching on only where it helps", async () => {
    const { trainer, save, logger } = setup();
    const results = await trainer.trainAll();
    expect(results?.map((r) => [r.tenantId, r.metrics.active, r.metrics.reason])).toEqual([
      ["t-good", true, "better"],
      ["t-few", false, "too_few"],
    ]);
    expect(save.mock.calls.map(([tenantId, model]) => [tenantId, model === null])).toEqual([
      ["t-good", false],
      ["t-few", true],
    ]);
    // Counts only in the log.
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/github|atlassian/);
  });

  it("keeps training the others when one company fails, logging only its id", async () => {
    const { trainer, save, logger } = setup({
      examples: async (tenantId) => {
        if (tenantId === "t-good") throw new Error("connection reset");
        return learnable();
      },
    });
    const results = await trainer.trainAll();
    expect(results?.map((r) => r.tenantId)).toEqual(["t-few"]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith({ tenant_id: "t-good", errorType: "Error" }, "Training a company's ranker failed");
  });

  it("skips a round another server is already running", async () => {
    const { trainer, save, logger } = setup({}, async () => null);
    expect(await trainer.trainAll()).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith({}, expect.stringMatching(/skipped/));
  });
});

describe("RankerTrainer on its timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits a little after start, then trains once a day, and stops when asked", async () => {
    const companies = vi.fn(async () => [] as string[]);
    const { trainer } = setup({ companies });
    trainer.start();
    trainer.start();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(companies).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(companies).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(companies).toHaveBeenCalledTimes(2);
    trainer.stop();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);
    expect(companies).toHaveBeenCalledTimes(2);
  });

  it("carries on with the next round after one fails", async () => {
    const companies = vi.fn(async () => {
      throw new Error("db down");
    });
    const { trainer, logger } = setup({ companies });
    trainer.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(logger.error).toHaveBeenCalledWith({ errorType: "Error" }, "Ranker training failed");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(companies).toHaveBeenCalledTimes(2);
    trainer.stop();
  });
});
