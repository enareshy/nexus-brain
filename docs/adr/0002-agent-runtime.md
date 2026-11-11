# ADR 0002: A small agent runtime of our own, instead of LangGraph

Status: accepted, 2026-11-02. Departs from FR-AGT-01 and `docs/TECH-STACK.md`, which name LangGraph.

## Decision
Agents run on about 300 lines in `apps/api/src/agents`: a loop over model turns, with progress saved to Postgres after each step.

## Why
- The first agent is one loop: ask the model, run one tool, repeat, pause for approval. No branching graph is needed.
- Every rule that matters must live in our code either way: the fixed tool list, approvals, audit, caps and per-person isolation.
- Saved state must be encrypted and protected by row-level security. Our own tables already follow that pattern; a third-party checkpointer would need its schema adapted to it.
- No new dependency to review, and the model call stays inside `packages/llm-gateway`.

## What it gives up
Graph features such as parallel branches, sub-agents and time travel. Revisit LangGraph when an agent actually needs one of these. The saved state is private to this code, so switching affects only runs in progress.

## How it works
- **Saved progress.** A tool call is saved before it runs, so a restart continues from there without asking the model again. Reads may repeat. A proposal's id comes from the run and tool call, so repeating one finds the same proposal.
- **One worker per run.** A worker takes a time-limited lease in the database. An expired lease means the worker stopped.
- **Resuming is lazy.** Row-level security stops a background job from reading across people, so a run resumes when its owner opens the Agents page or that run. A run nobody opens stays where it was, and spends nothing.
- **Approvals.** The model can only propose. A proposal goes through the same approval path as a person's own change, and the run waits for the decision. Waiting uses no model calls.
- **Caps per run.** 8 model turns, $0.25 and 24 hours, which includes time spent waiting for a decision. The cost check runs between turns, so one turn can pass the limit. Per person: 2 working at once and 20 starts an hour.

- **Dropped connections.** A turn is asked again up to 3 times, because live runs lost connections to the AI service often. The cause on this network is unproven. A dropped turn counts an estimated cost, since it may have been charged.

## Not done yet
Triggers (FR-AGT-05), notifications when a run needs a decision (only the page shows it), a per-agent tool list (FR-AGT-02: one fixed list, narrowed by a skill), and agent evals. Documents an agent reads are labelled as untrusted, which lowers injection risk but cannot rule it out. The approval step is what stops a hijacked agent from changing anything, but a person must still read what they approve.

## Approval modes (FR-AGT-04)

An agent never changes anything itself: it proposes, and a person approves. Each person chooses "Ask me first" (the default) or "Read only" for their own agents on the Agents page, and an admin can make every agent in the company read only ("Agents can propose changes" in the AI settings). Both are read before every step. A read-only run is never offered the `propose_*` tools, and a proposal saved before the change, or asked for anyway, is refused like any tool outside the list. There is no mode that changes things without asking: agents always read outside content, and FR-WR-04 requires approval whenever they have. A change already waiting for a decision stays open; the person can still reject it. The settings cover Brain's own agents only, as the page and admin wording say. Proposals a person makes themselves (the Changes page, item drafts) and ones an outside AI tool makes through Brain's MCP server are not covered; extending "read only" to the MCP server is an open decision.
