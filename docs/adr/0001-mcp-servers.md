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
Reused MCP sessions per user (60 s idle) and a per-user site list cache (5 min). A per-user search cache (60 s) was also measured below, then removed on 2026-11-02 (FR-RET-03): the leak suite showed a document with removed access still reaching the model, and a revoked account still getting results. Every search now asks the service with the user's token, so the "repeat search" row below no longer applies and a repeat costs about the same as a new search.

| Step | Before | After |
|---|---|---|
| Search, cold | 2-3.4 s | 3.9 s (includes connect) |
| New search, warm session | same as cold | 2.0 s |
| Repeat search | same as cold | 26 ms |
| First answer text, after searching | 5.7 s | 3.5 s |
| First answer text, new question, warm session | 5.7 s | 3.8 s |

The 2.5 s first-text target is still not met: about 1.6 s is document reads and 1.1-1.9 s is the model. One run each on a small site, so treat these as indicative.

Isolation rules for this code: every cache and pool key starts with tenant, user and server; reconnecting takes the same per-user lock as session work, so a request on the old account cannot refill the site cache or session pool afterwards (a mutation-checked integration test covers this); needing re-auth, disconnecting and connecting all clear that user's entries. Known gaps: one heavy user can push out others' cache entries (shared size bound), audit rows do not mark cached results, and caches and the pool are per API instance.

### Write path (FR-WR-01..05, FR-WS-J04)
Only `createJiraIssue` and `editJiraIssue` (write) and `addCommentToJiraIssue` (external-effect) can be called. Everything else, including transitions, worklogs, links and Confluence writes, is unknown to the manifest and so treated as destructive. `editJiraIssue` is limited to summary and description; `commentId` is never sent, because it would overwrite an existing comment.

How a write runs: the request names an action, never a tool, and the arguments are built field by field and stored unchanged (the app role has no UPDATE on those columns). Approval sends back the hash of the arguments shown. A single per-user-locked transaction checks the cap and moves the row from pending to executing, so a replay cannot write twice. The call runs once on a new session with no retry. A failure before sending leaves the change open; a failure after sending is recorded as `unknown` and is never retried, because Jira has no idempotency key here.

Undo (FR-WR-06): before an approved issue edit is sent, Brain reads the fields it changes (summary, description, in Jira's own document format) and saves them, and reads them again once it succeeds. If the first read fails, nothing is sent and the approval stays open. "Undo" on the Changes page proposes setting them back, which needs approval like any change and is not sent if the fields were edited again since. New issues, subtasks and comments cannot be undone, as that would need delete tools, which stay disabled.

Known gaps: undo covers issue edits only; no tenant-wide write cap, because RLS limits these rows to their owner; the per-tenant admin switch for destructive tools (FR-WR-03) does not exist, so they are simply unavailable; the card has no "sources read" list because only people draft changes so far, and it needs one when the model starts drafting; stuck rows are finalised when their owner next lists changes, not by a background job.

### Not verified
- **Jira descriptions:** the search shape is now confirmed live on a real issue (`issues[].key`, `fields.summary`, `fields.updated`), and `createJiraIssue` returned a usable `key`. Reading `fields.description` for answers is still untested, because the test issue has no description.
- **`editJiraIssue` and `addCommentToJiraIssue`:** tested against the mock server only. `createJiraIssue` was run once live through the approval flow on 2026-11-01.
- **@Brain mentions** (`atlassian-mentions.ts`): `atlassianUserInfo` (`account_id`) and `getJiraIssue` with `fields: ["comment"]` (`fields.comment.comments[].{ id, author.accountId, updateAuthor.accountId, body, created }`, markdown body) follow Jira's REST format and the tool descriptions, not a live response. A different shape makes the mention agent find nothing rather than act on the wrong comment.
- **Subtasks** (`create_subtask` in `atlassian-writes.ts`): `createJiraIssue` with `parent` and the project's subtask type, found through `getVisibleJiraProjects` (`searchString` set to the project key, `issueTypes[].subtask`), follows the tool descriptions and is tested on synthetic data only.
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

## GitHub (`https://api.githubcopilot.com/mcp/readonly`)
Raw tool list: [`0001-github-tools.json`](0001-github-tools.json) (28 tools, all `readOnlyHint: true`, captured from the live server).

### Connection (verified live, 2026-11-01)
- GitHub's authorization server has no registration endpoint, so this needs a GitHub App created in advance. Its client id and secret come from `GITHUB_MCP_CLIENT_ID` and `GITHUB_MCP_CLIENT_SECRET`, and are never stored per user. The secret is sent in the request body, because GitHub's metadata names no method and the SDK would otherwise use HTTP Basic.
- `/mcp/readonly` is used so the server itself refuses writes, and the app has read-only permissions. A token reaches only repositories where the app is installed.
- There is no revocation endpoint, so disconnecting tells the user to revoke access in GitHub.

### Decisions
1. **Search only the user's own repositories.** Without a scope, GitHub searches every public repository, which is noisy and brings in strangers' text.
2. **Pull requests use `user:<login>` with keywords joined by OR**, at most six keywords because GitHub allows five operators. Questions lose all punctuation first, and keywords are lowercased, so they cannot add qualifiers or operators.
3. **Issues are searched per repository**, in the three most recently updated repositories: `search_issues` takes natural language, returned an error with a `user:` qualifier, and returned nothing with no scope.
4. **Links must be `https://github.com/<owner>/<repo>/(issues|pull)/<n>`.** Anything else is dropped.

### Not verified, and known gaps
- Reliability (2026-11-01): a direct search took about 3 s including connecting. In the app, one search hit the 10 s budget just after a full test run; the cause is not proven. The budget also counts time waiting for the per-user lock, and identical searches arriving together wait for each other (seen at 4.5 s). In one of three direct runs, `search_issues` returned an error for two of three repositories; the reason was not captured, and the rest of the search still returned results.
- Issue result shape: the test repository has no issues, so it follows the pull request shape from the same search API.
- Code search returned nothing on the test repository, so it is left out. `get_file_contents` returned only 81 characters of text (not read, length only), and our client keeps only text parts, so reading files needs work too.
- Organisation repositories are not searched, which pilot customers will need.
- Only three repositories are searched for issues.
- Pull request descriptions are unread on the test pull request, which has none.

## Notion (`https://mcp.notion.com/mcp`)
Read from Notion's documentation and probed on 2026-11-10, not yet connected live. The protected resource metadata names `https://mcp.notion.com` as the authorization server; its metadata puts authorize, token, registration, revocation and introspection on `mcp.notion.com`, with PKCE (S256) and client registration without a secret (`token_endpoint_auth_method: none`), so no app is needed in advance and the outbound allow-list is just `mcp.notion.com`. An unauthenticated MCP request is refused with 401.
- Acts as the signed-in workspace member and sees only what they can; guests cannot connect at all. Enterprise policy can block MCP clients.
- Refresh tokens rotate on every refresh, and replaying one rotated out revokes the whole grant, so refreshes must never overlap: the shared connection lock covers this. Refresh tokens end 180 days after first sign-in, or after 30 days unused.
- Tools used: `notion-search` (arguments built from its own schema; content search only, never the user lookup) and `notion-fetch` (by page URL) to read the top pages' text, capped at 50,000 characters. The result shape of search is not documented, so pages are found by their `notion.so` links ending in a 32-character id; results on other hosts are dropped. Notion's write tools (create and update pages, comments, databases, files) are never called: writes go only through the approval policy, which knows none of them. `notion-connector-search` (Notion AI's search of other services) is not used, as Brain searches those itself as the person.
- Every tool call counts toward Notion's API request limits; a rate-limited call comes back as a tool error, which Brain reports as that service being unavailable for the search.
- Reading a page re-checks its link first, as summaries, drafts and Brain's own MCP server pass in links from callers: only a `notion.so` page link is sent to `notion-fetch`, rebuilt without port, query or fragment. Known gap, as for Slack: if search replies in formatted text rather than JSON, a `notion.so` link written inside a page the person can see becomes a citation and is read, so a planted public Notion page could reach the model as a document (always as untrusted text). In JSON, only a top-level `results` list counts.
- To check on first live connect: capture the tools (`apps/api/scripts/mcp-shape.ts`), confirm search results carry `notion.so` page links, and that fetch returns the page text.

## Other servers
All probed 2026-11-01. None has been connected live, so nothing below has run against a real account. Adapters exist for all three, tested on synthetic data: Drive and Gmail follow Google's published output schemas, and Slack finds hits by their message links because its tools are visible only when signed in. Slack's tool names come from memory and its docs, so if they differ it reports that no search tool was found. When a service first connects, capture its tools and check real results. Known gaps: if Slack returns formatted text, a message link pasted from another workspace can become a citation, and the snippet is the whole line, which may hold author names; JSON results use only the message's own permalink and text. A Gmail thread too large for the size cap loses its full text and falls back to its snippet.

- **Google Drive** (`drivemcp.googleapis.com/mcp/v1`) and **Gmail** (`gmailmcp.googleapis.com/mcp/v1`): no client registration, and they list tools without a token ([Drive](0001-google-drive-tools.json), [Gmail](0001-gmail-tools.json)). They use the `drive.readonly` and `gmail.readonly` scopes and share one company app. Google asks for app verification for wider use, which needs checking against its current rules. Gmail drafts (FR-WR-07) would need a wider scope, so they are not offered yet. Senders, recipients and file owners are not copied into hits.
- **Slack** (`mcp.slack.com/mcp`): no client registration; its docs say only Marketplace and internal apps may use MCP, with a client secret, and admins can approve clients. Scopes are limited to `search:read.public`, `search:read.private`, `channels:history` and `groups:history`, so no posting, direct or group messages. Not verified: whether those scopes are enough, and whether Slack accepts an http loopback redirect during development. It may need an https address.
- **Microsoft 365 and Teams: not added.** Microsoft's docs say available servers vary by tenant, region, rollout, licensing and administrator settings, describe workload servers such as Teams as a legacy experience, and point to Work IQ MCP (preview). `agent365.svc.cloud.microsoft/agents/servers/mcp_TeamsServer` and `mcp.svc.cloud.microsoft/enterprise` both answered 401 with OAuth metadata. Building this needs a Microsoft 365 tenant to test against. Do the same capture before writing each adapter. Read every tool description for cost or side effects before the first call.
