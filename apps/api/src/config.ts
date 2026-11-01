import { baseEnvSchema, loadEnv } from "@brain/core";
import { z } from "zod";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const apiEnvObject = baseEnvSchema.extend({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  /** Public base URL of this API; the OAuth redirect URI is derived from it. */
  PUBLIC_API_URL: z.string().url().default("http://127.0.0.1:3001"),
  WEB_APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_APP_ROLE_URL: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  /** Defaults to the Keycloak JWKS path under the issuer. */
  OIDC_JWKS_URL: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  /** 32 random bytes, base64. Seals connector tokens (FR-CON-02). */
  CONNECTOR_TOKEN_ENC_KEY: z.string().min(40),
  /** Comma-separated allow-listed MCP server IDs (FR-MCP-02). */
  MCP_SERVERS: z.string().default("atlassian,github,google-drive,gmail,slack"),
  /** Optional: normally an admin sets these apps up in the web app, per company. These override that. */
  GITHUB_MCP_CLIENT_ID: z.string().optional().transform((value) => value?.trim() || undefined),
  GITHUB_MCP_CLIENT_SECRET: z.string().optional().transform((value) => value?.trim() || undefined),
  GOOGLE_MCP_CLIENT_ID: z.string().optional().transform((value) => value?.trim() || undefined),
  GOOGLE_MCP_CLIENT_SECRET: z.string().optional().transform((value) => value?.trim() || undefined),
  /** Optional: without it search works and AI answers report that they are not configured. */
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
});

/** In production, every externally visible URL must be https and not loopback (review M6). */
export const apiEnvSchema = apiEnvObject.superRefine((env, issues) => {
  if (env.NODE_ENV !== "production") return;
  for (const key of ["PUBLIC_API_URL", "WEB_APP_URL", "OIDC_ISSUER"] as const) {
    const url = new URL(env[key]);
    if (url.protocol !== "https:" || LOOPBACK.has(url.hostname)) {
      issues.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "must be a public https URL in production" });
    }
  }
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

export function oauthRedirectUrl(env: Pick<ApiEnv, "PUBLIC_API_URL">): string {
  return new URL("/oauth/callback", env.PUBLIC_API_URL).toString();
}
