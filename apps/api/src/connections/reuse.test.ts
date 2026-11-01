import type { McpSession } from "@brain/mcp-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionPool } from "./session-pool.js";
import { TtlCache } from "./ttl-cache.js";

function fakeSession(closeError?: Error): McpSession {
  return {
    listTools: async () => [],
    callTool: async () => ({ text: "", isError: false, truncated: false }),
    close: vi.fn(async () => {
      if (closeError) throw closeError;
    }),
  };
}

describe("TtlCache", () => {
  let now = 1_000;
  const cache = () => new TtlCache<string>(2, () => now);

  beforeEach(() => {
    now = 1_000;
  });

  it("returns values until they expire", () => {
    const c = cache();
    c.set("a", "1", 100);
    expect(c.get("a")).toBe("1");
    now += 99;
    expect(c.get("a")).toBe("1");
    now += 1;
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("evicts the oldest entry at the size bound", () => {
    const c = cache();
    c.set("a", "1", 100);
    c.set("b", "2", 100);
    c.set("c", "3", 100);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("c")).toBe("3");
    expect(c.size).toBe(2);
  });

  it("does not evict when replacing an existing key", () => {
    const c = cache();
    c.set("a", "1", 100);
    c.set("b", "2", 100);
    c.set("b", "3", 100);
    expect(c.get("a")).toBe("1");
    expect(c.get("b")).toBe("3");
  });

  it("removes expired entries before evicting live ones", () => {
    const c = cache();
    c.set("short", "1", 10);
    c.set("long", "2", 1_000);
    now += 50;
    c.set("new", "3", 1_000);
    expect(c.get("long")).toBe("2");
    expect(c.get("new")).toBe("3");
  });

  it("deletes only the given prefix", () => {
    const c = new TtlCache<string>(10, () => now);
    c.set("tenant|alice|jira|x", "1", 100);
    c.set("tenant|alice|jira|y", "2", 100);
    c.set("tenant|bob|jira|x", "3", 100);
    c.deleteByPrefix("tenant|alice|jira|");
    expect(c.size).toBe(1);
    expect(c.get("tenant|bob|jira|x")).toBe("3");
  });
});

describe("SessionPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const pool = (onCloseError?: (e: unknown) => void) =>
    new SessionPool({ idleMs: 1_000, maxSessions: 2, onCloseError });

  it("hands a session to one caller at a time", () => {
    const p = pool();
    const s = fakeSession();
    p.put("alice", s);
    expect(p.take("alice")).toBe(s);
    expect(p.take("alice")).toBeNull();
  });

  it("never returns another key's session", () => {
    const p = pool();
    p.put("alice", fakeSession());
    expect(p.take("bob")).toBeNull();
  });

  it("closes sessions after the idle time", () => {
    const p = pool();
    const s = fakeSession();
    p.put("alice", s);
    vi.advanceTimersByTime(999);
    expect(s.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(s.close).toHaveBeenCalledOnce();
    expect(p.size).toBe(0);
  });

  it("does not close a session that was taken before the idle time", () => {
    const p = pool();
    const s = fakeSession();
    p.put("alice", s);
    p.take("alice");
    vi.advanceTimersByTime(5_000);
    expect(s.close).not.toHaveBeenCalled();
  });

  it("closes the session it replaces and the oldest at the size bound", () => {
    const p = pool();
    const [a, b, c, d] = [fakeSession(), fakeSession(), fakeSession(), fakeSession()];
    p.put("alice", a);
    p.put("alice", b);
    expect(a.close).toHaveBeenCalledOnce();
    p.put("bob", c);
    p.put("carol", d);
    expect(b.close).toHaveBeenCalledOnce();
    expect(p.size).toBe(2);
  });

  it("evicts one key and closes all", () => {
    const p = pool();
    const [a, b] = [fakeSession(), fakeSession()];
    p.put("alice", a);
    p.put("bob", b);
    p.evict("alice");
    expect(a.close).toHaveBeenCalledOnce();
    p.evict("nobody");
    p.closeAll();
    expect(b.close).toHaveBeenCalledOnce();
    expect(p.size).toBe(0);
  });

  it("closes instead of keeping a session returned after shutdown", () => {
    const p = pool();
    p.closeAll();
    const s = fakeSession();
    p.put("alice", s);
    expect(s.close).toHaveBeenCalledOnce();
    expect(p.size).toBe(0);
  });

  it("reports close failures instead of throwing", async () => {
    const onCloseError = vi.fn();
    const p = pool(onCloseError);
    p.put("alice", fakeSession(new Error("gone")));
    p.evict("alice");
    await vi.waitFor(() => expect(onCloseError).toHaveBeenCalledOnce());
  });
});
