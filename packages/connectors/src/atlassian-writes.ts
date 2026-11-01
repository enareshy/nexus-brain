import { AppError } from "@brain/core";
import { ISSUE_KEY, parseSites, SITES_TOOL } from "./atlassian.js";
import type { ToolSession, WriteAdapter, WriteDraft, WriteOutcome, WriteProject, WriteRequest } from "./types.js";

// Tool names and arguments follow the live tools/list capture (docs/adr/0001-atlassian-tools.json).
// Only these three tools can ever be called. Delete, bulk, transition, worklog and link tools,
// and Confluence writes, are absent, so write-policy treats them as destructive.
const CREATE_TOOL = "createJiraIssue";
const EDIT_TOOL = "editJiraIssue";
const COMMENT_TOOL = "addCommentToJiraIssue";
const WRITE_SCOPE = "write:jira-work";
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
const MAX_SITES = 3;
const MAX_PROJECTS = 50;

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

function requireIssueKey(key: string): string {
  if (!ISSUE_KEY.test(key)) throw new AppError("VALIDATION", "That is not a valid issue key");
  return key;
}

/** Sites from the user's own grant where they may write to Jira. */
async function writableSites(session: ToolSession) {
  const result = await session.callTool(SITES_TOOL, {});
  if (result.isError) throw new AppError("UNAVAILABLE", "Could not list Atlassian sites");
  return parseSites(result.text).filter((site) => site.scopes.has(WRITE_SCOPE));
}

function issueTypeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((type) =>
    isObj(type) && typeof type.name === "string" && type.subtask !== true ? [type.name] : [],
  );
}

export function parseProjects(text: string): WriteProject[] {
  const data = parseJson(text);
  const values = isObj(data) && Array.isArray(data.values) ? data.values : [];
  return values.flatMap((project) => {
    if (!isObj(project) || typeof project.key !== "string" || !PROJECT_KEY.test(project.key)) return [];
    return [
      {
        key: project.key,
        name: typeof project.name === "string" ? project.name : project.key,
        issueTypes: issueTypeNames(project.issueTypes),
      },
    ];
  });
}

/** Arguments are built field by field, so nothing else in a request can reach the tool. */
function toolCall(request: WriteRequest): Pick<WriteDraft, "toolName" | "args"> {
  const cloudId = request.siteId;
  switch (request.action) {
    case "create_issue":
      if (!PROJECT_KEY.test(request.projectKey)) throw new AppError("VALIDATION", "That is not a valid project key");
      return {
        toolName: CREATE_TOOL,
        args: {
          cloudId,
          projectKey: request.projectKey,
          issueTypeName: request.issueType,
          summary: request.summary,
          ...(request.description ? { description: request.description } : {}),
          contentFormat: "markdown",
        },
      };
    case "update_issue": {
      const fields = {
        ...(request.summary ? { summary: request.summary } : {}),
        ...(request.description ? { description: request.description } : {}),
      };
      if (Object.keys(fields).length === 0) throw new AppError("VALIDATION", "Nothing to change");
      return {
        toolName: EDIT_TOOL,
        args: { cloudId, issueIdOrKey: requireIssueKey(request.issueKey), fields, contentFormat: "markdown" },
      };
    }
    case "add_comment":
      // commentId is never sent: with it, this tool would overwrite an existing comment.
      return {
        toolName: COMMENT_TOOL,
        args: {
          cloudId,
          issueIdOrKey: requireIssueKey(request.issueKey),
          commentBody: request.body,
          contentFormat: "markdown",
        },
      };
  }
}

export const atlassianWrites: WriteAdapter = {
  serverId: "atlassian",
  manifest: {
    [CREATE_TOOL]: "write",
    [EDIT_TOOL]: "write",
    [COMMENT_TOOL]: "external-effect",
  },

  async targets(session) {
    const sites = (await writableSites(session)).slice(0, MAX_SITES);
    return Promise.all(
      sites.map(async (site) => {
        const result = await session.callTool("getVisibleJiraProjects", {
          cloudId: site.id,
          action: "create",
          maxResults: MAX_PROJECTS,
          expandIssueTypes: true,
        });
        if (result.isError) throw new AppError("UNAVAILABLE", "Could not list Jira projects");
        return { siteId: site.id, siteOrigin: site.origin, projects: parseProjects(result.text) };
      }),
    );
  },

  async draft(session, request) {
    const call = toolCall(request);
    const site = (await writableSites(session)).find((s) => s.id === request.siteId);
    if (!site) throw new AppError("VALIDATION", "You cannot make changes on that Jira site");
    return { action: request.action, siteOrigin: site.origin, ...call };
  },

  /** The link comes from the trusted site origin; only a well-formed key is taken from the result. */
  outcome(draft, resultText): WriteOutcome {
    const data = parseJson(resultText);
    const key = draft.toolName === CREATE_TOOL ? (isObj(data) ? data.key : null) : draft.args.issueIdOrKey;
    if (typeof key !== "string" || !ISSUE_KEY.test(key)) return { externalId: null, url: null };
    return { externalId: key, url: `${draft.siteOrigin}/browse/${key}` };
  },
};
