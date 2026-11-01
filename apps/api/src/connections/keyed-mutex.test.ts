import { describe, expect, it } from "vitest";
import { KeyedMutex } from "./keyed-mutex.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("KeyedMutex", () => {
  it("runs work for the same key one at a time, in order", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([mutex.run("k", job("a")), mutex.run("k", job("b"))]);
    expect(results).toEqual(["a", "b"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("runs different keys concurrently", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
    };
    await Promise.all([mutex.run("k1", job("a")), mutex.run("k2", job("b"))]);
    expect(log.slice(0, 2)).toEqual(["start a", "start b"]);
  });

  it("keeps going after a failure and cleans up keys", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(mutex.run("k", async () => "ok")).resolves.toBe("ok");
    expect(mutex.size).toBe(0);
  });
});
