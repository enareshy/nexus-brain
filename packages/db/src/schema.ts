import {
  bigserial,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Mirrors migrations/*.sql. SQL migrations are the source of truth (RLS needs raw SQL).

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  region: text("region").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["owner", "admin", "member", "guest"] }).notNull(),
  externalSubject: text("external_subject").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groups = pgTable("groups", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groupMembers = pgTable(
  "group_members",
  {
    tenantId: uuid("tenant_id").notNull(),
    groupId: uuid("group_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.userId] })],
);

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id"),
  action: text("action").notNull(),
  resource: text("resource"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpConnections = pgTable(
  "mcp_connections",
  {
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    serverId: text("server_id").notNull(),
    status: text("status", { enum: ["active", "needs_reauth"] }).notNull(),
    tokensCiphertext: text("tokens_ciphertext").notNull(),
    scopes: text("scopes"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId, table.serverId] })],
);

export const oauthStates = pgTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  serverId: text("server_id").notNull(),
  verifierCiphertext: text("verifier_ciphertext").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpClientRegistrations = pgTable("mcp_client_registrations", {
  serverId: text("server_id").primaryKey(),
  clientInfoCiphertext: text("client_info_ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageLedger = pgTable("usage_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  feature: text("feature").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpServerApps = pgTable(
  "mcp_server_apps",
  {
    tenantId: uuid("tenant_id").notNull(),
    serverId: text("server_id").notNull(),
    clientId: text("client_id").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.serverId] })],
);

export const writeProposals = pgTable("write_proposals", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  serverId: text("server_id").notNull(),
  action: text("action").notNull(),
  toolName: text("tool_name").notNull(),
  toolClass: text("tool_class").notNull().$type<"write" | "external-effect">(),
  args: jsonb("args").notNull().$type<Record<string, unknown>>(),
  argsHash: text("args_hash").notNull(),
  siteOrigin: text("site_origin").notNull(),
  status: text("status").notNull().$type<ProposalStatus>(),
  externalId: text("external_id"),
  resultUrl: text("result_url"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type ProposalStatus = "pending" | "executing" | "succeeded" | "failed" | "unknown" | "rejected";

export const schema = {
  mcpServerApps,
  writeProposals,
  usageLedger,
  tenants,
  users,
  groups,
  groupMembers,
  auditLog,
  mcpConnections,
  oauthStates,
  mcpClientRegistrations,
};
