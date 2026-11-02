import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.int.test.ts"],
    setupFiles: ["reflect-metadata"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Services, vault and the proposals API are covered (and threshold-gated) by the integration suite.
      exclude: [
        "src/**/*.test.ts",
        "src/main.ts",
        "src/test-support/**",
        "src/connections/connections.service.ts",
        "src/connections/vault-store.ts",
        "src/proposals/**",
        "src/admin/**",
        "src/agents/**",
        "src/conversations/**",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
