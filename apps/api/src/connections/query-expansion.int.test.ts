// A search that finds nothing tries once more with better words: API -> vault -> mock MCP server.
import { createSecretBox } from "@brain/core";
import type { SearchAdapter } from "@brain/connectors";
import { applyMigrations, createAppPool, loadMigrations, MIGRATIONS_DIR, seed } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { createRegistry } from "@brain/mcp-client";
import { simulateConsent, startMockMcpServer, type MockMcpServer } from "@brain/mcp-client/testing";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsService } from "./connections.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain";
const SERVER = "mockexpand";
const bob = seedUser("bob");
const scope = { tenantId: TENANTS[bob.tenant].id, userId: bob.id };

const HIT = { serverId: SERVER, externalId: "1", title: "Login guide", url: "https://x.example/1", snippet: "", updatedAt: null };

let pool: pg.Pool;
let owner: pg.Client;
let mock: MockMcpServer;
let service: ConnectionsService;
const expand = vi.fn(async (): Promise<readonly string[]> => ["login"]);
let failing = false;

const adapter: SearchAdapter = {
  serverId: SERVER,
  search: async (_session, query) => {
    if (failing) throw new Error("source down");
    return query.startsWith("login") ? [HIT] : [];
  },
};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  await owner.query("DELETE FROM mcp_connections WHERE server_id = $1", [SERVER]);
  await owner.query("DELETE FROM mcp_client_registrations WHERE server_id = $1", [SERVER]);
  mock = await startMockMcpServer({ id: SERVER, issuesByIdentity: { someone: [] } });
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  service = new ConnectionsService({
    pool,
    box: createSecretBox(randomBytes(32).toString("base64")),
    registry: createRegistry([mock.definition]),
    adapters: new Map([[SERVER, adapter]]),
    client: { redirectUrl: "http://127.0.0.1:3001/oauth/callback", clientName: "Nexus Brain (int test)" },
    expander: { expand },
  });
  mock.setNextIdentity("someone");
  const { authorizationUrl } = await service.authorize(scope, SERVER);
  const consent = await simulateConsent(authorizationUrl);
  await service.complete(scope, consent.code, consent.state);
});

beforeEach(() => {
  expand.mockClear();
  failing = false;
});

afterAll(async () => {
  service?.close();
  await owner?.query("DELETE FROM mcp_connections WHERE server_id = $1", [SERVER]);
  await owner?.end();
  await pool?.end();
  await mock?.close();
});

describe("search with no results", () => {
  it("searches again with better words, and says which", async () => {
    const result = await service.search(scope, "cannot sign in", 10);
    expect(expand).toHaveBeenCalledOnce();
    expect(result.hits.map((h) => h.externalId)).toEqual(["1"]);
    expect(result.expandedTerms).toEqual(["login"]);
  });

  it("does not spend anything when the first search finds something", async () => {
    const result = await service.search(scope, "login page", 10);
    expect(expand).not.toHaveBeenCalled();
    expect(result.hits).toHaveLength(1);
    expect(result.expandedTerms).toBeUndefined();
  });

  it("does not retry when a source failed, because no results may just mean an outage", async () => {
    failing = true;
    const result = await service.search(scope, "cannot sign in", 10);
    expect(expand).not.toHaveBeenCalled();
    expect(result.sources[0]?.ok).toBe(false);
  });

  it("returns the empty result when the model has no words to add", async () => {
    expand.mockResolvedValueOnce([]);
    const result = await service.search(scope, "still nothing here", 10);
    expect(result.hits).toEqual([]);
    expect(result.expandedTerms).toBeUndefined();
  });

  it("records one audit row for the whole search, without the question or the new words", async () => {
    const question = "unique audit question text";
    await service.search(scope, question, 10);
    const { rows } = await owner.query(
      "SELECT meta FROM audit_log WHERE action = 'search' AND user_id = $1 ORDER BY id DESC LIMIT 1",
      [scope.userId],
    );
    expect(JSON.stringify(rows)).not.toContain(question);
    expect(rows[0].meta.expanded).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('"login"');
  });
});
