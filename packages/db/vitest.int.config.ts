import { defineConfig } from "vitest/config";

// Integration tests need `pnpm infra:up`. They run serially against the shared database.
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
