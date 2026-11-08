// The work graph end to end (FR-RET-09): a person rates an answer up or opens an item, and their own
// later searches put those items higher. Nobody else's order changes. Real Postgres, mock service.
import type { SearchAdapter, SearchHit } from "@brain/connectors";
import { createSecretBox } from "@brain/core";
import { applyMigrations, createAppPool, loadMigrations, MIGRATIONS_DIR, seed } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { createRegistry } from "@brain/mcp-client";
import { simulateConsent, startMockMcpServer, type MockMcpServer } from "@brain/mcp-client/testing";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionsService } from "../connections/connections.service.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { createGraphStore, GraphService } from "./graph.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const SERVER = "mock";
const bob = { tenantId: TENANTS.acme.id, userId: seedUser("bob").id };
const alice = { tenantId: TENANTS.acme.id, userId: seedUser("alice").id };

const issue = (key: string, title: string): SearchHit => ({
  serverId: SERVER,
  externalId: key,
  title,
  url: `https://acme.example/browse/${key}`,
  snippet: title,
  updatedAt: null,
});
/** Six results that match a launch question about equally well. */
const LAUNCH = [
  issue("L-1", "launch plan"),
  issue("L-2", "launch plan review"),
  issue("L-3", "launch plan owners"),
  issue("L-4", "launch plan risks"),
  issue("L-5", "launch plan budget"),
  issue("L-6", "launch plan dates"),
];
const adapter: SearchAdapter = {
  serverId: SERVER,
  search: async (_session, query) => (/launch/i.test(query) ? LAUNCH : []),
  readDocuments: async (_session, hits) => new Map(hits.map((h) => [h.url, `text of ${h.externalId}`])),
};

let owner: pg.Client;
let pool: pg.Pool;
let mock: MockMcpServer;
let connections: ConnectionsService;
let conversations: ConversationsService;

const order = async (scope: typeof bob) => (await connections.search(scope, "launch plan", 10)).hits.map((h) => h.externalId);

/**
 * Removes what this file leaves for Bob and Alice. Its chats are sealed with this file's own key, so
 * any left behind would be unreadable to the next test that lists their chats.
 */
async function forgetPeople(): Promise<void> {
  for (const table of ["work_graph_edges", "conversations"]) {
    await owner.query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [[bob.userId, alice.userId]]);
  }
}

async function connect(scope: typeof bob, identity: string): Promise<void> {
  mock.setNextIdentity(identity);
  const { authorizationUrl } = await connections.authorize(scope, SERVER);
  const consent = await simulateConsent(authorizationUrl);
  await connections.complete(scope, consent.code, consent.state);
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  for (const table of ["mcp_connections", "oauth_states", "mcp_client_registrations"]) {
    await owner.query(`DELETE FROM ${table} WHERE server_id = $1`, [SERVER]);
  }
  await forgetPeople();

  mock = await startMockMcpServer({ id: SERVER, issuesByIdentity: {} });
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  const box = createSecretBox(randomBytes(32).toString("base64"));
  const graph = new GraphService({ store: createGraphStore(pool), onError: (err) => { throw err; } });
  connections = new ConnectionsService({
    pool,
    box,
    graph,
    registry: createRegistry([mock.definition]),
    adapters: new Map([[SERVER, adapter]]),
    client: { redirectUrl: "http://127.0.0.1:3001/oauth/callback", clientName: "Nexus Brain (graph test)" },
  });
  conversations = new ConversationsService({ pool, box, graph });
  await connect(bob, "bob-account");
  await connect(alice, "alice-account");
});

afterAll(async () => {
  await forgetPeople();
  for (const table of ["mcp_connections", "oauth_states"]) await owner?.query(`DELETE FROM ${table} WHERE server_id = $1`, [SERVER]);
  await owner?.end();
  await pool?.end();
  await mock?.close();
});

describe("a person's work graph in their searches", () => {
  it("puts the sources of an answer they rated up higher in their own later searches only", async () => {
    const before = await order(bob);
    const aliceBefore = await order(alice);
    const last = before.at(-1)!;

    // Bob asks something, the answer cites the last result, and he rates it up.
    const started = await conversations.begin(bob, undefined, "what is the launch plan?");
    const hits = LAUNCH.map((hit, index) => ({ ...hit, score: 1 / (index + 1) }));
    const cited = hits.findIndex((hit) => hit.externalId === last) + 1;
    const messageId = await conversations.saveAnswer(bob, started.conversationId, {
      parts: [{ kind: "text", text: "The plan is " }, { kind: "cite", source: cited, quotes: [] }],
      hits,
      outcome: "answered",
      grounded: true,
      truncatedDocuments: 0,
    });
    await conversations.feedback(bob, started.conversationId, messageId, { rating: "up" });
    // Rating it up again, or a retried request, does not count twice.
    await conversations.feedback(bob, started.conversationId, messageId, { rating: "up" });
    const weights = await owner.query("SELECT DISTINCT weight FROM work_graph_edges WHERE user_id = $1", [bob.userId]);
    expect(weights.rows).toEqual([{ weight: 1 }]);

    const after = await order(bob);
    expect(after.indexOf(last)).toBeLessThan(before.indexOf(last));
    expect([...after].sort()).toEqual([...before].sort());
    // Alice's results keep their order: Bob's graph is his alone.
    expect(await order(alice)).toEqual(aliceBefore);
  });

  it("learns from an item the person opened, and a rating down teaches nothing", async () => {
    const before = await order(alice);
    const lastButOne = before.at(-2)!;
    const item = LAUNCH.find((hit) => hit.externalId === lastButOne)!;
    expect(await connections.readItem(alice, { serverId: SERVER, externalId: item.externalId, url: item.url })).toContain(lastButOne);
    expect((await order(alice)).indexOf(lastButOne)).toBeLessThan(before.indexOf(lastButOne));

    const started = await conversations.begin(alice, undefined, "launch?");
    const messageId = await conversations.saveAnswer(alice, started.conversationId, {
      parts: [{ kind: "cite", source: 1, quotes: [] }],
      hits: LAUNCH.map((hit) => ({ ...hit, score: 1 })),
      outcome: "answered",
      grounded: true,
      truncatedDocuments: 0,
    });
    await conversations.feedback(alice, started.conversationId, messageId, { rating: "down" });

    const edges = await owner.query("SELECT kind FROM work_graph_edges WHERE user_id = $1", [alice.userId]);
    expect(edges.rows).toEqual([{ kind: "opened" }]);
  });
});
