// Each person's own work graph (FR-RET-09): private to them, bounded, and holding ids only.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./config.js";
import { applyMigrations, loadMigrations } from "./migrator.js";
import { seed } from "./seed.js";
import { seedUser, TENANTS } from "./seed-data.js";
import { withUser } from "./tenant.js";
import { clearGraph, exportGraph, forgetGraphItem, graphLinksFor, listGraphItems, recordGraphEdges } from "./work-graph.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const bob = { tenantId: TENANTS.acme.id, userId: seedUser("bob").id };
const alice = { tenantId: TENANTS.acme.id, userId: seedUser("alice").id };
const globexPerson = { tenantId: TENANTS.globex.id, userId: seedUser("patGlobex").id };

let owner: pg.Client;
let appPool: pg.Pool;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  appPool = new pg.Pool({ connectionString: APP_URL, max: 2 });
});

beforeEach(async () => {
  await owner.query("DELETE FROM work_graph_edges");
});

afterAll(async () => {
  await owner?.query("DELETE FROM work_graph_edges");
  await owner?.end();
  await appPool?.end();
});

describe("a person's work graph", () => {
  it("finds links straight from the person, and through items cited alongside ones they used", async () => {
    // Opened on two occasions, so it counts twice.
    await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:ENG-1", kind: "opened" }]);
    await recordGraphEdges(appPool, bob, [
      { source: "me", target: "atlassian:ENG-1", kind: "opened" },
      { source: "me", target: "atlassian:DOC-9", kind: "cited_up" },
      { source: "atlassian:DOC-9", target: "github:pr-4", kind: "co_cited" },
      { source: "github:pr-4", target: "atlassian:DOC-9", kind: "co_cited" },
    ]);
    const links = await graphLinksFor(appPool, bob, ["atlassian:ENG-1", "github:pr-4", "atlassian:NONE"]);
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "atlassian:ENG-1", kind: "opened", via: "direct", weight: 2 }),
        expect.objectContaining({ key: "github:pr-4", kind: "co_cited", via: "neighbour", weight: 1 }),
      ]),
    );
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.ageDays >= 0 && link.ageDays < 1)).toBe(true);
  });

  it("is private to the person: a colleague or another company sees and changes nothing of it", async () => {
    await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:SECRET-1", kind: "opened" }]);
    expect(await graphLinksFor(appPool, alice, ["atlassian:SECRET-1"])).toEqual([]);
    expect(await graphLinksFor(appPool, globexPerson, ["atlassian:SECRET-1"])).toEqual([]);
    expect(await exportGraph(appPool, alice)).toEqual([]);
    // Alice's own link to the same item stays hers, and does not add to Bob's.
    await recordGraphEdges(appPool, alice, [{ source: "me", target: "atlassian:SECRET-1", kind: "opened" }]);
    expect((await graphLinksFor(appPool, bob, ["atlassian:SECRET-1"]))[0]?.weight).toBe(1);
    await expect(
      withUser(appPool, alice, (db) =>
        db.execute(`INSERT INTO work_graph_edges (tenant_id, user_id, source_key, target_key, kind)
          VALUES ('${bob.tenantId}', '${bob.userId}', 'me', 'atlassian:PLANTED', 'opened')`),
      ),
    ).rejects.toThrow(/row-level security/);
    const removed = await withUser(appPool, alice, (db) => db.execute("DELETE FROM work_graph_edges WHERE target_key = 'atlassian:SECRET-1'"));
    expect(removed.rowCount).toBe(1);
    expect(await graphLinksFor(appPool, bob, ["atlassian:SECRET-1"])).toHaveLength(1);
  });

  it("keeps repeats bounded, forgets old links, and refuses links that are not ids", async () => {
    for (let i = 0; i < 25; i += 1) await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:ENG-2", kind: "opened" }]);
    expect((await graphLinksFor(appPool, bob, ["atlassian:ENG-2"]))[0]?.weight).toBe(20);

    await owner.query("UPDATE work_graph_edges SET last_seen_at = now() - interval '91 days'");
    await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:ENG-3", kind: "opened" }]);
    expect(await graphLinksFor(appPool, bob, ["atlassian:ENG-2"])).toEqual([]);

    const bad = [
      { source: "me", target: "not an id", kind: "opened" as const },
      { source: "me", target: "atlassian:line\nbreak", kind: "opened" as const },
      { source: "me", target: "atlassian:ENG-1", kind: "co_cited" as const },
      { source: "atlassian:A", target: "atlassian:B", kind: "opened" as const },
      { source: "atlassian:A", target: "atlassian:A", kind: "co_cited" as const },
    ];
    for (const edge of bad) await expect(recordGraphEdges(appPool, bob, [edge])).rejects.toThrow();
    await expect(recordGraphEdges(appPool, bob, Array.from({ length: 51 }, (_, i) => ({ source: "me", target: `atlassian:X-${i}`, kind: "opened" as const })))).rejects.toThrow(/At most/);
  });

  it("counts an item reached through another item once, even if that item was both opened and rated up", async () => {
    await recordGraphEdges(appPool, bob, [
      { source: "me", target: "atlassian:X", kind: "opened" },
      { source: "me", target: "atlassian:X", kind: "cited_up" },
      { source: "atlassian:X", target: "atlassian:R", kind: "co_cited" },
    ]);
    const links = await graphLinksFor(appPool, bob, ["atlassian:R"]);
    expect(links).toEqual([expect.objectContaining({ key: "atlassian:R", via: "neighbour", weight: 1 })]);
  });

  it("records one call's repeated links once, and keeps at most 5,000 links, dropping the oldest", async () => {
    await recordGraphEdges(appPool, bob, [
      { source: "me", target: "atlassian:ENG-9", kind: "opened" },
      { source: "me", target: "atlassian:ENG-9", kind: "opened" },
    ]);
    expect((await graphLinksFor(appPool, bob, ["atlassian:ENG-9"]))[0]?.weight).toBe(1);

    await owner.query(
      `INSERT INTO work_graph_edges (tenant_id, user_id, source_key, target_key, kind, last_seen_at)
       SELECT $1, $2, 'me', 'atlassian:OLD-' || i, 'opened', now() - interval '1 day' - i * interval '1 second'
         FROM generate_series(1, 5000) AS i`,
      [bob.tenantId, bob.userId],
    );
    await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:NEW-1", kind: "opened" }]);
    const kept = await owner.query("SELECT count(*)::int AS n, bool_or(target_key = 'atlassian:OLD-5000') AS oldest FROM work_graph_edges WHERE user_id = $1", [bob.userId]);
    expect(kept.rows[0]).toEqual({ n: 5000, oldest: false });
    expect(await graphLinksFor(appPool, bob, ["atlassian:NEW-1"])).toHaveLength(1);
  });

  it("does not let the app clear a colleague's graph by marking them erased", async () => {
    await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:KEEP-1", kind: "opened" }]);
    try {
      await withUser(appPool, alice, (db) => db.execute(`UPDATE users SET erased_at = now() WHERE id = '${bob.userId}'`));
      expect(await graphLinksFor(appPool, bob, ["atlassian:KEEP-1"])).toHaveLength(1);
    } finally {
      await owner.query("UPDATE users SET erased_at = NULL WHERE id = $1", [bob.userId]);
    }
  });

  it("exports everything in it, newest first, for the person's own data download", async () => {
    await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:ENG-1", kind: "opened" }]);
    await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:DOC-2", kind: "cited_up" }]);
    const exported = await exportGraph(appPool, bob);
    expect(exported.map((edge) => edge.target)).toEqual(["atlassian:DOC-2", "atlassian:ENG-1"]);
    expect(exported[0]).toEqual({ source: "me", target: "atlassian:DOC-2", kind: "cited_up", weight: 1, lastSeenAt: expect.any(String) });
  });

  it("lists what the person used, newest first, and lets them forget one item or clear it all", async () => {
    await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:ENG-1", kind: "opened" }]);
    await recordGraphEdges(appPool, bob, [{ source: "me", target: "atlassian:ENG-1", kind: "opened" }]);
    await recordGraphEdges(appPool, bob, [
      { source: "me", target: "atlassian:DOC-2", kind: "cited_up" },
      { source: "me", target: "github:pr-3", kind: "cited_up" },
      { source: "atlassian:DOC-2", target: "github:pr-3", kind: "co_cited" },
      { source: "github:pr-3", target: "atlassian:DOC-2", kind: "co_cited" },
    ]);
    await recordGraphEdges(appPool, alice, [{ source: "me", target: "atlassian:ALICE-1", kind: "opened" }]);
    await owner.query("UPDATE work_graph_edges SET last_seen_at = now() - interval '1 day' WHERE target_key = 'atlassian:ENG-1'");

    const items = await listGraphItems(appPool, bob);
    expect(items.map((i) => i.key)).toEqual(["atlassian:DOC-2", "github:pr-3", "atlassian:ENG-1"]);
    expect(items[0]).toMatchObject({ opened: 0, helpful: 1, linkedItems: 1 });
    expect(items[2]).toMatchObject({ opened: 2, helpful: 0, linkedItems: 0 });

    // Forgetting an item removes every link to and from it, and only Bob's.
    expect(await forgetGraphItem(appPool, bob, "github:pr-3")).toBe(3);
    expect((await listGraphItems(appPool, bob)).map((i) => i.key)).toEqual(["atlassian:DOC-2", "atlassian:ENG-1"]);
    expect(await graphLinksFor(appPool, bob, ["github:pr-3"])).toEqual([]);
    expect(await forgetGraphItem(appPool, alice, "atlassian:ENG-1")).toBe(0);

    expect(await clearGraph(appPool, bob)).toBe(2);
    expect(await listGraphItems(appPool, bob)).toEqual([]);
    expect(await listGraphItems(appPool, alice)).toHaveLength(1);
  });
});
