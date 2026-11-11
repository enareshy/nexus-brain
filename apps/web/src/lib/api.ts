import { z } from "zod";

export const ConnectionSchema = z.object({
  serverId: z.string(),
  displayName: z.string(),
  status: z.enum(["not_connected", "active", "needs_reauth"]),
  lastUsedAt: z.string().nullable(),
  setup: z.enum(["ready", "needs_app", "configured"]),
  redirectUrl: z.string(),
  allowed: z.boolean(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const HitSchema = z.object({
  serverId: z.string(),
  externalId: z.string(),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  updatedAt: z.string().nullable(),
  score: z.number(),
  /** Which provider site the item is on, needed to read it again for a summary. */
  siteId: z.string().optional(),
});
export type Hit = z.infer<typeof HitSchema>;

export const SourceStatusSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  hits: z.number(),
  ms: z.number(),
  error: z.string().optional(),
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const SearchResultSchema = z.object({
  hits: z.array(HitSchema),
  sources: z.array(SourceStatusSchema),
  expandedTerms: z.array(z.string()).optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const MeSchema = z.object({
  tenantId: z.string(),
  userId: z.string(),
  role: z.string(),
  principals: z.array(z.string()),
});
export type Me = z.infer<typeof MeSchema>;

export const ProposalSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  action: z.string(),
  toolName: z.string(),
  toolClass: z.enum(["write", "external-effect"]),
  args: z.record(z.string(), z.unknown()),
  argsHash: z.string(),
  status: z.enum(["pending", "executing", "succeeded", "failed", "unknown", "rejected", "expired"]),
  externalId: z.string().nullable(),
  url: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  agentRunId: z.string().nullable().optional(),
  undoOf: z.string().nullable().optional(),
  canUndo: z.boolean().optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const WriteTargetSchema = z.object({
  siteId: z.string(),
  siteOrigin: z.string(),
  projects: z.array(z.object({ key: z.string(), name: z.string(), issueTypes: z.array(z.string()) })),
});
export type WriteTarget = z.infer<typeof WriteTargetSchema>;

/** Work Brain does on one search result (FR-AST-06). */
export type ItemTask = { kind: "summary" } | { kind: "draft"; request: string } | { kind: "subtasks" };

const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** A Jira issue, which can take comments and subtasks. */
export const isJiraIssue = (hit: Hit): hit is Hit & { siteId: string } =>
  hit.serverId === "atlassian" && Boolean(hit.siteId) && JIRA_ISSUE_KEY.test(hit.externalId);

export type WriteRequest =
  | {
      action: "create_issue";
      siteId: string;
      projectKey: string;
      issueType: string;
      summary: string;
      description?: string;
    }
  | { action: "update_issue"; siteId: string; issueKey: string; summary?: string; description?: string }
  | { action: "add_comment"; siteId: string; issueKey: string; body: string }
  | { action: "create_subtask"; siteId: string; parentKey: string; summary: string; description?: string };

export const AuditEntrySchema = z.object({
  id: z.number(),
  userId: z.string().nullable(),
  userEmail: z.string().nullable(),
  action: z.string(),
  resource: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const SavedAnswerSchema = z.object({
  parts: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), text: z.string() }),
      z.object({ kind: z.literal("cite"), source: z.number(), quotes: z.array(z.string().max(700)).max(5).optional() }),
    ]),
  ),
  hits: z.array(HitSchema),
  outcome: z.enum(["answered", "no_documents", "refused", "incomplete", "search_only"]),
  grounded: z.boolean(),
  truncatedDocuments: z.number(),
});
export type SavedAnswer = z.infer<typeof SavedAnswerSchema>;

export const ConversationSummarySchema = z.object({ id: z.string(), title: z.string(), updatedAt: z.string() });
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(
    z.discriminatedUnion("role", [
      z.object({ id: z.string(), role: z.literal("user"), createdAt: z.string(), text: z.string() }),
      z.object({
        id: z.string(),
        role: z.literal("assistant"),
        createdAt: z.string(),
        answer: SavedAnswerSchema,
        rating: z.enum(["up", "down"]).nullable(),
      }),
    ]),
  ),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

const AgentRunStatusSchema = z.enum(["running", "waiting_approval", "completed", "failed", "cancelled"]);

export const AgentRunSummarySchema = z.object({
  id: z.string(),
  goal: z.string(),
  status: AgentRunStatusSchema,
  errorCode: z.string().nullable(),
  automatic: z.boolean().optional(),
  createdAt: z.string(),
});
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;

export const AgentRunSchema = AgentRunSummarySchema.extend({
  result: z.string().nullable(),
  costUsd: z.number(),
  turnCount: z.number(),
  waitingProposalId: z.string().nullable(),
  steps: z.array(
    z.object({
      seq: z.number(),
      tool: z.string(),
      outcome: z.string(),
      documents: z.array(z.object({ title: z.string(), url: z.string() })),
      proposalId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AgentTriggerSchema = z.object({
  id: z.string(),
  kind: z.enum(["schedule", "jira_assigned", "jira_mention"]),
  goal: z.string(),
  schedule: z.enum(["hourly", "daily", "weekly"]).nullable(),
  enabled: z.boolean(),
  pausedReason: z.string().nullable(),
  nextRunAt: z.string(),
});
export type AgentTrigger = z.infer<typeof AgentTriggerSchema>;
export type NewAgentTrigger =
  | { kind: "schedule"; goal: string; schedule: "hourly" | "daily" | "weekly" }
  | { kind: "jira_assigned" | "jira_mention"; goal: string };

export const NotificationSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  runId: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const MemorySchema = z.object({
  id: z.string(),
  text: z.string(),
  readable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Memory = z.infer<typeof MemorySchema>;

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  tools: z.array(z.string()),
  shared: z.boolean(),
  mine: z.boolean(),
  ownerName: z.string(),
  readable: z.boolean(),
  updatedAt: z.string(),
});
export type Skill = z.infer<typeof SkillSchema>;
export type SkillInput = Pick<Skill, "name" | "instructions" | "tools" | "shared">;

const BudgetLevelSchema = z.enum(["ok", "warn", "stop"]);

export const BudgetStatusSchema = z.object({
  level: BudgetLevelSchema,
  limit: z.enum(["company", "person", "credits"]).nullable(),
  percentUsed: z.number().nullable(),
});
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

export const BudgetSchema = z.object({
  monthlyLimitUsd: z.number().nullable(),
  perPersonLimitUsd: z.number().nullable(),
  warnAtPercent: z.number(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const CreditsSchema = z.object({
  plan: z.string(),
  planLabel: z.string(),
  monthlyCredits: z.number(),
  topUpCredits: z.number(),
  usedCredits: z.number(),
  leftCredits: z.number(),
  level: BudgetLevelSchema,
  topUps: z.array(z.object({ id: z.string(), credits: z.number(), addedByEmail: z.string().nullable(), createdAt: z.string() })),
});
export type Credits = z.infer<typeof CreditsSchema>;

export const RetentionSchema = z.object({ conversationDays: z.number().nullable(), agentRunDays: z.number().nullable() });
export type Retention = z.infer<typeof RetentionSchema>;

export const MAX_AUTOMATIC_RUNS_PER_DAY = 10;
export const AiSettingsSchema = z.object({
  modelChoice: z.enum(["premium", "standard"]),
  agentsEnabled: z.boolean(),
  automaticAgentsEnabled: z.boolean(),
  automaticRunsPerDay: z.number().int().min(1).max(MAX_AUTOMATIC_RUNS_PER_DAY),
  agentChangesAllowed: z.boolean(),
  peopleChooseModel: z.boolean(),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;
export type ModelChoice = AiSettings["modelChoice"];

const ModelChoiceSchema = z.enum(["premium", "standard"]);
export const PersonalModelViewSchema = z.object({
  modelChoice: ModelChoiceSchema.nullable(),
  companyModel: ModelChoiceSchema,
  peopleCanChoose: z.boolean(),
  inUse: ModelChoiceSchema,
});
export type PersonalModelView = z.infer<typeof PersonalModelViewSchema>;

export const AgentModeViewSchema = z.object({ mode: z.enum(["ask", "read_only"]), companyAllowsChanges: z.boolean() });
export type AgentModeView = z.infer<typeof AgentModeViewSchema>;
export type AgentMode = AgentModeView["mode"];

export const UsageOverviewSchema = z.object({
  summary: z.object({
    monthStart: z.string(),
    totalUsd: z.number(),
    calls: z.number(),
    unpricedCalls: z.number(),
    byFeature: z.array(z.object({ feature: z.string(), costUsd: z.number(), calls: z.number() })),
    byPerson: z.array(z.object({ userId: z.string(), email: z.string().nullable(), costUsd: z.number(), calls: z.number() })),
    byDay: z.array(z.object({ day: z.string(), costUsd: z.number() })),
  }),
  budget: BudgetSchema.nullable(),
  companyLevel: BudgetLevelSchema,
  credits: CreditsSchema.nullable(),
});
export type UsageOverview = z.infer<typeof UsageOverviewSchema>;

export const PersonSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["owner", "admin", "member", "guest"]),
  active: z.boolean(),
  deactivatedAt: z.string().nullable(),
  erased: z.boolean(),
});
export type Person = z.infer<typeof PersonSchema>;

/** One item in the person's own work graph (FR-RET-09). Ids only: titles are never stored. */
export const GraphItemSchema = z.object({
  serverId: z.string(),
  itemId: z.string(),
  opened: z.number(),
  helpful: z.number(),
  linkedItems: z.number(),
  lastSeenAt: z.string(),
});
export type GraphItem = z.infer<typeof GraphItemSchema>;

/** Whether the company's learned ranker is in use (FR-RET-08), for admins. */
export const RankerStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("never_trained"), minAnswers: z.number() }),
  z.object({
    state: z.enum(["on", "off"]),
    minAnswers: z.number(),
    trainedAt: z.string(),
    details: z
      .object({
        reason: z.enum(["too_few", "no_gain", "better"]),
        answers: z.number(),
        examples: z.number(),
        holdoutMrr: z.number(),
        baselineMrr: z.number(),
      })
      .nullable(),
  }),
]);
export type RankerStatus = z.infer<typeof RankerStatusSchema>;

export const ErasureSchema = z.object({
  erased: z.boolean(),
  conversations: z.number(),
  memories: z.number(),
  skills: z.number(),
  agentRuns: z.number(),
  automaticAgents: z.number(),
  changes: z.number(),
  notifications: z.number(),
});
export type Erasure = z.infer<typeof ErasureSchema>;

export const DeactivationSchema = z.object({
  changed: z.boolean(),
  connectionsRemoved: z.number(),
  connectionsRevoked: z.number(),
  triggersPaused: z.number(),
  runsCancelled: z.number(),
  proposalsRejected: z.number(),
  changesInProgress: z.number(),
});
export type Deactivation = z.infer<typeof DeactivationSchema>;

const ErrorEnvelope = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type Fetch = typeof fetch;

export interface ApiClient {
  me(): Promise<Me>;
  connections(): Promise<Connection[]>;
  authorize(serverId: string): Promise<{ authorizationUrl: string }>;
  complete(code: string, state: string): Promise<{ serverId: string }>;
  disconnect(serverId: string): Promise<{ disconnected: boolean; revoked: boolean }>;
  saveServerApp(serverId: string, app: { clientId: string; clientSecret: string }): Promise<{ saved: true }>;
  setServerAllowed(serverId: string, allowed: boolean): Promise<{ allowed: boolean }>;
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult>;
  /** Opens the answer stream and returns its body. Resolves once headers arrive. */
  openAnswerStream(question: string, signal: AbortSignal, conversationId?: string): Promise<ReadableStream<Uint8Array>>;
  /** Opens a summary, draft or subtask suggestions for one search result, in the same events as an answer. */
  openItemStream(task: ItemTask, hit: Hit, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  conversations(): Promise<ConversationSummary[]>;
  conversation(id: string): Promise<ConversationDetail>;
  deleteConversation(id: string): Promise<{ deleted: true }>;
  sendFeedback(
    conversationId: string,
    messageId: string,
    feedback: { rating: "up" | "down"; reason?: string },
  ): Promise<{ saved: true }>;
  audit(before?: number): Promise<{ entries: AuditEntry[]; nextBefore: number | null }>;
  memories(): Promise<Memory[]>;
  addMemory(text: string): Promise<Memory>;
  updateMemory(id: string, text: string): Promise<Memory>;
  deleteMemory(id: string): Promise<{ deleted: true }>;
  deleteAllMemories(): Promise<{ deleted: number }>;
  workGraph(): Promise<GraphItem[]>;
  /** Tells Brain the person opened one of their search results. Survives the page being left. */
  openedResult(item: { serverId: string; itemId: string }): Promise<void>;
  forgetGraphItem(item: { serverId: string; itemId: string }): Promise<{ forgotten: number }>;
  clearWorkGraph(): Promise<{ deleted: number }>;
  rankerStatus(): Promise<RankerStatus>;
  skills(): Promise<Skill[]>;
  addSkill(skill: SkillInput): Promise<Skill>;
  updateSkill(id: string, skill: SkillInput): Promise<Skill>;
  deleteSkill(id: string): Promise<{ deleted: true }>;
  usageStatus(): Promise<BudgetStatus>;
  usageOverview(): Promise<UsageOverview>;
  setBudget(budget: Budget): Promise<Budget>;
  addCredits(credits: number): Promise<Credits>;
  retention(): Promise<Retention>;
  setRetention(retention: Retention): Promise<Retention>;
  /** Everyone may read them; only admins may change them. */
  aiSettings(): Promise<AiSettings>;
  setAiSettings(settings: AiSettings): Promise<AiSettings>;
  /** Everything Brain holds for the signed-in person, as plain data. */
  exportMyData(): Promise<unknown>;
  people(): Promise<Person[]>;
  deactivatePerson(id: string): Promise<Deactivation>;
  reactivatePerson(id: string): Promise<{ changed: boolean }>;
  /** Only for someone already turned off. Cannot be undone. */
  erasePerson(id: string): Promise<Erasure>;
  agentTriggers(): Promise<AgentTrigger[]>;
  createAgentTrigger(trigger: NewAgentTrigger): Promise<AgentTrigger>;
  deleteAgentTrigger(id: string): Promise<{ deleted: true }>;
  notifications(): Promise<{ items: Notification[]; unread: number }>;
  markNotificationsRead(ids?: string[]): Promise<{ read: true }>;
  agentRuns(): Promise<AgentRunSummary[]>;
  agentRun(id: string): Promise<AgentRun>;
  /** With a skill, the run follows its instructions and uses only its tools. Pass the skill as it was shown. */
  startAgentRun(goal: string, skill?: Pick<Skill, "id" | "updatedAt">): Promise<AgentRunSummary>;
  agentMode(): Promise<AgentModeView>;
  personalModel(): Promise<PersonalModelView>;
  setPersonalModel(modelChoice: ModelChoice | null): Promise<PersonalModelView>;
  setAgentMode(mode: AgentMode): Promise<AgentModeView>;
  cancelAgentRun(id: string): Promise<{ cancelled: true }>;
  proposal(id: string): Promise<Proposal>;
  proposals(): Promise<Proposal[]>;
  writeTargets(serverId: string): Promise<WriteTarget[]>;
  propose(serverId: string, request: WriteRequest): Promise<Proposal>;
  approveProposal(id: string, argsHash: string): Promise<Proposal>;
  rejectProposal(id: string): Promise<Proposal>;
  undoProposal(id: string): Promise<Proposal>;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Joins a path to a base URL without discarding a base path prefix (e.g. https://h/api). */
export function joinUrl(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\//, ""), baseUrl.replace(/\/?$/, "/"));
}

/**
 * Typed client for the Nexus Brain API. Every response is validated with Zod, so
 * unexpected shapes fail loudly instead of rendering partial data.
 */
export function createApiClient(
  baseUrl: string,
  getToken: () => string | null,
  fetchImpl: Fetch = (...args) => fetch(...args),
): ApiClient {
  async function request<T>(schema: z.ZodType<T>, path: string, init: RequestInit = {}): Promise<T> {
    const token = getToken();
    if (!token) throw new ApiError("UNAUTHENTICATED", "Please sign in", 401);

    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetchImpl(joinUrl(baseUrl, path), { ...init, headers, signal });
    } catch (err) {
      if (init.signal?.aborted) throw new ApiError("ABORTED", "Request was cancelled", 0);
      throw new ApiError("NETWORK", err instanceof DOMException && err.name === "TimeoutError" ? "The API took too long to respond" : "Cannot reach the Nexus Brain API", 0);
    }

    const body: unknown = await res.json().catch(() => null);
    const failure = ErrorEnvelope.safeParse(body);
    if (failure.success) {
      throw new ApiError(failure.data.error.code, failure.data.error.message, res.status);
    }
    const envelope = z.object({ success: z.literal(true), data: z.unknown() }).safeParse(body);
    const data = envelope.success ? schema.safeParse(envelope.data.data) : null;
    if (!data?.success) throw new ApiError("BAD_RESPONSE", "Unexpected response from the API", res.status);
    return data.data;
  }

  const enc = encodeURIComponent;
  return {
    me: () => request(MeSchema, "/me"),
    connections: () => request(z.array(ConnectionSchema), "/connections"),
    authorize: (serverId) =>
      request(z.object({ authorizationUrl: z.string() }), `/connections/${enc(serverId)}/authorize`, { method: "POST" }),
    complete: (code, state) =>
      request(z.object({ serverId: z.string() }), "/connections/complete", {
        method: "POST",
        body: JSON.stringify({ code, state }),
      }),
    disconnect: (serverId) =>
      request(z.object({ disconnected: z.boolean(), revoked: z.boolean() }), `/connections/${enc(serverId)}`, {
        method: "DELETE",
      }),
    saveServerApp: (serverId, app) =>
      request(z.object({ saved: z.literal(true) }), `/connections/${enc(serverId)}/app`, {
        method: "POST",
        body: JSON.stringify(app),
      }),
    setServerAllowed: (serverId, allowed) =>
      request(z.object({ allowed: z.boolean() }), `/connections/${enc(serverId)}/allowed`, {
        method: "POST",
        body: JSON.stringify({ allowed }),
      }),
    search: (query, options = {}) =>
      request(SearchResultSchema, `/search?q=${enc(query)}&limit=${options.limit ?? 10}`, {
        signal: options.signal,
      }),
    audit: (before) =>
      request(
        z.object({ entries: z.array(AuditEntrySchema), nextBefore: z.number().nullable() }),
        before === undefined ? "/admin/audit" : `/admin/audit?before=${before}`,
      ),
    memories: () => request(z.array(MemorySchema), "/memories"),
    addMemory: (text) => request(MemorySchema, "/memories", { method: "POST", body: JSON.stringify({ text }) }),
    updateMemory: (id, text) => request(MemorySchema, `/memories/${enc(id)}`, { method: "POST", body: JSON.stringify({ text }) }),
    deleteMemory: (id) => request(z.object({ deleted: z.literal(true) }), `/memories/${enc(id)}`, { method: "DELETE" }),
    deleteAllMemories: () => request(z.object({ deleted: z.number() }), "/memories", { method: "DELETE" }),
    workGraph: () => request(z.array(GraphItemSchema), "/me/work-graph"),
    openedResult: async ({ serverId, itemId }) => {
      await request(z.unknown(), "/me/work-graph/opened", { method: "POST", body: JSON.stringify({ serverId, itemId }), keepalive: true });
    },
    forgetGraphItem: ({ serverId, itemId }) =>
      request(z.object({ forgotten: z.number() }), "/me/work-graph/forget", { method: "POST", body: JSON.stringify({ serverId, itemId }) }),
    clearWorkGraph: () => request(z.object({ deleted: z.number() }), "/me/work-graph", { method: "DELETE" }),
    rankerStatus: () => request(RankerStatusSchema, "/admin/ranker"),
    skills: () => request(z.array(SkillSchema), "/skills"),
    addSkill: (skill) => request(SkillSchema, "/skills", { method: "POST", body: JSON.stringify(skill) }),
    updateSkill: (id, skill) => request(SkillSchema, `/skills/${enc(id)}`, { method: "POST", body: JSON.stringify(skill) }),
    deleteSkill: (id) => request(z.object({ deleted: z.literal(true) }), `/skills/${enc(id)}`, { method: "DELETE" }),
    usageStatus: () => request(BudgetStatusSchema, "/usage/status"),
    usageOverview: () => request(UsageOverviewSchema, "/admin/usage"),
    setBudget: (budget) => request(BudgetSchema, "/admin/budget", { method: "POST", body: JSON.stringify(budget) }),
    addCredits: (credits) => request(CreditsSchema, "/admin/credits", { method: "POST", body: JSON.stringify({ credits }) }),
    retention: () => request(RetentionSchema, "/data/retention"),
    setRetention: (retention) => request(RetentionSchema, "/admin/retention", { method: "POST", body: JSON.stringify(retention) }),
    aiSettings: () => request(AiSettingsSchema, "/ai-settings"),
    setAiSettings: (settings) => request(AiSettingsSchema, "/admin/ai-settings", { method: "POST", body: JSON.stringify(settings) }),
    exportMyData: () => request(z.record(z.unknown()), "/me/export"),
    people: () => request(z.array(PersonSchema), "/admin/people"),
    deactivatePerson: (id) => request(DeactivationSchema, `/admin/people/${enc(id)}/deactivate`, { method: "POST" }),
    erasePerson: (id) => request(ErasureSchema, `/admin/people/${enc(id)}/erase`, { method: "POST" }),
    reactivatePerson: (id) =>
      request(z.object({ changed: z.boolean() }), `/admin/people/${enc(id)}/reactivate`, { method: "POST" }),
    agentTriggers: () => request(z.array(AgentTriggerSchema), "/agent-triggers"),
    createAgentTrigger: (trigger) =>
      request(AgentTriggerSchema, "/agent-triggers", { method: "POST", body: JSON.stringify(trigger) }),
    deleteAgentTrigger: (id) =>
      request(z.object({ deleted: z.literal(true) }), `/agent-triggers/${enc(id)}`, { method: "DELETE" }),
    notifications: () =>
      request(z.object({ items: z.array(NotificationSchema), unread: z.number() }), "/notifications"),
    markNotificationsRead: (ids) =>
      request(z.object({ read: z.literal(true) }), "/notifications/read", {
        method: "POST",
        body: JSON.stringify(ids ? { ids } : {}),
      }),
    agentRuns: () => request(z.array(AgentRunSummarySchema), "/agent-runs"),
    agentRun: (id) => request(AgentRunSchema, `/agent-runs/${enc(id)}`),
    agentMode: () => request(AgentModeViewSchema, "/agent-runs/mode"),
    personalModel: () => request(PersonalModelViewSchema, "/me/model"),
    setPersonalModel: (modelChoice) =>
      request(PersonalModelViewSchema, "/me/model", { method: "POST", body: JSON.stringify({ modelChoice }) }),
    setAgentMode: (mode) => request(AgentModeViewSchema, "/agent-runs/mode", { method: "POST", body: JSON.stringify({ mode }) }),
    startAgentRun: (goal, skill) =>
      request(AgentRunSummarySchema, "/agent-runs", {
        method: "POST",
        body: JSON.stringify({ goal, ...(skill ? { skillId: skill.id, skillVersion: skill.updatedAt } : {}) }),
      }),
    cancelAgentRun: (id) =>
      request(z.object({ cancelled: z.literal(true) }), `/agent-runs/${enc(id)}/cancel`, { method: "POST" }),
    proposal: (id) => request(ProposalSchema, `/proposals/${enc(id)}`),
    proposals: () => request(z.array(ProposalSchema), "/proposals"),
    writeTargets: (serverId) => request(z.array(WriteTargetSchema), `/proposals/targets/${enc(serverId)}`),
    propose: (serverId, writeRequest) =>
      request(ProposalSchema, "/proposals", {
        method: "POST",
        body: JSON.stringify({ serverId, request: writeRequest }),
      }),
    approveProposal: (id, argsHash) =>
      request(ProposalSchema, `/proposals/${enc(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ argsHash }),
      }),
    rejectProposal: (id) => request(ProposalSchema, `/proposals/${enc(id)}/reject`, { method: "POST" }),
    undoProposal: (id) => request(ProposalSchema, `/proposals/${enc(id)}/undo`, { method: "POST" }),
    conversations: () => request(z.array(ConversationSummarySchema), "/conversations"),
    conversation: (id) => request(ConversationDetailSchema, `/conversations/${enc(id)}`),
    deleteConversation: (id) =>
      request(z.object({ deleted: z.literal(true) }), `/conversations/${enc(id)}`, { method: "DELETE" }),
    sendFeedback: (conversationId, messageId, feedback) =>
      request(z.object({ saved: z.literal(true) }), `/conversations/${enc(conversationId)}/messages/${enc(messageId)}/feedback`, {
        method: "POST",
        body: JSON.stringify(feedback),
      }),
    openAnswerStream: (question, signal, conversationId) =>
      openStream("/answers", { q: question, ...(conversationId ? { conversationId } : {}) }, signal),
    openItemStream: (task, hit, signal) =>
      openStream(
        `/answers/${task.kind}`,
        {
          serverId: hit.serverId,
          externalId: hit.externalId,
          url: hit.url,
          title: hit.title,
          ...(hit.siteId ? { siteId: hit.siteId } : {}),
          ...(task.kind === "draft" ? { request: task.request } : {}),
        },
        signal,
      ),
  };

  async function openStream(path: string, body: object, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const token = getToken();
    if (!token) throw new ApiError("UNAUTHENTICATED", "Please sign in", 401);
    let res: Response;
    try {
      // No client timeout: answers stream for as long as the caller keeps the signal open.
      res = await fetchImpl(joinUrl(baseUrl, path), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      if (signal.aborted) throw new ApiError("ABORTED", "Request was cancelled", 0);
      throw new ApiError("NETWORK", "Cannot reach the Nexus Brain API", 0);
    }
    if (!res.ok || !res.body) {
      const failure = ErrorEnvelope.safeParse(await res.json().catch(() => null));
      throw failure.success
        ? new ApiError(failure.data.error.code, failure.data.error.message, res.status)
        : new ApiError("BAD_RESPONSE", "Unexpected response from the API", res.status);
    }
    return res.body;
  }
}

/** Human message for an API error code; never shows server internals. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (error.code) {
    case "UNAUTHENTICATED":
      return "Your session has ended. Please sign in again.";
    case "FORBIDDEN":
      return "You don't have access to this workspace.";
    case "RECONNECT_REQUIRED":
      return "This connection needs to be reconnected.";
    case "RATE_LIMITED":
      return "Too many requests. Wait a moment and try again.";
    case "UNAVAILABLE":
    case "NETWORK":
      return "The service is unavailable right now. Please try again shortly.";
    case "VALIDATION":
    case "BUDGET_EXCEEDED":
      return error.message;
    default:
      return "Something went wrong. Please try again.";
  }
}
