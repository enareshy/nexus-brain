import type { ToolResult } from "@brain/mcp-client";
import { describe, expect, it, vi } from "vitest";
import { atlassianWrites, parseProjects } from "./atlassian-writes.js";
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
