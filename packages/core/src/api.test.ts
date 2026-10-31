import { describe, expect, it } from "vitest";
import { fail, ok } from "./api.js";
import { AppError, isAppError } from "./errors.js";

describe("api envelope", () => {
  it("wraps success data", () => {
    expect(ok({ a: 1 })).toEqual({ success: true, data: { a: 1 }, error: null });
  });

  it("includes meta when provided", () => {
    expect(ok([], { total: 0 }).meta).toEqual({ total: 0 });
  });

  it("wraps failures", () => {
    expect(fail("NOT_FOUND", "missing", { requestId: "r1" })).toEqual({
      success: false,
      data: null,
      error: { code: "NOT_FOUND", message: "missing" },
      meta: { requestId: "r1" },
    });
  });

  it("omits meta on failures without it", () => {
    expect(fail("INTERNAL", "boom")).not.toHaveProperty("meta");
  });
});

describe("AppError", () => {
  it("maps codes to HTTP status and freezes details", () => {
    const err = new AppError("FORBIDDEN", "no", { reason: "x" });
    expect(err.status).toBe(403);
    expect(Object.isFrozen(err.details)).toBe(true);
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
  });

  it("leaves details undefined when none are given", () => {
    expect(new AppError("INTERNAL", "x").details).toBeUndefined();
  });
});
