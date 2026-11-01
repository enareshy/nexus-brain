import { AppError } from "@brain/core";
import { interleave, toKeywords, toTextSearchTerm } from "./atlassian.js";
import type { SearchAdapter, SearchHit, ToolSession } from "./types.js";

// Tool names and result shapes verified against the live GitHub MCP server on 2026-11-01
// (docs/adr/0001-mcp-servers.md). Code search is left out: it returned nothing on the test
// repository, so its results have never been seen. Searches reach only the signed-in user's
// own repositories, because otherwise GitHub searches every public repository.
const ME_TOOL = "get_me";
const REPOS_TOOL = "search_repositories";
const PULLS_TOOL = "search_pull_requests";
const ISSUES_TOOL = "search_issues";
const LOOKUP_TTL_MS = 5 * 60 * 1000;
const MAX_REPOS = 3;
const SNIPPET_CHARS = 300;
/** GitHub allows five boolean operators in one query. */
const MAX_PR_KEYWORDS = 6;
const ITEM_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)$/;
const ITEM_ID = /^([\w.-]+)\/([\w.-]+)#(issues|pull)\/(\d+)$/;
const LOGIN = /^[A-Za-z0-9-]+$/;
const REPO_NAME = /^[\w.-]+$/;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function itemsOf(text: string): unknown[] {
  const data = parseJson(text);
  return isObj(data) && Array.isArray(data.items) ? data.items : [];
}

/** The link is checked strictly because it comes from tool output and becomes a citation. */
export function parseGithubItems(text: string): SearchHit[] {
  return itemsOf(text).flatMap((item) => {
    if (!isObj(item) || typeof item.html_url !== "string") return [];
    const match = ITEM_URL.exec(item.html_url);
    const title = typeof item.title === "string" ? item.title.trim() : "";
    // A browser would resolve "." and ".." to a different repository than the one cited.
    if (!match || !title || /^\.+$/.test(match[1] ?? "") || /^\.+$/.test(match[2] ?? "")) return [];
    const [, owner, repo, kind, number] = match;
    return [
      {
        serverId: "github",
        externalId: `${owner}/${repo}#${kind}/${number}`,
        title: title.slice(0, 500),
        url: item.html_url,
        snippet: typeof item.body === "string" ? item.body.slice(0, SNIPPET_CHARS) : "",
        updatedAt: typeof item.updated_at === "string" ? item.updated_at : null,
      },
    ];
  });
}

/** Keywords are lowercased because GitHub's operators are case-sensitive uppercase words. */
export function buildPullRequestQuery(login: string, term: string): string {
  const keywords = toKeywords(term).slice(0, MAX_PR_KEYWORDS).map((word) => word.toLowerCase());
  return `user:${login} ${keywords.join(" OR ")}`;
}

async function signedInLogin(session: ToolSession): Promise<string> {
  const result = await session.callTool(ME_TOOL, {});
  const data = result.isError ? null : parseJson(result.text);
  const login = isObj(data) ? data.login : null;
  if (typeof login !== "string" || !LOGIN.test(login)) throw new AppError("UNAVAILABLE", "Could not identify the GitHub user");
  return login;
}

/** Most recently updated repositories that really belong to this user. */
async function ownRepositories(session: ToolSession, login: string): Promise<string[]> {
  const result = await session.callTool(REPOS_TOOL, {
    query: `user:${login}`,
    sort: "updated",
    order: "desc",
    perPage: MAX_REPOS,
  });
  if (result.isError) return [];
  const prefix = `${login.toLowerCase()}/`;
  return itemsOf(result.text).flatMap((repo) => {
    if (!isObj(repo) || typeof repo.name !== "string" || typeof repo.full_name !== "string") return [];
    return repo.full_name.toLowerCase().startsWith(prefix) && REPO_NAME.test(repo.name) ? [repo.name] : [];
  });
}

async function searchPulls(session: ToolSession, login: string, term: string, limit: number): Promise<SearchHit[]> {
  const result = await session.callTool(PULLS_TOOL, {
    query: buildPullRequestQuery(login, term),
    perPage: limit,
    fields: ["number", "title", "body", "html_url", "updated_at"],
  });
  if (result.isError) throw new AppError("UNAVAILABLE", "GitHub pull request search failed");
  return parseGithubItems(result.text);
}

async function searchIssues(session: ToolSession, login: string, repo: string, term: string, limit: number): Promise<SearchHit[]> {
  // This tool takes natural language and rejects qualifiers, so scope comes from owner and repo.
  // Lowercase, so a word like NOT in a question cannot act as an operator.
  const result = await session.callTool(ISSUES_TOOL, {
    query: term.toLowerCase(),
    owner: login,
    repo,
    perPage: limit,
    fields: ["number", "title", "body", "html_url", "updated_at"],
  });
  if (result.isError) throw new AppError("UNAVAILABLE", "GitHub issue search failed");
  return parseGithubItems(result.text);
}

async function readBody(session: ToolSession, hit: SearchHit): Promise<string | null> {
  const match = ITEM_ID.exec(hit.externalId);
  if (!match) return null;
  const [, owner, repo, kind, number] = match;
  const result =
    kind === "issues"
      ? await session.callTool("issue_read", { method: "get", owner, repo, issue_number: Number(number) })
      : await session.callTool("pull_request_read", { method: "get", owner, repo, pullNumber: Number(number) });
  const data = result.isError ? null : parseJson(result.text);
  return isObj(data) && typeof data.body === "string" && data.body.trim() ? data.body : null;
}

export const githubSearch: SearchAdapter = {
  serverId: "github",
  // Only who the user is and where to search; every search and read still uses the user's token.
  cachedTools: { [ME_TOOL]: LOOKUP_TTL_MS, [REPOS_TOOL]: LOOKUP_TTL_MS },

  async readDocuments(session, hits) {
    const settled = await Promise.allSettled(
      hits.map(async (hit) => [hit.url, await readBody(session, hit)] as const),
    );
    const bodies = new Map<string, string>();
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value[1]) bodies.set(outcome.value[0], outcome.value[1]);
    }
    return bodies;
  },

  async search(session, query, limit) {
    const term = toTextSearchTerm(query);
    if (!term) return [];
    const login = await signedInLogin(session);
    const repos = await ownRepositories(session, login);

    const settled = await Promise.allSettled([
      searchPulls(session, login, term, limit),
      ...repos.map((repo) => searchIssues(session, login, repo, term, limit)),
    ]);
    const succeeded = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (succeeded.length === 0) throw new AppError("UNAVAILABLE", "GitHub search failed");
    return interleave(succeeded, limit);
  },
};
