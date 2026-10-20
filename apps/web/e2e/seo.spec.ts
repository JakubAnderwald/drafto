import { expect, test } from "@playwright/test";

/**
 * Crawlers and app-link verifiers visit signed out and don't follow a redirect to /login.
 * robots.txt, the sitemap and the `.well-known` association files must answer directly, and
 * the public pages must name their canonical URL on the apex host.
 */

test.describe("Search engine and app-link files (signed out)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("robots.txt is served and points at the sitemap", async ({ request }) => {
    const response = await request.get("/robots.txt", { maxRedirects: 0 });

    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("Sitemap: https://drafto.eu/sitemap.xml");
  });

  test("sitemap.xml is served and lists the landing and login pages", async ({ request }) => {
    const response = await request.get("/sitemap.xml", { maxRedirects: 0 });

    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("<loc>https://drafto.eu/</loc>");
    expect(body).toContain("<loc>https://drafto.eu/login</loc>");
  });

  test("the Universal Links association file is served as JSON", async ({ request }) => {
    const response = await request.get("/.well-known/apple-app-site-association", {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(await response.json()).toHaveProperty("applinks");
  });

  test("the login page declares its apex URL as canonical", async ({ page }) => {
    await page.goto("/login");

    await expect(page).toHaveTitle("Log in — Drafto");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://drafto.eu/login",
    );
  });

  test("auth utility pages are kept out of search results", async ({ page }) => {
    await page.goto("/forgot-password");

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });
});
