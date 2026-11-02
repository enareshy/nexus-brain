import { count, desc, eq, sql } from "drizzle-orm";
import { conversationMessages, conversations, messageFeedback } from "./schema.js";
import { withUser, type PoolLike, type UserScope } from "./tenant.js";

export type StoredConversation = Pick<
  typeof conversations.$inferSelect,
  "id" | "titleCiphertext" | "createdAt" | "updatedAt"
>;

const conversationColumns = {
  id: conversations.id,
  titleCiphertext: conversations.titleCiphertext,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};

export interface StoredMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly payloadCiphertext: string;
  readonly createdAt: Date;
  readonly rating: "up" | "down" | null;
}

export function createConversation(
  pool: PoolLike,
  scope: UserScope,
  conversation: { readonly id: string; readonly titleCiphertext: string },
): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db.insert(conversations).values({ ...conversation, tenantId: scope.tenantId, userId: scope.userId });
  });
}

export function getConversation(pool: PoolLike, scope: UserScope, id: string): Promise<StoredConversation | null> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db.select(conversationColumns).from(conversations).where(eq(conversations.id, id)).limit(1);
    return row ?? null;
  });
}

export function listConversations(pool: PoolLike, scope: UserScope, limit: number): Promise<StoredConversation[]> {
  return withUser(pool, scope, (db) =>
    db.select(conversationColumns).from(conversations).orderBy(desc(conversations.updatedAt)).limit(limit),
  );
}

export function countConversations(pool: PoolLike, scope: UserScope): Promise<number> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db.select({ value: count() }).from(conversations);
    return row?.value ?? 0;
  });
}

export function countMessages(pool: PoolLike, scope: UserScope, conversationId: string): Promise<number> {
  return withUser(pool, scope, async (db) => {
    const [row] = await db
      .select({ value: count() })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId));
    return row?.value ?? 0;
  });
}

/** Deletes the conversation with its messages and feedback. Returns true when one was removed. */
export function deleteConversation(pool: PoolLike, scope: UserScope, id: string): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const removed = await db.delete(conversations).where(eq(conversations.id, id)).returning({ id: conversations.id });
    return removed.length > 0;
  });
}

export function addMessage(
  pool: PoolLike,
  scope: UserScope,
  message: {
    readonly id: string;
    readonly conversationId: string;
    readonly role: "user" | "assistant";
    readonly payloadCiphertext: string;
  },
): Promise<void> {
  return withUser(pool, scope, async (db) => {
    await db.insert(conversationMessages).values({ ...message, tenantId: scope.tenantId, userId: scope.userId });
    await db.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, message.conversationId));
  });
}

/** The most recent `limit` messages, oldest first. */
export function listMessages(pool: PoolLike, scope: UserScope, conversationId: string, limit: number): Promise<StoredMessage[]> {
  return withUser(pool, scope, async (db) => {
    const rows = await db
      .select({
        id: conversationMessages.id,
        role: conversationMessages.role,
        payloadCiphertext: conversationMessages.payloadCiphertext,
        createdAt: conversationMessages.createdAt,
        rating: messageFeedback.rating,
      })
      .from(conversationMessages)
      .leftJoin(messageFeedback, eq(messageFeedback.messageId, conversationMessages.id))
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(limit);
    return rows.reverse();
  });
}

/** Records or replaces feedback. Returns false for a message that is not this person's answer. */
export function saveFeedback(
  pool: PoolLike,
  scope: UserScope,
  feedback: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly rating: "up" | "down";
    readonly reasonCiphertext: string | null;
  },
): Promise<boolean> {
  return withUser(pool, scope, async (db) => {
    const [message] = await db
      .select({ role: conversationMessages.role, conversationId: conversationMessages.conversationId })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, feedback.messageId))
      .limit(1);
    if (message?.role !== "assistant" || message.conversationId !== feedback.conversationId) return false;
    const values = { rating: feedback.rating, reasonCiphertext: feedback.reasonCiphertext, updatedAt: sql`now()` };
    await db
      .insert(messageFeedback)
      .values({ ...values, messageId: feedback.messageId, tenantId: scope.tenantId, userId: scope.userId })
      .onConflictDoUpdate({ target: messageFeedback.messageId, set: values });
    return true;
  });
}
