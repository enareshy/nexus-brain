import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors.js";
import { createSecretBox } from "./vault.js";

const KEY = randomBytes(32).toString("base64");

describe("createSecretBox", () => {
  const box = createSecretBox(KEY);

  it("round-trips with the same context", () => {
    const sealed = box.seal("access-token-value", "tenant|user|jira");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("access-token-value");
    expect(box.open(sealed, "tenant|user|jira")).toBe("access-token-value");
  });

  it("uses a fresh IV each time", () => {
    expect(box.seal("x", "c")).not.toBe(box.seal("x", "c"));
  });

  it("refuses to open under a different context (row swap)", () => {
    const sealed = box.seal("secret", "tenantA|userA|jira");
    expect(() => box.open(sealed, "tenantA|userB|jira")).toThrowError(AppError);
  });

  it("refuses tampered ciphertext", () => {
    const sealed = box.seal("secret", "ctx");
    const parts = sealed.split(".");
    const body = Buffer.from(parts[3]!, "base64url");
    body[0] = body[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString("base64url")].join(".");
    expect(() => box.open(tampered, "ctx")).toThrowError(AppError);
  });

  it("refuses a different key", () => {
    const other = createSecretBox(randomBytes(32).toString("base64"));
    expect(() => other.open(box.seal("secret", "ctx"), "ctx")).toThrowError(AppError);
  });

  it("rejects malformed input", () => {
    expect(() => box.open("garbage", "ctx")).toThrowError(/Unreadable/);
  });

  it("fingerprints deterministically per key and never reveals the input", () => {
    const other = createSecretBox(randomBytes(32).toString("base64"));
    expect(box.fingerprint("login bug")).toBe(box.fingerprint("login bug"));
    expect(box.fingerprint("login bug")).not.toBe(other.fingerprint("login bug"));
    expect(box.fingerprint("login bug")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => createSecretBox(randomBytes(16).toString("base64"))).toThrowError(/32 bytes/);
  });
});
