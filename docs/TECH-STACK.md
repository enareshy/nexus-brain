# Technology stack

Legend: **Chosen** = decision for this build. **Alt** = acceptable swap. ClickUp evidence is from public job postings (see `reports/ClickUp Brain 2 architecture.md`); the rest are recommendations to validate.

| Layer | Chosen | Alt | Why |
|---|---|---|---|
| Language/runtime | TypeScript 5.x, Node.js 22 LTS | Python for ML-only workers | One language end to end; ClickUp core is TS/Node |
| Monorepo | pnpm workspaces + Turborepo | Nx | Fast, simple |
| API framework | NestJS 11 (Fastify adapter) | Hono, Express | Matches ClickUp (NestJS); DI + modules suit domains |
| Validation/contracts | Zod + OpenAPI generation (`nestjs-zod`) | TypeBox | Single schema source |
| ORM/migrations | Drizzle ORM + drizzle-kit | Prisma, Kysely | SQL-first, good with RLS and pgvector |
| System of record DB | PostgreSQL 16 (Aurora/RDS in prod) + RLS | — | Confirmed ClickUp |
| Vector (MVP) | pgvector (HNSW) | — | One less moving part for MVP |
| Search + hybrid | OpenSearch 2.x (BM25 + k-NN, `search_pipeline` RRF) | Elasticsearch, Qdrant+PG | Confirmed ClickUp uses OpenSearch |
| Event backbone | Redpanda locally / Kafka (MSK) prod | SQS+SNS, NATS | Confirmed ClickUp uses Kafka |
| Queue/jobs | BullMQ on Redis (short jobs); Temporal (durable agent/sync runs, Phase 3) | Inngest | Resumable sync + agents |
| Cache | Redis 7 / Valkey | — | Confirmed ClickUp |
| Object storage | S3 (MinIO locally) | — | Raw files, exports |
| Auth | OIDC; Keycloak locally; `jose` for JWT | Auth0, Cognito, WorkOS | Standards-based |
| LLM gateway | In-repo `packages/llm-gateway` on the official `@anthropic-ai/sdk` (pinned 1.3.0). Other vendors and tier routing are not built; add them when there is a need | LiteLLM proxy | Typed, testable, no extra service |
| LLMs | `claude-opus-5-5` for answers ($4/$20 per MTok), effort `low`, server-side refusal fallbacks on. Cheaper option: `claude-sonnet-5-5` ($2/$10), one line in `models.ts` | Bedrock-hosted | Model IDs in config only |
| Embeddings | Configurable: `voyage-3-large` or OpenAI `text-embedding-3-large` (dim 1024/3072 → store `model`+`dim` per vector) | Cohere embed v4, BGE self-host | Pick after eval on golden set |
| Reranker | Cohere Rerank 3.x API | BGE-reranker-v2 self-hosted | Quick win; swap by eval |
| Agent orchestration | LangGraph.js (`@langchain/langgraph`) + Postgres checkpointer | Mastra, custom | Confirmed ClickUp (LangGraph) |
| MCP | Official `@modelcontextprotocol/sdk` **1.32.2** (pinned). Correction 2026-10-31: this SDK's latest protocol is `2025-11-25`, not `2026-07-28`; we use whatever the SDK negotiates and adopt the stateless revision when the SDK ships it | — | Server + **client (primary connector path)**; per-user OAuth via the SDK's `OAuthClientProvider`, token vault in Postgres (AES-256-GCM now, AWS KMS envelope keys in Phase 5) |
| Connector model | MCP client adapters, federated first (see `DECISIONS-AND-INTEGRATIONS.md`) | Bespoke API connectors | User-linked servers inherit source permissions |
| Write policy | In-repo policy engine: tool classification, approval cards, exact-args binding, idempotency | — | FR-WR-* |
| Frontend | Next.js 15 (React 19), Tailwind, shadcn/ui, TanStack Query | Angular (ClickUp uses) | Streaming UI, rich ecosystem |
| Streaming | SSE over HTTP | WebSocket | Simple, proxy-friendly |
| Observability | OpenTelemetry → Grafana stack (Tempo/Loki/Prometheus); Langfuse for LLM traces | Datadog | Open standards |
| Evals | promptfoo + custom retrieval harness (recall@k, nDCG, groundedness) | Ragas, Braintrust | CI-gating |
| Tests | Vitest, Testcontainers, Playwright (E2E), `fast-check` | Jest | |
| Lint/format | ESLint (flat) + Prettier + `tsc --noEmit` strict | Biome | |
| IaC | Terraform (AWS: EKS, Aurora, OpenSearch Service, MSK, ElastiCache, S3, KMS) | CDK | Confirmed ClickUp (Terraform/EKS) |
| CI/CD | GitHub Actions; ArgoCD or Helm deploy | | |
| Secrets | AWS Secrets Manager; `.env` locally; gitleaks pre-commit | | |
| Security scanning | gitleaks, `pnpm audit`, Semgrep, Trivy | | |

## Repo layout (target)
```
brain-build/
  apps/
    api/            NestJS HTTP API (auth, chat, search, admin)
    web/            Next.js UI
    worker/         ingestion + sync workers (BullMQ/Kafka consumers)
    agent-runtime/  LangGraph runner (Phase 3)
    mcp-server/     MCP server (Phase 3)
  packages/
    core/           domain types, Zod schemas (Document, Chunk, AclPrincipal, Event)
    db/             Drizzle schema, migrations, RLS policies
    connector-sdk/  connector interface + contract tests
    connectors/     google-drive, slack, native
    retrieval/      hybrid query builder, RRF, rerank, ACL filter, verifier
    llm-gateway/    adapters, router, cache, fallback, metering hook
    evals/          golden set, harness, red-team (leak) suite
    telemetry/      OTel + logger
  infra/            terraform/, helm/, docker/
  docs/             REQUIREMENTS, TECH-STACK, ARCHITECTURE, BUILD-PLAN
  prompts/          Claude Code prompts per phase
  .claude/          settings, commands, agents
```

## Key design decisions (ADR summary)
1. **ACLs on every chunk** as `acl_principals: keyword[]` (user:`u_x`, group:`g_y`, `tenant:all`); filter in the OpenSearch query and in SQL. Membership expansion happens at **query time** (user → groups) so group changes apply instantly.
2. **Two-stage permission check**: index filter, then verify top-k with the source/system of record before prompting the LLM.
3. **Canonical schema first**: connectors only produce `Document`/`AclPrincipal`; nothing downstream knows about vendors.
4. **Gateway owns vendors**: no feature code imports a vendor SDK directly (lint rule).
5. **Every LLM call is metered** through the gateway hook; no hook, no call.
6. **Cache keys include permission hash** so answers are never shared across users with different access.
7. **Graph deferred**: begin with Postgres edge tables; adopt a graph DB only if eval shows need.
8. **Embedding rows store `model` and `dim`** to allow re-embedding and A/B.
