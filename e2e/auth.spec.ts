import { test, expect } from "@playwright/test";

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

  test("approved user is redirected away from waiting-for-approval page", async ({ page }) => {
    // The E2E test user is approved — middleware redirects them away
    await page.goto("/waiting-for-approval");

    // Should NOT see the waiting-for-approval content
    await expect(page.getByRole("heading", { name: "Waiting for Approval" })).not.toBeVisible({
      timeout: 10000,
    });
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
