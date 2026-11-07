// A lock shared by every API server, for work that must not run twice at once, such as using a
// connection whose refresh token can only be used once.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSharedLock } from "./advisory-lock.js";
import { createAppPool } from "./pool.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";

let owner: pg.Client;
let serverA: pg.Pool;
let serverB: pg.Pool;

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  serverA = createAppPool({ connectionString: APP_URL, max: 2, detectDeadPeers: true, onError: () => {} });
  serverB = createAppPool({ connectionString: APP_URL, max: 2, onError: () => {} });
});

afterAll(async () => {
  await owner?.end();
  await serverA?.end();
  await serverB?.end();
});

describe("withSharedLock", () => {
  it("runs work for one key on one server at a time, and other keys freely", async () => {
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withSharedLock(serverA, "conn|t|u|jira", 5_000, async () => {
      order.push("a start");
      await gate;
      order.push("a end");
    });
    await later(100);
    const second = withSharedLock(serverB, "conn|t|u|jira", 5_000, async () => {
      order.push("b");
    });
    const other = withSharedLock(serverB, "conn|t|u|github", 5_000, async () => {
      order.push("other");
    });
    await other;
    await later(100);
    expect(order).toEqual(["a start", "other"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a start", "other", "a end", "b"]);
  });

  it("gives up waiting after the limit, saying the service is busy", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withSharedLock(serverA, "conn|busy", 5_000, () => gate);
    await later(100);
    await expect(withSharedLock(serverB, "conn|busy", 200, async () => "never")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    release();
    await holder;
    // A wait that gave up leaves nothing behind.
    await expect(withSharedLock(serverB, "conn|busy", 1_000, async () => "ok")).resolves.toBe("ok");
  });

  it("says the service is busy when no lock connection is free", async () => {
    const unreachable = createAppPool({ connectionString: "postgres://brain_app:brain_app@127.0.0.1:1/brain_test", max: 1, onError: () => {} });
    try {
      await expect(withSharedLock(unreachable, "conn|nopool", 1_000, async () => "never")).rejects.toMatchObject({
        code: "UNAVAILABLE",
        details: { reason: "lock_pool" },
      });
    } finally {
      await unreachable.end();
    }
  });

  it("frees the lock when the work fails, and returns its result otherwise", async () => {
    await expect(withSharedLock(serverA, "conn|fail", 1_000, async () => { throw new Error("work failed"); })).rejects.toThrow("work failed");
    await expect(withSharedLock(serverB, "conn|fail", 1_000, async () => 42)).resolves.toBe(42);
  });

  it("frees the lock when the server holding it loses its database connection", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withSharedLock(serverA, "conn|crash", 5_000, () => gate);
    await later(100);
    const lock = await owner.query(
      "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objid = (hashtextextended('conn|crash', 0) & x'ffffffff'::bigint)::oid",
    );
    expect(lock.rows).toHaveLength(1);
    await owner.query("SELECT pg_terminate_backend($1)", [lock.rows[0].pid]);
    await expect(withSharedLock(serverB, "conn|crash", 2_000, async () => "taken over")).resolves.toBe("taken over");
    release();
    await holder.catch(() => undefined);
  });

  it("asks Postgres to notice a server that died without closing its connection", async () => {
    const client = await serverA.connect();
    try {
      const { rows } = await client.query("SELECT current_setting('tcp_keepalives_idle') AS idle, current_setting('tcp_user_timeout') AS gone");
      expect(rows[0]).toEqual({ idle: "30", gone: "60000" });
    } finally {
      client.release();
    }
  });

  it("does not leave a lock wait limit on connections returned to the pool", async () => {
    await withSharedLock(serverA, "conn|reset", 1_000, async () => undefined);
    const client = await serverA.connect();
    try {
      const { rows } = await client.query("SHOW lock_timeout");
      expect(rows[0].lock_timeout).toBe("0");
    } finally {
      client.release();
    }
  });
});
