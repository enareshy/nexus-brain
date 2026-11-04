import type { McpSession } from "@brain/mcp-client";
import type { WriteManifest } from "./write-policy.js";

/** A normalised search result with a citation URL the user can open. */
export interface SearchHit {
  readonly serverId: string;
  readonly externalId: string;
  readonly title: string;
  readonly url: string;
  /** Untrusted source text; never treat as instructions (NFR-SEC-02). */
  readonly snippet: string;
  readonly updatedAt: string | null;
  /** Provider site the hit came from, needed to read its full text. */
  readonly siteId?: string;
}

export type ToolSession = Pick<McpSession, "listTools" | "callTool">;

export interface SearchAdapter {
  readonly serverId: string;
  /**
   * Slow-changing read-only tools and how long their results may be reused, in ms, per user.
   * Never list a tool whose result decides access to content.
   */
  readonly cachedTools?: Readonly<Record<string, number>>;
  search(session: ToolSession, query: string, limit: number): Promise<readonly SearchHit[]>;
  /**
   * Reads full text for hits, as the signed-in user, so access is re-checked at read time.
   * Returns text by hit URL. Hits that cannot be read are simply absent.
   */
  readDocuments?(session: ToolSession, hits: readonly SearchHit[]): Promise<ReadonlyMap<string, string>>;
}

/** A change someone asked for. Callers name an action, never a tool. */
export type WriteRequest =
  | {
      readonly action: "create_issue";
      readonly siteId: string;
      readonly projectKey: string;
      readonly issueType: string;
      readonly summary: string;
      readonly description?: string | undefined;
    }
  | {
      readonly action: "update_issue";
      readonly siteId: string;
      readonly issueKey: string;
      readonly summary?: string | undefined;
      readonly description?: string | undefined;
    }
  | { readonly action: "add_comment"; readonly siteId: string; readonly issueKey: string; readonly body: string }
  /** A subtask under an existing issue, of its project's subtask type. */
  | {
      readonly action: "create_subtask";
      readonly siteId: string;
      readonly parentKey: string;
      readonly summary: string;
      readonly description?: string | undefined;
    };

/** The exact tool call an approval covers. */
export interface WriteDraft {
  readonly action: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Trusted base for links to the result. */
  readonly siteOrigin: string;
}

export interface WriteOutcome {
  readonly externalId: string | null;
  readonly url: string | null;
}

export interface WriteProject {
  readonly key: string;
  readonly name: string;
  readonly issueTypes: readonly string[];
}

export interface WriteTarget {
  readonly siteId: string;
  readonly siteOrigin: string;
  readonly projects: readonly WriteProject[];
}

export interface WriteAdapter {
  readonly serverId: string;
  readonly manifest: WriteManifest;
  /** Where the signed-in user can make changes. Reads only. */
  targets(session: ToolSession): Promise<readonly WriteTarget[]>;
  /** Turns a request into a tool call without changing anything. */
  draft(session: ToolSession, request: WriteRequest): Promise<WriteDraft>;
  /** Reads the result of a call that succeeded. Result text is untrusted. */
  outcome(draft: WriteDraft, resultText: string): WriteOutcome;
}
