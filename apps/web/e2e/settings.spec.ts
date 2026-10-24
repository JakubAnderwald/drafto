import { expect, test } from "@playwright/test";

/**
 * The Settings page: a server wrapper that reads the running build's commit and renders the
 * client settings UI. Runs signed in as the shared E2E user (the chromium project's storage
 * state). Local and CI servers have no `VERCEL_GIT_COMMIT_SHA`, so the build line is usually
 * absent here; on a Vercel deployment it reads `Build <first 7 characters of the SHA>`.
 */
test("settings page renders, with a well-formed build line when the commit is known", async ({
  page,
}) => {
  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible();

  const buildLine = page.getByTestId("build-commit");
  if ((await buildLine.count()) > 0) {
    await expect(buildLine).toHaveText(/^Build [0-9a-f]{7}$/);
  }
});

/**
 * Revoking the key the "shown once" box holds must take its value off the page. Creates a real
 * key for the shared E2E user on the dev project and revokes it, which soft-deletes the row. The
 * key gets a unique name and only its own row is clicked, so parallel workers can't collide.
 */
test("revoking a just-generated key removes its value from the page", async ({ page }) => {
  const keyName = `e2e-revoke-${Date.now()}`;

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible({ timeout: 10000 });
  // The key list leaves its loading state only after hydration and the first fetch, so the fill
  // and click land and that fetch can't overwrite the list refreshed after Generate.
  await expect(page.getByText("Loading...")).toBeHidden({ timeout: 10000 });

  await page.getByPlaceholder("Key name (e.g. Claude Desktop)").fill(keyName);
  await page.getByRole("button", { name: "Generate key" }).click();

  // Only the box holds a full key; list rows show just the `dk_xxxxx...` prefix. Match it by
  // shape, never by value: a locator built from the key would put it in the step title, and the
  // CI report scan (scripts/scan-playwright-report.mjs) withholds any report that carries one.
  const revealed = page.getByText(/^dk_[0-9a-f]{48}$/);
  await expect(revealed).toBeVisible({ timeout: 10000 });

  const row = page.getByRole("listitem").filter({ hasText: keyName });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Revoke" }).click();

  await expect(row).toHaveCount(0);
  await expect(revealed).toHaveCount(0);
  await expect(page.getByText(/copy it now/)).toHaveCount(0);
});
