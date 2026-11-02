import "reflect-metadata";
import { AppError, createSecretBox } from "@brain/core";
import {
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
import { createAnthropicGateway } from "@brain/llm-gateway";
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
import { AgentsService } from "./agents/agents.service.js";
import { AnswersService } from "./answers/answers.service.js";
import { QueryRewriter } from "./answers/query-rewriter.js";
import { ConnectionsService } from "./connections/connections.service.js";
import { ConversationsService } from "./conversations/conversations.service.js";
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

const gateway = env.ANTHROPIC_API_KEY ? createAnthropicGateway({ apiKey: env.ANTHROPIC_API_KEY }) : null;
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
const answers = new AnswersService({
  conversations,
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

const agents = new AgentsService({ pool, box, gateway, documents: connections, proposals, logger });

const app = await createApp({
  agents,
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
    keySet: createRemoteJWKSet(jwksUrl(env)),
  }),
  directory: createDbUserDirectory(pool),
});

app.getHttpAdapter().getInstance().addHook("onClose", async () => {
  connections.close();
  await pool.end();
  await tracing.shutdown();
});

await app.listen({ host: env.API_HOST, port: env.API_PORT });
logger.info(
  { host: env.API_HOST, port: env.API_PORT, mcpServers: enabled.map((e) => e.def.id), tracing: tracing.enabled },
  "API listening",
);
