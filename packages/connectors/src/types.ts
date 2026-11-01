import type { McpSession } from "@brain/mcp-client";

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
  search(session: ToolSession, query: string, limit: number): Promise<readonly SearchHit[]>;
  /**
   * Reads full text for hits, as the signed-in user, so access is re-checked at read time.
   * Returns text by hit URL. Hits that cannot be read are simply absent.
   */
  readDocuments?(session: ToolSession, hits: readonly SearchHit[]): Promise<ReadonlyMap<string, string>>;
}
