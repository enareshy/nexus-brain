import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/components/**/*.tsx"],
      // Auth wiring and the shell depend on the browser + Keycloak; verified end to end in the browser.
      exclude: [
        "src/**/*.test.*",
        "src/lib/auth.ts",
        "src/lib/config.ts",
        "src/components/AuthProvider.tsx",
        "src/components/AppShell.tsx",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
