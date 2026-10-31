---
description: Execute a build phase from docs/BUILD-PLAN.md (usage: /phase 1)
argument-hint: <phase-number>
---

Execute **Phase $ARGUMENTS** of `docs/BUILD-PLAN.md`.

1. Read `CLAUDE.md`, `docs/REQUIREMENTS.md`, `docs/TECH-STACK.md`, `docs/ARCHITECTURE.md`, and the Phase $ARGUMENTS section of `docs/BUILD-PLAN.md`.
2. Create branch `phase-$ARGUMENTS-<short-name>`.
3. Produce a task list from the phase's tasks; confirm it with me if anything is ambiguous or an open question in REQUIREMENTS §5 blocks you.
4. Implement task by task with TDD. Cite requirement IDs in commits.
5. After each major task run typecheck, lint, tests; run `pnpm test:leak` and `pnpm eval` when relevant.
6. Use the `permission-auditor` and `retrieval-evaluator` subagents where CLAUDE.md says so, plus `code-reviewer`.
7. Stop when the phase **exit criteria** are met; print an exit-criteria checklist with evidence (test output, metrics). Do not start the next phase.
