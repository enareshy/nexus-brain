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
- Pin CI actions to commit SHAs.
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
Not done yet (remaining Phase 1):
- Answers verified live (2026-11-01) through the API and browser: real citations, ledger and audit rows, about $0.025 per answer on one small test site (4,676 input and 299 output tokens), first text 5.7 s and total 8 s (target NFR-PERF-01 is 2.5 s to first token, not met: most time is search and document reads). Answer quality has not been evaluated; that needs real questions and a golden set.
- Answer known gaps: rate limits are in-process (reset on restart, per instance); no SSE heartbeat; cited text is not yet shown in the UI; model-written "[n]" text is not distinguished from real citations; no plan budgets (FR-MET-02/03).
- Verify the Jira issue result shape against a site with real issues.
- Reranker, answer generation with citations (needs LLM gateway keys), golden set of 300 queries.
- Other connectors (Drive, Slack, M365/Teams, Gmail, GitHub); Playwright E2E for the browser flows; move browser tokens to a backend-for-frontend with httpOnly cookies and nonce-based CSP (Phase 5).
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
