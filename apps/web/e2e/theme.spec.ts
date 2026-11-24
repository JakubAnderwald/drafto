import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/test";

/**
 * The browser chrome follows the in-app theme, not the OS (#865): `color-scheme` on `<html>`
 * (form controls, scroll bars) and `<meta name="theme-color">` (the mobile address and status
 * bars). So does Tailwind's `dark:` variant (#901), checked through the `/login` wordmark, whose
 * dark colour is a `dark:` utility, and through its "Sign up" link, whose `.ui-link` colour is too
 * (#910). Each case sets the OS to the opposite of the stored theme,
 * so a page that followed the OS would fail it. Signed out on /login, whose layout has the theme
 * toggle.
 */

const ORIGIN = "http://localhost:3000";
const LIGHT = { colorScheme: "light", themeColor: "#fff8f5" } as const;
const DARK = { colorScheme: "dark", themeColor: "#1f1b17" } as const;
/** `.brand-wordmark`: `text-primary-600`, and `dark:text-primary-300` under `.dark`. */
const WORDMARK = { light: "rgb(53, 37, 205)", dark: "rgb(148, 120, 255)" } as const;
/** `.ui-link` (#910): primary-600/700 in light mode, primary-300/200 under `.dark`. */
const UI_LINK = {
  light: { rest: "rgb(53, 37, 205)", hover: "rgb(40, 25, 168)" },
  dark: { rest: "rgb(148, 120, 255)", hover: "rgb(184, 164, 255)" },
} as const;

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

async function wordmarkColor(page: Page): Promise<string> {
  return page.locator(".brand-wordmark").evaluate((el) => getComputedStyle(el).color);
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

    test("color-scheme, theme-color and dark: follow the in-app theme from first paint", async ({
      page,
    }) => {
      await page.addInitScript(recordThemeColorAtBody);
      await page.goto("/login");

      expect(await page.evaluate(() => window.__themeColorAtBody)).toBe(expected.themeColor);
      await expect(page.getByTestId("theme-toggle")).toBeVisible();
      expect(await chrome(page)).toEqual(expected);
      expect(await wordmarkColor(page)).toBe(WORDMARK[expected.colorScheme]);
      await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);

      // The link has a 150 ms colour transition, so the retrying toHaveCSS reads it.
      const signUp = page.getByRole("link", { name: "Sign up" });
      await expect(signUp).toHaveCSS("color", UI_LINK[expected.colorScheme].rest);
      await signUp.hover();
      await expect(signUp).toHaveCSS("color", UI_LINK[expected.colorScheme].hover);
    });
  });
}

// The landing page's store badges ship a black and a white variant; `dark:` picks one.
for (const { stored, os, artwork } of [
  { stored: "dark", os: "light", artwork: "white" },
  { stored: "light", os: "dark", artwork: "black" },
] as const) {
  test.describe(`landing badges, in-app theme ${stored}, OS ${os}`, () => {
    test.use({ storageState: signedOutWithTheme(stored), colorScheme: os });

    test(`shows the ${artwork} artwork`, async ({ page }) => {
      await page.goto("/");
      const badge = page.getByRole("link", { name: "Download Drafto on the App Store" });
      const shown = badge.locator("img:visible");
      await expect(shown).toHaveCount(1);
      await expect(shown).toHaveAttribute("src", `/badges/app-store-${artwork}.svg`);
    });
  });
}

test.describe("toggling the theme", () => {
  test.use({ storageState: signedOutWithTheme("system"), colorScheme: "dark" });

  test("updates color-scheme, theme-color and dark: without a reload", async ({ page }) => {
    await page.goto("/login");
    const toggle = page.getByTestId("theme-toggle");
    await expect(toggle).toHaveAttribute("aria-label", "System theme (dark)");
    expect(await chrome(page)).toEqual(DARK);
    expect(await wordmarkColor(page)).toBe(WORDMARK.dark);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Light mode");
    expect(await chrome(page)).toEqual(LIGHT);
    expect(await wordmarkColor(page)).toBe(WORDMARK.light);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Dark mode");
    expect(await chrome(page)).toEqual(DARK);
    expect(await wordmarkColor(page)).toBe(WORDMARK.dark);

    // Under "system", an OS change moves the chrome with it.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "System theme (dark)");
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => chrome(page)).toEqual(LIGHT);
    await expect.poll(() => wordmarkColor(page)).toBe(WORDMARK.light);
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
