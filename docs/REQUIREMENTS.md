# Requirements: "Nexus Brain" — a ClickUp Brain²-style AI work assistant

Status: v1.0 draft. Priority: **P0** = MVP, **P1** = after MVP, **P2** = later.
Each requirement has an ID. Claude Code must reference IDs in commits, tests and PRs (e.g. `feat(FR-RET-03): ...`).

Assumptions (change here first, then in TECH-STACK.md):
- A1. The product is multi-tenant SaaS; one organisation = one tenant (workspace).
- A2. **(Decided)** An *existing product* is the system of record for tasks/docs (identity to be named, see §5 Q2); we do NOT build a first-party work system. All sources, including that product, are reached through **MCP servers** (Google Drive, Slack, Microsoft 365 + Teams, Gmail, GitHub, plus the existing product).
- A2a. **(Decided)** Hosting: single region, AWS US. Scale: pilot, under 20 tenants and under 1M chunks per tenant.
- A3. Source-system permissions are the source of truth. The index never grants access the source does not.
- A4. TypeScript end-to-end; AWS as target cloud; Anthropic Claude as the default LLM vendor, others pluggable.

---

## 1. Functional requirements

### 1.1 Tenancy, identity and access (FR-ID)
| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-ID-01 | P0 | Tenants, users, groups, roles (owner, admin, member, guest). | CRUD API + tests; guest cannot see member-only content. |
| FR-ID-02 | P0 | OIDC login (Keycloak locally, any OIDC IdP in prod). | Login via auth-code + PKCE; JWT carries `tenant_id`, `sub`. |
| FR-ID-03 | P0 | Postgres row-level security on every tenant-scoped table. | Test proves tenant A cannot read tenant B with a forged query. |
| FR-ID-04 | P1 | SCIM user/group provisioning. | Okta/Entra SCIM sync creates/removes users and groups. |
| FR-ID-05 | P1 | Per-user OAuth delegation to connectors (no shared service accounts). | Connector calls use the requesting user's token or a per-user mirrored ACL. |

### 1.2 Work system (FR-WS) — first-party data model
> **DEFERRED by decision:** an existing product is the system of record, reached via MCP. All FR-WS items below are now **P2** (build only if the existing product is later replaced). Priority cells below still show the original value; treat them as P2. Only FR-WS-04's idea survives: every ingested change is normalised into the canonical `DomainEvent`.

| ID | Pri | Requirement |
|---|---|---|
| FR-WS-01 | P0 | Hierarchy: Workspace > Space > Folder > List > Task (+ subtasks). |
| FR-WS-02 | P0 | Docs (rich text/markdown) and comments attached to any node. |
| FR-WS-03 | P0 | Per-node permissions (inherit from parent, override allowed). |
| FR-WS-04 | P0 | Emit an immutable domain event for every create/update/delete/permission change (outbox pattern). |
| FR-WS-05 | P1 | Chat channels and threads. |
| FR-WS-06 | P1 | Custom fields, including AI Fields (LLM-computed fields). |
| FR-WS-07 | P1 | Automations engine (trigger → condition → action) used by agents. |

### 1.3 Ingestion and connectors (FR-ING)
| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-ING-01 | P0 | Connector SDK: `listItems`, `getItem`, `listPrincipals`, `listPermissions`, `webhook`, `rateLimit`. | Two reference connectors pass the shared contract test suite. |
| FR-ING-02 | P0 | **MCP connector adapter**: wraps any MCP server behind the connector-sdk interface (tool mapping config: which tools list/search/get/permissions). | Contract suite passes against a mock MCP server and one real server. |
| FR-ING-03 | P0 | Connectors via MCP for: Google Drive, Slack, Microsoft 365 (SharePoint/OneDrive) + Teams, Gmail, GitHub, and the existing work-system product. Each runs in `mode: federated` (live search through MCP as the signed-in user) at MVP; `mode: indexed` (periodic crawl through MCP tools into our hybrid index) is optional per connector. | Per-user OAuth; federated search returns results the user can see; results merged and reranked with other sources. |
| FR-ING-04 | P0 | Normalise to canonical `Document` + `Chunk` + `AclPrincipal` schema. | Schema validated with Zod; invalid items go to a dead-letter queue. |
| FR-ING-05 | P0 | Idempotent, resumable sync jobs with checkpoints. | Kill worker mid-sync; resume without duplicates. |
| FR-ING-06 | P0 | Sync group membership and ACL changes independently of content. | ACL change reflected in retrieval within SLA (NFR-FRESH-02). |
| FR-ING-07 | P1 | More connectors: Gmail, OneDrive/SharePoint, Teams, GitHub, Notion, Salesforce. | Each passes contract suite. |
| FR-ING-08 | P1 | Federated (live-query) mode for sources that forbid copying. | Per-connector flag `mode: indexed | federated`. |
| FR-ING-09 | P1 | Deletion propagation (source delete → index delete ≤ SLA, incl. embeddings). | Verified by test; GDPR erase path. |

### 1.4 Retrieval and search (FR-RET)
| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-RET-01 | P0 | Hybrid retrieval: BM25 + vector kNN, fused with RRF. | Beats BM25-only baseline on golden set (recall@10). |
| FR-RET-02 | P0 | ACL filter applied **inside** the retrieval query (not post-filter only). | Red-team suite: 0 leaks. |
| FR-RET-03 | P0 | Re-verify top-k permissions against the source of record at fetch time. | Revoked-access doc never appears in an answer (test). |
| FR-RET-04 | P0 | Cross-encoder reranking of top-N. | Rerank improves nDCG@10 vs RRF alone. |
| FR-RET-05 | P0 | Cited answers: every claim links to chunk/doc IDs the user can open. | Answer JSON contains `citations[]`; uncited claims rejected by validator. |
| FR-RET-06 | P0 | Filters: source, space/folder, author, date, type. | Filter DSL + tests. |
| FR-RET-07 | P1 | Query understanding: intent classification, expansion, rewriting with chat history. | Measurable gain on eval set. |
| FR-RET-08 | P1 | Learned ranker using click/feedback signals. | Online A/B or offline replay shows gain. |
| FR-RET-09 | P1 | Work graph (entities/edges: person, project, doc, task) for boosting and personalisation. | Graph features improve eval metrics over FR-RET-01..04. |
| FR-RET-10 | P2 | Context compression for long contexts. | Token reduction with equal answer quality. |

### 1.5 Assistant (chat, Q&A) (FR-AST)
| ID | Pri | Requirement |
|---|---|---|
| FR-AST-01 | P0 | Chat UI + API with streaming responses (SSE) and citations. |
| FR-AST-02 | P0 | "Ask my workspace": RAG answer over everything the user can access. |
| FR-AST-03 | P0 | Conversation history per user (private; not visible to admins). |
| FR-AST-04 | P0 | Feedback (thumbs up/down + reason) stored for evaluation. |
| FR-AST-05 | P1 | `@Brain` mention in tasks/docs/comments. |
| FR-AST-06 | P1 | Summarise a task/doc/thread; draft content; generate subtasks. |
| FR-AST-07 | P1 | Persistent memory: per-user preferences and facts; user can view, edit, delete. |
| FR-AST-08 | P1 | Skills: reusable, named prompt+tool bundles, shareable within a tenant. |
| FR-AST-09 | P2 | Meeting notetaker, voice input, artifact generation (decks/dashboards). |

### 1.6 Agents (FR-AGT)
| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-AGT-01 | P1 | Agent runtime (LangGraph): stateful graphs, checkpointing, resumable runs. | Run survives worker restart. |
| FR-AGT-02 | P1 | Tool registry with least-privilege scopes per agent. | Agent cannot call a tool not in its manifest. |
| FR-AGT-03 | P1 | Agents run **as a user** (delegated identity); all actions audited. | Audit row per tool call: user, agent, args hash, result. |
| FR-AGT-04 | P1 | Human-in-the-loop approval for write/destructive tools (configurable: always/never/ask). | Pending-approval state, notify, approve/deny API. |
| FR-AGT-05 | P1 | Triggers: assigned, @mention, schedule, automation event. | Each trigger type has an integration test. |
| FR-AGT-06 | P1 | Step, token, time and cost caps per run. | Run aborts with clear status when cap hit. |
| FR-AGT-07 | P2 | Ambient agents (continuously monitor a scope and propose actions). |
| FR-AGT-08 | P2 | Self-improvement loop (skill suggestions from successful runs) — human-approved only. |

### 1.7 LLM gateway and model routing (FR-LLM)
| ID | Pri | Requirement |
|---|---|---|
| FR-LLM-01 | P0 | Single gateway interface (`generate`, `stream`, `embed`, `rerank`) hiding vendors. |
| FR-LLM-02 | P0 | Provider adapters: Anthropic (default), OpenAI, Google; config-driven model map. |
| FR-LLM-03 | P0 | Tiers: `fast` (cheap), `standard`, `premium`; router picks per task type; user may override. |
| FR-LLM-04 | P0 | Retries, timeouts, fallback to a second vendor, circuit breaker. |
| FR-LLM-05 | P0 | Prompt caching and response caching keyed by (tenant, user-permission-hash, prompt-hash). |
| FR-LLM-06 | P0 | Zero-retention / no-training vendor settings enforced and documented. |
| FR-LLM-07 | P1 | Per-tenant model allow-list and region pinning. |

### 1.8 MCP (FR-MCP)
| ID | Pri | Requirement |
|---|---|---|
| FR-MCP-01 | P1 | Own MCP **server** exposing search, get-item, create/update task, list hierarchy; OAuth 2.1 + PKCE; acts as the signed-in user. Target spec revision 2026-07-28 (stateless; no `initialize`; `ttlMs`/`cacheScope` on list results). |
| FR-MCP-02 | **P0** | MCP **client** (promoted: it is now the primary connector path). Connects to third-party MCP servers, admin-allow-listed per tenant; per-user OAuth token vault (encrypted); tool allow-list per server; read-only tools only at MVP; timeouts, retries, per-server rate limiting and circuit breaker; response size caps. |
| FR-MCP-05 | P0 | Federated retrieval orchestrator: fan out a query to selected MCP search tools in parallel (budget ≤ 3 s), normalise results to `Document`/`Chunk`, merge with indexed results via RRF + rerank, dedupe, cite with source URLs. |
| FR-MCP-06 | P0 | Treat all MCP tool output as untrusted data (NFR-SEC-02); strip/neutralise instruction-like content; never let it choose tools. |
| FR-MCP-03 | P1 | No token passthrough; audience-validated tokens; SSRF guard on metadata fetch; minimal scopes. |
| FR-MCP-04 | P1 | Per-plan MCP rate limits. |

### 1.8a Connections and write actions (FR-CON, FR-WR) — added after decisions 7 and 8
| ID | Pri | Requirement | Acceptance |
|---|---|---|---|
| FR-CON-01 | P0 | Per-user "Connections" UI: connect, status, scopes, last used, disconnect, for each allow-listed MCP server. | User A's connection is invisible and unusable to user B. |
| FR-CON-02 | P0 | Encrypted token vault (KMS envelope, per tenant), proactive refresh, revoke on disconnect/offboarding/repeated 401. | Tokens absent from logs, traces, prompts; revoked token stops access immediately. |
| FR-CON-03 | P0 | OAuth client registration per vendor: pre-registered app by default, Client ID Metadata Document where supported (DCR is deprecated in the 2026-07-28 spec). | Documented per server in ADR 0001. |
| FR-CON-04 | P1 | Tenant-admin integration approval step and admin allow-list; user-added URLs disabled by default; HTTPS only; block private IP ranges. | SSRF tests pass. |
| FR-WR-01 | P0 | Tool classification: read / write / external-effect / destructive from MCP annotations plus per-server manifest; unknown = destructive. | Unit tests per class. |
| FR-WR-02 | P0 | Approval cards for write and external-effect tools showing server, tool, exact arguments, and the sources read; approval binds to exact args. | Changing args after approval forces re-approval. |
| FR-WR-03 | P0 | Destructive tools disabled by default; per-tenant admin enable; approval still required. | Disabled tool never callable (test). |
| FR-WR-04 | P0 | If the run has read untrusted external content, writes always need approval regardless of user "auto" setting. | Injection red-team case blocked. |
| FR-WR-05 | P0 | Idempotency keys, audit row per write (user, run, server, tool, args hash, approver, result), per-user/tenant write rate caps. | Replay of the same key does not duplicate the write. |
| FR-WR-06 | P1 | Undo where the vendor supports it; before-state recorded. | Undo restores state in integration test. |
| FR-WR-07 | P0 | Gmail: draft only in v1 (no send). Slack: post only to user-selected channels. | Tests per connector. |

### 1.9 Metering, plans and credits (FR-MET)
| ID | Pri | Requirement |
|---|---|---|
| FR-MET-01 | P0 | Usage ledger: one append-only row per LLM/embedding/rerank call (tenant, user, feature, model, tokens in/out, cost). |
| FR-MET-02 | P1 | Plans with pooled monthly credits; chat on standard models not metered; agents/AI Fields metered. |
| FR-MET-03 | P1 | Budget enforcement (soft warn, hard stop) per tenant, optional per user. |
| FR-MET-04 | P1 | Top-ups and cost dashboard; reconcile ledger to vendor invoices monthly. |

### 1.10 Admin and governance (FR-ADM)
| ID | Pri | Requirement |
|---|---|---|
| FR-ADM-01 | P0 | Audit log of every retrieval (user, query hash, returned doc IDs) and every agent action. |
| FR-ADM-02 | P1 | Admin console: connectors, model allow-list, agent policies, usage. |
| FR-ADM-03 | P1 | Data retention settings, export, and tenant-level delete (GDPR). |
| FR-ADM-04 | P1 | Data-residency selection (US/EU/AU/SG) at tenant creation. |

---

## 2. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-SEC-01 | Security | **Zero cross-user and cross-tenant leakage** — release-blocking. |
| NFR-SEC-02 | Security | Retrieved text is untrusted: tools that write or send data require approval when the run has seen untrusted content. |
| NFR-SEC-03 | Security | Secrets only via env/secret manager; none in git; pre-commit secret scan. |
| NFR-SEC-04 | Security | OWASP ASVS L2 baseline; dependency audit in CI. |
| NFR-SEC-05 | Security | Egress allow-list for agent tool execution; SSRF protections. |
| NFR-SEC-06 | Security | Encryption in transit (TLS 1.2+) and at rest; per-tenant KMS key (P1). |
| NFR-PERF-01 | Performance | Search p95 ≤ 800 ms (no LLM); first token of answer p95 ≤ 2.5 s. |
| NFR-PERF-02 | Performance | Ingestion throughput ≥ 200 docs/s/worker on reference hardware. |
| NFR-FRESH-01 | Freshness | Native events searchable ≤ 60 s p95; external connectors ≤ 5 min p95. |
| NFR-FRESH-02 | Freshness | ACL/membership changes enforced ≤ 60 s p95 (native), ≤ 5 min (external). |
| NFR-AVAIL-01 | Reliability | 99.9% monthly for search/chat; graceful degradation: if LLM down → return search results only. |
| NFR-SCALE-01 | Scalability | Design target: 1,000 tenants, 10M chunks/tenant ceiling, horizontal scale for workers. |
| NFR-QUAL-01 | Quality | Golden eval set ≥ 300 queries by end of Phase 1; recall@10 ≥ 0.85; groundedness ≥ 0.95 (LLM-judge + spot human review). |
| NFR-QUAL-02 | Quality | Model/prompt changes gated by the eval suite in CI. |
| NFR-OBS-01 | Observability | OpenTelemetry traces across API → retrieval → LLM; LLM traces in Langfuse. |
| NFR-OBS-02 | Observability | Structured JSON logs with `tenant_id`, `user_id`, `request_id`; PII-safe. |
| NFR-COMP-01 | Compliance | SOC 2 Type I → II readiness (P2); GDPR erase/export (P1). |
| NFR-COST-01 | Cost | Target ≤ $0.02 per standard Q&A and ≤ $0.50 per agent run (tunable; tracked on dashboard). |
| NFR-DX-01 | Dev experience | `pnpm dev` brings up the whole stack locally; `pnpm test` ≤ 5 min; coverage ≥ 80%. |
| NFR-A11Y-01 | Accessibility | WCAG 2.2 AA on the web UI. |

---

## 3. MVP definition (Phase 0–2 + minimal Phase 3)
In: tenancy + RLS, OIDC, **MCP client + per-user OAuth token vault**, **federated connectors via MCP (Drive, Slack, M365+Teams, Gmail, GitHub, existing work-system product)**, federated retrieval orchestrator with merge + rerank, cited chat with streaming, gateway with 2 tiers, usage ledger, audit log, eval harness, leak red-team suite. Hybrid index (OpenSearch/pgvector) only for connectors switched to `indexed` mode or for chat memory; ACL filtering and fetch-time verification apply to indexed content.
Also in MVP (decision 8): approval-gated write tools (FR-WR-01..05, 07) and per-user Connections (FR-CON-01..03).
Out (deferred): first-party work system, knowledge graph, learned ranker, ambient agents, notetaker, voice, SCIM, SOC 2.
Update 2026-11-08: a per-person work graph (FR-RET-09) was built after the MVP, as decided by the project owner; a company-wide graph stays deferred.

Trade-off accepted: federated MCP search is simpler and inherits each source's permissions (the user's own token), but gives lower and uneven latency, depends on each server's search quality, and has no cross-source ranking signals until indexed mode is enabled. Re-evaluate after the Phase 1 eval.

## 4. Out of scope / won't do
- Training or fine-tuning foundation models.
- Storing source credentials of end users in plaintext.
- Cross-tenant learning from customer content.

## 5. Decisions and remaining open questions
Decided (user, answered in session):
1. Connectors: all of Google Drive, Slack, Microsoft 365 + Teams, Gmail, GitHub, **provided through MCP**.
2. System of record: an **existing product** (not built here).
3. Hosting/residency: **single region, AWS US**.
5. Scale: **pilot, under 20 tenants, under 1M chunks each**.

Decided in the second round (details and sources in `docs/DECISIONS-AND-INTEGRATIONS.md`):
6. Work system: **pluggable**; catalog of products with live remote MCP endpoints is in that doc. **First adapter decided: Atlassian Jira (+ Confluence)** via `https://mcp.atlassian.com/v1/mcp`. Later config-only adapters: Asana, Notion, Linear, monday.com, ClickUp.
   - FR-WS-J01 (P0): `WorkSystemAdapter` interface (search, get, create, update, comment, transition, list projects) implemented for Jira via MCP; tool-name mapping in config.
   - FR-WS-J02 (P0): MCP client tolerates servers without RFC 9728 metadata (falls back to host-level authorization-server discovery) and supports PKCE S256 plus refresh tokens.
   - FR-WS-J03 (P0): Jira/Confluence results normalised to `Document` (issue key, project, status, assignee, updated, URL) and cited with browse URLs.
   - FR-WS-J04 (P0): Jira write tools mapped into the FR-WR classes (create/update/transition = write; comment = external-effect; delete/bulk = destructive, disabled).
7. Connections are **per user**: each user links each MCP server with their own OAuth; no shared service account.
8. **Write access is in v1**, behind the policy engine in FR-WR-*.
9. LLM: Anthropic Commercial org with ZDR on prod (per-org, via account team); avoid Fable/Mythos models for ZDR tenants; embeddings and rerank vendor chosen by eval plus contract.

Still open:
- Q1a. Per server: confirm `tools/list`, a search tool, write tools, rate limits, OAuth client registration method (pre-registered app vs Client ID Metadata Document). Microsoft 365/Teams endpoints are unverified.
- Q4a. Written confirmation from Anthropic that the three default models are ZDR-eligible; embeddings/rerank vendor terms.
- Q7. Pilot customer intake (questionnaire in the decisions doc §6): identity provider, compliance asks, which systems they use.
- Q8. Allow user-supplied custom MCP URLs, or admin allow-list only (default: allow-list only)?
