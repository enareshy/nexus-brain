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

/** Waits until some server holds the lock on `key`, rather than guessing how long that takes. */
async function untilHeld(key: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { rows } = await owner.query(
      "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND objid = (hashtextextended($1, 0) & x'ffffffff'::bigint)::oid",
      [key],
    );
    if (rows.length > 0) return;
    await later(10);
  }
  throw new Error(`lock ${key} was never taken`);
}

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
    await untilHeld("conn|t|u|jira");
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
    await untilHeld("conn|busy");
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

  it("stops waiting at once when the request is cancelled, and gives its connection back", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withSharedLock(serverA, "conn|cancel", 5_000, () => gate);
    await untilHeld("conn|cancel");
    const controller = new AbortController();
    const started = Date.now();
    const waiting = withSharedLock(serverB, "conn|cancel", 5_000, async () => "never", controller.signal);
    setTimeout(() => controller.abort(), 150);
    await expect(waiting).rejects.toMatchObject({ code: "UNAVAILABLE", details: { reason: "lock_cancelled" } });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Already cancelled: nothing is asked of the database at all.
    await expect(withSharedLock(serverB, "conn|cancel", 5_000, async () => "never", controller.signal)).rejects.toMatchObject({
      details: { reason: "lock_cancelled" },
    });
    // Both of the other server's connections are free again.
    const [one, two] = await Promise.all([serverB.connect(), serverB.connect()]);
    one.release();
    two.release();
    release();
    await holder;
  });

  it("frees the lock when the work fails, and returns its result otherwise", async () => {
    await expect(withSharedLock(serverA, "conn|fail", 1_000, async () => { throw new Error("work failed"); })).rejects.toThrow("work failed");
    await expect(withSharedLock(serverB, "conn|fail", 1_000, async () => 42)).resolves.toBe(42);
  });

  it("frees the lock when the server holding it loses its database connection", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withSharedLock(serverA, "conn|crash", 5_000, () => gate);
    await untilHeld("conn|crash");
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
