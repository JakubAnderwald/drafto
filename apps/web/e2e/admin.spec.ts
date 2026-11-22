import { expect, test, type Page } from "@playwright/test";
import { ADMIN_E2E_SKIP_REASON, getAdminCredentials } from "./helpers/admin-credentials";

/**
 * Admin — Accounts panel: closing it with the ✕ button or Escape.
 *
 * Runs in the `chromium-admin` project, signed in as E2E_ADMIN_EMAIL (see
 * admin.setup.ts). That project is only registered when the admin E2E variables
 * are set; the skip below covers running this file some other way.
 */
const hasAdminCredentials = getAdminCredentials() !== null;

const HEADING = "Admin — Accounts";

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

const STATS_SECTIONS = [
  "Needs attention",
  "Platform limits",
  "Activation",
  "Writers",
  "Depth",
  "Sign-ups",
  "Active users and retention",
];

test.describe("Admin product metrics", () => {
  test.skip(!hasAdminCredentials, ADMIN_E2E_SKIP_REASON);

  test("the admin panel links to /admin/stats, which shows every section", async ({ page }) => {
    await openAdminPanel(page);
    const metricsLink = page.getByRole("link", { name: "Product metrics" });
    await expect(metricsLink).toHaveClass(/\bui-link\b/);
    await metricsLink.click();

    await page.waitForURL((url) => url.pathname === "/admin/stats", { timeout: 15000 });
    await expect(page.getByRole("heading", { level: 1, name: "Product metrics" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(STATS_SECTIONS);

    // The weekly hosting-usage readout (ADR-0093): its readings, or why there are none.
    await expect(page.getByTestId("metrics-section-platform-limits")).toContainText(
      /No dashboard readout yet|Vercel — |Supabase — /,
    );

    // The page scrolls inside the app shell, which clips overflow: the last section must be
    // reachable, not cut off below the fold.
    const last = page.getByRole("heading", { level: 2, name: STATS_SECTIONS.at(-1) });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
  });
});
