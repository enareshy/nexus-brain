import { baseEnvSchema, loadEnv } from "@brain/core";
import { z } from "zod";

export const apiEnvSchema = baseEnvSchema.extend({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_APP_ROLE_URL: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  /** Defaults to the Keycloak JWKS path under the issuer. */
  OIDC_JWKS_URL: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source?: Record<string, string | undefined>): ApiEnv {
  return loadEnv(apiEnvSchema, source);
}

export function jwksUrl(env: Pick<ApiEnv, "OIDC_ISSUER" | "OIDC_JWKS_URL">): URL {
  return new URL(
    env.OIDC_JWKS_URL ?? `${env.OIDC_ISSUER.replace(/\/$/, "")}/protocol/openid-connect/certs`,
  );
}
