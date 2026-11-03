import { testDatabaseEnv } from "@brain/db/testing";
import { defineConfig } from "vitest/config";

// Needs `pnpm infra:up` (Postgres). Runs serially against its own `*_test` database, never the dev database.
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    setupFiles: ["reflect-metadata"],
    globalSetup: ["./vitest.int.setup.ts"],
    env: testDatabaseEnv(),
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: [
        "src/connections/connections.service.ts",
        "src/connections/vault-store.ts",
        "src/proposals/proposals.service.ts",
        "src/proposals/proposals.controller.ts",
        "src/admin/**/*.ts",
        "src/agents/**/*.ts",
        "src/mcp/**/*.ts",
        "src/conversations/**/*.ts",
        "src/memory/**/*.ts",
        "src/usage/**/*.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
