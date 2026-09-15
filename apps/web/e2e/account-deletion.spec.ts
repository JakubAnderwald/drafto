import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Account deletion — the public explainer page and the settings confirm flow.
 *
 * The settings tests run as the shared E2E user, who must never really be
 * deleted. Every test there routes `DELETE /api/account` before the first click,
 * so the real endpoint is unreachable from this file: the gating tests answer
 * it with a 500 and assert it was never called, and the success test answers
 * it with a mocked `{ success: true }`.
 */

const WARNING =
  "This permanently deletes your Drafto account and all of your notebooks, notes and attachments. This cannot be undone.";

type AccountDeletionMock = { status: number; body: unknown };

/** Routes the account-deletion endpoint and returns the list of DELETE calls it saw. */
async function mockAccountDeletion(page: Page, response: AccountDeletionMock) {
  const deleteCalls: string[] = [];
  await page.route("**/api/account", async (route: Route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    deleteCalls.push(route.request().url());
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });
  return deleteCalls;
}

/**
 * A `local`-scope sign-out still asks Supabase to revoke the current session,
 * and that session is the one every spec shares through `e2e/.auth/user.json`.
 * Answer the logout call here so only this browser context forgets it.
 */
async function mockSupabaseLogout(page: Page) {
  await page.route("**/auth/v1/logout**", async (route: Route) => {
    // Cross-origin call to Supabase: Playwright answers the preflight itself.
    await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
  });
}

async function gotoSettings(page: Page) {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible({
    timeout: 10000,
  });
  // The API key list leaves its loading state only after hydration, so clicks land.
  await expect(page.getByText("Loading...")).toBeHidden({ timeout: 10000 });
}

async function openDeleteAccountDialog(page: Page) {
  const section = page.getByTestId("delete-account-section");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText(WARNING)).toBeVisible();
  await section.getByRole("button", { name: "Delete account" }).click();

  const dialog = page.getByRole("alertdialog", { name: "Delete your account?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Account deletion page", () => {
  // Must work for people who can no longer sign in, so use a signed-out context.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("is reachable without signing in and offers the email fallback", async ({ page }) => {
    await page.goto("/account/delete");

    await expect(page).toHaveURL(/\/account\/delete$/);
    await expect(
      page.getByRole("heading", { name: "Delete your account", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "What is deleted" })).toBeVisible();
    await expect(page.getByRole("link", { name: "support@drafto.eu" })).toHaveAttribute(
      "href",
      "mailto:support@drafto.eu",
    );
  });
});

test.describe("Delete account in settings", () => {
  test("confirm stays disabled until DELETE is typed, and cancel closes the dialog", async ({
    page,
  }) => {
    const deleteCalls = await mockAccountDeletion(page, {
      status: 500,
      body: { error: "E2E must not reach the real account deletion endpoint" },
    });

    await gotoSettings(page);
    const dialog = await openDeleteAccountDialog(page);
    const input = dialog.getByLabel("Type DELETE to confirm");
    const confirm = dialog.getByRole("button", { name: "Delete account" });

    await expect(confirm).toBeDisabled();
    await input.fill("delete");
    await expect(confirm).toBeDisabled();
    await input.fill("DELET");
    await expect(confirm).toBeDisabled();
    await input.fill("DELETE");
    await expect(confirm).toBeEnabled();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    // Reopening, without a reload, starts from scratch.
    const reopened = await openDeleteAccountDialog(page);
    await expect(reopened.getByLabel("Type DELETE to confirm")).toHaveValue("");
    await expect(reopened.getByRole("button", { name: "Delete account" })).toBeDisabled();

    expect(deleteCalls).toHaveLength(0);
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("a successful deletion signs out and shows the notice on the login page", async ({
    page,
  }) => {
    // Both mocks go in before anything on the page is clicked.
    const deleteCalls = await mockAccountDeletion(page, {
      status: 200,
      body: { success: true },
    });
    await mockSupabaseLogout(page);

    await gotoSettings(page);
    const dialog = await openDeleteAccountDialog(page);
    await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
    await dialog.getByRole("button", { name: "Delete account" }).click();

    await expect(page).toHaveURL(/\/login\?deleted=1$/, { timeout: 10000 });
    await expect(page.getByTestId("account-deleted-notice")).toHaveText(
      "Your account has been deleted.",
    );
    expect(deleteCalls).toHaveLength(1);
  });
});
