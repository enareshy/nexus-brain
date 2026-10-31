# Nexus Brain — build kit for Claude Code

A complete input pack to build a ClickUp Brain²-style assistant with Claude Code. Based on `../reports/ClickUp Brain 2 architecture.md`.

## What's here
| Path | Purpose |
|---|---|
| `CLAUDE.md` | Project rules Claude Code loads automatically |
| `docs/REQUIREMENTS.md` | Functional + non-functional requirements with IDs and acceptance criteria |
| `docs/TECH-STACK.md` | Chosen stack, alternatives, repo layout, design decisions |
| `docs/ARCHITECTURE.md` | Component, query, ingestion, agent flows; data model |
| `docs/BUILD-PLAN.md` | Phases 0–5 with tasks and exit criteria |
| `prompts/PHASE-PROMPTS.md` | Paste-ready prompts per phase + utility prompts |
| `.claude/settings.json` | Permission allow/deny list (blocks `.env` reads, force-push, terraform apply) |
| `.claude/agents/` | `permission-auditor`, `retrieval-evaluator` subagents |
| `.claude/commands/` | `/phase <n>`, `/leak-check` |
| `docker-compose.yml`, `.env.example` | Local infra and config template |

## Prerequisites
Node 22, pnpm 9+, Docker Desktop, Git, Claude Code. API keys: Anthropic (required); Voyage or OpenAI (embeddings); Cohere (rerank). Google and Slack OAuth apps for Phase 1 connectors.

## Status
Phase 0 (foundations) is implemented: monorepo, `@brain/core`, `@brain/db` (RLS), `@brain/telemetry`, `@brain/evals`, `apps/api` (NestJS + Fastify, OIDC), Keycloak dev realm, CI. Not yet built: `apps/web` (UI shell). Next: Phase 1 (`/phase 1`).

## Run it locally
```bash
pnpm install
cp .env.example .env
pnpm infra:up             # Docker Desktop must be running
pnpm db:migrate && pnpm db:seed
pnpm dev                  # API on http://127.0.0.1:3001
node scripts/smoke-login.mjs
```
Checks: `pnpm typecheck && pnpm lint && pnpm test:cov && pnpm test:int && pnpm eval`.

### Web app
`pnpm dev` starts the API (http://127.0.0.1:3001) and the web app (http://localhost:3000). Sign in as a dev user, open **Connections**, click **Connect** for Atlassian, approve in Atlassian, and you return to the app connected. Then search from the home page.

### Connect Jira from the terminal (alternative)
With `pnpm dev` running (stop the web app first: the CLI listens on port 3000 for the redirect):
```bash
node scripts/dev-brain.mjs connect pat.acme atlassian   # open the printed URL, approve in Atlassian
node scripts/dev-brain.mjs status pat.acme
node scripts/dev-brain.mjs tools pat.acme atlassian     # records the real tool list for ADR 0001
node scripts/dev-brain.mjs search pat.acme "login bug"
```
Dev logins (Keycloak at http://localhost:8081, realm `brain`): `alice`, `bob`, `gina`, `pat.acme` (tenant Acme), `pat.globex`, `gus` (tenant Globex); passwords are in `infra/keycloak/brain-realm.json` (local test values only).

## Operating tips
- One phase per session; `/clear` between phases; commit at the end of each task.
- Keep `docs/REQUIREMENTS.md` as the source of truth; change requirements there, not in chat.
- Gate every phase on its exit criteria; don't skip the leak suite and evals.
- Verify the MCP spec revision, model IDs and vendor SDK versions at implementation time — they change.

## Caveats
Stack choices beyond what ClickUp's job postings confirm (Postgres, OpenSearch, Kafka, LangGraph, TypeScript, AWS, Terraform) are recommendations, not verified facts. Durations, costs and quality targets are starting estimates to calibrate.
