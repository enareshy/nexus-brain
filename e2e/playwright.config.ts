import { defineConfig, devices } from "@playwright/test";
import { API_ENV, WEB_ENV } from "./test-env.js";

// End-to-end checks of the main flows in a real browser: Keycloak sign-in, the web app and the API.
// The API runs on a test database (`brain_test`), never the dev one, with every AI and outside-service
// key blanked, so a run costs nothing and reaches nothing real (see test-env.ts). Needs `pnpm infra:up` (Postgres and Keycloak) and the ports
// 3000 and 3001 free: the web app must be on 3000, as Keycloak only redirects there.

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  // One browser and one database: tests run in order so they never change each other's data mid-test.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @brain/api start",
      cwd: "..",
      url: "http://127.0.0.1:3001/health",
      // Never a dev server already running on the dev database.
      reuseExistingServer: false,
      timeout: 120_000,
      env: API_ENV,
    },
    {
      command: "pnpm --filter @brain/web dev",
      cwd: "..",
      url: "http://localhost:3000",
      reuseExistingServer: false,
      timeout: 180_000,
      env: WEB_ENV,
    },
  ],
});
