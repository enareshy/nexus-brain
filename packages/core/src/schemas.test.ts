import { describe, expect, it } from "vitest";
import { AclPrincipalSchema, DocumentSchema, DomainEventSchema, UserSchema } from "./schemas.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";

describe("AclPrincipalSchema", () => {
  it.each([`user:${USER}`, `group:${USER}`, "tenant:all"])("accepts %s", (value) => {
    expect(AclPrincipalSchema.safeParse(value).success).toBe(true);
  });

  it.each(["user:abc", "tenant:other", "admin:all", "", `user:${USER} OR 1=1`])(
    "rejects %s",
    (value) => {
      expect(AclPrincipalSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("DocumentSchema", () => {
  const valid = {
    id: DOC,
    tenantId: TENANT,
    source: "jira",
    externalId: "PROJ-1",
    title: "Fix login",
    url: "https://example.atlassian.net/browse/PROJ-1",
    aclPrincipals: [`user:${USER}`],
    updatedAt: "2026-10-31T10:00:00Z",
  };

  it("accepts a valid document and defaults metadata", () => {
    const parsed = DocumentSchema.parse(valid);
    expect(parsed.metadata).toEqual({});
  });

  it("rejects a document without ACL principals (fail closed)", () => {
    expect(DocumentSchema.safeParse({ ...valid, aclPrincipals: [] }).success).toBe(false);
  });

  it("rejects an unknown source", () => {
    expect(DocumentSchema.safeParse({ ...valid, source: "dropbox" }).success).toBe(false);
  });
});

describe("UserSchema", () => {
  it("rejects an unknown role", () => {
    const result = UserSchema.safeParse({
      id: USER,
      tenantId: TENANT,
      email: "a@example.com",
      displayName: "A",
      role: "superuser",
      externalSubject: "sub",
    });
    expect(result.success).toBe(false);
  });
});

describe("DomainEventSchema", () => {
  it("parses a membership change", () => {
    const event = DomainEventSchema.parse({
      id: DOC,
      tenantId: TENANT,
      occurredAt: "2026-10-31T10:00:00Z",
      type: "membership.change",
      groupId: USER,
      userId: USER,
      change: "removed",
    });
    expect(event.type).toBe("membership.change");
  });

  it("rejects an unknown event type", () => {
    const result = DomainEventSchema.safeParse({
      id: DOC,
      tenantId: TENANT,
      occurredAt: "2026-10-31T10:00:00Z",
      type: "doc.explode",
    });
    expect(result.success).toBe(false);
  });
});
