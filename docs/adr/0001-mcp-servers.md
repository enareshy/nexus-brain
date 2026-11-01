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
5. **Text queries are reduced to plain keywords, matched with OR.** Operators are stripped so user input cannot change JQL/CQL meaning or cause syntax errors. A live test showed a `text ~` phrase of a whole question ("What is the project about") returns nothing while its keyword ("project") returns results, so stop words are removed (English only for now) and each keyword gets its own literal. OR matching favours recall; ranking quality still needs measuring with a golden set.

### Observed behaviour
| Item | Result |
|---|---|
| Sites | Array of `{ id, url, name, scopes[], avatarUrl }`, one entry per product |
| CQL result | `results[].{ content.id, title, excerpt, url (relative to /wiki), lastModified }`; `@@@hl@@@` markers in text |
| JQL with no bound (`order by updated DESC`) | Rejected with an error; our queries always include `text ~` |
| Latency | connect 0.4-1 s, tools/list 0.2 s, sites 0.8-1.2 s, JQL/CQL 1.1-2.1 s; end-to-end search 2-3.4 s |
| Tool annotations | Read tools have `readOnlyHint: true`; write tools have `destructiveHint: false`. No delete tools are listed |

### Speed work (measured live, 2026-11-01)
Reused MCP sessions per user (60 s idle), per-user site list cache (5 min) and per-user search cache (60 s, non-empty only). Document reads stay uncached because they re-check access.

| Step | Before | After |
|---|---|---|
| Search, cold | 2-3.4 s | 3.9 s (includes connect) |
| New search, warm session | same as cold | 2.0 s |
| Repeat search | same as cold | 26 ms |
| First answer text, after searching | 5.7 s | 3.5 s |
| First answer text, new question, warm session | 5.7 s | 3.8 s |

The 2.5 s first-text target is still not met: about 1.6 s is document reads and 1.1-1.9 s is the model. One run each on a small site, so treat these as indicative. Search results can be up to 60 s stale.

Isolation rules for this code: every cache and pool key starts with tenant, user and server; reconnecting takes the same per-user lock as session work, so a request on the old account cannot refill the caches afterwards (a mutation-checked integration test covers this); needing re-auth, disconnecting and connecting all clear that user's entries. Known gaps: one heavy user can push out others' cache entries (shared size bound), audit rows do not mark cached results, and caches and the pool are per API instance.

### Write path (FR-WR-01..05, FR-WS-J04)
Only `createJiraIssue` and `editJiraIssue` (write) and `addCommentToJiraIssue` (external-effect) can be called. Everything else, including transitions, worklogs, links and Confluence writes, is unknown to the manifest and so treated as destructive. `editJiraIssue` is limited to summary and description; `commentId` is never sent, because it would overwrite an existing comment.

How a write runs: the request names an action, never a tool, and the arguments are built field by field and stored unchanged (the app role has no UPDATE on those columns). Approval sends back the hash of the arguments shown. A single per-user-locked transaction checks the cap and moves the row from pending to executing, so a replay cannot write twice. The call runs once on a new session with no retry. A failure before sending leaves the change open; a failure after sending is recorded as `unknown` and is never retried, because Jira has no idempotency key here.

Known gaps: no undo or before-state (FR-WR-06, P1); no tenant-wide write cap, because RLS limits these rows to their owner; the per-tenant admin switch for destructive tools (FR-WR-03) does not exist, so they are simply unavailable; the card has no "sources read" list because only people draft changes so far, and it needs one when the model starts drafting; stuck rows are finalised when their owner next lists changes, not by a background job.

### Not verified
- **Jira descriptions:** the search shape is now confirmed live on a real issue (`issues[].key`, `fields.summary`, `fields.updated`), and `createJiraIssue` returned a usable `key`. Reading `fields.description` for answers is still untested, because the test issue has no description.
- **`editJiraIssue` and `addCommentToJiraIssue`:** tested against the mock server only. `createJiraIssue` was run once live through the approval flow on 2026-11-01.
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
