import { AppError } from "@brain/core";
import { defuseMentions } from "./atlassian-mentions.js";
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
const PROJECTS_TOOL = "getVisibleJiraProjects";
const ISSUE_TOOL = "getJiraIssue";
/** The only fields an edit can set, so the only ones an undo can put back. */
const UNDOABLE_FIELDS: ReadonlySet<string> = new Set(["summary", "description"]);
/** Bigger than this and the saved state is not worth keeping: undo is then not offered. */
const MAX_STATE_BYTES = 64 * 1024;

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

/** The name of a project's subtask issue type, or null when it has none the person can create. */
export function parseSubtaskType(text: string, projectKey: string): string | null {
  const data = parseJson(text);
  const values = isObj(data) && Array.isArray(data.values) ? data.values : [];
  const project = values.find((p): p is Obj => isObj(p) && p.key === projectKey);
  const types = project && Array.isArray(project.issueTypes) ? project.issueTypes : [];
  const subtask = types.find((t): t is Obj => isObj(t) && t.subtask === true && typeof t.name === "string");
  return subtask ? (subtask.name as string) : null;
}

/** Subtasks must use the parent project's own subtask type, which can be named anything. */
async function subtaskType(session: ToolSession, siteId: string, parentKey: string): Promise<string> {
  const projectKey = parentKey.slice(0, parentKey.lastIndexOf("-"));
  const result = await session.callTool(PROJECTS_TOOL, {
    cloudId: siteId,
    action: "create",
    searchString: projectKey,
    maxResults: MAX_PROJECTS,
    expandIssueTypes: true,
  });
  if (result.isError) throw new AppError("UNAVAILABLE", "Could not list Jira projects");
  const name = parseSubtaskType(result.text, projectKey);
  if (!name) throw new AppError("VALIDATION", "You cannot add subtasks in that project");
  return name;
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

/**
 * Arguments are built field by field, so nothing else in a request can reach the tool. Every text
 * field has its @Brain defused: Brain writes as the person, so its text must never read as a request.
 */
function toolCall(request: WriteRequest, subtaskTypeName = ""): Pick<WriteDraft, "toolName" | "args"> {
  const text = defuseMentions;
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
          summary: text(request.summary),
          ...(request.description ? { description: text(request.description) } : {}),
          contentFormat: "markdown",
        },
      };
    case "update_issue": {
      const fields = {
        ...(request.summary ? { summary: text(request.summary) } : {}),
        ...(request.description ? { description: text(request.description) } : {}),
      };
      if (Object.keys(fields).length === 0) throw new AppError("VALIDATION", "Nothing to change");
      return {
        toolName: EDIT_TOOL,
        args: { cloudId, issueIdOrKey: requireIssueKey(request.issueKey), fields, contentFormat: "markdown" },
      };
    }
    case "create_subtask":
      return {
        toolName: CREATE_TOOL,
        args: {
          cloudId,
          projectKey: request.parentKey.slice(0, request.parentKey.lastIndexOf("-")),
          issueTypeName: subtaskTypeName,
          summary: text(request.summary),
          parent: request.parentKey,
          ...(request.description ? { description: text(request.description) } : {}),
          contentFormat: "markdown",
        },
      };
    case "add_comment":
      // commentId is never sent: with it, this tool would overwrite an existing comment.
      return {
        toolName: COMMENT_TOOL,
        args: {
          cloudId,
          issueIdOrKey: requireIssueKey(request.issueKey),
          commentBody: text(request.body),
          contentFormat: "markdown",
        },
      };
  }
}

/** The fields an edit sets, if every one of them can be put back. */
function editedFields(draft: WriteDraft): string[] | null {
  if (draft.toolName !== EDIT_TOOL || !isObj(draft.args.fields)) return null;
  const keys = Object.keys(draft.args.fields);
  return keys.length > 0 && keys.every((key) => UNDOABLE_FIELDS.has(key)) ? keys : null;
}

/**
 * The fields as Jira holds them, in its own document format so formatting survives a round trip.
 * Anything unexpected gives null: the change can still be made, only not undone.
 */
export function parseIssueState(text: string, keys: readonly string[]): Record<string, unknown> | null {
  if (text.length > MAX_STATE_BYTES) return null;
  const data = parseJson(text);
  const fields = isObj(data) && isObj(data.fields) ? data.fields : null;
  if (!fields) return null;
  const state: Record<string, unknown> = {};
  for (const key of keys) {
    const value = fields[key] ?? null;
    if (key === "summary" && typeof value !== "string") return null;
    if (key === "description" && value !== null && !(isObj(value) && value.type === "doc")) return null;
    state[key] = value;
  }
  return state;
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
        const result = await session.callTool(PROJECTS_TOOL, {
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
    if (request.action === "create_subtask") requireIssueKey(request.parentKey);
    else toolCall(request);
    const site = (await writableSites(session)).find((s) => s.id === request.siteId);
    if (!site) throw new AppError("VALIDATION", "You cannot make changes on that Jira site");
    // Looked up only on a site the person can write to, so no other cloud id is ever sent.
    const typeName = request.action === "create_subtask" ? await subtaskType(session, site.id, request.parentKey) : "";
    return { action: request.action, siteOrigin: site.origin, ...toolCall(request, typeName) };
  },

  /** The link comes from the trusted site origin; only a well-formed key is taken from the result. */
  outcome(draft, resultText): WriteOutcome {
    const data = parseJson(resultText);
    const key = draft.toolName === CREATE_TOOL ? (isObj(data) ? data.key : null) : draft.args.issueIdOrKey;
    if (typeof key !== "string" || !ISSUE_KEY.test(key)) return { externalId: null, url: null };
    return { externalId: key, url: `${draft.siteOrigin}/browse/${key}` };
  },

  /** Only edits can be undone: undoing a new issue or comment would mean deleting it, which stays disabled. */
  async readState(session, draft) {
    const keys = editedFields(draft);
    if (!keys) return null;
    const result = await session.callTool(ISSUE_TOOL, {
      cloudId: draft.args.cloudId,
      issueIdOrKey: draft.args.issueIdOrKey,
      fields: keys,
      responseContentFormat: "adf",
    });
    if (result.isError) throw new AppError("UNAVAILABLE", "Could not read the issue before changing it");
    return parseIssueState(result.text, keys);
  },

  /** Puts back exactly what was there, on the same site and issue. A null clears a field that was empty. */
  undoDraft(draft, before) {
    const keys = editedFields(draft);
    if (!keys || !keys.every((key) => key in before)) throw new AppError("VALIDATION", "This change cannot be undone");
    const fields = Object.fromEntries(keys.map((key) => [key, before[key]]));
    return {
      action: "undo_update",
      toolName: EDIT_TOOL,
      args: { cloudId: draft.args.cloudId, issueIdOrKey: draft.args.issueIdOrKey, fields, contentFormat: "adf" },
      siteOrigin: draft.siteOrigin,
    };
  },
};
