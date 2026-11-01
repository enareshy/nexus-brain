import { AppError } from "@brain/core";
import { toKeywords, toTextSearchTerm } from "./atlassian.js";
import type { SearchAdapter, SearchHit, ToolSession } from "./types.js";

// Tools and result shapes follow the input and output schemas Google publishes in tools/list
// (docs/adr/0001-google-drive-tools.json, 0001-gmail-tools.json, captured 2026-11-01). No real
// account has been connected yet, so results have not been seen live.
const SNIPPET_CHARS = 300;
const ID = /^[\w-]+$/;
const FOLDER = "application/vnd.google-apps.folder";
const DRIVE_HOSTS: ReadonlySet<string> = new Set(["docs.google.com", "drive.google.com"]);
const GMAIL_HOSTS: ReadonlySet<string> = new Set(["mail.google.com"]);
const DRIVE_ID = /^drive:([\w-]+)$/;
const GMAIL_ID = /^gmail:([\w-]+)$/;
const FILE_CONTENT_KEY = '"fileContent":"';

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

function listOf(text: string, key: string): unknown[] {
  const data = parseJson(text);
  const list = isObj(data) ? data[key] : null;
  return Array.isArray(list) ? list : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Links come from tool output and become citations, so only exact https hosts pass. */
function safeLink(value: unknown, hosts: ReadonlySet<string>): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && hosts.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Reads what it can. A failed read just leaves that hit without full text. */
async function readBodies(
  hits: readonly SearchHit[],
  read: (hit: SearchHit) => Promise<string | null>,
): Promise<ReadonlyMap<string, string>> {
  const settled = await Promise.allSettled(hits.map(async (hit) => [hit.url, await read(hit)] as const));
  const bodies = new Map<string, string>();
  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value[1]) bodies.set(outcome.value[0], outcome.value[1]);
  }
  return bodies;
}

/** Quotes and operators were already removed by toTextSearchTerm, so each word stays a literal. */
export function buildDriveQuery(term: string): string {
  return toKeywords(term).map((word) => `fullText contains '${word}'`).join(" or ");
}

/** Keeps only what a citation needs; owners and other people's details are not copied. */
export function parseDriveFiles(text: string): SearchHit[] {
  return listOf(text, "files").flatMap((file) => {
    if (!isObj(file) || file.trashed === true || file.mimeType === FOLDER) return [];
    const id = str(file.id);
    const title = str(file.title);
    const url = safeLink(file.viewUrl, DRIVE_HOSTS);
    if (!id || !ID.test(id) || !title || !url) return [];
    return [
      {
        serverId: "google-drive",
        externalId: `drive:${id}`,
        title: title.slice(0, 500),
        url,
        snippet: (str(file.contentSnippet) ?? "").slice(0, SNIPPET_CHARS),
        updatedAt: str(file.modifiedTime),
      },
    ];
  });
}

async function readDriveFile(session: ToolSession, hit: SearchHit): Promise<string | null> {
  const fileId = DRIVE_ID.exec(hit.externalId)?.[1];
  if (!fileId) return null;
  const result = await session.callTool("read_file_content", { fileId });
  if (result.isError) return null;
  const data = parseJson(result.text);
  if (isObj(data)) return str(data.fileContent);
  return result.truncated ? salvageFileContent(result.text) : null;
}

/** A very large file is cut off mid-JSON by the size cap. The text before the cut is still good. */
export function salvageFileContent(text: string): string | null {
  const start = text.indexOf(FILE_CONTENT_KEY);
  if (start < 0) return null;
  const partial = text.slice(start + FILE_CONTENT_KEY.length);
  // Cut back past any escape sequence the cap may have split, then decode as a JSON string.
  const safe = partial.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
  try {
    const decoded: unknown = JSON.parse(`"${safe}"`);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

export const driveSearch: SearchAdapter = {
  serverId: "google-drive",
  readDocuments: (session, hits) => readBodies(hits, (hit) => readDriveFile(session, hit)),
  async search(session, query, limit) {
    const term = toTextSearchTerm(query);
    if (!term) return [];
    const result = await session.callTool("search_files", {
      query: buildDriveQuery(term),
      pageSize: limit,
      snippetVerbosity: "BRIEF",
    });
    if (result.isError) throw new AppError("UNAVAILABLE", "Google Drive search failed");
    return parseDriveFiles(result.text).slice(0, limit);
  },
};

/** Lowercase keywords joined by OR. Gmail's operators need uppercase or a colon, which are removed. */
export function buildGmailQuery(term: string): string {
  return toKeywords(term).map((word) => word.toLowerCase()).join(" OR ");
}

/** Keeps only what a citation needs; senders and recipients are not copied. */
export function parseGmailThreads(text: string): SearchHit[] {
  return listOf(text, "threads").flatMap((thread) => {
    if (!isObj(thread)) return [];
    const id = str(thread.id);
    const url = safeLink(thread.viewUrl, GMAIL_HOSTS);
    if (!id || !ID.test(id) || !url) return [];
    const messages = (Array.isArray(thread.messages) ? thread.messages : []).filter(isObj);
    const first = messages[0];
    return [
      {
        serverId: "gmail",
        externalId: `gmail:${id}`,
        title: (str(first?.subject) ?? "(no subject)").slice(0, 500),
        url,
        snippet: (str(first?.snippet) ?? "").slice(0, SNIPPET_CHARS),
        updatedAt: str(messages.at(-1)?.date),
      },
    ];
  });
}

async function readGmailThread(session: ToolSession, hit: SearchHit): Promise<string | null> {
  const threadId = GMAIL_ID.exec(hit.externalId)?.[1];
  if (!threadId) return null;
  const result = await session.callTool("get_thread", { threadId, messageFormat: "PLAIN_TEXT" });
  if (result.isError) return null;
  const bodies = listOf(result.text, "messages").flatMap((message) => {
    const body = isObj(message) ? str(message.plaintextBody) : null;
    return body ? [body] : [];
  });
  return bodies.length > 0 ? bodies.join("\n\n") : null;
}

export const gmailSearch: SearchAdapter = {
  serverId: "gmail",
  readDocuments: (session, hits) => readBodies(hits, (hit) => readGmailThread(session, hit)),
  async search(session, query, limit) {
    const term = toTextSearchTerm(query);
    if (!term) return [];
    const result = await session.callTool("search_threads", {
      query: buildGmailQuery(term),
      pageSize: limit,
      view: "THREAD_VIEW_MINIMAL",
    });
    if (result.isError) throw new AppError("UNAVAILABLE", "Gmail search failed");
    return parseGmailThreads(result.text).slice(0, limit);
  },
};
