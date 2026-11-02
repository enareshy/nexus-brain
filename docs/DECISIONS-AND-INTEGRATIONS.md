# Decisions and integration catalog (answers to open questions)

Date: 2026-10-31. Method: direct HTTP probes of vendor MCP endpoints and Anthropic's published data-retention page. Web search was unavailable, so nothing here comes from vendor marketing or third-party summaries.

**How to read "Probe result".** An unauthenticated request returning `401` with a `WWW-Authenticate: Bearer` header (many also advertise `resource_metadata`, the OAuth protected-resource metadata of RFC 9728) proves only that **a live, OAuth-protected MCP endpoint exists at that URL**. It does NOT prove the tool list, that a search tool exists, that write tools exist, or the vendor's support status. Phase 1 task 1 must run `tools/list` per server after a real login and record the result in `docs/adr/0001-mcp-servers.md`.

---
## 1. Work-system products that expose a remote MCP server

| Product | Endpoint probed | Probe result | Notes |
|---|---|---|---|
| Jira + Confluence (Atlassian) | `https://mcp.atlassian.com/v1/mcp` | 401, OAuth bearer | Atlassian's remote MCP; covers Jira/Confluence. Trello not confirmed (see below). |
| Asana | `https://mcp.asana.com/v2/mcp` | 401, advertises `resource_metadata` | Version path `v2`: older `/sse` clients may be retired; use the Streamable HTTP URL. |
| Notion | `https://mcp.notion.com/mcp` (also `/sse`) | 401 on both | |
| Linear | `https://mcp.linear.app/mcp` | 401, advertises `resource_metadata` | |
| monday.com | `https://mcp.monday.com/mcp` | 401, advertises `resource_metadata` | |
| ClickUp | `https://mcp.clickup.com/mcp` | 401 | OAuth only, acts as the signed-in user (ClickUp developer docs). |
| Airtable | `https://mcp.airtable.com/mcp` | 401 | |
| Smartsheet | `https://mcp.smartsheet.com/` | 401 | |
| Basecamp | `https://mcp.basecamp.com/mcp` | 401, advertises `resource_metadata` | |
| Todoist | `https://ai.todoist.net/mcp` | 401 | Personal tasks more than team work management. |

Not confirmed (do not plan on these until verified): **Trello** (`mcp.trello.com/mcp` returned 403), **Wrike** (404 at the path tried), **Zoho Projects/Zoho** (400/404 at paths tried), **Microsoft Planner/To Do** (not probed). A failed probe means "wrong URL or blocked for bots", not "no MCP server".

**Recommendation (not verified fact).** The product is not yet chosen, so build a pluggable `WorkSystemAdapter` over the generic MCP client and ship **Atlassian (Jira/Confluence) as the reference implementation**, then Asana, Notion, Linear, monday.com and ClickUp as config-only adapters (tool-name mappings for search, get, create, update, comment). Choose the first one by what the pilot customers actually use (see §5).

### 1a. DECIDED: first work-system adapter = Atlassian Jira (+ Confluence)
Decision (user, 2026-10-31). Reference implementation of `WorkSystemAdapter` targets `https://mcp.atlassian.com/v1/mcp`.

Auth facts from the live authorization-server metadata (`https://mcp.atlassian.com/.well-known/oauth-authorization-server`, fetched 2026-10-31):
- Endpoints: `/v1/authorize`, `/v1/token`, `/v1/register` (Dynamic Client Registration is offered), revocation at `/v1/token`.
- Grants: `authorization_code` and `refresh_token`; PKCE `S256` supported (and `plain`); token auth methods `client_secret_basic`, `client_secret_post`, `none` (public client possible).
- Not found: `/.well-known/oauth-protected-resource` returned 404 on the host and at the `/v1/mcp` path, and the 401 carried no `resource_metadata` pointer. **Our MCP client must therefore fall back to host-level authorization-server discovery** when RFC 9728 metadata is missing.
- No Client ID Metadata Document support advertised. Since the 2026-07-28 MCP spec deprecates DCR, register an Atlassian OAuth app manually if DCR is later removed; until then DCR works for development. Record the choice in ADR 0001.

Still to verify in Phase 1 with a real Atlassian login (not checked here): the exact `tools/list` (Jira search, get issue, create/update issue, add comment, transitions; Confluence search/get/create page), which tools carry read-only/destructive annotations, scopes requested, rate limits, whether site/cloud-ID selection is part of the flow, and whether Jira Server/Data Center is out of scope (this endpoint targets Atlassian Cloud).

Write classification starting point (confirm against the real tool list): search/get = `read`; create issue, update fields, add comment, transition = `write` (comment is also visible to others, so treat as `external-effect`); delete issue/page, bulk edits = `destructive` (disabled by default).

## 2. Source connectors the user listed

| Source | Endpoint probed | Probe result | Confidence |
|---|---|---|---|
| GitHub | `https://api.githubcopilot.com/mcp/` | 401, bearer | Live. |
| Slack | `https://mcp.slack.com/mcp` | 401, advertises `resource_metadata` | Live. |
| Google Drive | `https://drivemcp.googleapis.com/mcp/v1` | 400 to a malformed test request (endpoint responds; auth not exercised) | Likely live; verify with a real OAuth client. |
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1` | 400 to a malformed test request | Likely live; verify. |
| Microsoft 365 (SharePoint/OneDrive/Outlook) + Teams | not probed | unknown | **Unverified.** Find Microsoft's current official MCP endpoints and tenant-admin consent requirements in Phase 1. |

## 3. "Each user will link the MCP server" — what that requires

Decision: connections are **per user**. Each user signs in to each source or work system with their own account; our app never uses a shared service account to read user data.

Requirements that follow (all added to REQUIREMENTS.md):
1. **Connections UI**: user clicks "Connect Jira" and goes through the vendor's OAuth consent; shows status, scopes granted, last used, Disconnect.
2. **OAuth client registration.** The MCP spec revision 2026-07-28 deprecates Dynamic Client Registration and uses Client ID Metadata Documents (per the earlier research of the spec changelog). So per vendor we either (a) publish a client metadata document at an HTTPS URL we control and use it as `client_id`, or (b) pre-register an OAuth app by hand with that vendor (Google, Slack, GitHub and Microsoft typically require this anyway). Plan for (b) as the default, (a) where servers support it. Capture each vendor's approach in the ADR.
3. **Token vault**: access/refresh tokens encrypted with envelope encryption (AWS KMS, per-tenant data key), scoped to (tenant, user, server), refreshed proactively, revoked on Disconnect, on user removal, and on repeated 401. Tokens never appear in logs, prompts, traces or the browser.
4. **Audience validation / no token passthrough**: a token minted for server A is only ever sent to server A (MCP security best practices).
5. **Custom server URLs**: if users may paste arbitrary MCP URLs, that is an SSRF and data-exfiltration risk. Default policy: **admin-allow-listed servers only** (FR-MCP-02); user-added URLs disabled unless an admin enables them per tenant. Block private IP ranges and non-HTTPS.
   - As built (2026-11-02): users cannot add URLs at all. Two allow-lists apply. The deployment's `MCP_SERVERS` lists the vetted servers this build can reach, and each company's admin can turn any of them off for everyone. A server the admin has not touched is **allowed**, so existing companies kept working. This departs from a strict default-deny; flip it to default-off for new companies before onboarding customers who expect that.
6. **Org-level consent**: Microsoft 365 and some Slack/Google scopes need tenant-admin approval; add an admin "approve integration" step and document it for pilot customers.

## 4. Write access (decided: yes, in v1)

Write actions are in scope. They are the highest-risk feature in the product, so v1 ships them behind a policy engine, not as raw tool access.

| Rule | Detail |
|---|---|
| Classify every tool | `read`, `write`, `external-effect` (sends something outside: Slack post, email send, issue comment visible to others), `destructive` (delete, close, overwrite). Source: MCP tool annotations (`readOnlyHint`, `destructiveHint`) where the server provides them, overridden by our own per-server manifest. Unknown tool = treated as destructive. |
| Default approval | `read`: none. `write`: user approval card showing server, tool, exact arguments and the sources the model read. `external-effect`: always approval, never auto. `destructive`: **disabled by default**; admin must enable per tenant, and approval still required. |
| Untrusted-content rule | If the run has read content from any external source (documents, mail, messages), write tools require approval even if the user set "auto", because the content may be an injection. |
| Exact-args binding | Approval binds to the exact arguments shown; any change after approval invalidates it. |
| Idempotency and audit | Every write has an idempotency key; audit row stores user, agent run, server, tool, args hash, redacted args, approver, result, timestamps. |
| Rate and cost caps | Per-user and per-tenant write caps per hour; step and cost caps per run (FR-AGT-06). |
| Gmail/Slack specifics | Gmail: create **draft** first, not send, in v1. Slack: post only to channels the user selected; no DMs to third parties without approval. |
| Reversibility | Prefer tools with undo (status changes, edits). Record before-state so the UI can offer "undo" where the vendor API allows. |

## 5. LLM vendors and zero-retention suggestions

**Facts from Anthropic's API data-retention page (platform.claude.com, fetched 2026-10-31):**
- Zero data retention (ZDR) means Anthropic does not store prompts or responses at rest after the response is returned. **It is enabled per organization by contacting Anthropic sales/your account team**; each new organization needs separate enablement.
- Without ZDR, conversation content is not retained by default except for "Covered Models" (Claude Fable 5, Fable 5.1, Mythos 5, Mythos 5.1), which require **30-day retention and are not available under ZDR** unless Anthropic authorizes it.
- Retained data is not used for training without express permission. Features differ in eligibility (for example code execution is not ZDR-eligible), and the API rejects non-eligible features for ZDR/HIPAA orgs.
- CORS is not supported for ZDR orgs, so browser calls must go through our backend (already the design).
- HIPAA-ready access is available with a BAA, enforced per organization.
- Claude Platform on AWS and Claude on Google Cloud follow the same retention policy; ZDR is available on request.

**What I could not verify:** whether `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-opus-5-5` are ZDR-eligible in your contract. The page names only the Fable/Mythos models as Covered. Confirm in writing with your account team before promising ZDR to a pilot customer.

**Suggested setup (recommendation):**
1. **Anthropic Commercial organization (Claude API), two workspaces/orgs**: `dev` (synthetic data only, no ZDR needed) and `prod` (ZDR enabled by account team). Because ZDR is per org, plan prod as its own organization.
2. **Models**: default to `claude-sonnet-5-5` (standard), `claude-haiku-5-5` (fast), `claude-opus-5-5` (premium). **Do not use Fable/Mythos models for ZDR tenants** (they force 30-day retention). Keep model IDs in config.
3. **Hosting path option**: because the platform runs on AWS, evaluate Claude via Amazon Bedrock to keep data inside your AWS account and one DPA. Compare against the direct API on ZDR terms, feature availability, regions and cost; not verified here.
4. **Embeddings and reranking**: Anthropic does not provide an embeddings model. Pick one vendor with a written no-training/zero-retention commitment: shortlist Voyage, Cohere (also rerank) or OpenAI, or an AWS-hosted option via Bedrock. Terms for these were **not** checked; treat as a Phase 1 procurement task and decide by eval plus contract.
5. **Second LLM vendor** (fallback, FR-LLM-04): only add if its ZDR/no-training terms match; otherwise fall back to a second Anthropic model.
6. **Keys you need on day one**: Anthropic API key (dev), embeddings key, rerank key, OAuth apps for Google, Slack, GitHub, Microsoft and the chosen work-system vendor, and an AWS account with KMS. Store in AWS Secrets Manager; never in git.
7. **Customer-facing documents to prepare**: subprocessor list (Anthropic, embeddings vendor, AWS), DPA template, data-flow diagram, retention statement.

## 6. Pilot customers: what to find out (you said you need more details)

Collect these before Phase 1 ends; they decide connectors, scopes and compliance work:
1. Company size, industry, countries of users and data (any EU/UK users trigger GDPR obligations even if hosting is US).
2. Which work system, chat, mail, file store and code host they use; which of the listed MCP servers they will actually connect.
3. Identity provider (Okta, Entra, Google) and whether they need SSO/SCIM at pilot.
4. Admin consent: can their IT approve Microsoft 365/Slack/Google OAuth apps? Typical lead time?
5. Compliance asks: SOC 2 report, DPA, security questionnaire, pen-test summary, ISO 27001, HIPAA/BAA, data residency, retention period, right-to-delete.
6. Sensitive data: HR, legal, health, financial content that must be excluded from indexing or from LLM calls.
7. Write-action appetite: which actions may the assistant take, and who must approve.
8. Success metrics and pilot length.

**Default compliance posture until answered (recommendation):** no SOC 2 report yet (state this honestly), signed DPA, subprocessor list, ZDR on prod, encryption at rest and in transit, audit log, tenant data-delete on request, and a SOC 2 Type I readiness plan in Phase 5.
