import { createLogger } from "@brain/telemetry";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createJwtVerifier } from "./auth/jwt-verifier.js";
import type { DirectoryUser, UserDirectory } from "./auth/user-directory.js";
import { createFakeConnections } from "./test-support/fake-connections.js";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "./test-support/tokens.js";
import { unusedProposals } from "./test-support/fake-proposals.js";

const ACME = "0a000000-0000-4000-8000-000000000001";
const GLOBEX = "0b000000-0000-4000-8000-000000000001";
const PAT_SUBJECT = "5a000000-0000-4000-8000-0000000000a4";
const PAT_ID = "0a000000-0000-4000-8000-0000000000a4";
const ENGINEERING = "0a000000-0000-4000-8000-0000000000e1";
const BROKEN_SUBJECT = "broken";

// Fake directory keyed by tenant + subject, mirroring RLS: other tenants resolve to null.
const directory: UserDirectory = {
  async findBySubject(tenantId, subject): Promise<DirectoryUser | null> {
    if (subject === BROKEN_SUBJECT) throw new Error("db connection string postgres://secret");
    if (tenantId === ACME && subject === PAT_SUBJECT) {
      return { userId: PAT_ID, tenantId: ACME, role: "member", groupIds: [ENGINEERING] };
    }
    return null;
  },
};

const logLines: string[] = [];
const silentLogger = createLogger({
  service: "api-test",
  destination: new Writable({
    write(chunk, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
});

let app: NestFastifyApplication;
let keys: TestKeys;

beforeAll(async () => {
  keys = await createTestKeys();
  app = await createApp({
    logger: silentLogger,
    directory,
    connections: createFakeConnections(),
    proposals: unusedProposals,
    answers: { answer: async () => {} },
    webAppUrl: "http://localhost:3000",
    verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

function inject(url: string, headers: Record<string, string> = {}) {
  return app.getHttpAdapter().getInstance().inject({ method: "GET", url, headers });
}

describe("GET /health", () => {
  it("is public and uses the envelope", async () => {
    const res = await inject("/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { status: "ok" }, error: null });
  });
});

describe("GET /me", () => {
  it("returns 401 without a token", async () => {
    const res = await inject("/me");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      success: false,
      data: null,
      error: { code: "UNAUTHENTICATED" },
    });
    expect(res.json().meta.requestId).toBeTruthy();
  });

  it("returns 401 for a non-bearer scheme", async () => {
    const res = await inject("/me", { authorization: "Basic dXNlcjpwYXNz" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the tenant context for a valid token", async () => {
    const token = await keys.sign({ tenant_id: ACME }, { subject: PAT_SUBJECT });
    const res = await inject("/me", { authorization: `Bearer ${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      tenantId: ACME,
      userId: PAT_ID,
      role: "member",
      principals: [`user:${PAT_ID}`, `group:${ENGINEERING}`, "tenant:all"],
    });
  });

  it("ignores tenant headers; the tenant comes only from the verified token", async () => {
    const token = await keys.sign({ tenant_id: ACME }, { subject: PAT_SUBJECT });
    const res = await inject("/me", { authorization: `Bearer ${token}`, "x-tenant-id": GLOBEX });
    expect(res.json().data.tenantId).toBe(ACME);
  });

  it("returns 403 when the subject is not provisioned in the token's tenant", async () => {
    const token = await keys.sign({ tenant_id: GLOBEX }, { subject: PAT_SUBJECT });
    const res = await inject("/me", { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("returns a generic 500 without leaking internals", async () => {
    const token = await keys.sign({ tenant_id: ACME }, { subject: BROKEN_SUBJECT });
    const res = await inject("/me", { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toEqual({ code: "INTERNAL", message: "Internal error" });
    expect(res.body).not.toContain("postgres://");
  });

  it("never logs the bearer token", async () => {
    const token = await keys.sign({ tenant_id: GLOBEX }, { subject: PAT_SUBJECT });
    await inject("/me", { authorization: `Bearer ${token}` });
    expect(logLines.join("")).not.toContain(token);
  });
});

describe("unknown routes", () => {
  it("return 404 in the envelope", async () => {
    const res = await inject("/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });
});
