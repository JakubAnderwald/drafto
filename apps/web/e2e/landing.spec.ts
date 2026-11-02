import { expect, test } from "@playwright/test";

/**
 * Signed-out `/` is the public home page. Middleware rewrites it to the landing page, so the
 * URL stays `/` and answers 200. It used to 307 to /login, which made Google index the login
 * form under `/` and ignore /login's own canonical.
 */

test.describe("Landing page (signed out)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/ answers 200 instead of redirecting to /login", async ({ request }) => {
    const response = await request.get("/", { maxRedirects: 0 });

    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("What Drafto does");
  });

  test("says what Drafto is and declares / as its canonical URL", async ({ page }) => {
    await page.goto("/");

    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByRole("heading", { level: 1, name: "Drafto" })).toBeVisible();
    await expect(page.getByText(/note-taking app for the web, iPhone, iPad/)).toBeVisible();
    // Next.js renders the root canonical without the trailing slash; it is the same URL.
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      /^https:\/\/drafto\.eu\/?$/,
    );
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  });

  test("leads to sign-up and login", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Sign up" }).click();
    await expect(page).toHaveURL(/\/signup$/);

    await page.goto("/");
    await page.getByRole("link", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("links the privacy policy and support page", async ({ page }) => {
    // Google's OAuth brand verification reads https://drafto.eu as the app's home page: it must
    // describe the app (checked above) and link the privacy policy.
    await page.goto("/");
    const legal = page.getByRole("navigation", { name: "Legal" });

    await expect(legal.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    await expect(legal.getByRole("link", { name: "Support" })).toHaveAttribute("href", "/support");
  });

  test("a direct visit to the landing page's route is sent to /", async ({ request }) => {
    const response = await request.get("/welcome", { maxRedirects: 0 });

    expect(response.status()).toBe(308);
    expect(new URL(response.headers()["location"], response.url()).pathname).toBe("/");
  });
});
