import { describe, expect, it } from "vitest";
import { canAccess, expandPrincipals, permissionHash } from "./acl.js";
import { AppError } from "./errors.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "22222222-2222-4222-8222-222222222222";
const G1 = "44444444-4444-4444-8444-444444444444";
const G2 = "55555555-5555-4555-8555-555555555555";

describe("expandPrincipals", () => {
  it("includes user, sorted unique groups and tenant:all for members", () => {
    const principals = expandPrincipals({ userId: USER, groupIds: [G2, G1, G2], role: "member" });
    expect(principals).toEqual([`user:${USER}`, `group:${G1}`, `group:${G2}`, "tenant:all"]);
  });

  it("never gives guests tenant:all (guest cannot see member-only content)", () => {
    const principals = expandPrincipals({ userId: USER, groupIds: [G1], role: "guest" });
    expect(principals).toEqual([`user:${USER}`, `group:${G1}`]);
    expect(canAccess(["tenant:all"], principals)).toBe(false);
  });

  it("returns a frozen array", () => {
    expect(Object.isFrozen(expandPrincipals({ userId: USER, groupIds: [], role: "owner" }))).toBe(
      true,
    );
  });

  it("rejects non-UUID identifiers to prevent filter injection", () => {
    expect(() =>
      expandPrincipals({ userId: "x\" OR 1=1", groupIds: [], role: "member" }),
    ).toThrowError(AppError);
    expect(() =>
      expandPrincipals({ userId: USER, groupIds: ["not-a-uuid"], role: "member" }),
    ).toThrowError(AppError);
  });
});

describe("canAccess", () => {
  const principals = expandPrincipals({ userId: USER, groupIds: [G1], role: "member" });

  it("grants when any principal matches", () => {
    expect(canAccess([`group:${G1}`], principals)).toBe(true);
  });

  it("denies when nothing matches", () => {
    expect(canAccess([`group:${G2}`], principals)).toBe(false);
  });

  it("denies an empty ACL (fail closed)", () => {
    expect(canAccess([], principals)).toBe(false);
  });
});

describe("permissionHash", () => {
  const p1 = expandPrincipals({ userId: USER, groupIds: [G1, G2], role: "member" });
  const p2 = expandPrincipals({ userId: USER, groupIds: [G2, G1], role: "member" });
  const p3 = expandPrincipals({ userId: USER, groupIds: [G1], role: "member" });

  it("is order-independent", () => {
    expect(permissionHash(TENANT_A, p1)).toBe(permissionHash(TENANT_A, p2));
  });

  it("changes when access changes", () => {
    expect(permissionHash(TENANT_A, p1)).not.toBe(permissionHash(TENANT_A, p3));
  });

  it("changes across tenants with identical principals", () => {
    expect(permissionHash(TENANT_A, p1)).not.toBe(permissionHash(TENANT_B, p1));
  });

  it("rejects an invalid tenant id", () => {
    expect(() => permissionHash("tenant", p1)).toThrowError(AppError);
  });
});
