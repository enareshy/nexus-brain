// DEV ONLY: prints the SHAPE of real MCP tool results for adapter work. Values are masked,
// so customer content never reaches the terminal. Read-only tools only.
//   node --env-file-if-exists=../../.env --import tsx scripts/mcp-shape.ts <seedUserKey>
import { createSecretBox } from "@brain/core";
import { createAppPool } from "@brain/db";
import { seedUser, TENANTS } from "@brain/db/seed-data";
import { ATLASSIAN_SERVER, openSession } from "@brain/mcp-client";
import { loadApiEnv, oauthRedirectUrl } from "../src/config.js";
import { createVaultStore } from "../src/connections/vault-store.js";

const MAX_ARRAY_ITEMS_SHOWN = 1;

function maskUrl(value: string): string {
  // Path segments can hold page titles or project keys, so only their count is shown.
  const url = new URL(value);
  const host = url.hostname.endsWith(".atlassian.net") ? "<site>.atlassian.net" : "<other-host>";
  return `<url ${url.protocol}//${host} segments=${url.pathname.split("/").filter(Boolean).length}>`;
}

function shape(value: unknown, depth = 0): unknown {
  if (depth > 6) return "<deep>";
  if (Array.isArray(value)) {
    return { [`array(${value.length})`]: value.slice(0, MAX_ARRAY_ITEMS_SHOWN).map((v) => shape(v, depth + 1)) };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  if (typeof value === "string") {
    return /^https?:\/\//.test(value) ? maskUrl(value) : `<string ${value.length}>`;
  }
  return `<${typeof value}>`;
}

function describe(text: string): unknown {
  try {
    return shape(JSON.parse(text));
  } catch {
    return `<non-JSON text, ${text.length} chars>`;
  }
}

/** Platform errors can echo queries or project names, so only the status code is shown. */
function errorSummary(text: string): string {
  try {
    const parsed = JSON.parse(text) as { statusCode?: unknown };
    return `error status=${String(parsed.statusCode)} (${text.length} chars)`;
  } catch {
    return `error (${text.length} chars)`;
  }
}

function parseSiteList(text: string): Array<{ id: string; scopes: string[] }> {
  try {
    return JSON.parse(text) as Array<{ id: string; scopes: string[] }>;
  } catch {
    // A SyntaxError message would embed part of the input.
    throw new Error(`Site list was not JSON (${text.length} chars)`);
  }
}

const userKey = (process.argv[2] ?? "patAcme") as Parameters<typeof seedUser>[0];
const user = seedUser(userKey);
const env = loadApiEnv();
const pool = createAppPool({ connectionString: env.DATABASE_APP_ROLE_URL, onError: () => {} });
const box = createSecretBox(env.CONNECTOR_TOKEN_ENC_KEY);
const scope = { tenantId: TENANTS[user.tenant].id, userId: user.id };
const store = createVaultStore(pool, box, scope, ATLASSIAN_SERVER.id);
const ctx = { redirectUrl: oauthRedirectUrl(env), clientName: "Nexus Brain" };

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await work();
  console.log(`[${label}] ${Date.now() - started} ms`);
  return result;
}

const session = await timed("connect", () => openSession(ATLASSIAN_SERVER, store, ctx));
try {
  const tools = await timed("listTools", () => session.listTools());
  for (const name of ["search", "searchJiraIssuesUsingJql", "searchConfluenceUsingCql"]) {
    console.log(`\n--- ${name} description\n${tools.find((t) => t.name === name)?.description}`);
  }
  const sites = await timed("sites", () => session.callTool("getAccessibleAtlassianResources", {}));
  const list = parseSiteList(sites.text);
  console.log(`entries: ${list.length}, unique ids: ${new Set(list.map((s) => s.id)).size}`);
  const projects = await session.callTool("getVisibleJiraProjects", { cloudId: list[0]?.id ?? "" });
  console.log("projects:", projects.isError ? errorSummary(projects.text) : JSON.stringify(describe(projects.text)));

  for (const [index, site] of list.entries()) {
    console.log(`\n===== site ${index}, scopes: ${site.scopes.join(" ")}`);
    const jira = await timed("jql", () =>
      session.callTool("searchJiraIssuesUsingJql", {
        cloudId: site.id,
        jql: "created >= -3650d ORDER BY updated DESC",
        maxResults: 1,
        fields: ["summary", "updated"],
      }),
    );
    console.log("jql:", jira.isError ? errorSummary(jira.text) : JSON.stringify(describe(jira.text), null, 1));

    const wiki = await timed("cql", () =>
      session.callTool("searchConfluenceUsingCql", { cloudId: site.id, cql: "type = page", limit: 1 }),
    );
    console.log("cql:", wiki.isError ? errorSummary(wiki.text) : `${wiki.text.length} chars`);
  }
} finally {
  await session.close();
  await pool.end();
}
