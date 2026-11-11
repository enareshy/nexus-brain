import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.js";

// The main flows a person goes through, end to end. Each test signs in afresh, so none depends on another.
// Choices are marked only once saved, so tests click and then wait for them rather than use check().

test("someone signed out is asked to sign in, and can sign in and out again", async ({ page }) => {
  await page.goto("/memory");
  await expect(page.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
  await signIn(page, "bob");
  await expect(page.getByText("Bob Acme")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
});

test("search with nothing connected points the person to Connections", async ({ page }) => {
  await signIn(page, "gina");
  await page.getByPlaceholder("e.g. status of the login bug").fill("login bug");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\?q=login(\+|%20)bug/);
  const connect = page.getByRole("link", { name: "Connect Jira" });
  await expect(connect).toBeVisible();
  await connect.click();
  await expect(page).toHaveURL(/\/connections$/);
});

test("a person adds a memory, sees it kept after a reload, and deletes it", async ({ page }) => {
  await signIn(page, "bob");
  await page.goto("/memory");
  const text = `E2E memory ${Date.now()}`;
  await page.getByLabel("Something for Brain to remember").fill(text);
  await page.getByRole("button", { name: "Remember" }).click();
  const remembered = page.getByText(text);
  try {
    await expect(remembered).toBeVisible();
    await page.reload();
    await expect(remembered).toBeVisible();
  } finally {
    // Also after a failure, so test memories never pile up.
    const remove = page.getByRole("button", { name: `Delete: ${text}` });
    if (await remove.isVisible()) await remove.click();
  }
  await expect(remembered).toHaveCount(0);
});

test("a person makes their agents read only and back, and it stays after a reload", async ({ page }) => {
  await signIn(page, "bob");
  await page.goto("/agents");
  const readOnly = page.getByRole("radio", { name: "Read only" });
  const ask = page.getByRole("radio", { name: "Ask me first" });
  // From "Ask me first", whatever an earlier run left behind.
  await ask.click();
  await expect(ask).toBeChecked();
  await readOnly.click();
  await expect(readOnly).toBeChecked();
  await page.reload();
  await expect(readOnly).toBeChecked();
  await ask.click();
  await expect(ask).toBeChecked();
});

test("a member sees the company's AI settings but cannot change them", async ({ page }) => {
  await signIn(page, "bob");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "AI settings" })).toBeVisible();
  await expect(page.getByText("Only an admin can change these.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);
});

test("an admin lets people choose their model, a member picks one, and the admin turns it off again", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  const member = await (await browser.newContext()).newPage();
  await signIn(admin, "pat.acme");
  await admin.goto("/admin");
  const choose = admin.getByRole("checkbox", { name: /People can choose their own model/ });
  const save = admin.getByRole("button", { name: "Save settings" });

  // Whatever an earlier run left: only save when it is not already on (Save is off with no change).
  if (!(await choose.isChecked())) {
    await choose.check();
    await save.click();
    await expect(admin.getByText("Saved.", { exact: false })).toBeVisible();
  }

  try {
    await signIn(member, "bob");
    await member.goto("/admin");
    const balanced = member.getByRole("radio", { name: "Balanced" });
    await balanced.click();
    await expect(balanced).toBeChecked();
    await member.reload();
    await expect(member.getByRole("radio", { name: "Balanced" })).toBeChecked();
  } finally {
    // The member's own choice first, while it can still be changed; then the company's switch.
    const company = member.getByRole("radio", { name: "Your company's choice" });
    if ((await company.isVisible()) && !(await company.isChecked())) {
      await company.click();
      await expect(company).toBeChecked();
    }
    await admin.reload();
    await choose.uncheck();
    await save.click();
    await expect(admin.getByText("Saved.", { exact: false })).toBeVisible();
  }
  await member.reload();
  await expect(member.getByText(/Your company uses one model for everyone/)).toBeVisible();
});
