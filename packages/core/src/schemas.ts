import { z } from "zod";

export const UuidSchema = z.string().uuid();

export const RoleSchema = z.enum(["owner", "admin", "member", "guest"]);
export type Role = z.infer<typeof RoleSchema>;

/** Sources we connect to through MCP (docs/DECISIONS-AND-INTEGRATIONS.md). */
export const SourceSchema = z.enum([
  "jira",
  "confluence",
  "gdrive",
  "gmail",
  "slack",
  "github",
  "m365",
  "teams",
]);
export type Source = z.infer<typeof SourceSchema>;

export const TenantSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(200),
  region: z.literal("us-east-1"),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const UserSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  email: z.string().email(),
  displayName: z.string().min(1).max(200),
  role: RoleSchema,
  externalSubject: z.string().min(1),
});
export type User = z.infer<typeof UserSchema>;

export const GroupSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  name: z.string().min(1).max(200),
});
export type Group = z.infer<typeof GroupSchema>;

/** `user:<uuid>`, `group:<uuid>` or `tenant:all`. */
export const AclPrincipalSchema = z
  .string()
  .regex(/^(?:(?:user|group):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|tenant:all)$/);

export const DocumentSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  source: SourceSchema,
  externalId: z.string().min(1),
  title: z.string().max(1000),
  url: z.string().url(),
  aclPrincipals: z.array(AclPrincipalSchema).min(1),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Document = z.infer<typeof DocumentSchema>;

export const ChunkSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  documentId: UuidSchema,
  ordinal: z.number().int().nonnegative(),
  text: z.string().min(1),
  aclPrincipals: z.array(AclPrincipalSchema).min(1),
});
export type Chunk = z.infer<typeof ChunkSchema>;

const eventBase = {
  id: UuidSchema,
  tenantId: UuidSchema,
  occurredAt: z.string().datetime(),
};

export const DomainEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("doc.upsert"), document: DocumentSchema }),
  z.object({ ...eventBase, type: z.literal("doc.delete"), documentId: UuidSchema }),
  z.object({
    ...eventBase,
    type: z.literal("acl.change"),
    documentId: UuidSchema,
    aclPrincipals: z.array(AclPrincipalSchema).min(1),
  }),
  z.object({
    ...eventBase,
    type: z.literal("membership.change"),
    groupId: UuidSchema,
    userId: UuidSchema,
    change: z.enum(["added", "removed"]),
  }),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
