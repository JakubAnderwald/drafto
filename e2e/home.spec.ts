import { expect, test } from "@playwright/test";

test("home page loads and shows heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Drafto - Notes App" })).toBeVisible();
});

test("health API returns ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.status).toBe("ok");
  expect(body.timestamp).toBeDefined();
});
