// DEV ONLY: saves a connected server's real tools/list to docs/adr for adapter work.
// It lists tools and calls none of them.
//   node --env-file-if-exists=../../.env --import tsx scripts/mcp-capture-tools.ts <serverId> <seedUserKey>
import { createSecretBox } from "@brain/core";
import { createAppPool } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { ATLASSIAN_SERVER, createGithubServer, openSession, type McpServerDefinition } from "@brain/mcp-client";
import { writeFileSync } from "node:fs";
import { loadApiEnv, oauthRedirectUrl } from "../src/config.js";
import { createVaultStore } from "../src/connections/vault-store.js";

const env = loadApiEnv();

function serverFor(id: string): McpServerDefinition {
  if (id === ATLASSIAN_SERVER.id) return ATLASSIAN_SERVER;
  if (id === "github" && env.GITHUB_MCP_CLIENT_ID && env.GITHUB_MCP_CLIENT_SECRET) {
    return createGithubServer({ clientId: env.GITHUB_MCP_CLIENT_ID, clientSecret: env.GITHUB_MCP_CLIENT_SECRET });
  }
  throw new Error(`Cannot capture server ${id}`);
}

const serverId = process.argv[2] ?? "github";
const user = seedUser((process.argv[3] ?? "patAcme") as Parameters<typeof seedUser>[0]);
const def = serverFor(serverId);
const pool = createAppPool({ connectionString: env.DATABASE_APP_ROLE_URL, onError: () => {} });
const scope = { tenantId: TENANTS[user.tenant].id, userId: user.id };
const store = createVaultStore(pool, createSecretBox(env.CONNECTOR_TOKEN_ENC_KEY), scope, serverId);

const session = await openSession(def, store, { redirectUrl: oauthRedirectUrl(env), clientName: "Nexus Brain" });
try {
  const tools = await session.listTools();
  writeFileSync(`../../docs/adr/0001-${serverId}-tools.json`, `${JSON.stringify(tools, null, 2)}\n`);
  for (const tool of tools) {
    const readOnly = tool.annotations.readOnlyHint === true ? "read" : "NOT-READ-ONLY";
    console.log(`${tool.name}\t${readOnly}`);
  }
  console.log(`total ${tools.length}`);
} finally {
  await session.close();
  await pool.end();
}
