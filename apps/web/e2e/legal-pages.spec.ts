import { expect, test, type Page } from "@playwright/test";

/**
 * The privacy policy and support pages are linked from the App Store and Play listings,
 * so store reviewers open them signed out. Both must render for a visitor with no session
 * instead of redirecting to the login page.
 */

async function expectNoLoginForm(page: Page) {
  await expect(page.getByRole("button", { name: "Log in" })).toHaveCount(0);
  await expect(page.getByLabel("Password")).toHaveCount(0);
}

test.describe("Legal and support pages (signed out)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("privacy policy is reachable without signing in", async ({ page }) => {
    await page.goto("/privacy");

    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { name: "Privacy Policy", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Who is responsible/i })).toBeVisible();
    await expectNoLoginForm(page);
  });

  test("support page is reachable without signing in", async ({ page }) => {
    await page.goto("/support");

    await expect(page).toHaveURL(/\/support$/);
    await expect(page.getByRole("heading", { name: "Support", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "support@drafto.eu" }).first()).toHaveAttribute(
      "href",
      "mailto:support@drafto.eu",
    );
    await expectNoLoginForm(page);
  });

  test("the account deletion page's footer links open both pages signed out", async ({ page }) => {
    // The footer sits inside <main>, so it is not a "contentinfo" landmark for Playwright.
    const footer = page.locator("main > footer");

    await page.goto("/account/delete");
    await footer.getByRole("link", { name: "Privacy Policy", exact: true }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { name: "Privacy Policy", level: 1 })).toBeVisible();

    await footer.getByRole("link", { name: "Support", exact: true }).click();
    await expect(page).toHaveURL(/\/support$/);
    await expect(page.getByRole("heading", { name: "Support", level: 1 })).toBeVisible();
  });
});
