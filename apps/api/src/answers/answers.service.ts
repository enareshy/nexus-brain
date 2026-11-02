import type { RankedHit, SourceStatus } from "@brain/connectors";
import { AppError, type SecretBox } from "@brain/core";
import { appendAudit, appendUsage, type PoolLike, type UserScope } from "@brain/db";
import type { AnswerDocument, AnswerOutcome, LlmGateway, UsageReport } from "@brain/llm-gateway";
import type { Logger } from "@brain/telemetry";
import type { DocumentSource } from "../connections/connections.service.js";
import { withExpandedTerms, type QueryExpander } from "./query-rewriter.js";

const SEARCH_LIMIT = 10;
const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_CHARS = 30_000;
const RATE_WINDOW_MS = 60_000;
/** In-process cost guard per user; plan budgets come with FR-MET-02/03. */
const MAX_ANSWERS_PER_WINDOW = 10;
const MAX_CONCURRENT_ANSWERS = 2;

export type AnswerStreamEvent =
  | { readonly type: "sources"; readonly hits: readonly RankedHit[]; readonly sources: readonly SourceStatus[] }
  | { readonly type: "text"; readonly text: string }
  /** `source` is the 1-based position in `hits`. */
  | { readonly type: "citation"; readonly source: number; readonly citedText: string }
  | {
      readonly type: "done";
      /** answered | no_documents | refused | incomplete */
      readonly outcome: "answered" | "no_documents" | "refused" | "incomplete";
      /** False when the model produced text with no citation, so the UI can warn. */
      readonly grounded: boolean;
      /** Documents shortened to fit, so the answer may have missed later text. */
      readonly truncatedDocuments: number;
    }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export interface AnswersApi {
  answer(
    scope: UserScope,
    question: string,
    emit: (event: AnswerStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
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
  ): Promise<void> {
    const gateway = this.deps.gateway;
    if (!gateway) {
      throw new AppError("UNAVAILABLE", "AI answers are not configured yet. Search still works.");
    }
    this.enforceRate(scope);
    const key = userKey(scope);
    const running = this.inFlight.get(key) ?? 0;
    if (running >= MAX_CONCURRENT_ANSWERS) {
      throw new AppError("RATE_LIMITED", "Another answer is still running. Wait for it to finish.");
    }
    this.inFlight.set(key, running + 1);
    try {
      await this.run(gateway, scope, question, emit, signal);
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
  ): Promise<void> {
    const terms = (await this.deps.expander?.expand(scope, question, signal)) ?? [];
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
      emit({ type: "done", outcome: "no_documents", grounded: false, truncatedDocuments: 0 });
      await this.record(scope, question, gathered.hits, [], null, null, 0, "no_documents");
      return;
    }

    let truncatedDocuments = 0;
    const documents: AnswerDocument[] = cited.map((hit) => {
      const full = gathered.bodies.get(hit.url) ?? (hit.snippet || hit.title);
      if (full.length > MAX_DOCUMENT_CHARS) truncatedDocuments += 1;
      return { title: hit.title, text: full.slice(0, MAX_DOCUMENT_CHARS) };
    });

    let citationCount = 0;
    let usage: UsageReport | null = null;
    let outcome: AnswerOutcome | null = null;
    try {
      outcome = await gateway.streamAnswer(
        { question, documents },
        (event) => {
          if (event.type === "text") {
            emit(event);
          } else if (event.documentIndex >= 0 && event.documentIndex < cited.length) {
            // Only documents we actually sent can be cited.
            citationCount += 1;
            emit({ type: "citation", source: event.documentIndex + 1, citedText: event.citedText });
          }
        },
        signal,
        (report) => {
          usage = report;
        },
      );
      // Tell the user first: a bookkeeping failure must not turn a good answer into an error.
      emit({
        type: "done",
        outcome:
          outcome.stopReason === "refusal"
            ? "refused"
            : outcome.stopReason === "end_turn"
              ? "answered"
              : "incomplete",
        grounded: citationCount > 0,
        truncatedDocuments,
      });
    } finally {
      // Runs on failure and abort too, because the provider may have billed for those calls.
      await this.record(scope, question, gathered.hits, cited, usage, outcome, citationCount);
    }
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
        stopReason: endedEarly ?? outcome?.stopReason ?? "not_completed",
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
