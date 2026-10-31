import { createSchemaSearchAdapter } from "./schema-search.js";
import type { SearchAdapter } from "./types.js";

/**
 * Atlassian (Jira + Confluence). PROVISIONAL tool names, from memory and NOT verified:
 * capture the real list with GET /connections/atlassian/tools after connecting and
 * record it in docs/adr/0001-mcp-servers.md, then trim these candidates.
 * Unknown names are harmless: the adapter only uses tools the server actually lists.
 */
export const atlassianSearch: SearchAdapter = createSchemaSearchAdapter({
  serverId: "atlassian",
  searchTools: ["search", "searchJiraIssuesUsingJql", "searchConfluenceUsingCql"],
  resourceTools: ["getAccessibleAtlassianResources"],
  citationHosts: ["*.atlassian.net"],
});

/** The local mock server used in tests and development. */
export const mockSearch: SearchAdapter = createSchemaSearchAdapter({
  serverId: "mock",
  searchTools: ["search_issues"],
  citationHosts: ["acme.example"],
});
