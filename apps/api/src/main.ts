import "reflect-metadata";
import { AppError, createSecretBox } from "@brain/core";
import { atlassianSearch, type SearchAdapter } from "@brain/connectors";
import { assertRlsEnforced, createAppPool } from "@brain/db";
import { ATLASSIAN_SERVER, createRegistry, type McpServerDefinition } from "@brain/mcp-client";
import { createLogger, startTracing } from "@brain/telemetry";
import { createRemoteJWKSet } from "jose";
import { createApp } from "./app.js";
import { createJwtVerifier } from "./auth/jwt-verifier.js";
import { createDbUserDirectory } from "./auth/user-directory.js";
import { jwksUrl, loadApiEnv, oauthRedirectUrl } from "./config.js";
import { ConnectionsService } from "./connections/connections.service.js";

/** Servers this build knows how to talk to. MCP_SERVERS selects which are enabled. */
const KNOWN_SERVERS: ReadonlyMap<string, { def: McpServerDefinition; adapter: SearchAdapter }> =
  new Map([[ATLASSIAN_SERVER.id, { def: ATLASSIAN_SERVER, adapter: atlassianSearch }]]);

const env = loadApiEnv();
const tracing = startTracing("brain-api", env.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger({ service: "brain-api", level: env.LOG_LEVEL });
const pool = createAppPool({
  connectionString: env.DATABASE_APP_ROLE_URL,
  onError: (err) => logger.error({ err }, "Idle database client error"),
});

// Tenant isolation depends on RLS; never start with a role that bypasses it.
await assertRlsEnforced(pool);

const enabled = env.MCP_SERVERS.split(",").map((s) => s.trim()).filter(Boolean).map((id) => {
  const known = KNOWN_SERVERS.get(id);
  if (!known) throw new AppError("CONFIG_INVALID", `MCP_SERVERS lists unknown server ${id}`);
  return known;
});

const connections = new ConnectionsService({
  pool,
  box: createSecretBox(env.CONNECTOR_TOKEN_ENC_KEY),
  registry: createRegistry(enabled.map((e) => e.def)),
  adapters: new Map(enabled.map((e) => [e.def.id, e.adapter])),
  client: { redirectUrl: oauthRedirectUrl(env), clientName: "Nexus Brain" },
});

const app = await createApp({
  logger,
  connections,
  webAppUrl: env.WEB_APP_URL,
  verifier: createJwtVerifier({
    issuer: env.OIDC_ISSUER,
    audience: env.OIDC_AUDIENCE,
    keySet: createRemoteJWKSet(jwksUrl(env)),
  }),
  directory: createDbUserDirectory(pool),
});

app.getHttpAdapter().getInstance().addHook("onClose", async () => {
  await pool.end();
  await tracing.shutdown();
});

await app.listen({ host: env.API_HOST, port: env.API_PORT });
logger.info(
  { host: env.API_HOST, port: env.API_PORT, mcpServers: enabled.map((e) => e.def.id), tracing: tracing.enabled },
  "API listening",
);
