import { describe, expect, it, vi } from "vitest";
import { createMemoryRateLimiter, createPgRateLimiter, releaseQuietly, type RateLimiter } from "./rate-limiter.js";

const bob = { tenantId: "t1", userId: "bob" };
const pat = { tenantId: "t1", userId: "pat" };
const limit = { bucket: "answer", max: 2, windowMs: 1_000 };

describe("createMemoryRateLimiter", () => {
  it("allows up to the limit per person and kind, then frees uses as they expire", async () => {
    let clock = 0;
    const limiter = createMemoryRateLimiter(() => clock);
    expect(await limiter.take(bob, limit)).not.toBeNull();
    expect(await limiter.take(bob, limit)).not.toBeNull();
    expect(await limiter.take(bob, limit)).toBeNull();
    expect(await limiter.take(pat, limit)).not.toBeNull();
    expect(await limiter.take(bob, { ...limit, bucket: "export" })).not.toBeNull();

    clock = 999;
    expect(await limiter.take(bob, limit)).toBeNull();
    clock = 1_000;
    expect(await limiter.take(bob, limit)).not.toBeNull();
  });

  it("gives a use back, but only for its owner", async () => {
    const limiter = createMemoryRateLimiter(() => 0);
    const first = (await limiter.take(bob, { ...limit, max: 1 })) as string;
    await limiter.release(pat, first);
    expect(await limiter.take(bob, { ...limit, max: 1 })).toBeNull();
    await limiter.release(bob, first);
    expect(await limiter.take(bob, { ...limit, max: 1 })).not.toBeNull();
  });
});

describe("createPgRateLimiter", () => {
  const person = { tenantId: "0a000000-0000-4000-8000-000000000001", userId: "0a000000-0000-4000-8000-0000000000a4" };
  it("allows nothing and asks the person to retry when the database cannot be reached", async () => {
    const pool = { connect: async () => { throw new Error("ECONNREFUSED"); } } as never;
    await expect(createPgRateLimiter(pool).take(person, limit)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reason: "rate_limit_store", errorType: "Error" },
    });
    // So is a failure part-way through counting.
    const broken = { connect: async () => ({ query: async () => { throw new TypeError("bad"); }, release: () => {} }) } as never;
    await expect(createPgRateLimiter(broken).take(person, limit)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reason: "rate_limit_store", errorType: "TypeError" },
    });
  });
});

describe("releaseQuietly", () => {
  const failing = (times: number): RateLimiter & { calls: number } => {
    const limiter = {
      calls: 0,
      take: async () => null,
      release: async () => {
        limiter.calls += 1;
        if (limiter.calls <= times) throw new Error("blip");
      },
    };
    return limiter;
  };

  it("tries once more after a failure", async () => {
    const limiter = failing(1);
    const onError = vi.fn();
    await releaseQuietly(limiter, bob, "id", onError);
    expect(limiter.calls).toBe(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a second failure instead of throwing", async () => {
    const limiter = failing(2);
    const onError = vi.fn();
    await expect(releaseQuietly(limiter, bob, "id", onError)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
