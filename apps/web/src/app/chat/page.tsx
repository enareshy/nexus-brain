"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { RequireAuth } from "@/components/AppShell";
import { useAuth } from "@/components/AuthProvider";
import { ChatThread, type ChatTurn } from "@/components/ChatThread";
import { answerStateFromSaved, INITIAL_ANSWER, readAnswerStream, reduceAnswer, type AnswerState } from "@/lib/answer";
import { describeError, type ConversationDetail, type ConversationSummary } from "@/lib/api";

const MAX_QUESTION_CHARS = 500;

function turnsFrom(detail: ConversationDetail): ChatTurn[] {
  return detail.messages.map((message) =>
    message.role === "user"
      ? { kind: "question", id: message.id, text: message.text }
      : {
          kind: "answer",
          id: message.id,
          state: answerStateFromSaved(message.answer),
          messageId: message.id,
          rating: message.rating,
        },
  );
}

function ChatPage() {
  const { api } = useAuth();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const loadList = useCallback(async () => {
    try {
      setConversations(await api.conversations());
    } catch (e) {
      setError(describeError(e));
    }
  }, [api]);

  useEffect(() => {
    void loadList();
    // Leaving the page stops any answer still streaming, which stops spending.
    return () => abort.current?.abort();
  }, [loadList]);

  function startNew() {
    abort.current?.abort();
    setActiveId(null);
    setTurns([]);
    setError(null);
  }

  async function open(id: string) {
    abort.current?.abort();
    setError(null);
    try {
      const detail = await api.conversation(id);
      setActiveId(id);
      setTurns(turnsFrom(detail));
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api.deleteConversation(id);
      if (id === activeId) startNew();
      await loadList();
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function handleAsk(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || isStreaming) return;
    const controller = new AbortController();
    abort.current = controller;
    const answerId = crypto.randomUUID();
    const updateAnswer = (change: (turn: Extract<ChatTurn, { kind: "answer" }>) => Partial<Extract<ChatTurn, { kind: "answer" }>>) =>
      setTurns((current) => current.map((turn) => (turn.kind === "answer" && turn.id === answerId ? { ...turn, ...change(turn) } : turn)));
    const applyState = (next: (state: AnswerState) => AnswerState) => {
      if (!controller.signal.aborted) updateAnswer((turn) => ({ state: next(turn.state) }));
    };

    setDraft("");
    setError(null);
    setIsStreaming(true);
    setTurns((current) => [
      ...current,
      { kind: "question", id: crypto.randomUUID(), text: question },
      { kind: "answer", id: answerId, state: INITIAL_ANSWER, messageId: null, rating: null },
    ]);
    try {
      const body = await api.openAnswerStream(question, controller.signal, activeId ?? undefined);
      await readAnswerStream(body, (streamEvent) => {
        if (streamEvent.type === "conversation") setActiveId(streamEvent.conversationId);
        if (streamEvent.type === "done" && streamEvent.messageId) {
          const { messageId } = streamEvent;
          updateAnswer(() => ({ messageId }));
        }
        applyState((state) => reduceAnswer(state, streamEvent));
      });
      applyState((state) =>
        state.status === "streaming" ? { ...state, status: "error", error: "The answer was interrupted. Please try again." } : state,
      );
      void loadList();
    } catch (e) {
      if (!controller.signal.aborted) applyState((state) => ({ ...state, status: "error", error: describeError(e) }));
    } finally {
      if (abort.current === controller) setIsStreaming(false);
    }
  }

  async function handleFeedback(messageId: string, rating: "up" | "down", reason?: string) {
    if (!activeId) return;
    setTurns((current) => current.map((turn) => (turn.kind === "answer" && turn.messageId === messageId ? { ...turn, rating } : turn)));
    try {
      await api.sendFeedback(activeId, messageId, { rating, ...(reason ? { reason } : {}) });
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[15rem_1fr]">
      <aside aria-label="Your conversations">
        <button
          type="button"
          onClick={startNew}
          className="w-full rounded-md bg-brand px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          New conversation
        </button>
        <p className="mt-3 text-xs text-slate-500">Only you can see these, including from admins.</p>
        <ul className="mt-4 space-y-1">
          {conversations.map((conversation) => (
            <li key={conversation.id} className="flex items-center gap-1">
              <button
                type="button"
                aria-current={conversation.id === activeId ? "true" : undefined}
                onClick={() => void open(conversation.id)}
                className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 aria-[current=true]:bg-slate-200 dark:hover:bg-slate-800 dark:aria-[current=true]:bg-slate-800"
              >
                {conversation.title}
              </button>
              <button
                type="button"
                aria-label={`Delete conversation: ${conversation.title}`}
                onClick={() => void remove(conversation.id)}
                className="rounded px-1.5 py-1 text-xs text-slate-500 hover:text-red-700"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section aria-label="Conversation" className="min-w-0 max-w-3xl">
        {turns.length === 0 && (
          <div className="mb-10">
            <h1 className="text-4xl font-bold tracking-tight">Ask anything about your work.</h1>
            <p className="mt-3 text-lg text-slate-600 dark:text-slate-400">
              Answers come only from what you can access in your connected tools, with sources you can check. You can ask follow-up questions.
            </p>
          </div>
        )}
        <ChatThread turns={turns} onFeedback={(id, rating, reason) => void handleFeedback(id, rating, reason)} />
        {error && (
          <p role="alert" className="mb-4 text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <form onSubmit={(e) => void handleAsk(e)} className="flex gap-3">
          <label htmlFor="question" className="sr-only">
            Your question
          </label>
          <input
            id="question"
            value={draft}
            maxLength={MAX_QUESTION_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={turns.length > 0 ? "Ask a follow-up…" : "e.g. what is the status of the login bug?"}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 shadow-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/15 dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="submit"
            disabled={isStreaming || !draft.trim()}
            className="rounded-lg bg-slate-900 px-5 py-3 font-semibold text-white transition hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            {isStreaming ? "Answering…" : "Ask"}
          </button>
        </form>
      </section>
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <ChatPage />
    </RequireAuth>
  );
}
