import { createSchemaSearchAdapter } from "./schema-search.js";
import type { SearchAdapter } from "./types.js";

/** The local mock server used in tests and development. */
export const mockSearch: SearchAdapter = createSchemaSearchAdapter({
  serverId: "mock",
  searchTools: ["search_issues"],
  citationHosts: ["acme.example"],
});
