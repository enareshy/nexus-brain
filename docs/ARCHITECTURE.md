# Architecture

```
 Web (Next.js) / MCP clients / @Brain mentions
            |  HTTPS + SSE
      +-----v------------------------------+
      | apps/api (NestJS)                  |  OIDC JWT -> tenant_id, user_id; RLS context
      |  chat | search | admin | approvals |
      +--+-----------+----------------+----+
         |           |                |
   +-----v----+  +---v-----------+  +-v-------------------+
   | retrieval|  | agent-runtime |  | mcp-server          |
   | package  |  | (LangGraph +  |  | OAuth2.1, acts as   |
   |          |  |  Temporal)    |  | signed-in user      |
   +--+----+--+  +---+-----------+  +---------------------+
      |    |         |
      |    |   +-----v---------------+      +------------------+
      |    |   | packages/llm-gateway|----->| Anthropic/OpenAI/|
      |    |   | route|cache|fallback|      | Google           |
      |    |   +-----+---------------+      +------------------+
      |    |         | usage events
      |    |   +-----v---------------+
      |    |   | usage_ledger (PG)   |
      |    |   +---------------------+
 +----v----v-----------------------------+
 | OpenSearch: chunks (BM25 + kNN + ACL) |   Postgres: docs, principals, memberships,
 | pgvector (MVP alt)                    |   permissions, audit, ledger, checkpoints (RLS)
 +----^----------------------------------+
      | bulk index
 +----+--------------------------------------+
 | apps/worker: chunk -> embed -> index       |
 | consumes Kafka topics: doc.upsert, doc.del,|
 | acl.change, membership.change              |
 +----^--------------------------------------+
      | events (outbox)               | connector sync (webhook/poll)
 +----+----------------+      +-------+------------------------+
 | first-party work    |      | packages/connectors: drive,    |
 | system (Postgres)   |      | slack, ... (per-user OAuth)    |
 +---------------------+      +--------------------------------+
```

## Query flow (Ask my workspace)
1. API authenticates; resolves `tenant_id`, `user_id`, expands `principals = [user, groups..., tenant:all]`.
2. Query understanding (P1): rewrite using chat history.
3. Retrieval: OpenSearch hybrid (BM25 + kNN) **with `terms: acl_principals` filter** → RRF → top 50.
4. Rerank (cross-encoder) → top 8–12.
5. **Verify** each doc against source of record (or fresh ACL read); drop failures.
6. Build prompt: system rules + untrusted-context block (delimited, labelled) + question.
7. Gateway call (tier by task) → stream tokens; validator enforces citations ⊆ verified set.
8. Write audit row (user, query hash, doc ids), usage ledger row, trace.
9. Degrade: LLM failure → return ranked results with snippets.

## Ingestion flow
Source event/poll → connector normalises to `Document` + `AclPrincipal[]` → Kafka `doc.upsert` → worker chunks (semantic + heading-aware, 400–800 tokens, 12% overlap) → embeds (batched, cached by content hash) → bulk index with ACL → ack checkpoint. ACL/membership changes flow on separate topics and update the ACL field (partial update) without re-embedding.

## Agent flow (Phase 3)
Trigger → create run (as delegated user) → LangGraph graph with Postgres checkpointer → tools from manifest (least privilege) → write tools hit approval policy (`interrupt`) → audit each call → caps on steps/tokens/cost → final result + notification.

## Data model (core tables, all with `tenant_id` + RLS)
`tenants, users, groups, group_members, nodes(hierarchy), node_permissions, documents, chunks(meta), chunk_embeddings(model,dim,vector), connectors, connector_accounts, sync_checkpoints, conversations, messages, memories, skills, agent_runs, agent_steps, approvals, audit_log, usage_ledger, plans, feedback, eval_runs`.

## Security model summary
- Identity: OIDC; every request has tenant + user; DB session sets `app.tenant_id`.
- Authorization: ACL principals on chunks; query-time group expansion; fetch-time verification.
- Caches keyed by `tenant|permHash|promptHash`.
- Untrusted content: delimited, never in system role, write-tools gated.
- Observability: trace id propagates API → retrieval → LLM; Langfuse links.
