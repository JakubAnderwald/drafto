import { expect, test } from "@playwright/test";

test("authenticated user sees app shell with notebooks", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
});

test("health API returns ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.status).toBe("ok");
  expect(body.timestamp).toBeDefined();
  // `null` when `VERCEL_GIT_COMMIT_SHA` isn't set (local, CI); the full SHA on Vercel.
  expect(body).toHaveProperty("commit");
  if (body.commit !== null) {
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
  }
});
