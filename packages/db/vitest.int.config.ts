import { defineConfig } from "vitest/config";
import { testDatabaseEnv } from "./src/test-database.js";

// Integration tests need `pnpm infra:up`. They run serially against their own `*_test` database,
// never the dev database.
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    globalSetup: ["./vitest.int.setup.ts"],
    env: testDatabaseEnv(),
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
