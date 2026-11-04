import { ISSUE_KEY } from "@brain/connectors";
import type { ItemReference } from "../connections/connections.service.js";

// Work Brain does on one item the person picked from their results (FR-AST-06). Each request below
// is sent as the person's own question, so the usual answer instructions apply to it.

export type ItemTask =
  | { readonly kind: "summary" }
  /** `request` is what the person asked to have drafted, in their own words. */
  | { readonly kind: "draft"; readonly request: string }
  | { readonly kind: "subtasks" };

export const MAX_SUBTASKS = 8;
const MAX_SUBTASK_CHARS = 200;
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/;
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

const SUMMARY_REQUEST =
  "Summarise this for me in a few short bullet points: what it is about, where it stands now, any decisions or open questions, and who is involved.";
const SUBTASKS_REQUEST =
  `Suggest up to ${MAX_SUBTASKS} subtasks that together would complete the work this item describes. ` +
  'Write each on its own line starting with "- ", as a short title under 100 characters. Write nothing else.';

export function itemTaskRequest(task: ItemTask): string {
  switch (task.kind) {
    case "summary":
      return SUMMARY_REQUEST;
    case "draft":
      return `Using this item, draft the following for me: ${task.request}\n\nWrite only the draft itself, ready to use as it is.`;
    case "subtasks":
      return SUBTASKS_REQUEST;
  }
}

/** Subtasks can only be added under a Jira issue. */
export function canHaveSubtasks(item: ItemReference): boolean {
  return item.serverId === "atlassian" && ISSUE_KEY.test(item.externalId);
}

/**
 * The suggested subtask titles in a model's list. Each is one plain line, and only proposals come of
 * them: the person picks which to send for approval, and approves each before anything is created.
 */
export function parseSubtasks(text: string): string[] {
  const titles = text.split("\n").flatMap((line) => {
    const title = LIST_ITEM.exec(line)?.[1]
      ?.replace(UNSAFE_CHARS, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_SUBTASK_CHARS);
    return title ? [title] : [];
  });
  return [...new Set(titles)].slice(0, MAX_SUBTASKS);
}
