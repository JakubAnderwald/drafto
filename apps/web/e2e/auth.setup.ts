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
