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

  test("shows the App Store badges and no Google Play badge yet", async ({ page }) => {
    await page.goto("/");
    const badges = page.getByRole("list", { name: "Get the app" });
    const appStoreUrl = "https://apps.apple.com/app/drafto/id6760675784";

    for (const name of [
      "Download Drafto on the App Store",
      "Download Drafto on the Mac App Store",
    ]) {
      const badge = badges.getByRole("link", { name });
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute("href", appStoreUrl);
      // Exactly one of the two theme variants is shown, and its artwork loaded.
      const shown = badge.locator("img:visible");
      await expect(shown).toHaveCount(1);
      await expect
        .poll(() => shown.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(0);
    }
    // GOOGLE_PLAY_PUBLIC is false until the Android app is live on Play; update this when it flips.
    await expect(page.getByRole("link", { name: /Google Play/ })).toHaveCount(0);
    await expect(page.locator('img[src*="google-play"]')).toHaveCount(0);
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

test.describe("Landing page store badges on a phone (signed out)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // 375px fits both badges on one line; 320px (the narrowest common phone) wraps them.
  for (const width of [375, 320]) {
    test(`stay centred and inside a ${width}px-wide screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/");
      const badges = page.getByRole("list", { name: "Get the app" }).getByRole("listitem");
      await expect(badges).toHaveCount(2);

      for (const badge of await badges.all()) {
        await expect(badge).toBeVisible();
        const box = await badge.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.height).toBe(40);
      }
      // No horizontal scrolling.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

      // Each line of badges is centred: its left and right margins match.
      const boxes = await Promise.all((await badges.all()).map((badge) => badge.boundingBox()));
      const lines = new Map<number, { left: number; right: number }>();
      for (const box of boxes) {
        const line = lines.get(box!.y) ?? { left: Infinity, right: -Infinity };
        lines.set(box!.y, {
          left: Math.min(line.left, box!.x),
          right: Math.max(line.right, box!.x + box!.width),
        });
      }
      for (const { left, right } of lines.values()) {
        expect(Math.abs(left - (width - right))).toBeLessThanOrEqual(1);
      }
      expect(lines.size).toBe(width === 320 ? 2 : 1);
    });
  }
});
