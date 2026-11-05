import { describe, expect, it } from "vitest";
import { parsePlanArgs } from "./plan-args.js";
import { formatReport, parseBill, reconcile } from "./reconcile.js";

describe("parseBill", () => {
  it("reads model,cost_usd lines, ignoring blank lines and Windows line endings", () => {
    expect(parseBill("\uFEFFmodel,cost_usd\r\nclaude-opus-5-5,10.50\r\n\r\nclaude-opus-5-5,1.5\nclaude-haiku-5-5,0\n")).toEqual([
      { model: "claude-opus-5-5", costUsd: 10.5 },
      { model: "claude-opus-5-5", costUsd: 1.5 },
      { model: "claude-haiku-5-5", costUsd: 0 },
    ]);
  });

  it("refuses a missing header, extra columns, bad models and bad amounts", () => {
    for (const csv of ["claude,1", "model,cost_usd\na,1,2", "model,cost_usd\nbad model,1", "model,cost_usd\na,-1", "model,cost_usd\na,", "model,cost_usd\na,x"]) {
      expect(() => parseBill(csv)).toThrow();
    }
  });
});

describe("reconcile (FR-MET-04)", () => {
  it("passes within 3% overall and shows each model's difference", () => {
    const report = reconcile(
      [
        { model: "opus", costUsd: 100 },
        { model: "opus", costUsd: 2 },
        { model: "haiku", costUsd: 1 },
      ],
      [
        { model: "opus", costUsd: 100 },
        { model: "haiku", costUsd: 1.02 },
      ],
    );
    expect(report).toMatchObject({ ledgerUsd: 103, billedUsd: 101.02, withinTolerance: true });
    expect(report.lines.map((l) => l.model)).toEqual(["haiku", "opus"]);
    expect(report.lines[1]!.difference).toBeCloseTo(0.02);
    expect(formatReport("2026-10", report)).toMatch(/Within 3\.0%\.$/);
  });

  it("fails beyond 3%, with unpriced calls, or when only the ledger has costs", () => {
    expect(reconcile([{ model: "opus", costUsd: 90 }], [{ model: "opus", costUsd: 100 }]).withinTolerance).toBe(false);
    const unpriced = reconcile([{ model: "opus", costUsd: 100 }], [{ model: "opus", costUsd: 100 }], 2);
    expect(unpriced.withinTolerance).toBe(false);
    expect(formatReport("2026-10", unpriced)).toContain("2 calls had no known price");
    const unbilled = reconcile([{ model: "new", costUsd: 5 }], []);
    expect(unbilled).toMatchObject({ difference: null, withinTolerance: false });
    expect(formatReport("2026-10", unbilled)).toMatch(/n\/a[\s\S]*Not within/);
    expect(reconcile([], []).withinTolerance).toBe(true);
  });

  it("fails when models are off in opposite directions, even if the total matches", () => {
    const report = reconcile(
      [
        { model: "opus", costUsd: 120 },
        { model: "haiku", costUsd: 80 },
        { model: "tiny", costUsd: 0.001 },
      ],
      [
        { model: "opus", costUsd: 100 },
        { model: "haiku", costUsd: 100 },
      ],
    );
    expect(report.difference).toBeCloseTo(0, 4);
    expect(report).toMatchObject({ modelsOff: ["haiku", "opus"], withinTolerance: false });
    expect(formatReport("2026-10", report)).toContain("Off by more than 3.0%: haiku, opus.");
  });
});

describe("parsePlanArgs", () => {
  const tenant = "00000000-0000-4000-8000-000000000001";

  it("uses the plan's own credits unless given others", () => {
    expect(parsePlanArgs([tenant, "team"])).toEqual({ tenantId: tenant, plan: { plan: "team", monthlyCredits: 20_000 } });
    expect(parsePlanArgs([tenant, "pilot", "0"]).plan.monthlyCredits).toBe(0);
  });

  it("refuses bad tenants, unknown plans and bad credit counts", () => {
    for (const args of [[tenant], ["acme", "team"], [tenant, "gold"], [tenant, "team", "1.5"], [tenant, "team", "-1"], [tenant, "team", "1", "x"], [tenant, "team", ""], [tenant, "team", " 5"], [tenant, "team", "1e3"]]) {
      expect(() => parsePlanArgs(args)).toThrow();
    }
  });
});
