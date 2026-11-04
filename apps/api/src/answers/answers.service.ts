import type { RankedHit, SourceStatus } from "@brain/connectors";
import { AppError, type SecretBox } from "@brain/core";
import { appendAudit, appendUsage, type PoolLike, type UserScope } from "@brain/db";
import type { AnswerDocument, AnswerOutcome, LlmGateway, UsageReport } from "@brain/llm-gateway";
import type { Logger } from "@brain/telemetry";
import type { DocumentSource, ItemReference } from "../connections/connections.service.js";
import type { AnswerPart, ConversationStart, ConversationStore } from "../conversations/conversations.service.js";
import type { MemorySource } from "../memory/memory.service.js";
import type { BudgetGuard } from "../usage/usage.service.js";
import { canHaveSubtasks, itemTaskRequest, parseSubtasks, type ItemTask } from "./item-tasks.js";
import { withExpandedTerms, type QueryExpander } from "./query-rewriter.js";

const SEARCH_LIMIT = 10;
const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_CHARS = 30_000;
const RATE_WINDOW_MS = 60_000;
/** In-process cost guard per user; plan budgets come with FR-MET-02/03. */
const MAX_ANSWERS_PER_WINDOW = 10;
const MAX_CONCURRENT_ANSWERS = 2;
const READ_TIME_LIMIT_MS = 20_000;

export type AnswerStreamEvent =
  | { readonly type: "conversation"; readonly conversationId: string }
  | { readonly type: "sources"; readonly hits: readonly RankedHit[]; readonly sources: readonly SourceStatus[] }
  | { readonly type: "text"; readonly text: string }
  /** `source` is the 1-based position in `hits`. */
  | { readonly type: "citation"; readonly source: number; readonly citedText: string }
  /** Suggested subtask titles, sent instead of text when subtasks were asked for. */
  | { readonly type: "subtasks"; readonly titles: readonly string[] }
  | {
      readonly type: "done";
      /** answered | no_documents | refused | incomplete */
      readonly outcome: "answered" | "no_documents" | "refused" | "incomplete";
      /** False when the model produced text with no citation, so the UI can warn. */
      readonly grounded: boolean;
      /** Documents shortened to fit, so the answer may have missed later text. */
      readonly truncatedDocuments: number;
      /** For feedback. Null if the answer could not be saved. */
      readonly messageId: string | null;
    }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export interface AnswersApi {
  answer(
    scope: UserScope,
    question: string,
    emit: (event: AnswerStreamEvent) => void,
    signal: AbortSignal,
    /** Continues this conversation. Without it, a new one is started. */
    conversationId?: string,
  ): Promise<void>;
  /** Summarises, drafts from, or suggests subtasks for one item the person can read (FR-AST-06). Not saved to their history. */
  itemTask?(scope: UserScope, item: SummaryItem, task: ItemTask, emit: (event: AnswerStreamEvent) => void, signal: AbortSignal): Promise<void>;
}

/** An item from the person's search results. The service's own access check decides whether it is read. */
export interface SummaryItem extends ItemReference {
  readonly title: string;
}

export interface AnswersDeps {
  readonly pool: PoolLike;
  readonly box: Pick<SecretBox, "fingerprint">;
  readonly documents: DocumentSource;
  /** Null when no API key is configured: search still works, answers report it. */
  readonly gateway: LlmGateway | null;
  readonly logger: Pick<Logger, "error">;
  readonly now?: () => number;
  /** Finds documents worded differently from the question. Without one, it searches as asked. */
  readonly expander?: QueryExpander;
  /** Keeps the person's private history. Without one, nothing is saved. */
  readonly conversations?: ConversationStore;
  /** What the person asked Brain to remember. Without one, answers use none. */
  readonly memories?: MemorySource;
  /** Stops answers once the monthly budget is used up. Without one, there is no limit. */
  readonly budget?: BudgetGuard;
  /** Reads one item with the person's own access, for summaries, drafts and subtasks. Without one, there are none. */
  readonly items?: { readItem(scope: UserScope, item: ItemReference): Promise<string | null> };
}

function appendText(parts: readonly AnswerPart[], text: string): readonly AnswerPart[] {
  const last = parts.at(-1);
  return last?.kind === "text"
    ? [...parts.slice(0, -1), { kind: "text", text: last.text + text }]
    : [...parts, { kind: "text", text }];
}

/** Repeated citations of one source in a row read better as a single marker. */
function appendCitation(parts: readonly AnswerPart[], source: number): readonly AnswerPart[] {
  const last = parts.at(-1);
  return last?.kind === "cite" && last.source === source ? parts : [...parts, { kind: "cite", source }];
}

/** Stops waiting for a read when it takes too long or the person leaves. The read itself may finish later. */
function withinReadTime<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  const limit = AbortSignal.any([signal, AbortSignal.timeout(READ_TIME_LIMIT_MS)]);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new AppError("UNAVAILABLE", "Reading the item took too long. Please try again.", { reason: "read_timeout" }));
    if (limit.aborted) return stop();
    limit.addEventListener("abort", stop, { once: true });
    read.then(resolve, reject).finally(() => limit.removeEventListener("abort", stop));
  });
}

function userKey(scope: UserScope): string {
  return `${scope.tenantId}|${scope.userId}`;
}

export class AnswersService implements AnswersApi {
  private readonly recent = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly deps: AnswersDeps) {}

  async answer(
    scope: UserScope,
    question: string,
    emit: (event: AnswerStreamEvent) => void,
    signal: AbortSignal,
    conversationId?: string,
  ): Promise<void> {
    await this.guarded(scope, (gateway) => this.run(gateway, scope, question, emit, signal, conversationId));
  }

  async itemTask(
    scope: UserScope,
    item: SummaryItem,
    task: ItemTask,
    emit: (event: AnswerStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const items = this.deps.items;
    if (!items) throw new AppError("UNAVAILABLE", "This is not available here");
    const { title, ...reference } = item;
    if (task.kind === "subtasks" && !canHaveSubtasks(reference)) {
      throw new AppError("VALIDATION", "Subtasks can only be suggested for a Jira issue");
    }
    await this.guarded(scope, async (gateway) => {
      // Read with the person's own token: what they cannot open, Brain cannot use for them.
      // Bounded, so a stalled service or a person who left cannot hold one of their answer slots.
      const text = await withinReadTime(items.readItem(scope, reference), signal);
      if (!text) throw new AppError("NOT_FOUND", "Brain could not read this item with your access");
      const hit: RankedHit = { ...reference, title, snippet: "", updatedAt: null, score: 1 };
      emit({ type: "sources", hits: [hit], sources: [] });
      // A subtask list is sent as titles to pick from once complete, not as text to read.
      const streamsText = task.kind !== "subtasks";

      let written = "";
      let citationCount = 0;
      let usage: UsageReport | null = null;
      let outcome: AnswerOutcome | null = null;
      const memories = (await this.deps.memories?.forPrompt(scope)) ?? [];
      try {
        outcome = await gateway.streamAnswer(
          {
            question: itemTaskRequest(task),
            documents: [{ title, text: text.slice(0, MAX_DOCUMENT_CHARS) }],
            cacheScope: scope.tenantId,
            ...(memories.length ? { memories } : {}),
          },
          (event) => {
            if (event.type === "text") {
              written += event.text;
              if (streamsText) emit(event);
            } else if (event.documentIndex === 0) {
              citationCount += 1;
              if (streamsText) emit({ type: "citation", source: 1, citedText: event.citedText });
            }
          },
          signal,
          (report) => {
            usage = report;
          },
        );
        const ended = outcome.stopReason === "refusal" ? "refused" : outcome.stopReason === "end_turn" ? "answered" : "incomplete";
        if (!streamsText && ended === "answered") emit({ type: "subtasks", titles: parseSubtasks(written) });
        emit({ type: "done", outcome: ended, grounded: citationCount > 0, truncatedDocuments: text.length > MAX_DOCUMENT_CHARS ? 1 : 0, messageId: null });
      } finally {
        await this.recordItemTask(scope, task, reference, usage, outcome, citationCount);
      }
    });
  }

  /** What answers and item tasks share: the AI must be configured, and rate, budget and concurrency allow it. */
  private async guarded(scope: UserScope, work: (gateway: LlmGateway) => Promise<void>): Promise<void> {
    const gateway = this.deps.gateway;
    if (!gateway) {
      throw new AppError("UNAVAILABLE", "AI answers are not configured yet. Search still works.");
    }
    this.enforceRate(scope);
    // Before any search or read too, since rewriting the question is also a paid call.
    await this.deps.budget?.require(scope);
    const key = userKey(scope);
    const running = this.inFlight.get(key) ?? 0;
    if (running >= MAX_CONCURRENT_ANSWERS) {
      throw new AppError("RATE_LIMITED", "Another answer is still running. Wait for it to finish.");
    }
    this.inFlight.set(key, running + 1);
    try {
      await work(gateway);
    } finally {
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left > 0) this.inFlight.set(key, left);
      else this.inFlight.delete(key);
    }
  }

  private async run(
    gateway: LlmGateway,
    scope: UserScope,
    question: string,
    emit: (event: AnswerStreamEvent) => void,
    signal: AbortSignal,
    conversationId?: string,
  ): Promise<void> {
    // First, so nothing is spent on a conversation that is not this person's.
    const conversation = await this.deps.conversations?.begin(scope, conversationId, question);
    if (conversation) emit({ type: "conversation", conversationId: conversation.conversationId });

    const terms = (await this.deps.expander?.expand(scope, question, signal, conversation?.previousQuestions)) ?? [];
    // The answer itself still responds to the question exactly as asked.
    const gathered = await this.deps.documents
      .gatherDocuments(scope, withExpandedTerms(question, terms), {
        limit: SEARCH_LIMIT,
        maxDocuments: MAX_DOCUMENTS,
        signal,
      })
      .catch(async (err: unknown) => {
        await this.record(scope, question, [], [], null, null, 0, "search_failed");
        throw err;
      });
    // The caller left during the search: do not spend money on an answer nobody will read.
    if (signal.aborted) {
      await this.record(scope, question, gathered.hits, [], null, null, 0, "cancelled");
      return;
    }
    emit({ type: "sources", hits: gathered.hits, sources: gathered.sources });

    const cited = gathered.hits.slice(0, MAX_DOCUMENTS);
    if (cited.length === 0) {
      const messageId = await this.saveAnswer(scope, conversation, {
        parts: [],
        hits: gathered.hits,
        outcome: "no_documents",
        grounded: false,
        truncatedDocuments: 0,
      });
      emit({ type: "done", outcome: "no_documents", grounded: false, truncatedDocuments: 0, messageId });
      await this.record(scope, question, gathered.hits, [], null, null, 0, "no_documents");
      return;
    }

    let truncatedDocuments = 0;
    const documents: AnswerDocument[] = cited.map((hit) => {
      const full = gathered.bodies.get(hit.url) ?? (hit.snippet || hit.title);
      if (full.length > MAX_DOCUMENT_CHARS) truncatedDocuments += 1;
      return { title: hit.title, text: full.slice(0, MAX_DOCUMENT_CHARS) };
    });

    const memories = (await this.deps.memories?.forPrompt(scope)) ?? [];
    let citationCount = 0;
    let parts: readonly AnswerPart[] = [];
    let usage: UsageReport | null = null;
    let outcome: AnswerOutcome | null = null;
    let saved = false;
    try {
      outcome = await gateway.streamAnswer(
        {
          question,
          documents,
          cacheScope: scope.tenantId,
          ...(conversation?.history.length ? { history: conversation.history } : {}),
          ...(memories.length ? { memories } : {}),
        },
        (event) => {
          if (event.type === "text") {
            parts = appendText(parts, event.text);
            emit(event);
          } else if (event.documentIndex >= 0 && event.documentIndex < cited.length) {
            // Only documents we actually sent can be cited.
            citationCount += 1;
            parts = appendCitation(parts, event.documentIndex + 1);
            emit({ type: "citation", source: event.documentIndex + 1, citedText: event.citedText });
          }
        },
        signal,
        (report) => {
          usage = report;
        },
      );
      const ended =
        outcome.stopReason === "refusal" ? "refused" : outcome.stopReason === "end_turn" ? "answered" : "incomplete";
      const summary = { outcome: ended, grounded: citationCount > 0, truncatedDocuments } as const;
      const messageId = await this.saveAnswer(scope, conversation, { parts, hits: gathered.hits, ...summary });
      saved = true;
      emit({ type: "done", ...summary, messageId });
    } finally {
      // A stream that broke or was cancelled: keep what was said, marked as incomplete.
      if (!saved && parts.length > 0) {
        await this.saveAnswer(scope, conversation, {
          parts,
          hits: gathered.hits,
          outcome: "incomplete",
          grounded: citationCount > 0,
          truncatedDocuments,
        });
      }
      // Runs on failure and abort too, because the provider may have billed for those calls.
      await this.record(scope, question, gathered.hits, cited, usage, outcome, citationCount);
    }
  }

  /** History is bookkeeping: failing to save must not turn a good answer into an error. */
  private async saveAnswer(
    scope: UserScope,
    conversation: ConversationStart | undefined,
    answer: Parameters<ConversationStore["saveAnswer"]>[2],
  ): Promise<string | null> {
    if (!conversation) return null;
    return this.deps.conversations!.saveAnswer(scope, conversation.conversationId, answer).catch((err: unknown) => {
      this.deps.logger.error({ errorType: err instanceof Error ? err.name : typeof err, tenant_id: scope.tenantId }, "Saving an answer failed");
      return null;
    });
  }

  /** Each write is independent, so losing one row never loses the other or hides the answer. */
  private async record(
    scope: UserScope,
    question: string,
    retrieved: readonly RankedHit[],
    cited: readonly RankedHit[],
    usage: UsageReport | null,
    outcome: AnswerOutcome | null,
    citations: number,
    endedEarly?: "cancelled" | "no_documents" | "search_failed",
  ): Promise<void> {
    if (usage) {
      const { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, estimated } = usage;
      await appendUsage(this.deps.pool, scope, {
        feature: estimated ? "answer_estimated" : "answer",
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd,
      }).catch((err: unknown) => this.deps.logger.error({ err, tenant_id: scope.tenantId }, "Usage ledger write failed"));
    }
    await appendAudit(this.deps.pool, {
      tenantId: scope.tenantId,
      userId: scope.userId,
      action: "answer",
      meta: {
        queryFingerprint: this.deps.box.fingerprint(question),
        // FR-ADM-01: everything returned to this person, and what of it went to the model.
        retrieved: retrieved.map((h) => ({ serverId: h.serverId, externalId: h.externalId })),
        documents: cited.map((h) => ({ serverId: h.serverId, externalId: h.externalId })),
        model: outcome?.model ?? null,
        // A replay of a recent identical answer, so the model was not called.
        cached: outcome?.cached === true,
        stopReason: endedEarly ?? outcome?.stopReason ?? "not_completed",
        citations,
      },
    }).catch((err: unknown) => this.deps.logger.error({ err, tenant_id: scope.tenantId }, "Audit write failed"));
  }

  /** Runs on failure and abort too, as the provider may have billed. Never records the item's text. */
  private async recordItemTask(
    scope: UserScope,
    task: ItemTask,
    item: ItemReference,
    usage: UsageReport | null,
    outcome: AnswerOutcome | null,
    citations: number,
  ): Promise<void> {
    if (usage) {
      const { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, estimated } = usage;
      await appendUsage(this.deps.pool, scope, {
        feature: estimated ? `${task.kind}_estimated` : task.kind,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd,
      }).catch((err: unknown) => this.deps.logger.error({ err, tenant_id: scope.tenantId }, "Usage ledger write failed"));
    }
    await appendAudit(this.deps.pool, {
      tenantId: scope.tenantId,
      userId: scope.userId,
      action: task.kind,
      meta: {
        documents: [{ serverId: item.serverId, externalId: item.externalId }],
        model: outcome?.model ?? null,
        cached: outcome?.cached === true,
        stopReason: outcome?.stopReason ?? "not_completed",
        citations,
      },
    }).catch((err: unknown) => this.deps.logger.error({ err, tenant_id: scope.tenantId }, "Audit write failed"));
  }

  private enforceRate(scope: UserScope): void {
    const now = (this.deps.now ?? Date.now)();
    const key = userKey(scope);
    // Drop users with no recent calls so the map cannot grow without bound.
    for (const [other, times] of this.recent) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) this.recent.delete(other);
    }
    const inWindow = (this.recent.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (inWindow.length >= MAX_ANSWERS_PER_WINDOW) {
      throw new AppError("RATE_LIMITED", "Too many answers in a short time. Wait a minute and try again.");
    }
    this.recent.set(key, [...inWindow, now]);
  }
}
