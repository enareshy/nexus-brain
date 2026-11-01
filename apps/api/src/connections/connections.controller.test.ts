import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createJwtVerifier } from "../auth/jwt-verifier.js";
import type { UserDirectory } from "../auth/user-directory.js";
import { createFakeConnections, type FakeConnections } from "../test-support/fake-connections.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { unusedProposals } from "../test-support/fake-proposals.js";

const ACME = "0a000000-0000-4000-8000-000000000001";
const PAT = "0a000000-0000-4000-8000-0000000000a4";
const SUBJECT = "5a000000-0000-4000-8000-0000000000a4";

const directory: UserDirectory = {
  findBySubject: async (tenantId, subject) =>
    tenantId === ACME && subject === SUBJECT
      ? { userId: PAT, tenantId: ACME, role: "member", groupIds: [] }
      : null,
};

let app: NestFastifyApplication;
let keys: TestKeys;
let fake: FakeConnections;
let token: string;

beforeAll(async () => {
  keys = await createTestKeys();
  fake = createFakeConnections();
  app = await createApp({
    logger: createLogger({ service: "t", destination: new Writable({ write: (_c, _e, d) => d() }) }),
    directory,
    connections: fake,
    proposals: unusedProposals,
    answers: { answer: async () => {} },
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  token = await keys.sign({ tenant_id: ACME }, { subject: SUBJECT });
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  fake.calls.length = 0;
});

function req(method: "GET" | "POST" | "DELETE", url: string, opts: { auth?: boolean; body?: unknown } = {}) {
  return app.getHttpAdapter().getInstance().inject({
    method,
    url,
    headers: opts.auth === false ? {} : { authorization: `Bearer ${token}` },
    ...(opts.body === undefined ? {} : { payload: opts.body as object }),
  });
}

const scope = { tenantId: ACME, userId: PAT };

describe("connections endpoints", () => {
  it("require authentication", async () => {
    expect((await req("GET", "/connections", { auth: false })).statusCode).toBe(401);
    expect((await req("POST", "/connections/atlassian/authorize", { auth: false })).statusCode).toBe(401);
    expect((await req("POST", "/connections/complete", { auth: false, body: { code: "good", state: "s" } })).statusCode).toBe(401);
    expect((await req("GET", "/search?q=x", { auth: false })).statusCode).toBe(401);
  });

  it("list connections for the caller's scope only", async () => {
    const res = await req("GET", "/connections");
    expect(res.statusCode).toBe(200);
    expect(fake.calls[0]).toEqual({ method: "list", args: [scope] });
  });

  it("start authorization and return the consent URL", async () => {
    const res = await req("POST", "/connections/atlassian/authorize");
    expect(res.json().data.authorizationUrl).toContain("mcp.atlassian.com");
    expect(fake.calls[0]).toEqual({ method: "authorize", args: [scope, "atlassian"] });
  });

  it("complete consent for the signed-in user", async () => {
    const res = await req("POST", "/connections/complete", { body: { code: "good", state: "abc" } });
    expect(res.statusCode).toBe(200);
    expect(fake.calls[0]).toEqual({ method: "complete", args: [scope, "good", "abc"] });
  });

  it("reject a malformed completion body", async () => {
    expect((await req("POST", "/connections/complete", { body: { code: "" } })).statusCode).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("reject malformed server ids before reaching the service", async () => {
    const res = await req("POST", "/connections/..%2Fevil/authorize");
    expect(res.statusCode).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("disconnect and list tools in scope", async () => {
    const res = await req("DELETE", "/connections/atlassian");
    expect(res.json().data).toEqual({ disconnected: true, revoked: true });
    await req("GET", "/connections/atlassian/tools");
    expect(fake.calls.map((c) => c.method)).toEqual(["disconnect", "tools"]);
  });
});

describe("GET /search", () => {
  it("validates the query and applies a default limit", async () => {
    expect((await req("GET", "/search")).statusCode).toBe(400);
    expect((await req("GET", `/search?q=${"x".repeat(201)}`)).statusCode).toBe(400);
    expect((await req("GET", "/search?q=login&limit=99")).statusCode).toBe(400);

    const res = await req("GET", "/search?q=%20login%20");
    expect(res.statusCode).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ method: "search", args: [scope, "login", 10] });
  });
});

describe("GET /oauth/callback", () => {
  it("is public, does not complete anything, and forwards code + state to the web app", async () => {
    const res = await req("GET", "/oauth/callback?code=c1&state=s1", { auth: false });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:3000/connections/complete?code=c1&state=s1");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(fake.calls).toEqual([]);
  });

  it("redirects with only an error status when consent was declined or incomplete", async () => {
    for (const url of ["/oauth/callback?error=access_denied&state=s", "/oauth/callback?code=c"]) {
      const res = await req("GET", url, { auth: false });
      expect(res.headers.location).toBe("http://localhost:3000/connections/complete?status=error");
    }
  });
});

describe("hardening", () => {
  it("sets a CORS allow-origin only for the web app", async () => {
    const res = await app.getHttpAdapter().getInstance().inject({
      method: "OPTIONS",
      url: "/connections",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
  });

  it("applies rate limiting headers", async () => {
    const res = await req("GET", "/health", { auth: false });
    expect(res.headers["x-ratelimit-limit"]).toBe("120");
  });
});
