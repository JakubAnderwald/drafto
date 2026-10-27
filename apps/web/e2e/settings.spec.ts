import { expect, test } from "@playwright/test";

// What React logs when hydration fails or a boundary falls back to a client render: production
// builds (CI's `pnpm start`) print the minified codes, #418 for a mismatch, #419 for a server
// render error, #422 and #423 for a hydration error recovered by a client render, and React 18's
// #425 for a text mismatch. `pnpm dev` prints the full text ("Hydration failed because ...").
const HYDRATION_ERROR = /#(?:418|419|422|423|425)\b|hydrat|Switched to client rendering/i;

interface McpConfig {
  mcpServers: { drafto: { url: string } };
}

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
 * The "Connect to Claude" snippet points at the origin the page is served from (#748). The
 * server renders drafto.eu's origin and the browser hydrates that before switching to its own,
 * so the page loads without a hydration error on localhost and on previews too.
 */
test("the MCP snippet shows the page's own origin, and the page hydrates without errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/settings");

  // Before hydration the snippet still shows drafto.eu, so wait for the switch rather than
  // reading it once.
  const expectedUrl = `${new URL(page.url()).origin}/api/mcp`;
  const snippet = page.locator("code", { hasText: "mcpServers" });
  await expect(snippet).toContainText(`"url": "${expectedUrl}"`, { timeout: 10000 });
  const config = JSON.parse((await snippet.textContent()) ?? "") as McpConfig;
  expect(config.mcpServers.drafto.url).toBe(expectedUrl);

  // React reports a failed hydration when it commits. Let the page finish loading and the main
  // thread go idle so that has happened before checking.
  await page.waitForLoadState("load");
  await page.evaluate(
    () => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 5000 })),
  );

  expect(errors.filter((text) => HYDRATION_ERROR.test(text))).toEqual([]);
});

/**
 * Revoking the key the "shown once" box holds must take its value off the page. Creates a real
 * key for the shared E2E user on the dev project and revokes it, which soft-deletes the row. The
 * key gets a unique name and only its own row is clicked, so parallel workers can't collide.
 */
test("revoking a just-generated key removes its value from the page", async ({ page }) => {
  // A UUID, not a timestamp: concurrent runs (other PRs' CI, a local run) share the E2E user,
  // and two keys with one name would make the row's Revoke click ambiguous.
  const keyName = `e2e-revoke-${crypto.randomUUID()}`;

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
