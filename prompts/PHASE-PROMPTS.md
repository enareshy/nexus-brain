# Paste-ready prompts for Claude Code

Run from `brain-build/`. Start Claude Code with `claude`. Use one prompt per session; `/clear` between phases.

---
## P-00 Kickoff (run once)
```
Read CLAUDE.md, docs/REQUIREMENTS.md, docs/TECH-STACK.md, docs/ARCHITECTURE.md and docs/BUILD-PLAN.md.
Summarise in 15 lines what we're building, list every open question in REQUIREMENTS §5 that blocks Phase 0 or 1,
and propose answers/defaults for each. Do not write code yet. Wait for my confirmation.
```

## P-01 Phase 0 — Foundations
```
/phase 0
```
Or the long form:
```
Execute Phase 0 of docs/BUILD-PLAN.md using TDD. Scaffold the pnpm/Turborepo monorepo exactly as in docs/TECH-STACK.md "Repo layout".
Implement packages/core (Zod schemas + typed env loader), packages/db (Drizzle schema, RLS policies for every tenant table, withTenant helper, seed with two tenants and overlapping users),
apps/api (NestJS + Fastify, OIDC JWT guard against local Keycloak, request context with tenant_id/user_id), packages/telemetry, and a CI workflow.
Write RLS isolation tests first. Finish with an exit-criteria checklist and evidence.
```

## P-02 Phase 1 — Ingestion + hybrid index
```
/phase 1
```
Extra guidance to append if needed:
```
Read docs/DECISIONS-AND-INTEGRATIONS.md first. Start with the connector-sdk contract tests, then packages/mcp-client (per-user OAuth + PKCE, token vault, discovery fallback when RFC 9728 metadata is missing),
then the Atlassian Jira/Confluence adapter against https://mcp.atlassian.com/v1/mcp end to end. Capture the real tools/list into docs/adr/0001-mcp-servers.md before mapping tools; never assume tool names.
Only after Jira passes, add Google Drive, Slack, Microsoft 365 + Teams, Gmail and GitHub adapters. For indexed-mode connectors only:
OpenSearch mapping must include acl_principals (keyword), tenant_id, embedding (knn_vector, dimension from config), and the RRF search pipeline.
Store embedding model+dim with each vector. Provide a script to measure ingest-to-searchable latency. Grow the golden set to 300 queries and report recall@10 vs BM25-only.
```

## P-03 Phase 2 — Permission enforcement
```
/phase 2
Then run /leak-check. Build the red-team suite first (tests that currently fail), then make them pass. Include prompt-injection exfiltration cases and cache-poisoning cases.
```

## P-04 Phase 3 — Gateway, chat, agents, MCP
```
/phase 3
Implement llm-gateway first with an ESLint rule banning direct vendor SDK imports elsewhere. Model IDs only in config/models.ts
(standard claude-sonnet-5-5, fast claude-haiku-5-5, premium claude-opus-5-5). Meter every call. Then streaming chat, then agent runtime with approval interrupts,
then the MCP server targeting spec revision 2026-07-28 (stateless, OAuth 2.1 + PKCE, no token passthrough). Fetch the current MCP spec and SDK docs before coding.
```

## P-05 Phase 4 and 5
```
/phase 4
```
```
/phase 5
Do not run terraform apply. Produce plans and documentation; I will apply manually.
```

---
## Utility prompts
**Review before merge**
```
Run the code-reviewer and permission-auditor subagents on the current diff. Fix CRITICAL/HIGH issues, then print a summary table.
```
**Debug a retrieval miss**
```
Query "<paste query>" as user <user> in tenant <tenant> should return <doc>. Trace the ACL filter, principal expansion, BM25/kNN scores, RRF, and rerank.
Find the root cause before changing code; add a regression case to the golden set.
```
**Add a connector**
```
Add a <name> connector via packages/connector-sdk. Write the contract tests first. Document auth scopes, rate limits, ACL mapping, deletion handling, and indexed vs federated mode.
```
**Cost check**
```
Query usage_ledger for the last 7 days; report cost per feature and per model, top 10 expensive requests, and propose routing/caching changes. Do not change code yet.
```
