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
