import "reflect-metadata";
import { AppError, createSecretBox } from "@brain/core";
import {
  atlassianAssignedIssues,
  atlassianSearch,
  atlassianWrites,
  driveSearch,
  githubSearch,
  gmailSearch,
  slackSearch,
  type SearchAdapter,
  type WriteAdapter,
} from "@brain/connectors";
import { assertRlsEnforced, createAppPool } from "@brain/db";
import { createAnthropicGateway, withAnswerCache, withCircuitBreaker } from "@brain/llm-gateway";
import {
  ATLASSIAN_SERVER,
  createGithubServer,
  createGmailServer,
  createGoogleDriveServer,
  createRegistry,
  createSlackServer,
  type McpServerDefinition,
} from "@brain/mcp-client";
import { createLogger, startTracing } from "@brain/telemetry";
import { createRemoteJWKSet } from "jose";
import { createApp } from "./app.js";
import { createJwtVerifier } from "./auth/jwt-verifier.js";
import { createDbUserDirectory } from "./auth/user-directory.js";
import { jwksUrl, loadApiEnv, oauthRedirectUrl } from "./config.js";
import { createDbAuditApi } from "./admin/audit.service.js";
import { createPeopleService } from "./admin/people.service.js";
import { AgentsService } from "./agents/agents.service.js";
import { TriggersService } from "./agents/triggers.service.js";
import { AnswersService } from "./answers/answers.service.js";
import { QueryRewriter } from "./answers/query-rewriter.js";
import { ConnectionsService } from "./connections/connections.service.js";
import { ConversationsService } from "./conversations/conversations.service.js";
import { McpToolsService } from "./mcp/mcp.service.js";
import { MemoryService } from "./memory/memory.service.js";
import { UsageService } from "./usage/usage.service.js";
import { ProposalsService } from "./proposals/proposals.service.js";

interface KnownServer {
  readonly def: McpServerDefinition;
  readonly adapter: SearchAdapter;
  readonly writes?: WriteAdapter;
}

const env = loadApiEnv();

/** An app in the environment applies to every company; without one, each company's admin sets it up. */
function envClient(clientId: string | undefined, clientSecret: string | undefined) {
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Servers this build knows how to talk to. MCP_SERVERS selects which are enabled. */
const KNOWN_SERVERS: Readonly<Record<string, () => KnownServer>> = {
  [ATLASSIAN_SERVER.id]: () => ({ def: ATLASSIAN_SERVER, adapter: atlassianSearch, writes: atlassianWrites }),
  github: () => ({
    def: createGithubServer(envClient(env.GITHUB_MCP_CLIENT_ID, env.GITHUB_MCP_CLIENT_SECRET)),
    adapter: githubSearch,
  }),
  "google-drive": () => ({
    def: createGoogleDriveServer(envClient(env.GOOGLE_MCP_CLIENT_ID, env.GOOGLE_MCP_CLIENT_SECRET)),
    adapter: driveSearch,
  }),
  gmail: () => ({
    def: createGmailServer(envClient(env.GOOGLE_MCP_CLIENT_ID, env.GOOGLE_MCP_CLIENT_SECRET)),
    adapter: gmailSearch,
  }),
  slack: () => ({ def: createSlackServer(), adapter: slackSearch }),
};

const tracing = startTracing("brain-api", env.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger({ service: "brain-api", level: env.LOG_LEVEL });
const pool = createAppPool({
  connectionString: env.DATABASE_APP_ROLE_URL,
  onError: (err) => logger.error({ err }, "Idle database client error"),
});

// Tenant isolation depends on RLS; never start with a role that bypasses it.
await assertRlsEnforced(pool);

const enabled = env.MCP_SERVERS.split(",").map((s) => s.trim()).filter(Boolean).map((id) => {
  const known = Object.hasOwn(KNOWN_SERVERS, id) ? KNOWN_SERVERS[id] : undefined;
  if (!known) throw new AppError("CONFIG_INVALID", `MCP_SERVERS lists unknown server ${id}`);
  return known();
});

// The cache sits outside the breaker, so a recent answer can still be replayed while the provider is down.
const gateway = env.ANTHROPIC_API_KEY
  ? withAnswerCache(
      withCircuitBreaker(createAnthropicGateway({ apiKey: env.ANTHROPIC_API_KEY }), {
        failureThreshold: 5,
        openMs: 30_000,
        onStateChange: (task, state) =>
          state === "open"
            ? logger.warn({ task }, "AI provider failing; calls paused for 30 s")
            : logger.info({ task }, "AI provider calls resumed"),
      }),
      // Bounded to roughly 20 MB of text in all.
      { ttlMs: 10 * 60_000, maxEntries: 500, maxEventChars: 20_000 },
    )
  : null;
const expander = new QueryRewriter({ pool, gateway, logger });

const connections = new ConnectionsService({
  pool,
  expander,
  box: createSecretBox(env.CONNECTOR_TOKEN_ENC_KEY),
  registry: createRegistry(enabled.map((e) => e.def)),
  adapters: new Map(enabled.map((e) => [e.def.id, e.adapter])),
  client: { redirectUrl: oauthRedirectUrl(env), clientName: "Nexus Brain" },
  onBackgroundError: (err) => logger.warn({ err }, "MCP session housekeeping failed"),
});

const box = createSecretBox(env.CONNECTOR_TOKEN_ENC_KEY);
const conversations = new ConversationsService({ pool, box });
const memory = new MemoryService({ pool, box, logger });
const usage = new UsageService({ pool });
const answers = new AnswersService({
  conversations,
  memories: memory,
  budget: usage,
  items: connections,
  pool,
  box,
  logger,
  documents: connections,
  gateway,
  expander,
});

const proposals = new ProposalsService({
  pool,
  logger,
  sessions: connections,
  adapters: new Map(enabled.flatMap((e) => (e.writes ? [[e.def.id, e.writes] as const] : []))),
});

// The two need each other: runs send notifications, and triggers start runs.
const agents: AgentsService = new AgentsService({
  pool,
  box,
  gateway,
  documents: connections,
  proposals,
  logger,
  memories: memory,
  budget: usage,
  notify: (scope, notification) => triggers.notify(scope, notification),
});
const triggers = new TriggersService({
  pool,
  box,
  agents,
  logger,
  assignments: { list: (scope) => connections.readWithSession(scope, ATLASSIAN_SERVER.id, atlassianAssignedIssues) },
});

const keySet = createRemoteJWKSet(jwksUrl(env));

const app = await createApp({
  agents,
  triggers,
  people: createPeopleService({ pool, logger, connections }),
  memory,
  usage,
  mcp: {
    verifier: createJwtVerifier({ issuer: env.OIDC_ISSUER, audience: env.MCP_SERVER_AUDIENCE, keySet }),
    tools: new McpToolsService({ pool, connections, proposals, logger, webAppUrl: env.WEB_APP_URL }),
    resourceUrl: new URL("/mcp", env.PUBLIC_API_URL).toString(),
    issuer: env.OIDC_ISSUER,
  },
  logger,
  connections,
  answers,
  proposals,
  audit: createDbAuditApi(pool),
  conversations,
  webAppUrl: env.WEB_APP_URL,
  verifier: createJwtVerifier({
    issuer: env.OIDC_ISSUER,
    audience: env.OIDC_AUDIENCE,
    keySet,
  }),
  directory: createDbUserDirectory(pool),
});

app.getHttpAdapter().getInstance().addHook("onClose", async () => {
  triggers.stop();
  connections.close();
  await pool.end();
  await tracing.shutdown();
});

await app.listen({ host: env.API_HOST, port: env.API_PORT });
triggers.start();
logger.info(
  { host: env.API_HOST, port: env.API_PORT, mcpServers: enabled.map((e) => e.def.id), tracing: tracing.enabled },
  "API listening",
);
