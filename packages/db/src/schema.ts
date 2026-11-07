import {
  boolean,
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
import { sql } from "drizzle-orm";

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
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  erasedAt: timestamp("erased_at", { withTimezone: true }),
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

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  status: text("status").notNull().$type<"running" | "waiting_approval" | "completed" | "failed" | "cancelled">(),
  goalCiphertext: text("goal_ciphertext").notNull(),
  stateCiphertext: text("state_ciphertext").notNull(),
  resultCiphertext: text("result_ciphertext"),
  errorCode: text("error_code"),
  turnCount: integer("turn_count").notNull().default(0),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  waitingProposalId: uuid("waiting_proposal_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  triggerId: uuid("trigger_id"),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentSteps = pgTable(
  "agent_steps",
  {
    runId: uuid("run_id").notNull(),
    seq: integer("seq").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    toolName: text("tool_name").notNull(),
    argsHash: text("args_hash").notNull(),
    outcome: text("outcome").notNull(),
    detailCiphertext: text("detail_ciphertext").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);

export const tenantServerSettings = pgTable(
  "tenant_server_settings",
  {
    tenantId: uuid("tenant_id").notNull(),
    serverId: text("server_id").notNull(),
    allowed: boolean("allowed").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.serverId] })],
);

export const tenantBudgets = pgTable("tenant_budgets", {
  tenantId: uuid("tenant_id").primaryKey(),
  monthlyLimitUsd: numeric("monthly_limit_usd", { precision: 12, scale: 2 }),
  perPersonLimitUsd: numeric("per_person_limit_usd", { precision: 12, scale: 2 }),
  warnAtPercent: integer("warn_at_percent").notNull().default(80),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantPlans = pgTable("tenant_plans", {
  tenantId: uuid("tenant_id").primaryKey(),
  plan: text("plan").notNull(),
  monthlyCredits: integer("monthly_credits").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const creditTopups = pgTable("credit_topups", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  credits: integer("credits").notNull(),
  addedBy: uuid("added_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantRetention = pgTable("tenant_retention", {
  tenantId: uuid("tenant_id").primaryKey(),
  conversationDays: integer("conversation_days"),
  agentRunDays: integer("agent_run_days"),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantAiSettings = pgTable("tenant_ai_settings", {
  tenantId: uuid("tenant_id").primaryKey(),
  modelChoice: text("model_choice").notNull().$type<"premium" | "standard">(),
  agentsEnabled: boolean("agents_enabled").notNull(),
  automaticAgentsEnabled: boolean("automatic_agents_enabled").notNull(),
  automaticRunsPerDay: integer("automatic_runs_per_day").notNull(),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentTriggers = pgTable("agent_triggers", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  kind: text("kind").notNull().$type<"schedule" | "jira_assigned" | "jira_mention">(),
  goalCiphertext: text("goal_ciphertext").notNull(),
  intervalMinutes: integer("interval_minutes").notNull(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  pausedReason: text("paused_reason"),
  baselinedAt: timestamp("baselined_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentTriggerEvents = pgTable(
  "agent_trigger_events",
  {
    triggerId: uuid("trigger_id").notNull(),
    eventHash: text("event_hash").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.triggerId, table.eventHash] })],
);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  kind: text("kind").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  titleCiphertext: text("title_ciphertext").notNull(),
  agentRunId: uuid("agent_run_id"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  titleCiphertext: text("title_ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversationMessages = pgTable("conversation_messages", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull().$type<"user" | "assistant">(),
  payloadCiphertext: text("payload_ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
});

export const messageFeedback = pgTable("message_feedback", {
  messageId: uuid("message_id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  rating: text("rating").notNull().$type<"up" | "down">(),
  reasonCiphertext: text("reason_ciphertext"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memories = pgTable("memories", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  textCiphertext: text("text_ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  /** The person who wrote it, who alone can change it. */
  userId: uuid("user_id").notNull(),
  nameCiphertext: text("name_ciphertext").notNull(),
  instructionsCiphertext: text("instructions_ciphertext").notNull(),
  tools: text("tools").array().notNull(),
  shared: boolean("shared").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

/** One use counted against a per-person rate limit, until it expires (migration 0025). */
export const rateLimitUses = pgTable("rate_limit_uses", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  userId: uuid("user_id").notNull(),
  bucket: text("bucket").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  agentRunId: uuid("agent_run_id"),
  beforeState: jsonb("before_state").$type<Record<string, unknown>>(),
  afterState: jsonb("after_state").$type<Record<string, unknown>>(),
  undoOf: uuid("undo_of"),
  expectedState: jsonb("expected_state").$type<Record<string, unknown>>(),
});

export type ProposalStatus = "pending" | "executing" | "succeeded" | "failed" | "unknown" | "rejected";

export const schema = {
  agentRuns,
  agentSteps,
  agentTriggers,
  agentTriggerEvents,
  notifications,
  tenantServerSettings,
  tenantBudgets,
  conversations,
  conversationMessages,
  messageFeedback,
  memories,
  mcpServerApps,
  writeProposals,
  rateLimitUses,
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
