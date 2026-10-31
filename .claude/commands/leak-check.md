---
description: Run the permission-leak red-team suite and audit the current diff
---

1. Run `pnpm test:leak` and summarise failures.
2. Invoke the `permission-auditor` subagent on the current `git diff`.
3. If anything is CRITICAL or HIGH, stop and propose fixes with tests that reproduce the leak first.
