import "reflect-metadata";
import { assertRlsEnforced, createAppPool } from "@brain/db";
import { createLogger, startTracing } from "@brain/telemetry";
import { createRemoteJWKSet } from "jose";
import { createApp } from "./app.js";
import { createJwtVerifier } from "./auth/jwt-verifier.js";
import { createDbUserDirectory } from "./auth/user-directory.js";
import { jwksUrl, loadApiEnv } from "./config.js";

const env = loadApiEnv();
const tracing = startTracing("brain-api", env.OTEL_EXPORTER_OTLP_ENDPOINT);
const logger = createLogger({ service: "brain-api", level: env.LOG_LEVEL });
const pool = createAppPool({
  connectionString: env.DATABASE_APP_ROLE_URL,
  onError: (err) => logger.error({ err }, "Idle database client error"),
});

// Tenant isolation depends on RLS; never start with a role that bypasses it.
await assertRlsEnforced(pool);

const app = await createApp({
  logger,
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
logger.info({ host: env.API_HOST, port: env.API_PORT, tracing: tracing.enabled }, "API listening");
