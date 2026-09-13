import { expect, test, type Page } from "@playwright/test";
import { ADMIN_E2E_SKIP_REASON, getAdminCredentials } from "./helpers/admin-credentials";

/**
 * Admin — User Approval panel: closing it with the ✕ button or Escape.
 *
 * Runs in the `chromium-admin` project, signed in as E2E_ADMIN_EMAIL (see
 * auth.setup.ts). That project is only registered when the admin E2E variables
 * are set; the skip below covers running this file some other way.
 */
const hasAdminCredentials = getAdminCredentials() !== null;

const HEADING = "Admin — User Approval";

async function openAdminPanel(page: Page) {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: HEADING })).toBeVisible({ timeout: 10000 });
}

async function expectClosesWithoutReload(page: Page, close: () => Promise<void>) {
  // A full reload fires the page's load event; a soft navigation doesn't.
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });

  // The server-rendered panel is visible before it hydrates, and a click or
  // Escape before then does nothing — so retry until the navigation happens.
  await expect(async () => {
    if (new URL(page.url()).pathname !== "/") await close();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 2000 });
  }).toPass({ timeout: 15000 });

  await expect(page.getByRole("heading", { name: HEADING })).toBeHidden();
  await expect(page.getByTestId("notebooks-pane")).toBeVisible();
  expect(loads).toBe(0);
}

test.describe("Admin panel close button", () => {
  test.skip(!hasAdminCredentials, ADMIN_E2E_SKIP_REASON);

  test("shows a close button next to the heading", async ({ page }) => {
    await openAdminPanel(page);

    const headerRow = page.getByRole("heading", { name: HEADING }).locator("..");
    await expect(headerRow.getByRole("button", { name: "Close admin" })).toBeVisible();
  });

  test("clicking the close button closes the panel without a reload", async ({ page }) => {
    await openAdminPanel(page);

    // Bounded, so a click racing the navigation can't wait out the retry loop
    // for a button that has already unmounted.
    await expectClosesWithoutReload(page, () =>
      page.getByRole("button", { name: "Close admin" }).click({ timeout: 1000 }),
    );
  });

  test("pressing Escape closes the panel without a reload", async ({ page }) => {
    await openAdminPanel(page);

    await expectClosesWithoutReload(page, () => page.keyboard.press("Escape"));
  });
});
