import { expect, type Page } from "@playwright/test";

/** Seeded local Keycloak test users (infra/keycloak/brain-realm.json). Never real accounts. */
export type TestUser = "alice" | "bob" | "gina" | "pat.acme" | "pat.globex" | "gus";

// The local realm's shared dev password, from the realm file; overridable for another environment.
const PASSWORD = process.env.E2E_PASSWORD ?? "dev-password";

/** Signs in through the real Keycloak page and waits until the app shows the person signed in. */
export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto("/");
  await page.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/localhost:8081\/realms\/brain\//);
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#kc-login").click();
  await page.waitForURL("http://localhost:3000/**");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
