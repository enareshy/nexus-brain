# Build plan (phases, tasks, exit criteria)

Durations are estimates for 4–6 engineers; with Claude Code they are the human-review cadence, not coding time.

## Phase 0 — Foundations (3–4 wks)  [FR-ID-01..03, NFR-DX-01, NFR-OBS]
Tasks
1. Scaffold pnpm + Turborepo monorepo per TECH-STACK layout; TS strict, ESLint, Prettier, Vitest, husky + gitleaks.
2. `docker-compose.yml` local infra (see file); `pnpm infra:up`, health script.
3. `packages/core`: Zod schemas (Tenant, User, Group, Document, Chunk, AclPrincipal, DomainEvent), typed env loader.
4. `packages/db`: Drizzle schema, migrations, RLS policies, `withTenant(tx, tenantId)` helper, seed (2 tenants, overlapping people).
5. OIDC auth in `apps/api` (Keycloak realm JSON in `infra/keycloak/`); guards set tenant/user context.
6. `packages/telemetry`: OTel tracing, pino logger with context.
7. `packages/evals`: skeleton harness + 30-query seed golden set; CI workflow runs typecheck/lint/test.
Exit criteria
- Login works; JWT → tenant/user context; RLS isolation tests pass (tenant A cannot read B).
- `pnpm dev` runs api+web shell; CI green; eval harness executes on seed set.

### Phase 0 status (2026-10-31)
Done: monorepo, core, db (RLS + leak suite), telemetry, evals harness, API (OIDC guard, tenant context, envelope, RLS role check at startup), Keycloak dev realm, CI, loopback-only dev services.
Verified: typecheck, lint, 93 unit tests (coverage 93–100%), 16 RLS integration tests, 8-step Keycloak→API smoke test, eval harness, secret scan.
Not done: `apps/web` UI shell (moved to Phase 1, needed for the Connections UI).
Deferred review items (address before production):
- Split dev-only Keycloak content (`brain-dev-cli`, test passwords) into a separate realm file.
- Enforce `https` for `OIDC_ISSUER`/`OIDC_JWKS_URL` when `NODE_ENV=production`; normalise trailing slash on the issuer.
- Migrator: advisory lock for concurrent deploys and checksums for applied migrations.
- Add rate limiting, CORS, security headers and `trustProxy` to Fastify with the first Phase 1 endpoints.
- Revisit the per-request directory lookup (one DB transaction per request) once revocation semantics are decided.

### Phase 1 status (2026-10-31, branch `phase-1-mcp-jira`)
Done (slice 1a: Jira path end to end against a local mock MCP server):
- `packages/mcp-client`: SDK-based OAuth (discovery incl. fallback when RFC 9728 metadata is missing, DCR, PKCE S256, refresh), SSRF-guarded fetch, sessions, error mapping, mock OAuth+MCP server for tests.
- Token vault: AES-256-GCM with (tenant, user, server) bound as AAD; `mcp_connections` RLS per tenant **and user**; single-use hashed OAuth state with 10-minute expiry.
- `packages/connectors`: schema-driven search adapter (no hard-coded argument shapes), safe citation extraction, federated search with RRF and per-source budget.
- API: `GET /connections`, `POST /connections/:id/authorize`, `GET /oauth/callback`, `DELETE /connections/:id`, `GET /connections/:id/tools`, `GET /search`; audit rows (query hashed); rate limit; CORS.
- `scripts/dev-brain.mjs` to connect, capture tools and search before the UI exists.
- Security review fixes (0 critical/high; all 6 medium fixed): login-CSRF (completion requires the signed-in owner of the state, migration 0004), per-(tenant,user,server) session serialisation against refresh races, RFC 7009 revocation on disconnect, per-credential rate limits + bounded pending states + 5 MB response cap, citation host allow-list (https on the connected service only), https-only URLs in production; plus IPv6-mapped address checks, consent-URL host check, keyed (HMAC) audit fingerprints, validated stored tokens, no-store/no-referrer on the callback.
- Web UI shell (`apps/web`, Next.js 16 / React 19 / Tailwind 4): Keycloak sign-in (PKCE), Connections page (connect, reconnect, disconnect with revocation result), consent completion page, Search page with safe citations and per-source status; strict CSP and security headers; verified in the browser (sign-in, search, connections, error paths, 375px mobile, silent token renewal). React review: 0 critical; both high (hook/a11y lint rules now enforced; sessions renew via refresh token or clear on expiry) and all medium findings fixed (stale results, bfcache, load retry, base-path join, production env guard, a11y labels/headings/live regions, recovery paths, request cancellation + timeout, HSTS).
Note: never run `next build` while `next dev` is running in the same app; they rewrite `next-env.d.ts` differently and cause a reload loop.
- Real Atlassian connected and verified (ADR 0001): live OAuth, 32 tools captured, dedicated Jira + Confluence adapter using JQL/CQL only (the `search` tool can consume Rovo Credits), real cited Confluence results in 2-3.4 s.
- AI answers: `packages/llm-gateway` (Claude with native citations, no tools offered, refusal fallbacks, typed errors), `POST /answers` SSE stream, full-text reads with the user's token, usage ledger (migration 0005) including aborted and failed calls, per-user limits (10/min, 2 concurrent), "Answer with AI" button so answers only run on request. Security review: 0 critical; both high (unmetered failed calls, weak cost guard) and the medium items fixed.
- Approval-gated Jira writes (FR-WR-01..05, FR-WS-J04): Changes page, proposal store (migration 0006), approve/reject API, exact-args binding, single-claim replay protection, per-user caps, audit rows. People draft changes in a form; the model does not draft them yet. Details and gaps in ADR 0001.
- GitHub connected through a pre-created GitHub App on the read-only endpoint, with issue and pull request search. Verified live: one search and one answer citing both GitHub and Jira (2026-11-01). Two of the three sources for the Phase 1 exit are done. Details and gaps in ADR 0001.
- Admin setup of sign-in apps (migration 0007): services without client registration list a guided Set up panel on the Connections page. The client id and encrypted secret are saved per company with no restart, and end users only click Connect. Changing an app makes earlier connections reconnect. Old grants are not revoked at the provider on a change, because RLS keeps other users' tokens private; disconnect after a change also cannot revoke with the old app. The setup panel is unverified with a live Google client until Drive connects.
- Local reranker (BM25 over title and snippet, no vendor key) and a synthetic eval in `pnpm eval`, which runs the production keyword, merge and rerank code over invented documents. Of its 300 questions, 220 measure quality, 40 test permissions and 40 have no answer. Measured 2026-11-01 on the 220: nDCG@10 0.34 merged only, 0.81 reranked; recall@10 0.82, below the 0.85 target. By tag: exact title 1.00, keyword 1.00, multi-source 1.00, paraphrase 0.00. 20 of the 40 no-answer questions still return results, because any one keyword matching is enough. Read these with care: questions reuse the documents' own words, which makes keyword cases easy; each source's newest document is a weakly related note and sources sort newest first, which favours reranking and matches only Jira among the real services. They show mechanics, not quality on real data. CI fails on any leak, recall under 0.80, or reranking doing worse than merging. Permission cases are filtered by the simulator, so they can only catch this pipeline adding results: access is enforced by each service with the user's token, and by RLS in `pnpm test:leak`.
- Query rewriting (Claude Haiku, roughly $0.00005 to $0.0001 a question, metered as `query_rewrite`, including estimates for abandoned calls): answers always ask for up to four better search words; the search bar asks only when a clean search finds nothing, and says which words it used. The model sees only the question and has no tools, and its output is cut down to plain words before use. If it fails, search continues as asked. Failures were seen but not explained: 3 of about 15 calls in the running API failed with a connection error, then 0 of 9 after that, and 2 of 235 recorded calls failed with no retry in one run and 0 of 235 in the next. It retries once, and logs the network error code to catch the cause next time. Limit: 30 a minute per user, counting repeats, cached 5 minutes. `pnpm eval` replays recorded real output (`golden/rewrites.json`), so CI needs no key; re-record with `scripts/record-rewrites.ts` if the questions or prompt change, and a partly failed run writes nothing. Measured 2026-11-01 on the same synthetic set, rewriting every question as the answer path does: recall@10 0.82 to 0.97, nDCG@10 0.81 to 0.87, paraphrase recall 0.00 to 0.85. Costs of it: a rephrased question that is found often ranks low (paraphrase MRR 0.35); multi-source ranking drops (MRR 1.00 to 0.87), and exact titles and keyword questions slightly (to 0.98 and 0.96); no-answer questions returning results rise from 20 to 21 of 40. Known gaps: the search bar never rewrites if one loosely related result matches, which was seen live, so those searches still miss; the search path does not stop the rewrite if the client disconnects; answers wait for the rewrite before searching, and that added time has not been measured; search-bar questions that found nothing, and all answer questions, go to Anthropic. CI requires recall of 0.85 with rewriting.
Not done yet (remaining Phase 1):
- Answers verified live (2026-11-01) through the API and browser: real citations, ledger and audit rows, about $0.025 per answer on one small test site (4,676 input and 299 output tokens), first text 5.7 s, reduced to about 3.5 s with session reuse and per-user caches (ADR 0001; target NFR-PERF-01 of 2.5 s still not met). Answer quality has not been evaluated; that needs real questions and a golden set.
- Answer known gaps: rate limits are in-process (reset on restart, per instance); no SSE heartbeat; cited text is not yet shown in the UI; model-written "[n]" text is not distinguished from real citations; no plan budgets (FR-MET-02/03).
- Run Jira update and comment once live through the approval flow, and read a Jira description in an answer. Issue creation and search are verified on a real issue (2026-11-01).
- Replace the synthetic set with real questions, and evaluate answer quality, which nothing measures yet.
- Connect Drive, Gmail and Slack live and check their adapters against real results (built and tested on synthetic data only). Microsoft 365 and Teams need a tenant to test against. Playwright E2E for the browser flows; move browser tokens to a backend-for-frontend with httpOnly cookies and nonce-based CSP (Phase 5).
- Deferred review items: key id + rotation in the sealed format (KMS), Postgres advisory lock for refresh across multiple API instances, pin resolved IPs in the fetch (DNS rebinding), cancel abandoned source sessions on budget timeout, de-duplicate concurrent first-use client registration.

## Phase 1 — MCP connectors + federated retrieval (+ optional index) (5–7 wks)  [FR-ING-01..03, FR-MCP-02,05,06, FR-RET-01,04,05,06]
Tasks (revised after decisions: existing product as system of record, all sources via MCP)
1. (Replaces first-party work system.) Pick and verify MCP servers per source (Q1a/Q2a): list tools, auth model, search capability, rate limits. Record in `docs/adr/0001-mcp-servers.md`.
2. `connector-sdk` interface + shared contract test suite.
3. MCP client in `packages/mcp-client`: OAuth 2.1 + PKCE per-user flow, encrypted token vault, tool allow-list, timeouts/retries/circuit breaker, response caps, SSRF guard, no token passthrough.
3a. **Atlassian Jira/Confluence first**: build the generic MCP client and `WorkSystemAdapter` against `mcp.atlassian.com/v1/mcp` end to end (OAuth + PKCE with host-level discovery fallback, `tools/list` capture into the ADR, search → cited answer, then approval-gated create/update/comment). Use it to prove the whole pipeline before other connectors.
3b. MCP connector adapters: Google Drive, Slack, M365 + Teams, Gmail, GitHub (after Jira passes), plus other work systems as config-only adapters — `mode: federated` first; add `indexed` crawl per connector only if the eval shows need.
3c. Federated orchestrator: parallel fan-out (≤ 3 s budget), normalise, dedupe, merge with RRF, rerank, cite.
4. Kafka topics (`doc.upsert`, `doc.delete`, `acl.change`, `membership.change`); worker: chunk → embed (cached by content hash) → bulk index; DLQ.
5. OpenSearch index template: `text`, `embedding(knn_vector)`, `acl_principals(keyword)`, `tenant_id`, `source`, `path`, `updated_at`; hybrid search pipeline with RRF.
6. `packages/retrieval`: query builder with ACL filter, principal expansion, rerank client, citations.
7. Answer endpoint (non-streaming first) with citation validator.
8. Grow golden set to ≥ 300 queries incl. permission-sensitive cases.
Exit criteria
- Cross-source answers with citations from at least 3 MCP sources; federated fan-out p95 ≤ 3 s; recall@10 target tracked (≥ 0.85) and rerank improves nDCG.
- Per-user OAuth verified: user A's token never returns user B's data; revoked token stops access immediately.
- For any connector in `indexed` mode: freshness ≤ 5 min p95; kill-worker resume test and DLQ handling pass.

## Phase 2 — Permission enforcement (3–4 wks, overlaps 1)  [FR-RET-02,03, FR-ADM-01, NFR-SEC-01]
Tasks
1. Fetch-time verification of top-k against source/system of record.
2. Permission-drift detector (compare index ACL vs source on sample; alert).
3. Red-team suite `pnpm test:leak`: revoked access, group removal, guest vs member, cross-tenant forged filters, cache poisoning, prompt-injection-induced exfiltration attempts, memory bleed.
4. Audit log for every retrieval; admin query endpoint.
5. Cache keys include permission hash; tests.
Exit criteria
- 0 leaks across suite; drift alert latency within SLA; audit rows verified.

### Phase 2 status (2026-11-02, branch `phase-2-permissions`)
Decisions: sources are searched live with each user's own token, so the source enforces access inside each query. That meets FR-RET-02 for federated search; there is no index, so an ACL filter and the drift detector (task 2) do not apply until a connector uses `indexed` mode.
Done:
- FR-RET-03: search results are no longer cached, because the leak suite showed a document with removed access reaching the model and a revoked account still getting results. Each search now asks the service, so a repeated search takes about as long as a new one.
- Red-team suite in `pnpm test:leak` (`apps/api/src/leak.int.test.ts`), on the real API, RLS, vault and OAuth with a mock service and model: between people and companies, forged tokens and parameters, removed access, revoked grants, role change and deleted users on a still-valid token, planted instructions, audit access.
- FR-ADM-01: audit rows now list everything an answer retrieved, and empty or cancelled ones too. Admin-only `GET /admin/audit` and an Activity page, with filters and paging; viewing is itself recorded.
Limits of this evidence: planted instructions are tested against a fake model, so the suite shows no tool can be reached (no tools are offered), not how the real model behaves. Access enforcement by real services is trusted, not tested, beyond Atlassian and GitHub working live as one user. Memory-bleed cases wait for memory (Phase 4).
Known gaps: if a source times out after reading documents, those reads are dropped and not listed in the trail, though they never reach the person or the model; the per-user lists of Atlassian sites and GitHub repositories stay cached for 5 minutes, so a removed site or repository can stay in the search scope that long, while the service still refuses the search itself; someone disabled only in Keycloak keeps access until their token expires, because the check reads our user table; a search-time result can go stale in the moments before its text is read; the audit trail shows admins document IDs across the company, which customers should be told; the Activity page has no filter controls yet, though the API has them; the Activity link shows to everyone, and non-admins get a message.

## Phase 3 — Gateway, chat, agents, MCP (6–8 wks)  [FR-LLM, FR-AST-01..04, FR-AGT, FR-MCP, FR-MET-01]
Tasks
1. `llm-gateway`: adapters, tiers/router, retries/fallback/circuit breaker, caching, metering hook, zero-retention config, lint ban on direct vendor imports.
2. Streaming chat (SSE) UI + API; feedback capture; private history.
3. Agent runtime: LangGraph + Postgres checkpointer; tool registry with manifests; approval interrupts; triggers (assign, @mention, schedule); caps.
4. MCP server (OAuth 2.1 + PKCE; spec 2026-07-28) exposing search/get/create/update/list-hierarchy; MCP client with admin allow-list.
5. Agent eval set (task completion, tool accuracy, injection resistance).
Exit criteria
- Agent task-completion and tool-accuracy targets met on eval set; every write approval-gated or reversible.
- MCP passes auth review (no token passthrough, audience validation, SSRF guard).
- Every LLM call visible in ledger.

### Phase 3 status (2026-11-02)
Chat slice done (FR-AST-01..04): a Chat page with streaming, citations and follow-up questions; private history that the database keeps per person, so admins cannot read it through the app; text encrypted at rest and bound to its owner and conversation; delete; thumbs up or down with a reason. Follow-ups give the model earlier turns as context and give the search step only the person's own earlier questions; only documents read for the latest question count as sources. Answers started from the Search page are saved too.
Earlier turns reach the model as one block labelled untrusted, not as its own turns; that lowers injection risk but cannot rule it out. Limits: 500 conversations per person and 400 messages per conversation. Found live: browsers were blocked from every DELETE by the CORS settings, so Disconnect had also never worked from the page since Phase 1; fixed, with a test. There are still no browser end-to-end tests, which is why it stayed hidden. Known gaps: saved answers keep their text, titles, links and snippets, and earlier answers are still sent as context, even if access to their sources has since been removed or the connection removed, until the person deletes the conversation; there is no retention policy yet; two questions sent at once in one conversation can drop those turns from later context; the web sends one at a time; the gateway still has one provider, with no tiers, second vendor, circuit breaker or response cache (FR-LLM-02..05); saved answers keep their links, which are checked when saved and again by the page.
Agent slice built (FR-AGT-01..04, 06): an Agents page where a person gives a task; the agent searches their connected tools as them and proposes Jira changes that they approve; progress survives a restart. Own small runtime instead of LangGraph; see `docs/adr/0002-agent-runtime.md` for why, the caps and the gaps.
MCP server built (FR-MCP-01, 03): `POST /mcp` lets an AI tool search, read and propose changes as one signed-in person, with its own token audience and every change still approved in Brain. See `docs/adr/0003-brain-mcp-server.md` for how to connect and the gaps, including the protocol version and client registration.
Agent evals built (task 5): 32 tasks on invented documents, run through the real agent code and model by `apps/api/scripts/agent-eval.ts` (about $0.60), recorded in `packages/evals/golden/agent-results.json` and scored by `pnpm eval` in CI. CI fails if the prompt, tools or model change without a new recording. The targets are ours, since the requirements give none: 85% of tasks completed, 95% of tool calls valid, 100% of attacks resisted, mean cost at most $0.50. Limits: a small set of attacks we wrote ourselves, run without adapting to the model, on simulated search, so a pass is evidence and not a guarantee, and the approval step remains the real safeguard. Answer wording is checked by keywords.
Not started: triggers (FR-AGT-05, rest of task 3), admin allow-list for the MCP client (rest of task 4).

## Phase 4 — Memory, graph, metering, plans (6–8 wks)  [FR-AST-05..08, FR-RET-07..09, FR-MET-02..04, FR-WS-05..07]
Tasks
1. Memory (view/edit/delete), skills, @Brain mentions, summaries.
2. Work graph in Postgres edge tables; graph features in ranking; compare via eval.
3. Plans, pooled credits, budgets, top-ups, cost dashboard, invoice reconciliation script.
4. Query rewriting/intent; learned ranker from feedback (offline first).
Exit criteria
- Graph/learned signals improve eval over Phase 1 baseline; memory deletion verified end-to-end; ledger reconciles within 3%.

## Phase 5 — Production hardening (8+ wks)  [NFR-AVAIL, NFR-COMP, FR-ADM-02..04, FR-ING-07..09]
Tasks
Terraform for AWS (EKS, Aurora, OpenSearch, MSK, ElastiCache, S3, KMS); Helm + ArgoCD; load tests; DR drills; SOC 2 evidence; data residency; more connectors; admin console; GDPR export/delete.
Exit criteria
- SLOs met for a month; audit evidence assembled; model upgrades gated by eval suite.
