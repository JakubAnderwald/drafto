import { test, expect } from "@playwright/test";

/**
 * Admin user-approval close-button E2E.
 *
 * Requires an authenticated admin storage state, provisioned by the
 * "authenticate as admin" setup in `auth.setup.ts` from E2E_ADMIN_EMAIL /
 * E2E_ADMIN_PASSWORD. When those secrets are absent the admin Playwright
 * project is not registered (see `playwright.config.ts`), so these specs do
 * not run; the describe-level skip is a belt-and-suspenders guard.
 */
const hasAdminCreds = !!process.env.E2E_ADMIN_EMAIL && !!process.env.E2E_ADMIN_PASSWORD;

test.describe("admin user-approval close button", () => {
  test.skip(!hasAdminCreds, "Admin E2E requires E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD");

  test("admin sees the close button on /admin", async ({ page }) => {
    await page.goto("/admin");

    await expect(page.getByRole("button", { name: "Close admin" })).toBeVisible();
  });

  test("clicking close navigates to / without a full reload", async ({ page }) => {
    await page.goto("/admin");

    // A full page reload fires a top-level "load" event; SPA navigation does
    // not. Attach the listener before the click and assert it never fires.
    let loadCount = 0;
    page.on("load", () => {
      loadCount += 1;
    });

    await page.getByRole("button", { name: "Close admin" }).click();

    await expect(page).toHaveURL("/");
    expect(loadCount).toBe(0);
  });
});
