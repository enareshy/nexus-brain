import { describe, expect, it } from "vitest";
import { jwksUrl, loadApiEnv, oauthRedirectUrl } from "./config.js";

const BASE = {
  DATABASE_APP_ROLE_URL: "postgres://brain_app:x@localhost:5432/brain",
  OIDC_ISSUER: "http://localhost:8081/realms/brain/",
  OIDC_AUDIENCE: "brain-api",
  CONNECTOR_TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString("base64"),
};

describe("loadApiEnv", () => {
  it("applies defaults", () => {
    const env = loadApiEnv(BASE);
    expect(env.API_PORT).toBe(3001);
    expect(env.API_HOST).toBe("127.0.0.1");
  });

  it("refuses one audience for both the web API and the MCP server, so tokens stay separate", () => {
    expect(() => loadApiEnv({ ...BASE, MCP_SERVER_AUDIENCE: BASE.OIDC_AUDIENCE })).toThrow(/MCP_SERVER_AUDIENCE/);
  });

  it("fails fast without OIDC settings", () => {
    expect(() => loadApiEnv({ DATABASE_APP_ROLE_URL: BASE.DATABASE_APP_ROLE_URL })).toThrow(
      /OIDC_ISSUER/,
    );
  });
});

describe("jwksUrl", () => {
  it("derives the Keycloak certs URL from the issuer", () => {
    expect(jwksUrl(loadApiEnv(BASE)).href).toBe(
      "http://localhost:8081/realms/brain/protocol/openid-connect/certs",
    );
  });

  it("derives the OAuth redirect URL from the public API URL", () => {
    expect(oauthRedirectUrl(loadApiEnv({ ...BASE, PUBLIC_API_URL: "https://api.example.com" }))).toBe(
      "https://api.example.com/oauth/callback",
    );
  });

  it("requires public https URLs in production", () => {
    expect(() => loadApiEnv({ ...BASE, NODE_ENV: "production" })).toThrow(/PUBLIC_API_URL/);
    const prod = {
      ...BASE,
      NODE_ENV: "production",
      PUBLIC_API_URL: "https://api.example.com",
      WEB_APP_URL: "https://app.example.com",
      OIDC_ISSUER: "https://id.example.com/realms/brain",
    };
    expect(loadApiEnv(prod).PUBLIC_API_URL).toBe("https://api.example.com");
  });

  it("fails fast without the connector encryption key", () => {
    const { CONNECTOR_TOKEN_ENC_KEY: _omit, ...rest } = BASE;
    expect(() => loadApiEnv(rest)).toThrow(/CONNECTOR_TOKEN_ENC_KEY/);
  });

  it("prefers an explicit JWKS URL", () => {
    const env = loadApiEnv({ ...BASE, OIDC_JWKS_URL: "https://idp.example/jwks" });
    expect(jwksUrl(env).href).toBe("https://idp.example/jwks");
  });
});
