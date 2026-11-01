# ADR 0001: MCP servers and verified behaviour

Status: accepted for Atlassian (2026-11-01). Other servers are unverified.
Raw tool list: [`0001-atlassian-tools.json`](0001-atlassian-tools.json) (32 tools, captured from the live server).

## Atlassian (`https://mcp.atlassian.com/v1/mcp`)

### Connection (verified live)
- Dynamic Client Registration, authorization code + PKCE S256 and refresh all work via SDK 1.32.2.
- The HTTP loopback redirect `http://127.0.0.1:3001/oauth/callback` was accepted.
- Consent requires an account with a site that has both Jira and Confluence. Otherwise Atlassian shows "Access denied" before redirecting back. We request no explicit scopes, so Atlassian applies its defaults; whether a Jira-only grant is possible is untested.

### Decisions
1. **Do not use the `search` tool.** Its description says each call "may consume up to 10 Rovo Credits" and fails when credits run out. Use `searchJiraIssuesUsingJql` and `searchConfluenceUsingCql`, whose descriptions mention no credits (not independently confirmed with Atlassian billing).
2. **Dedicated parser, not the generic extractor.** Confluence URLs are relative, and results embed people data (including email) that must not be copied.
3. **Citations are built from the site URL** in `getAccessibleAtlassianResources` (https `*.atlassian.net` only), never from result payloads. Jira `self` links point at `api.atlassian.com`, so they are not browsable anyway.
4. **Merge sites by id.** The server lists one entry per product for the same site. Use each entry's scopes to decide which product to search.
5. **Text queries are reduced to plain words.** Operators are stripped so user input cannot change JQL/CQL meaning or cause syntax errors.

### Observed behaviour
| Item | Result |
|---|---|
| Sites | Array of `{ id, url, name, scopes[], avatarUrl }`, one entry per product |
| CQL result | `results[].{ content.id, title, excerpt, url (relative to /wiki), lastModified }`; `@@@hl@@@` markers in text |
| JQL with no bound (`order by updated DESC`) | Rejected with an error; our queries always include `text ~` |
| Latency | connect 0.4-1 s, tools/list 0.2 s, sites 0.8-1.2 s, JQL/CQL 1.1-2.1 s; end-to-end search 2-3.4 s |
| Tool annotations | Read tools have `readOnlyHint: true`; write tools have `destructiveHint: false`. No delete tools are listed |

### Not verified
- **Jira issue result shape:** the connected site has a project but no visible issues. `parseJiraIssues` follows the documented Jira REST format (`key`, `fields.summary`). Create an issue and re-test.
- Rate limits (responses include `x-ratelimit-*` headers; values not yet recorded).
- Accounts with several sites.

### Known gaps (from security review, 2026-11-01)
- A partial failure (Jira fails, Confluence succeeds) reports the source as OK; add a partial flag so the UI can say so.
- Only the first 3 sites of an account are searched.
- If the real Jira shape differs, hits are dropped silently; add a "parsed 0 of N" log when verifying.
- A key search for a non-existent issue makes JQL return an error; Confluence results still return.
- Titles and snippets are attacker-authorable. The web UI renders them as text; the LLM prompt builder must wrap them as delimited untrusted data when it is built.

### Consequences
- The 3 s fan-out target in FR-MCP-05 is not met with a fresh session per request. The budget is 10 s for now; reused sessions and cached sites are the way to reach it.
- `editJiraIssue`, `transitionJiraIssue` and similar report `destructiveHint: false`, but our policy (FR-WR) still requires approval for all writes, and comments are `external-effect`.

## Other servers
Google Drive, Gmail, Slack, GitHub, Microsoft 365 and Teams: not verified. Do the same capture before writing each adapter. Read every tool description for cost or side effects before the first call.
