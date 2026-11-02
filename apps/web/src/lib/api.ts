import { z } from "zod";

export const ConnectionSchema = z.object({
  serverId: z.string(),
  displayName: z.string(),
  status: z.enum(["not_connected", "active", "needs_reauth"]),
  lastUsedAt: z.string().nullable(),
  setup: z.enum(["ready", "needs_app", "configured"]),
  redirectUrl: z.string(),
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
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const WriteTargetSchema = z.object({
  siteId: z.string(),
  siteOrigin: z.string(),
  projects: z.array(z.object({ key: z.string(), name: z.string(), issueTypes: z.array(z.string()) })),
});
export type WriteTarget = z.infer<typeof WriteTargetSchema>;

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
  | { action: "add_comment"; siteId: string; issueKey: string; body: string };

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
      z.object({ kind: z.literal("cite"), source: z.number() }),
    ]),
  ),
  hits: z.array(HitSchema),
  outcome: z.enum(["answered", "no_documents", "refused", "incomplete"]),
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
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult>;
  /** Opens the answer stream and returns its body. Resolves once headers arrive. */
  openAnswerStream(question: string, signal: AbortSignal, conversationId?: string): Promise<ReadableStream<Uint8Array>>;
  conversations(): Promise<ConversationSummary[]>;
  conversation(id: string): Promise<ConversationDetail>;
  deleteConversation(id: string): Promise<{ deleted: true }>;
  sendFeedback(
    conversationId: string,
    messageId: string,
    feedback: { rating: "up" | "down"; reason?: string },
  ): Promise<{ saved: true }>;
  audit(before?: number): Promise<{ entries: AuditEntry[]; nextBefore: number | null }>;
  agentRuns(): Promise<AgentRunSummary[]>;
  agentRun(id: string): Promise<AgentRun>;
  startAgentRun(goal: string): Promise<AgentRunSummary>;
  cancelAgentRun(id: string): Promise<{ cancelled: true }>;
  proposal(id: string): Promise<Proposal>;
  proposals(): Promise<Proposal[]>;
  writeTargets(serverId: string): Promise<WriteTarget[]>;
  propose(serverId: string, request: WriteRequest): Promise<Proposal>;
  approveProposal(id: string, argsHash: string): Promise<Proposal>;
  rejectProposal(id: string): Promise<Proposal>;
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
    search: (query, options = {}) =>
      request(SearchResultSchema, `/search?q=${enc(query)}&limit=${options.limit ?? 10}`, {
        signal: options.signal,
      }),
    audit: (before) =>
      request(
        z.object({ entries: z.array(AuditEntrySchema), nextBefore: z.number().nullable() }),
        before === undefined ? "/admin/audit" : `/admin/audit?before=${before}`,
      ),
    agentRuns: () => request(z.array(AgentRunSummarySchema), "/agent-runs"),
    agentRun: (id) => request(AgentRunSchema, `/agent-runs/${enc(id)}`),
    startAgentRun: (goal) =>
      request(AgentRunSummarySchema, "/agent-runs", { method: "POST", body: JSON.stringify({ goal }) }),
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
    conversations: () => request(z.array(ConversationSummarySchema), "/conversations"),
    conversation: (id) => request(ConversationDetailSchema, `/conversations/${enc(id)}`),
    deleteConversation: (id) =>
      request(z.object({ deleted: z.literal(true) }), `/conversations/${enc(id)}`, { method: "DELETE" }),
    sendFeedback: (conversationId, messageId, feedback) =>
      request(z.object({ saved: z.literal(true) }), `/conversations/${enc(conversationId)}/messages/${enc(messageId)}/feedback`, {
        method: "POST",
        body: JSON.stringify(feedback),
      }),
    async openAnswerStream(question, signal, conversationId) {
      const token = getToken();
      if (!token) throw new ApiError("UNAUTHENTICATED", "Please sign in", 401);
      let res: Response;
      try {
        // No client timeout: answers stream for as long as the caller keeps the signal open.
        res = await fetchImpl(joinUrl(baseUrl, "/answers"), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ q: question, ...(conversationId ? { conversationId } : {}) }),
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
    },
  };
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
      return error.message;
    default:
      return "Something went wrong. Please try again.";
  }
}
