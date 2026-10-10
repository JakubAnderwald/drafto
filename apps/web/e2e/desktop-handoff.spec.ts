import { expect, test } from "@playwright/test";

/**
 * Supabase ends the macOS app's OAuth and password-reset redirects on these pages
 * (ADR-0044). The browser that lands here is signed out — the session belongs to the
 * app — so they must render without a login redirect, forward only the code (or error)
 * to the app's scheme, and clear the one-time code from the address bar.
 *
 * On a Mac the page navigates to `eu.drafto.desktop://` on its own. Headless Chromium
 * has no handler for it, so the page stays put and the assertions read it as rendered.
 */

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

test.describe("macOS app hand-off pages (signed out)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.describe("on a Mac", () => {
    test.use({ userAgent: MAC_UA });

    test("sign-in hand-off forwards only the code and clears it from the URL", async ({ page }) => {
      await page.goto("/auth/desktop/callback?code=abc&access_token=leak");

      await expect(
        page.getByRole("heading", { name: "Finishing sign-in in Drafto" }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Open Drafto" })).toHaveAttribute(
        "href",
        "eu.drafto.desktop://auth/callback?code=abc",
      );
      await expect(page).toHaveURL(/\/auth\/desktop\/callback$/);
      // Inherits the (auth) frame, including the footer Google's brand check reads.
      await expect(page.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
    });

    test("password-reset hand-off shows fixed copy for an expired link and forwards it", async ({
      page,
    }) => {
      await page.goto(
        "/auth/desktop/recovery#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      );

      await expect(
        page.getByRole("heading", { name: "Couldn't reset your password" }),
      ).toBeVisible();
      // Scoped: Next's route announcer is also a role="alert".
      await expect(page.getByTestId("desktop-handoff").getByRole("alert")).toHaveText(
        "This reset link has expired or was already used.",
      );
      await expect(page.getByText("Email link is invalid or has expired")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Open Drafto" })).toHaveAttribute(
        "href",
        "eu.drafto.desktop://auth/recovery?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      );
      await expect(page).toHaveURL(/\/auth\/desktop\/recovery$/);
    });

    test("an empty hand-off offers no button", async ({ page }) => {
      await page.goto("/auth/desktop/callback");

      await expect(page.getByRole("heading", { name: "Nothing to sign in with" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Open Drafto" })).toHaveCount(0);
    });
  });

  test("off the Mac, a reset link says to open it on the Mac instead of launching the app", async ({
    page,
  }) => {
    // The default Desktop Chrome device reports Windows.
    await page.goto("/auth/desktop/recovery?code=reset-code");

    await expect(page.getByRole("heading", { name: "Open this link on your Mac" })).toBeVisible();
    await expect(
      page.getByText(/only works on the Mac where you asked for the reset/),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/desktop\/recovery$/);
  });

  test("any other flow is a 404", async ({ page }) => {
    const response = await page.goto("/auth/desktop/other");

    expect(response?.status()).toBe(404);
  });

  test("the signed-out home page describes Drafto and links the privacy policy", async ({
    page,
  }) => {
    // Google's OAuth brand verification reads https://drafto.eu as the app's home page.
    await page.goto("/");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText(/Drafto is a note-taking app/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });
});
