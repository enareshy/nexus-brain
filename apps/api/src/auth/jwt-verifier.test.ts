import { AppError } from "@brain/core";
import { beforeAll, describe, expect, it } from "vitest";
import { AUDIENCE, createTestKeys, ISSUER, type TestKeys } from "../test-support/tokens.js";
import { createJwtVerifier, type IdentityVerifier } from "./jwt-verifier.js";

const TENANT = "0a000000-0000-4000-8000-000000000001";
const SUBJECT = "5a000000-0000-4000-8000-0000000000a1";

let keys: TestKeys;
let verifier: IdentityVerifier;

beforeAll(async () => {
  keys = await createTestKeys();
  verifier = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: keys.keySet });
});

async function expectRejected(token: string, message: RegExp) {
  const error = await verifier.verify(token).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe("UNAUTHENTICATED");
  expect((error as AppError).message).toMatch(message);
}

describe("createJwtVerifier", () => {
  it("returns subject and tenant for a valid token", async () => {
    const token = await keys.sign({ tenant_id: TENANT }, { subject: SUBJECT });
    await expect(verifier.verify(token)).resolves.toEqual({ subject: SUBJECT, tenantId: TENANT });
  });

  it("rejects the wrong audience", async () => {
    const token = await keys.sign({ tenant_id: TENANT }, { subject: SUBJECT, audience: "other" });
    await expectRejected(token, /Invalid or expired/);
  });

  it("rejects the wrong issuer", async () => {
    const token = await keys.sign(
      { tenant_id: TENANT },
      { subject: SUBJECT, issuer: "https://evil.example" },
    );
    await expectRejected(token, /Invalid or expired/);
  });

  it("rejects an expired token beyond clock tolerance", async () => {
    const past = Math.floor(Date.now() / 1000) - 120;
    const token = await keys.sign({ tenant_id: TENANT }, { subject: SUBJECT, expiresIn: past });
    await expectRejected(token, /Invalid or expired/);
  });

  it("rejects a token signed by an unknown key", async () => {
    const other = await createTestKeys();
    const token = await other.sign({ tenant_id: TENANT }, { subject: SUBJECT });
    await expectRejected(token, /Invalid or expired/);
  });

  it("rejects malformed input", async () => {
    await expectRejected("not-a-jwt", /Invalid or expired/);
  });

  it("rejects a token without a tenant claim", async () => {
    const token = await keys.sign({}, { subject: SUBJECT });
    await expectRejected(token, /missing required claims/);
  });

  it("rejects a non-UUID tenant claim", async () => {
    const token = await keys.sign({ tenant_id: "acme" }, { subject: SUBJECT });
    await expectRejected(token, /missing required claims/);
  });

  it("rejects a token without a subject", async () => {
    const token = await keys.sign({ tenant_id: TENANT });
    await expectRejected(token, /Invalid or expired/);
  });

  it("rejects a token without exp (would never expire)", async () => {
    const token = await keys.sign({ tenant_id: TENANT }, { subject: SUBJECT, expiresIn: null });
    await expectRejected(token, /Invalid or expired/);
  });

  it("returns 503 UNAVAILABLE when the key set cannot be reached", async () => {
    const offline = createJwtVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keySet: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const token = await keys.sign({ tenant_id: TENANT }, { subject: SUBJECT });
    const error = (await offline.verify(token).catch((e: unknown) => e)) as AppError;
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.status).toBe(503);
  });
});
