import { test as setup, expect } from "@playwright/test";

/**
 * Authenticate as the E2E test user and save storage state.
 *
 * Requires environment variables:
 *   E2E_TEST_EMAIL    — email of an approved test user
 *   E2E_TEST_PASSWORD — password for that user
 */
setup("authenticate", async ({ page }) => {
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;

  if (!email || !password) {
    throw new Error("E2E_TEST_EMAIL and E2E_TEST_PASSWORD must be set to run E2E tests");
  }

  await page.goto("/login");

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();

  // Wait until we're redirected away from the login page
  await expect(page).not.toHaveURL(/\/login/);

  // Save signed-in state to file
  await page.context().storageState({ path: "e2e/.auth/user.json" });
});

/**
 * Authenticate as an admin E2E user and save storage state.
 *
 * Optional — skipped cleanly when the admin credentials are absent. Requires:
 *   E2E_ADMIN_EMAIL    — email of an approved admin test user
 *   E2E_ADMIN_PASSWORD — password for that user
 */
setup("authenticate as admin", async ({ page }) => {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;

  setup.skip(!email || !password, "E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD not set");
  if (!email || !password) return; // unreachable after skip; narrows types

  await page.goto("/login");

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();

  // Wait until we're redirected away from the login page
  await expect(page).not.toHaveURL(/\/login/);

  // Save signed-in admin state to file
  await page.context().storageState({ path: "e2e/.auth/admin.json" });
});
