import { AppError, isAppError, type SecretBox } from "@brain/core";
import type { RankedHit } from "@brain/connectors";
import {
  addMessage,
  appendAudit,
  countConversations,
  countMessages,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  saveFeedback,
  type PoolLike,
  type StoredMessage,
  type UserScope,
} from "@brain/db";
import type { HistoryTurn } from "@brain/llm-gateway";
import { randomUUID } from "node:crypto";
import type { WorkGraph } from "../graph/graph.service.js";

const TITLE_CHARS = 80;
const LIST_LIMIT = 50;
const MAX_STORED_MESSAGES = 400;
/** Earlier turns sent with a follow-up. Long answers are shortened so cost stays bounded. */
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_TURN_CHARS = 2_000;
const MAX_PREVIOUS_QUESTIONS = 3;
/** Storage limits per person. Retention rules come with plans and admin settings. */
const MAX_CONVERSATIONS = 500;

/** `quotes` is the cited passage; answers saved before it was kept have none. */
export type AnswerPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "cite"; readonly source: number; readonly quotes?: readonly string[] };

export interface StoredAnswer {
  readonly parts: readonly AnswerPart[];
  readonly hits: readonly RankedHit[];
  readonly outcome: "answered" | "no_documents" | "refused" | "incomplete" | "search_only";
  readonly grounded: boolean;
  readonly truncatedDocuments: number;
}

export type MessageView =
  | { readonly id: string; readonly role: "user"; readonly createdAt: string; readonly text: string }
  | {
      readonly id: string;
      readonly role: "assistant";
      readonly createdAt: string;
      readonly answer: StoredAnswer;
      readonly rating: "up" | "down" | null;
    };

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface ConversationStart {
  readonly conversationId: string;
  /** Earlier turns, for the model. These are context only and never count as sources. */
  readonly history: readonly HistoryTurn[];
  /** Only the person's own earlier words, for choosing search words. */
  readonly previousQuestions: readonly string[];
}

/** What the answer service needs. */
export interface ConversationStore {
  begin(scope: UserScope, conversationId: string | undefined, question: string): Promise<ConversationStart>;
  saveAnswer(scope: UserScope, conversationId: string, answer: StoredAnswer): Promise<string>;
}

export interface ConversationsApi {
  list(scope: UserScope): Promise<readonly ConversationSummary[]>;
  get(scope: UserScope, id: string): Promise<{ id: string; title: string; messages: readonly MessageView[] }>;
  remove(scope: UserScope, id: string): Promise<void>;
  feedback(
    scope: UserScope,
    conversationId: string,
    messageId: string,
    input: { readonly rating: "up" | "down"; readonly reason?: string | undefined },
  ): Promise<void>;
}

function textOf(answer: StoredAnswer): string {
  return answer.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("");
}

export class ConversationsService implements ConversationsApi, ConversationStore {
  constructor(
    private readonly deps: {
      readonly pool: PoolLike;
      readonly box: Pick<SecretBox, "seal" | "open">;
      /** Learns from answers rated helpful. Without one, ratings are only stored. */
      readonly graph?: Pick<WorkGraph, "answerHelpful" | "report">;
    },
  ) {}

  /** Bound to the owner and conversation, so a copied row cannot be opened anywhere else. */
  private context(scope: UserScope, conversationId: string): string {
    return `conversation|${scope.tenantId}|${scope.userId}|${conversationId}`;
  }

  private seal(scope: UserScope, conversationId: string, value: unknown): string {
    return this.deps.box.seal(JSON.stringify(value), this.context(scope, conversationId));
  }

  private open<T>(scope: UserScope, conversationId: string, ciphertext: string): T {
    return JSON.parse(this.deps.box.open(ciphertext, this.context(scope, conversationId))) as T;
  }

  async list(scope: UserScope): Promise<readonly ConversationSummary[]> {
    const rows = await listConversations(this.deps.pool, scope, LIST_LIMIT);
    return rows.map((row) => ({
      id: row.id,
      title: this.open<string>(scope, row.id, row.titleCiphertext),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** Every conversation the person has, with its messages, for their data export (FR-ADM-03). */
  async exportAll(scope: UserScope): Promise<ReadonlyArray<{ id: string; title: string; updatedAt: string; messages: readonly MessageView[] }>> {
    const rows = await listConversations(this.deps.pool, scope, MAX_CONVERSATIONS);
    const all = [];
    for (const row of rows) {
      const { title, messages } = await this.get(scope, row.id);
      all.push({ id: row.id, title, updatedAt: row.updatedAt.toISOString(), messages });
    }
    return all;
  }

  async get(scope: UserScope, id: string) {
    const row = await getConversation(this.deps.pool, scope, id);
    if (!row) throw new AppError("NOT_FOUND", "Conversation not found");
    const stored = await listMessages(this.deps.pool, scope, id, MAX_STORED_MESSAGES);
    return {
      id,
      title: this.open<string>(scope, id, row.titleCiphertext),
      messages: stored.map((message) => this.view(scope, id, message)),
    };
  }

  private view(scope: UserScope, conversationId: string, message: StoredMessage): MessageView {
    const base = { id: message.id, createdAt: message.createdAt.toISOString() };
    return message.role === "user"
      ? { ...base, role: "user", text: this.open<string>(scope, conversationId, message.payloadCiphertext) }
      : {
          ...base,
          role: "assistant",
          answer: this.open<StoredAnswer>(scope, conversationId, message.payloadCiphertext),
          rating: message.rating,
        };
  }

  async remove(scope: UserScope, id: string): Promise<void> {
    if (!(await deleteConversation(this.deps.pool, scope, id))) {
      throw new AppError("NOT_FOUND", "Conversation not found");
    }
    await appendAudit(this.deps.pool, {
      tenantId: scope.tenantId,
      userId: scope.userId,
      action: "conversation.deleted",
    });
  }

  async feedback(
    scope: UserScope,
    conversationId: string,
    messageId: string,
    input: { readonly rating: "up" | "down"; readonly reason?: string | undefined },
  ): Promise<void> {
    const graph = this.deps.graph;
    // Read before the rating changes, so only a change to "up" teaches the graph, not a repeat.
    const before = input.rating === "up" && graph ? await this.ratedAnswer(scope, conversationId, messageId, graph) : null;
    const saved = await saveFeedback(this.deps.pool, scope, {
      conversationId,
      messageId,
      rating: input.rating,
      reasonCiphertext: input.reason ? this.seal(scope, conversationId, input.reason) : null,
    });
    if (!saved) throw new AppError("NOT_FOUND", "Answer not found");
    if (graph && before && before.rating !== "up") await graph.answerHelpful(scope, before.answer);
  }

  /** The answer being rated, or null if it cannot be read: the rating is saved either way. */
  private async ratedAnswer(
    scope: UserScope,
    conversationId: string,
    messageId: string,
    graph: Pick<WorkGraph, "report">,
  ): Promise<Extract<MessageView, { role: "assistant" }> | null> {
    try {
      const message = (await this.get(scope, conversationId)).messages.find((m) => m.id === messageId);
      return message?.role === "assistant" ? message : null;
    } catch (err) {
      if (!(isAppError(err) && err.code === "NOT_FOUND")) graph.report(err);
      return null;
    }
  }

  async begin(scope: UserScope, conversationId: string | undefined, question: string): Promise<ConversationStart> {
    const id = conversationId ?? randomUUID();
    if (conversationId && (await countMessages(this.deps.pool, scope, conversationId)) >= MAX_STORED_MESSAGES) {
      throw new AppError("VALIDATION", "This conversation is full. Please start a new one.");
    }
    const earlier = conversationId ? await this.earlierMessages(scope, conversationId) : [];
    if (!conversationId) {
      if ((await countConversations(this.deps.pool, scope)) >= MAX_CONVERSATIONS) {
        throw new AppError("VALIDATION", "You have reached the conversation limit. Delete some to start a new one.");
      }
      await createConversation(this.deps.pool, scope, {
        id,
        titleCiphertext: this.seal(scope, id, question.slice(0, TITLE_CHARS)),
      });
    }
    await addMessage(this.deps.pool, scope, {
      id: randomUUID(),
      conversationId: id,
      role: "user",
      payloadCiphertext: this.seal(scope, id, question),
    });
    const questions = earlier.flatMap((m) => (m.role === "user" ? [m.text] : []));
    return {
      conversationId: id,
      history: this.historyFrom(earlier),
      previousQuestions: questions.slice(-MAX_PREVIOUS_QUESTIONS),
    };
  }

  private async earlierMessages(scope: UserScope, conversationId: string): Promise<readonly MessageView[]> {
    const row = await getConversation(this.deps.pool, scope, conversationId);
    if (!row) throw new AppError("NOT_FOUND", "Conversation not found");
    // Twice the turns, because each turn is a question and an answer.
    const stored = await listMessages(this.deps.pool, scope, conversationId, MAX_HISTORY_TURNS * 2);
    return stored.map((message) => this.view(scope, conversationId, message));
  }

  /** Only complete pairs with answer text, since the model expects turns to alternate. */
  private historyFrom(messages: readonly MessageView[]): HistoryTurn[] {
    const turns: HistoryTurn[] = [];
    messages.forEach((message, index) => {
      const next = messages[index + 1];
      if (message.role !== "user" || next?.role !== "assistant") return;
      const reply = textOf(next.answer);
      if (reply) {
        turns.push({ role: "user", text: message.text.slice(0, MAX_HISTORY_TURN_CHARS) });
        turns.push({ role: "assistant", text: reply.slice(0, MAX_HISTORY_TURN_CHARS) });
      }
    });
    return turns;
  }

  async saveAnswer(scope: UserScope, conversationId: string, answer: StoredAnswer): Promise<string> {
    const id = randomUUID();
    await addMessage(this.deps.pool, scope, {
      id,
      conversationId,
      role: "assistant",
      payloadCiphertext: this.seal(scope, conversationId, answer),
    });
    return id;
  }
}
