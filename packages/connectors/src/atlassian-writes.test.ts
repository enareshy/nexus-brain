import type { ToolResult } from "@brain/mcp-client";
import { describe, expect, it, vi } from "vitest";
import { atlassianWrites, parseIssueState, parseProjects } from "./atlassian-writes.js";
import type { ToolSession } from "./types.js";

const CLOUD = "11111111-2222-3333-4444-555555555555";
const ORIGIN = "https://acme.atlassian.net";
const SITES = [
  { id: CLOUD, url: `${ORIGIN}/`, name: "acme", scopes: ["search:confluence"] },
  { id: CLOUD, url: `${ORIGIN}/`, name: "acme", scopes: ["read:jira-work", "write:jira-work"] },
];
const PROJECTS = {
  values: [
    {
      key: "ENG",
      name: "Engineering",
      issueTypes: [
        { name: "Task", subtask: false },
        { name: "Sub-task", subtask: true },
      ],
    },
  ],
};

function ok(data: unknown): ToolResult {
  return { text: JSON.stringify(data), isError: false, truncated: false };
}

function session(sites: unknown = SITES): ToolSession & { callTool: ReturnType<typeof vi.fn> } {
  return {
    listTools: async () => [],
    callTool: vi.fn(async (name: string) => {
      if (name === "getAccessibleAtlassianResources") return ok(sites);
      if (name === "getVisibleJiraProjects") return ok(PROJECTS);
      throw new Error(`unexpected tool ${name}`);
    }),
  };
}

const CREATE = {
  action: "create_issue",
  siteId: CLOUD,
  projectKey: "ENG",
  issueType: "Task",
  summary: "Fix login",
  description: "It fails",
} as const;

describe("draft", () => {
  it("builds the exact createJiraIssue arguments", async () => {
    const draft = await atlassianWrites.draft(session(), CREATE);
    expect(draft).toEqual({
      action: "create_issue",
      toolName: "createJiraIssue",
      siteOrigin: ORIGIN,
      args: {
        cloudId: CLOUD,
        projectKey: "ENG",
        issueTypeName: "Task",
        summary: "Fix login",
        description: "It fails",
        contentFormat: "markdown",
      },
    });
  });

  it("omits an empty description", async () => {
    const draft = await atlassianWrites.draft(session(), { ...CREATE, description: undefined });
    expect(draft.args).not.toHaveProperty("description");
  });

  it("limits an update to summary and description", async () => {
    const draft = await atlassianWrites.draft(session(), {
      action: "update_issue",
      siteId: CLOUD,
      issueKey: "ENG-1",
      summary: "New title",
    });
    expect(draft.toolName).toBe("editJiraIssue");
    expect(draft.args).toEqual({
      cloudId: CLOUD,
      issueIdOrKey: "ENG-1",
      fields: { summary: "New title" },
      contentFormat: "markdown",
    });
  });

  it("refuses an update that changes nothing", async () => {
    await expect(
      atlassianWrites.draft(session(), { action: "update_issue", siteId: CLOUD, issueKey: "ENG-1" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("adds a new comment and can never edit an existing one", async () => {
    const draft = await atlassianWrites.draft(session(), {
      action: "add_comment",
      siteId: CLOUD,
      issueKey: "ENG-1",
      body: "Looks good",
    });
    expect(draft.toolName).toBe("addCommentToJiraIssue");
    expect(draft.args).toEqual({
      cloudId: CLOUD,
      issueIdOrKey: "ENG-1",
      commentBody: "Looks good",
      contentFormat: "markdown",
    });
  });

  it("never posts a comment that reads as a new @Brain request", async () => {
    const draft = await atlassianWrites.draft(session(), { action: "add_comment", siteId: CLOUD, issueKey: "ENG-1", body: "@Brain done" });
    expect(draft.args).toMatchObject({ commentBody: "Brain done" });
    const edit = await atlassianWrites.draft(session(), { action: "update_issue", siteId: CLOUD, issueKey: "ENG-1", summary: "@Brain a", description: "@brain b" });
    expect(edit.args).toMatchObject({ fields: { summary: "Brain a", description: "brain b" } });
    const create = await atlassianWrites.draft(session(), { ...CREATE, summary: "@Brain c", description: "@Brain d" });
    expect(create.args).toMatchObject({ summary: "Brain c", description: "Brain d" });
  });

  it("creates a subtask of the parent project's own subtask type", async () => {
    const s = session();
    const draft = await atlassianWrites.draft(s, { action: "create_subtask", siteId: CLOUD, parentKey: "ENG-12", summary: "@Brain write tests" });
    expect(draft).toMatchObject({ action: "create_subtask", toolName: "createJiraIssue", siteOrigin: ORIGIN });
    expect(draft.args).toEqual({
      cloudId: CLOUD,
      projectKey: "ENG",
      issueTypeName: "Sub-task",
      summary: "Brain write tests",
      parent: "ENG-12",
      contentFormat: "markdown",
    });
    expect(s.callTool).toHaveBeenCalledWith("getVisibleJiraProjects", expect.objectContaining({ cloudId: CLOUD, searchString: "ENG" }));
  });

  it("refuses a subtask where the project has no subtask type, the parent key is malformed, or the site is not writable", async () => {
    const noSubtasks = { values: [{ key: "ENG", issueTypes: [{ name: "Task", subtask: false }] }] };
    const s = session();
    s.callTool.mockImplementation(async (name: string) => ok(name === "getVisibleJiraProjects" ? noSubtasks : SITES));
    const subtask = { action: "create_subtask", siteId: CLOUD, parentKey: "ENG-12", summary: "x" } as const;
    await expect(atlassianWrites.draft(s, subtask)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(atlassianWrites.draft(session(), { ...subtask, parentKey: "ENG" })).rejects.toMatchObject({ code: "VALIDATION" });
    const other = session();
    await expect(atlassianWrites.draft(other, { ...subtask, siteId: "other" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(other.callTool).not.toHaveBeenCalledWith("getVisibleJiraProjects", expect.anything());
  });

  it("reports an unavailable project list", async () => {
    const s = session();
    s.callTool.mockImplementation(async (name: string) =>
      name === "getVisibleJiraProjects" ? { text: "", isError: true, truncated: false } : ok(SITES),
    );
    await expect(
      atlassianWrites.draft(s, { action: "create_subtask", siteId: CLOUD, parentKey: "ENG-12", summary: "x", description: "d" }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects a malformed issue key or project key", async () => {
    await expect(
      atlassianWrites.draft(session(), { action: "add_comment", siteId: CLOUD, issueKey: "ENG-1 OR 1=1", body: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(atlassianWrites.draft(session(), { ...CREATE, projectKey: "../x" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("rejects a site the user has no write access to", async () => {
    await expect(atlassianWrites.draft(session(), { ...CREATE, siteId: "other" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const readOnly = [{ id: CLOUD, url: `${ORIGIN}/`, name: "acme", scopes: ["read:jira-work"] }];
    await expect(atlassianWrites.draft(session(readOnly), CREATE)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("does not pass caller-supplied extra fields through", async () => {
    const hostile = { ...CREATE, parent: "ENG-9", assignee_account_id: "x", additional_fields: { labels: ["y"] } };
    const draft = await atlassianWrites.draft(session(), hostile);
    expect(Object.keys(draft.args).sort()).toEqual(
      ["cloudId", "contentFormat", "description", "issueTypeName", "projectKey", "summary"].sort(),
    );
  });
});

describe("manifest (FR-WS-J04)", () => {
  it("classifies only the tools this adapter can call", () => {
    expect(atlassianWrites.manifest).toEqual({
      createJiraIssue: "write",
      editJiraIssue: "write",
      addCommentToJiraIssue: "external-effect",
    });
  });
});

describe("outcome", () => {
  const draftOf = (toolName: string, args: Record<string, unknown>) => ({
    action: "x",
    toolName,
    args,
    siteOrigin: ORIGIN,
  });

  it("builds the link to a created issue from the trusted site origin", () => {
    const outcome = atlassianWrites.outcome(draftOf("createJiraIssue", {}), '{"key":"ENG-7","self":"https://evil.example"}');
    expect(outcome).toEqual({ externalId: "ENG-7", url: `${ORIGIN}/browse/ENG-7` });
  });

  it("ignores a malformed key in the result", () => {
    expect(atlassianWrites.outcome(draftOf("createJiraIssue", {}), '{"key":"../../evil"}')).toEqual({
      externalId: null,
      url: null,
    });
    expect(atlassianWrites.outcome(draftOf("createJiraIssue", {}), "not json")).toEqual({
      externalId: null,
      url: null,
    });
  });

  it("links updates and comments to the issue from the approved arguments", () => {
    expect(atlassianWrites.outcome(draftOf("editJiraIssue", { issueIdOrKey: "ENG-1" }), "{}")).toEqual({
      externalId: "ENG-1",
      url: `${ORIGIN}/browse/ENG-1`,
    });
  });
});

describe("targets", () => {
  it("lists sites the user can write to, with projects and non-subtask issue types", async () => {
    const targets = await atlassianWrites.targets(session());
    expect(targets).toEqual([
      {
        siteId: CLOUD,
        siteOrigin: ORIGIN,
        projects: [{ key: "ENG", name: "Engineering", issueTypes: ["Task"] }],
      },
    ]);
  });
});

describe("parseProjects", () => {
  it("drops malformed entries", () => {
    const text = JSON.stringify({ values: [{ key: "bad key", name: "x" }, { key: "OK", name: "Fine" }, 3] });
    expect(parseProjects(text)).toEqual([{ key: "OK", name: "Fine", issueTypes: [] }]);
    expect(parseProjects("nope")).toEqual([]);
  });
});

describe("undo (FR-WR-06)", () => {
  const EDIT = {
    action: "update_issue",
    toolName: "editJiraIssue",
    siteOrigin: ORIGIN,
    args: { cloudId: CLOUD, issueIdOrKey: "ENG-1", fields: { summary: "New", description: "Body" }, contentFormat: "markdown" },
  } as const;
  const DOC = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Old body" }] }] };

  function reading(result: ToolResult): ToolSession & { callTool: ReturnType<typeof vi.fn> } {
    return { listTools: async () => [], callTool: vi.fn(async () => result) };
  }

  it("reads only the edited fields, in Jira's own format, from the same site and issue", async () => {
    const s = reading(ok({ key: "ENG-1", fields: { summary: "Old", description: DOC, status: { name: "Open" } } }));
    expect(await atlassianWrites.readState?.(s, EDIT)).toEqual({ summary: "Old", description: DOC });
    expect(s.callTool).toHaveBeenCalledWith("getJiraIssue", {
      cloudId: CLOUD,
      issueIdOrKey: "ENG-1",
      fields: ["summary", "description"],
      responseContentFormat: "adf",
    });
  });

  it("keeps an empty description as null, so undo clears it again", async () => {
    const s = reading(ok({ fields: { summary: "Old", description: null } }));
    expect(await atlassianWrites.readState?.(s, EDIT)).toEqual({ summary: "Old", description: null });
  });

  it("does not offer undo for new issues and comments, or when the issue looks unexpected", async () => {
    const s = reading(ok({ fields: { summary: "Old" } }));
    expect(await atlassianWrites.readState?.(s, { ...EDIT, toolName: "createJiraIssue" })).toBeNull();
    expect(await atlassianWrites.readState?.(s, { ...EDIT, toolName: "addCommentToJiraIssue" })).toBeNull();
    expect(s.callTool).not.toHaveBeenCalled();
    expect(parseIssueState("not json", ["summary"])).toBeNull();
    expect(parseIssueState(JSON.stringify({ fields: { summary: 7 } }), ["summary"])).toBeNull();
    expect(parseIssueState(JSON.stringify({ fields: { description: "plain" } }), ["description"])).toBeNull();
    expect(parseIssueState("x".repeat(70_000), ["summary"])).toBeNull();
  });

  it("stops before the change when Jira refuses the read", async () => {
    const s = reading({ text: "nope", isError: true, truncated: false });
    await expect(atlassianWrites.readState?.(s, EDIT)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("builds an edit that sets exactly the saved fields back on the same issue", () => {
    const undo = atlassianWrites.undoDraft?.(EDIT, { summary: "Old", description: DOC });
    expect(undo).toEqual({
      action: "undo_update",
      toolName: "editJiraIssue",
      siteOrigin: ORIGIN,
      args: { cloudId: CLOUD, issueIdOrKey: "ENG-1", fields: { summary: "Old", description: DOC }, contentFormat: "adf" },
    });
  });

  it("refuses an undo for anything but an edit, or with a field missing", () => {
    expect(() => atlassianWrites.undoDraft?.({ ...EDIT, toolName: "createJiraIssue" }, { summary: "Old" })).toThrow();
    expect(() => atlassianWrites.undoDraft?.(EDIT, { summary: "Old" })).toThrow();
  });
});
