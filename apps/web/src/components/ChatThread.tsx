"use client";

import { useState } from "react";
import type { AnswerState } from "@/lib/answer";
import { AnswerPanel } from "./AnswerPanel";

export type ChatTurn =
  | { readonly kind: "question"; readonly id: string; readonly text: string }
  | {
      readonly kind: "answer";
      readonly id: string;
      readonly state: AnswerState;
      /** Saved message to attach feedback to. Null while streaming or if saving failed. */
      readonly messageId: string | null;
      readonly rating: "up" | "down" | null;
    };

type ThreadProps = {
  turns: readonly ChatTurn[];
  onFeedback: (messageId: string, rating: "up" | "down", reason?: string) => void;
};

function Feedback({
  rating,
  onRate,
}: {
  rating: "up" | "down" | null;
  onRate: (rating: "up" | "down", reason?: string) => void;
}) {
  const [isAskingReason, setIsAskingReason] = useState(false);
  const [reason, setReason] = useState("");
  const buttonClass =
    "rounded-md px-2.5 py-1 text-sm ring-1 ring-slate-300 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand aria-pressed:bg-slate-900 aria-pressed:text-white dark:ring-slate-700 dark:hover:bg-slate-800";

  return (
    <div className="-mt-8 mb-10">
      <div role="group" aria-label="Rate this answer" className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={rating === "up"}
          onClick={() => {
            setIsAskingReason(false);
            onRate("up");
          }}
          className={buttonClass}
        >
          Helpful
        </button>
        <button
          type="button"
          aria-pressed={rating === "down"}
          onClick={() => {
            setIsAskingReason(true);
            onRate("down");
          }}
          className={buttonClass}
        >
          Not helpful
        </button>
      </div>
      {isAskingReason && (
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onRate("down", reason.trim());
            setIsAskingReason(false);
          }}
        >
          <label className="min-w-0 flex-1 text-sm">
            <span className="sr-only">What was wrong?</span>
            <input
              value={reason}
              maxLength={500}
              placeholder="What was wrong? (optional)"
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <button type="submit" className="rounded-md px-3 py-1.5 text-sm font-medium ring-1 ring-slate-300 dark:ring-slate-700">
            Send
          </button>
        </form>
      )}
    </div>
  );
}

/** Questions and answers in order. All of it renders as text, through the same safe answer panel. */
export function ChatThread({ turns, onFeedback }: ThreadProps) {
  return (
    <div aria-live="polite">
      {turns.map((turn) =>
        turn.kind === "question" ? (
          <p key={turn.id} className="mb-6 ml-auto max-w-[85%] w-fit whitespace-pre-wrap rounded-lg bg-slate-900 px-4 py-2.5 text-white dark:bg-white dark:text-slate-900">
            {turn.text}
          </p>
        ) : (
          <div key={turn.id}>
            <AnswerPanel state={turn.state} />
            {turn.messageId && turn.state.status === "done" && (
              <Feedback
                rating={turn.rating}
                onRate={(rating, reason) => onFeedback(turn.messageId!, rating, reason)}
              />
            )}
          </div>
        ),
      )}
    </div>
  );
}
