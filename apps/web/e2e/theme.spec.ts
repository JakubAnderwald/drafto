import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/test";

/**
 * The browser chrome follows the in-app theme, not the OS (#865): `color-scheme` on `<html>`
 * (form controls, scroll bars) and `<meta name="theme-color">` (the mobile address and status
 * bars). Each case sets the OS to the opposite of the stored theme, so a page that followed the
 * OS would fail it. Signed out on /login, whose layout has the theme toggle.
 */

const ORIGIN = "http://localhost:3000";
const LIGHT = { colorScheme: "light", themeColor: "#fff8f5" };
const DARK = { colorScheme: "dark", themeColor: "#1f1b17" };

declare global {
  interface Window {
    /** The `theme-color` meta's content when `<body>` was parsed, before React ran. */
    __themeColorAtBody?: string | null;
  }
}

function recordThemeColorAtBody(): void {
  const observer = new MutationObserver(() => {
    if (!document.body) return;
    window.__themeColorAtBody =
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null;
    observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}

async function chrome(page: Page): Promise<{ colorScheme: string; themeColor: string | null }> {
  return page.evaluate(() => ({
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
  }));
}

function signedOutWithTheme(theme: string) {
  return {
    cookies: [],
    origins: [{ origin: ORIGIN, localStorage: [{ name: "theme", value: theme }] }],
  };
}

const CASES = [
  { stored: "dark", os: "light", expected: DARK },
  { stored: "light", os: "dark", expected: LIGHT },
  { stored: "system", os: "dark", expected: DARK },
  { stored: "system", os: "light", expected: LIGHT },
] as const;

for (const { stored, os, expected } of CASES) {
  test.describe(`in-app theme ${stored}, OS ${os}`, () => {
    test.use({ storageState: signedOutWithTheme(stored), colorScheme: os });

    test("color-scheme and theme-color follow the in-app theme from first paint", async ({
      page,
    }) => {
      await page.addInitScript(recordThemeColorAtBody);
      await page.goto("/login");

      expect(await page.evaluate(() => window.__themeColorAtBody)).toBe(expected.themeColor);
      await expect(page.getByTestId("theme-toggle")).toBeVisible();
      expect(await chrome(page)).toEqual(expected);
      await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
    });
  });
}

test.describe("toggling the theme", () => {
  test.use({ storageState: signedOutWithTheme("system"), colorScheme: "dark" });

  test("updates color-scheme and theme-color without a reload", async ({ page }) => {
    await page.goto("/login");
    const toggle = page.getByTestId("theme-toggle");
    await expect(toggle).toHaveAttribute("aria-label", "System theme (dark)");
    expect(await chrome(page)).toEqual(DARK);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Light mode");
    expect(await chrome(page)).toEqual(LIGHT);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Dark mode");
    expect(await chrome(page)).toEqual(DARK);

    // Under "system", an OS change moves the chrome with it.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "System theme (dark)");
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => chrome(page)).toEqual(LIGHT);
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
  });

  test("keeps one theme-color meta across a client-side navigation", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("theme-toggle").click(); // light, against the dark OS
    await expect.poll(() => chrome(page)).toEqual(LIGHT);

    await page.getByRole("link", { name: "Sign up" }).click();
    await expect(page).toHaveURL(/\/signup/);

    expect(await chrome(page)).toEqual(LIGHT);
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
  });
});

// /privacy has no theme toggle: the root layout's ThemeSync keeps the chrome in step there.
test.describe("a page without a theme toggle", () => {
  test.use({ storageState: signedOutWithTheme("system"), colorScheme: "light" });

  test("follows an OS change under system", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByTestId("theme-toggle")).toHaveCount(0);
    expect(await chrome(page)).toEqual(LIGHT);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => chrome(page)).toEqual(DARK);
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
  });
});
