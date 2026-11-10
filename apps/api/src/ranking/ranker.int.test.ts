// A company's learned ranker end to end (FR-RET-08): people rate answers, an operator trains, and the
// company's later results follow what was rated useful. Another company is unaffected. Real Postgres.
import { createSecretBox } from "@brain/core";
import { applyMigrations, createAppPool, getTenantRanker, loadMigrations, MIGRATIONS_DIR, seed } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConversationsService } from "../conversations/conversations.service.js";
import { createRankerStore, RankerService } from "./ranker.service.js";
import { appTrainingStore } from "./train.js";
import { RankerTrainer } from "./trainer.service.js";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@localhost:5432/brain_test";
const APP_URL = process.env.DATABASE_APP_ROLE_URL ?? "postgres://brain_app:brain_app@localhost:5432/brain_test";
const bob = { tenantId: TENANTS.acme.id, userId: seedUser("bob").id };
const alice = { tenantId: TENANTS.acme.id, userId: seedUser("alice").id };
const gus = { tenantId: TENANTS.globex.id, userId: seedUser("gus").id };
const fingerprint = (value: string) => createHash("sha256").update(`test-key|${value}`).digest("hex");
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

let owner: pg.Client;
let pool: pg.Pool;
let conversations: ConversationsService;
let ranker: RankerService;

/** Five results where the useful one is a recent GitHub item, wherever it was in the list. */
function resultsWithGithubAt(position: number) {
  return Array.from({ length: 5 }, (_, i) => ({
    serverId: i === position ? "github" : "atlassian",
    externalId: `item-${i}`,
    title: `item ${i}`,
    url: `https://acme.example/${i}`,
    snippet: "",
    updatedAt: i === position ? daysAgo(2) : daysAgo(200),
    score: 1 - i * 0.1,
  }));
}

async function rateUp(scope: typeof bob, position: number, rateAgain = false): Promise<void> {
  const { conversationId } = await conversations.begin(scope, undefined, "where is it?");
  const messageId = await conversations.saveAnswer(scope, conversationId, {
    parts: [{ kind: "text", text: "Here." }, { kind: "cite", source: position + 1, quotes: [] }],
    hits: resultsWithGithubAt(position),
    outcome: "answered",
    grounded: true,
    truncatedDocuments: 0,
  });
  await conversations.feedback(scope, conversationId, messageId, { rating: "up" });
  // A repeated rating teaches nothing more.
  if (rateAgain) await conversations.feedback(scope, conversationId, messageId, { rating: "up" });
}

async function forget(): Promise<void> {
  await owner.query("DELETE FROM ranking_examples");
  await owner.query("DELETE FROM tenant_rankers");
  await owner.query("DELETE FROM conversations WHERE user_id = ANY($1)", [[bob.userId, alice.userId, gus.userId]]);
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await applyMigrations(owner, await loadMigrations(MIGRATIONS_DIR));
  await seed(owner);
  await forget();
  pool = createAppPool({ connectionString: APP_URL, onError: () => {} });
  const onError = (err: unknown) => {
    throw err;
  };
  ranker = new RankerService({ store: createRankerStore(pool), onError, fingerprint });
  conversations = new ConversationsService({ pool, box: createSecretBox(randomBytes(32).toString("base64")), ranking: ranker });
});

afterAll(async () => {
  await forget();
  await owner?.end();
  await pool?.end();
});

describe("a company's learned ranker", () => {
  it("learns from its people's ratings, and once trained puts what they found useful higher for everyone there", async () => {
    // Repeats for a few answers only: each rating is a real round trip, and these take time. One in
    // five answers is held back by a hash of its group, so 250 leave the 30 needed with a wide margin.
    for (let i = 0; i < 250; i += 1) await rateUp(i % 2 ? bob : alice, i % 5, i < 10);
    const saved = await owner.query("SELECT count(*)::int AS n, count(DISTINCT answer_group)::int AS answers FROM ranking_examples WHERE tenant_id = $1", [bob.tenantId]);
    expect(saved.rows[0]).toEqual({ n: 1250, answers: 250 });

    const before = (await ranker.rank(bob, resultsWithGithubAt(4))).map((h) => h.serverId);
    expect(before.indexOf("github")).toBe(4);

    // The daily job, on the app's own role, through its scoped functions.
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const trained = await new RankerTrainer({ store: appTrainingStore(pool), logger }).trainAll();
    expect(logger.error).not.toHaveBeenCalled();
    expect(trained).toEqual([{ tenantId: bob.tenantId, metrics: expect.objectContaining({ active: true, examples: 1250 }) }]);

    // A server that has not cached the old (empty) model.
    const fresh = new RankerService({ store: createRankerStore(pool), onError: () => {}, fingerprint });
    expect((await fresh.rank(bob, resultsWithGithubAt(4)))[0]?.serverId).toBe("github");
    expect((await fresh.rank(gus, resultsWithGithubAt(4))).map((h) => h.serverId).indexOf("github")).toBe(4);
    expect(await getTenantRanker(pool, gus.tenantId)).toBeNull();
  }, 120_000);

  it("saves only that cited results were wrong when an answer is rated down", async () => {
    await owner.query("DELETE FROM ranking_examples");
    const { conversationId } = await conversations.begin(gus, undefined, "where?");
    const messageId = await conversations.saveAnswer(gus, conversationId, {
      parts: [{ kind: "cite", source: 2, quotes: [] }],
      hits: resultsWithGithubAt(1),
      outcome: "answered",
      grounded: true,
      truncatedDocuments: 0,
    });
    await conversations.feedback(gus, conversationId, messageId, { rating: "down" });
    const rows = await owner.query("SELECT tenant_id, server_id, position, label FROM ranking_examples");
    expect(rows.rows).toEqual([{ tenant_id: gus.tenantId, server_id: "github", position: 1, label: 0 }]);
    // Changing their mind later adds nothing: each answer is learned from once.
    await conversations.feedback(gus, conversationId, messageId, { rating: "up" });
    await Promise.all([1, 2].map(() => conversations.feedback(gus, conversationId, messageId, { rating: "down" })));
    expect((await owner.query("SELECT count(*)::int AS n FROM ranking_examples")).rows[0].n).toBe(1);
  });
});
