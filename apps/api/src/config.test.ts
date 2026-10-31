import { describe, expect, it } from "vitest";
import { jwksUrl, loadApiEnv } from "./config.js";

const BASE = {
  DATABASE_APP_ROLE_URL: "postgres://brain_app:x@localhost:5432/brain",
  OIDC_ISSUER: "http://localhost:8081/realms/brain/",
  OIDC_AUDIENCE: "brain-api",
};

describe("loadApiEnv", () => {
  it("applies defaults", () => {
    const env = loadApiEnv(BASE);
    expect(env.API_PORT).toBe(3001);
    expect(env.API_HOST).toBe("127.0.0.1");
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

  it("prefers an explicit JWKS URL", () => {
    const env = loadApiEnv({ ...BASE, OIDC_JWKS_URL: "https://idp.example/jwks" });
    expect(jwksUrl(env).href).toBe("https://idp.example/jwks");
  });
});
