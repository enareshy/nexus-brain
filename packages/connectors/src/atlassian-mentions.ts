import { AppError } from "@brain/core";
import { ISSUE_KEY, JIRA_SCOPE, parseJiraIssues, parseSites, SITE_ID, SITES_TOOL } from "./atlassian.js";
import type { ToolSession } from "./types.js";

// @Brain mentions (FR-AST-05): a person writes "@Brain <request>" in a Jira comment, and their
// automatic agent picks it up. Only the person's own comments count: anyone else who can comment
// on an issue must never be able to give that person's agent work.
// The comment and user shapes follow Jira's REST format as the tool descriptions state; they are
// not yet checked against the live server (docs/adr/0001-mcp-servers.md).

const USER_TOOL = "atlassianUserInfo";
const ISSUE_TOOL = "getJiraIssue";
const SEARCH_TOOL = "searchJiraIssuesUsingJql";
// Text search matches the word, so this finds candidates; each comment is then checked exactly.
const MENTION_JQL = 'comment ~ "Brain" AND updated >= -1d ORDER BY updated DESC';
const MAX_SITES = 3;
const MAX_ISSUES = 10;
const MAX_REQUEST_CHARS = 1_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MENTION = /(?:^|[\s(>*_])@brain\b[\s:,.\-–—]*/i;
const COMMENT_ID = /^\d{1,20}$/;
/** Any @Brain, so a comment Brain posts can never start another run. */
const ANY_MENTION = /@(?=brain\b)/gi;
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
/** Code and quotes are often other people's words, so a mention inside them never counts. */
const CODE_BLOCK = /```[\s\S]*?(?:```|$)/g;
const QUOTE_LINE = /^[ \t]*>.*$/gm;
/** The request is the paragraph the mention starts; later paragraphs may be pasted material. */
const PARAGRAPH_END = /\n[ \t]*\n/;

export interface MentionRequest {
  readonly siteId: string;
  readonly key: string;
  readonly commentId: string;
  /** What the person asked for, as plain single-line text. */
  readonly request: string;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Removes the @ from every @Brain, for text Brain writes on someone's behalf. */
export function defuseMentions(text: string): string {
  return text.replace(ANY_MENTION, "");
}

/** The signed-in person's Atlassian account id. */
export function parseAccountId(text: string): string | null {
  const data = parseJson(text);
  if (!isObj(data)) return null;
  return str(data.account_id) ?? str(data.accountId);
}

/** The text after the first @Brain, made one plain line, or null when there is no request. */
export function mentionRequest(body: string): string | null {
  const own = body.replace(/\r\n?/g, "\n").replace(CODE_BLOCK, "\n\n").replace(QUOTE_LINE, "");
  const match = MENTION.exec(own);
  if (!match) return null;
  const rest = own.slice(match.index + match[0].length);
  const request = rest
    .split(PARAGRAPH_END)[0]!
    .replace(UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REQUEST_CHARS);
  return request || null;
}

const accountOf = (person: unknown): string | null => (isObj(person) ? str(person.accountId) : null);

/** The person's own recent @Brain comments on one issue. A comment edited by anyone else, or with no editor recorded, never counts. */
export function parseMentionComments(text: string, me: string, now: number): Array<{ commentId: string; request: string }> {
  const data = parseJson(text);
  const fields = isObj(data) && isObj(data.fields) ? data.fields : {};
  const comments = isObj(fields.comment) && Array.isArray(fields.comment.comments) ? fields.comment.comments : [];
  const found: Array<{ commentId: string; request: string }> = [];
  for (const comment of comments) {
    if (!isObj(comment)) continue;
    const commentId = str(comment.id);
    const body = typeof comment.body === "string" ? comment.body : null;
    const created = Date.parse(str(comment.created) ?? "");
    if (!commentId || !COMMENT_ID.test(commentId) || !body || Number.isNaN(created)) continue;
    if (accountOf(comment.author) !== me) continue;
    if (accountOf(comment.updateAuthor) !== me) continue;
    if (now - created > WINDOW_MS) continue;
    const request = mentionRequest(body);
    if (request) found.push({ commentId, request });
  }
  return found;
}

async function issueMentions(session: ToolSession, siteId: string, key: string, me: string, now: number): Promise<MentionRequest[]> {
  const result = await session.callTool(ISSUE_TOOL, {
    cloudId: siteId,
    issueIdOrKey: key,
    fields: ["comment"],
    responseContentFormat: "markdown",
  });
  if (result.isError) throw new AppError("UNAVAILABLE", "Could not read Jira comments");
  return parseMentionComments(result.text, me, now).map((c) => ({ siteId, key, ...c }));
}

/**
 * @Brain requests the signed-in person wrote in Jira comments in the last day. A failed read
 * throws rather than returning less, like the assignment check.
 */
export async function atlassianMentionRequests(session: ToolSession, now = Date.now()): Promise<MentionRequest[]> {
  const userResult = await session.callTool(USER_TOOL, {});
  const me = userResult.isError ? null : parseAccountId(userResult.text);
  if (!me) throw new AppError("UNAVAILABLE", "Could not identify the Atlassian account");
  const sitesResult = await session.callTool(SITES_TOOL, {});
  if (sitesResult.isError) throw new AppError("UNAVAILABLE", "Could not list Atlassian sites");
  const sites = parseSites(sitesResult.text)
    .filter((site) => site.scopes.has(JIRA_SCOPE) && SITE_ID.test(site.id))
    .slice(0, MAX_SITES);
  const perSite = await Promise.all(
    sites.map(async (site) => {
      const result = await session.callTool(SEARCH_TOOL, { cloudId: site.id, jql: MENTION_JQL, maxResults: MAX_ISSUES, fields: ["summary"] });
      if (result.isError) throw new AppError("UNAVAILABLE", "Could not search Jira comments");
      const keys = parseJiraIssues(result.text, site).map((hit) => hit.externalId).filter((key) => ISSUE_KEY.test(key));
      // One issue at a time: anyone can add "Brain" comments, so they must not cause a burst of calls.
      const found: MentionRequest[] = [];
      for (const key of keys) found.push(...(await issueMentions(session, site.id, key, me, now)));
      return found;
    }),
  );
  return perSite.flat();
}
