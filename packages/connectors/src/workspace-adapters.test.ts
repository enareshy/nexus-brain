import type { ToolInfo, ToolResult } from "@brain/mcp-client";
import { describe, expect, it, vi } from "vitest";
import {
  buildDriveQuery,
  buildGmailQuery,
  driveSearch,
  gmailSearch,
  parseDriveFiles,
  parseGmailThreads,
  salvageFileContent,
} from "./google.js";
import { parseSlackMessages, slackSearch } from "./slack.js";
import type { SearchHit, ToolSession } from "./types.js";

function ok(data: unknown): ToolResult {
  return { text: typeof data === "string" ? data : JSON.stringify(data), isError: false, truncated: false };
}
const FAILED: ToolResult = { text: "error", isError: true, truncated: false };

function sessionWith(handler: (name: string, args: Record<string, unknown>) => ToolResult, tools: ToolInfo[] = []) {
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => handler(name, args));
  const session: ToolSession & { callTool: typeof callTool } = { listTools: async () => tools, callTool };
  return session;
}

const hit = (externalId: string, url: string): SearchHit => ({
  serverId: "x",
  externalId,
  title: "t",
  url,
  snippet: "",
  updatedAt: null,
});

// Follows the output schema Google publishes for search_files, with synthetic values.
const FILE = {
  id: "abc_123-X",
  title: "Runbook",
  mimeType: "application/vnd.google-apps.document",
  contentSnippet: "How to rotate keys",
  modifiedTime: "2026-10-30T10:00:00Z",
  viewUrl: "https://docs.google.com/document/d/abc_123-X/edit",
  owner: "someone@acme.example",
};

describe("Google Drive", () => {
  it("builds a keyword query that the question cannot change", () => {
    expect(buildDriveQuery("rotate keys")).toBe("fullText contains 'rotate' or fullText contains 'keys'");
  });

  it("normalises files without copying people's details", () => {
    const hits = parseDriveFiles(JSON.stringify({ files: [FILE] }));
    expect(hits).toEqual([
      {
        serverId: "google-drive",
        externalId: "drive:abc_123-X",
        title: "Runbook",
        url: FILE.viewUrl,
        snippet: "How to rotate keys",
        updatedAt: FILE.modifiedTime,
      },
    ]);
    expect(JSON.stringify(hits)).not.toContain("someone@acme.example");
  });

  it("drops trashed files, folders, unsafe links and bad ids", () => {
    const bad = [
      { ...FILE, trashed: true },
      { ...FILE, mimeType: "application/vnd.google-apps.folder" },
      { ...FILE, viewUrl: "https://evil.example/d/1" },
      { ...FILE, viewUrl: "http://docs.google.com/d/1" },
      { ...FILE, viewUrl: "javascript:alert(1)" },
      { ...FILE, viewUrl: "https://docs.google.com.evil.example/d/1" },
      { ...FILE, id: "../x" },
      { ...FILE, title: " " },
      "nonsense",
    ];
    expect(parseDriveFiles(JSON.stringify({ files: bad }))).toEqual([]);
    expect(parseDriveFiles("not json")).toEqual([]);
  });

  it("searches with the query and limit, and strips operators from the question", async () => {
    const session = sessionWith(() => ok({ files: [FILE] }));
    const hits = await driveSearch.search(session, "owner = 'me' keys", 5);
    expect(hits).toHaveLength(1);
    const [, args] = session.callTool.mock.calls[0]!;
    expect(args.pageSize).toBe(5);
    expect(args.query).not.toContain("=");
    expect(String(args.query).match(/'/g)?.length).toBe(4);
  });

  it("does not call Drive for a question with no words, and reports failures", async () => {
    const session = sessionWith(() => ok({ files: [] }));
    expect(await driveSearch.search(session, "?!", 5)).toEqual([]);
    expect(session.callTool).not.toHaveBeenCalled();
    await expect(driveSearch.search(sessionWith(() => FAILED), "keys", 5)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("reads file text, skipping failures and hits it does not recognise", async () => {
    const session = sessionWith((_name, args) => (args.fileId === "bad" ? FAILED : ok({ fileContent: "full text" })));
    const bodies = await driveSearch.readDocuments!(session, [
      hit("drive:good", "https://docs.google.com/d/good"),
      hit("drive:bad", "https://docs.google.com/d/bad"),
      hit("other", "https://docs.google.com/d/other"),
    ]);
    expect([...bodies]).toEqual([["https://docs.google.com/d/good", "full text"]]);
    expect(session.callTool).toHaveBeenCalledTimes(2);
  });
});

describe("salvageFileContent", () => {
  it("keeps the text of a very large file that the size cap cut off", async () => {
    const full = JSON.stringify({ fileContent: 'line one\nsaid "hi" and more', title: "Doc" });
    const cut = full.slice(0, full.indexOf(" and more"));
    expect(salvageFileContent(cut)).toBe('line one\nsaid "hi"');

    const session = sessionWith(() => ({ text: cut, isError: false, truncated: true }));
    const bodies = await driveSearch.readDocuments!(session, [hit("drive:big", "https://docs.google.com/d/big")]);
    expect(bodies.get("https://docs.google.com/d/big")).toBe('line one\nsaid "hi"');
  });

  it("copes with a cut in the middle of an escape, and with no content", () => {
    expect(salvageFileContent('{"fileContent":"ab\\')).toBe("ab");
    expect(salvageFileContent('{"fileContent":"ab\\u00')).toBe("ab");
    expect(salvageFileContent('{"title":"x"')).toBeNull();
  });
});

const THREAD = {
  id: "18f2",
  messageCount: 2,
  viewUrl: "https://mail.google.com/mail/u/0/#all/18f2",
  messages: [
    { id: "m1", subject: "Invoice", snippet: "Please find", date: "2026-10-29", sender: "ceo@acme.example" },
    { id: "m2", subject: "Re: Invoice", snippet: "Thanks", date: "2026-10-30", sender: "cfo@acme.example" },
  ],
};

describe("Gmail", () => {
  it("builds a keyword query that cannot use Gmail's filters or operators", () => {
    expect(buildGmailQuery("invoice march")).toBe("invoice OR march");
    expect(buildGmailQuery("OR NOT")).toBe("or OR not");
  });

  it("normalises threads without copying senders", () => {
    const hits = parseGmailThreads(JSON.stringify({ threads: [THREAD] }));
    expect(hits).toEqual([
      {
        serverId: "gmail",
        externalId: "gmail:18f2",
        title: "Invoice",
        url: THREAD.viewUrl,
        snippet: "Please find",
        updatedAt: "2026-10-30",
      },
    ]);
    expect(JSON.stringify(hits)).not.toContain("acme.example");
  });

  it("names a thread with no subject, and drops unsafe links and bad ids", () => {
    const [unnamed] = parseGmailThreads(JSON.stringify({ threads: [{ ...THREAD, messages: [] }] }));
    expect(unnamed?.title).toBe("(no subject)");
    const bad = [
      { ...THREAD, viewUrl: "https://evil.example/x" },
      { ...THREAD, viewUrl: "http://mail.google.com/x" },
      { ...THREAD, id: "a/b" },
      3,
    ];
    expect(parseGmailThreads(JSON.stringify({ threads: bad }))).toEqual([]);
    expect(parseGmailThreads("no")).toEqual([]);
  });

  it("strips filters such as from: out of the question", async () => {
    const session = sessionWith(() => ok({ threads: [THREAD] }));
    await gmailSearch.search(session, "from:boss@acme.example has:attachment", 5);
    const [name, args] = session.callTool.mock.calls[0]!;
    expect(name).toBe("search_threads");
    expect(args.view).toBe("THREAD_VIEW_MINIMAL");
    expect(args.pageSize).toBe(5);
    expect(String(args.query)).not.toContain(":");
  });

  it("does not call Gmail for a question with no words, and reports failures", async () => {
    const session = sessionWith(() => ok({ threads: [] }));
    expect(await gmailSearch.search(session, "?!", 5)).toEqual([]);
    expect(session.callTool).not.toHaveBeenCalled();
    await expect(gmailSearch.search(sessionWith(() => FAILED), "x", 5)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("reads a thread's plain text only, without senders", async () => {
    const session = sessionWith(() =>
      ok({
        messages: [
          { subject: "Invoice", plaintextBody: "first", htmlBody: "<b>html</b>", sender: "ceo@acme.example" },
          { subject: "Re: Invoice", plaintextBody: "second" },
          { subject: "Empty" },
        ],
      }),
    );
    const url = THREAD.viewUrl;
    const bodies = await gmailSearch.readDocuments!(session, [hit("gmail:18f2", url), hit("other", "https://mail.google.com/x")]);
    expect(session.callTool).toHaveBeenCalledTimes(1);
    expect(session.callTool).toHaveBeenCalledWith("get_thread", { threadId: "18f2", messageFormat: "PLAIN_TEXT" });
    expect(bodies.get(url)).toBe("first\n\nsecond");
  });
});

const SLACK_TOOL: ToolInfo = {
  name: "slack_search_public",
  description: "",
  inputSchema: { properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
};
const LINK = "https://acme.slack.com/archives/C123/p1700000000000100";

describe("Slack", () => {
  it("copies only a message's own text from JSON, not names or other messages", () => {
    const hits = parseSlackMessages(
      JSON.stringify(
        {
          messages: [
            { user: "Secret Name", email: "a@acme.example", text: "first", permalink: LINK },
            { user: "Other Name", text: "second", permalink: "https://acme.slack.com/archives/C123/p2" },
          ],
        },
        null,
        2,
      ),
    );
    expect(hits.map((h) => h.snippet)).toEqual(["first", "second"]);
    expect(JSON.stringify(hits)).not.toMatch(/Secret Name|Other Name|acme\.example"/);
  });

  it("ignores links that appear only inside a message's text in JSON", () => {
    const pasted = "see https://evil.slack.com/archives/C9/p9";
    const hits = parseSlackMessages(JSON.stringify({ messages: [{ text: pasted, permalink: LINK }] }));
    expect(hits.map((h) => h.url)).toEqual([LINK]);
  });

  it("stays fast on hostile text", () => {
    const hostile = `${LINK} ${"[".repeat(200_000)}\n${"(".repeat(200_000)}`;
    const started = Date.now();
    expect(parseSlackMessages(hostile)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("returns nothing for a question that is only Slack's special characters", async () => {
    const session = sessionWith(() => ok(""), [SLACK_TOOL]);
    expect(await slackSearch.search(session, "# @", 5)).toEqual([]);
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it("finds message links in JSON and in formatted text", () => {
    const json = parseSlackMessages(JSON.stringify({ messages: [{ text: "deploy is done", permalink: LINK }] }));
    expect(json).toEqual([
      expect.objectContaining({ serverId: "slack", externalId: "slack:C123/p1700000000000100", url: LINK }),
    ]);
    const text = parseSlackMessages(`Result 1\nThe deploy is done [link](${LINK})\nnext line`);
    expect(text[0]?.url).toBe(LINK);
    expect(text[0]?.snippet).toContain("The deploy is done");
  });

  it("accepts only message links on slack.com, once each", () => {
    const text = [
      "https://evil.example/archives/C1/p1",
      "http://acme.slack.com/archives/C1/p1",
      "https://acme.slack.com.evil.example/archives/C1/p1",
      "https://acme.slack.com/admin",
      "javascript:alert(1)",
    ].join("\n");
    expect(parseSlackMessages(text)).toEqual([]);
    expect(parseSlackMessages(`${LINK}\n${LINK}`)).toHaveLength(1);
  });

  it("uses a listed search tool with the arguments its schema declares", async () => {
    const session = sessionWith(() => ok(LINK), [SLACK_TOOL]);
    const hits = await slackSearch.search(session, "deploy status", 5);
    expect(hits).toHaveLength(1);
    expect(session.callTool).toHaveBeenCalledWith("slack_search_public", { query: "deploy status", limit: 5 });
  });

  it("strips search modifiers from the question", async () => {
    const session = sessionWith(() => ok(""), [SLACK_TOOL]);
    await slackSearch.search(session, "in:#secret deploy", 5);
    const args = session.callTool.mock.calls[0]![1];
    expect(String(args.query)).not.toContain(":");
    expect(String(args.query)).not.toContain("#");
  });

  it("never calls a tool it does not know, including ones that post", async () => {
    const post = { ...SLACK_TOOL, name: "slack_send_message" };
    const session = sessionWith(() => ok(""), [post]);
    await expect(slackSearch.search(session, "deploy", 5)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(session.callTool).not.toHaveBeenCalled();
  });

  it("reports failures, and does nothing for a question with no words", async () => {
    await expect(slackSearch.search(sessionWith(() => FAILED, [SLACK_TOOL]), "x", 5)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    const session = sessionWith(() => ok(""), [SLACK_TOOL]);
    expect(await slackSearch.search(session, "?!", 5)).toEqual([]);
    expect(session.callTool).not.toHaveBeenCalled();
  });
});
