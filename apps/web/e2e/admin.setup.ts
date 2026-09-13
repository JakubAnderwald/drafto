import { test as setup, expect } from "@playwright/test";
import { ADMIN_E2E_SKIP_REASON, getAdminCredentials } from "./helpers/admin-credentials";

/**
 * Authenticate as the E2E admin user and save storage state for `admin.spec.ts`.
 *
 * Runs in its own `setup-admin` project, which only `chromium-admin` depends on,
 * so a failed admin login skips the admin specs but not the rest of the suite.
 *
 * Optional — skipped unless all of these are set:
 *   E2E_ADMIN_EMAIL           — email of an approved user with `profiles.is_admin = true`
 *   E2E_ADMIN_PASSWORD        — password for that user
 *   SUPABASE_SERVICE_ROLE_KEY — dev project key; /admin needs it to render
 *
 * Use a separate account from E2E_TEST_EMAIL: making the shared test user an
 * admin would put the admin UI in front of every other spec.
 */
setup("authenticate as admin", async ({ page }) => {
  const credentials = getAdminCredentials();

  if (!credentials) {
    setup.skip(true, ADMIN_E2E_SKIP_REASON);
    return;
  }

  await page.goto("/login");

  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Log in" }).click();

  // Wait until we're redirected away from the login page
  await expect(page).not.toHaveURL(/\/login/);

  // Save signed-in admin state to file
  await page.context().storageState({ path: "e2e/.auth/admin.json" });
});
