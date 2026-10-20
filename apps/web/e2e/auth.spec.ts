import { test, expect, type Page, type Route } from "@playwright/test";

test.describe("Login", () => {
  // Login tests need a fresh (unauthenticated) browser context
  test.use({ storageState: { cookies: [], origins: [] } });

  test("successful login with valid credentials", async ({ page }) => {
    const email = process.env.E2E_TEST_EMAIL;
    const password = process.env.E2E_TEST_PASSWORD;
    if (!email || !password) {
      test.skip();
      return;
    }

    await page.goto("/login");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();

    // Should redirect away from login on success
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10000 });
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
  });

  test("logging in from the landing page opens the app at /, not the landing page", async ({
    page,
  }) => {
    const email = process.env.E2E_TEST_EMAIL;
    const password = process.env.E2E_TEST_PASSWORD;
    if (!email || !password) {
      test.skip();
      return;
    }

    // Signed out, `/` is the landing page; the client router may still hold it after login.
    await page.goto("/");
    await page.getByRole("link", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByRole("heading", { name: "What Drafto does" })).toHaveCount(0);
  });

  test("failed login with wrong password shows error", async ({ page }) => {
    const email = process.env.E2E_TEST_EMAIL;
    if (!email) {
      test.skip();
      return;
    }

    await page.goto("/login");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("definitely-wrong-password-123");
    await page.getByRole("button", { name: "Log in" }).click();

    // Should show error and stay on login page
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("failed login with nonexistent email shows error", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Email").fill("nonexistent-e2e-user@example.com");
    await page.getByLabel("Password").fill("some-password-123");
    await page.getByRole("button", { name: "Log in" }).click();

    // Should show error and stay on login page
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Auth page smoke tests", () => {
  // All auth pages should be accessible without authentication
  test.use({ storageState: { cookies: [], origins: [] } });

  test("signup page renders correctly", async ({ page }) => {
    await page.goto("/signup");

    await expect(page.getByRole("heading", { name: "Create Account" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign up" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
    await expect(page.getByPlaceholder("Min. 6 characters")).toBeVisible();
  });

  test("signup validation rejects short password", async ({ page }) => {
    await page.goto("/signup");

    await page.getByLabel("Email").fill("test@example.com");
    await page.getByLabel("Password").fill("abc");
    await page.getByRole("button", { name: "Sign up" }).click();

    // HTML5 minLength validation should prevent submission — form stays on page
    await expect(page).toHaveURL(/\/signup/);
    // The password field should still be visible (form not submitted)
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("forgot-password page renders correctly", async ({ page }) => {
    await page.goto("/forgot-password");

    await expect(page.getByRole("heading", { name: "Forgot Password" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to login" })).toBeVisible();
  });

  test("reset-password page renders correctly", async ({ page }) => {
    await page.goto("/reset-password");

    await expect(page.getByRole("heading", { name: "Reset Password" })).toBeVisible();
    await expect(page.getByLabel("New Password")).toBeVisible();
    await expect(page.getByLabel("Confirm Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset password" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to login" })).toBeVisible();
  });

  test("reset-password validation catches mismatched passwords", async ({ page }) => {
    await page.goto("/reset-password");

    await page.getByLabel("New Password").fill("abc123");
    await page.getByLabel("Confirm Password").fill("xyz789");
    await page.getByRole("button", { name: "Reset password" }).click();

    await expect(page.getByText("Passwords do not match")).toBeVisible({ timeout: 5000 });
  });

  test("cross-page navigation between auth pages", async ({ page }) => {
    // Login → Signup
    await page.goto("/login");
    await page.getByRole("link", { name: "Sign up" }).click();
    await expect(page).toHaveURL(/\/signup/);

    // Signup → Login
    await page.getByRole("link", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/login/);

    // Login → Forgot Password
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password/);

    // Forgot Password → Login
    await page.getByRole("link", { name: "Back to login" }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Sign-up with email confirmation", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  /**
   * Answers Supabase's sign-up the way it does with email confirmation on: the user, and no
   * session. Mocked so a run neither creates an account nor sends mail. Returns the request
   * URLs it saw.
   */
  async function mockSignupWithoutSession(page: Page) {
    const requests: string[] = [];
    await page.route("**/auth/v1/signup**", async (route: Route) => {
      requests.push(route.request().url());
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        // Cross-origin call to Supabase: Playwright answers the preflight itself.
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          aud: "authenticated",
          role: "authenticated",
          email: "new-e2e-user@example.com",
          identities: [],
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          created_at: now,
          updated_at: now,
        }),
      });
    });
    return requests;
  }

  test("shows the check-email state instead of bouncing to login", async ({ page }) => {
    const signupRequests = await mockSignupWithoutSession(page);

    await page.goto("/signup");
    await page.getByLabel("Email").fill("new-e2e-user@example.com");
    await page.getByLabel("Password").fill("e2e-password-123");
    await page.getByRole("button", { name: "Sign up" }).click();

    await expect(page.getByRole("heading", { name: "Check Your Email" })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByTestId("signup-check-email")).toContainText("new-e2e-user@example.com");
    await expect(page.getByRole("button", { name: "Sign up" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/signup$/);

    // The confirmation link comes back through this origin's PKCE callback.
    expect(signupRequests).toHaveLength(1);
    const redirectTo = new URL(signupRequests[0]).searchParams.get("redirect_to");
    expect(redirectTo).toBe(new URL("/auth/callback", page.url()).toString());

    await page.getByRole("link", { name: "Back to login" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the login page confirms the address where the apps' confirmation link lands", async ({
    page,
  }) => {
    // The apps run PKCE, so Supabase appends a code this browser cannot use; it must not matter.
    await page.goto("/login?confirmed=1&code=app-pkce-code");

    await expect(page.getByTestId("email-confirmed-notice")).toBeVisible();
    await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  });

  test("the login page explains a link the callback could not use", async ({ page }) => {
    await page.goto("/login?error=auth-callback-error");

    await expect(page.getByTestId("auth-callback-error-notice")).toBeVisible();
  });
});
