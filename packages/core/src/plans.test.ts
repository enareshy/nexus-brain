import { describe, expect, it } from "vitest";
import { creditsFor, isPlanId, planLabel, PLANS } from "./plans.js";

describe("plans and credits (FR-MET-02)", () => {
  it("knows only the listed plans, and names an unlisted one by its id", () => {
    expect(isPlanId("team")).toBe(true);
    expect(isPlanId("toString")).toBe(false);
    expect(planLabel("business")).toBe(PLANS.business.label);
    expect(planLabel("legacy")).toBe("legacy");
  });

  it("counts a part-used credit as used, without floating-point surprises", () => {
    expect(creditsFor(0)).toBe(0);
    expect(creditsFor(0.0001)).toBe(1);
    expect(creditsFor(0.3)).toBe(30);
    expect(creditsFor(1.07)).toBe(107);
    expect(creditsFor(12.345678)).toBe(1235);
  });
});
