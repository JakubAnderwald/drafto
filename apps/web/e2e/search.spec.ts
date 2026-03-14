import { test, expect } from "@playwright/test";

test.describe("Search functionality", () => {
  test("open search with Cmd+K, search for a note, and select it", async ({ page }) => {
    await page.goto("/");

    // Wait for app to load
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Open search with keyboard shortcut
    await page.keyboard.press("Meta+k");

    // Search overlay should appear with input
    const searchInput = page.getByPlaceholder("Search notes...");
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await expect(searchInput).toBeFocused();

    // Close with Escape
    await page.keyboard.press("Escape");
    await expect(searchInput).not.toBeVisible();
  });

  test("open search via icon button", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    // Click the search icon button
    await page.getByLabel("Search notes").click();

    // Search overlay should appear
    await expect(page.getByPlaceholder("Search notes...")).toBeVisible({ timeout: 5000 });
  });

  test("search for an existing note and verify results appear", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // First, create a note with known content
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    const noteTitle = `SearchTest ${Date.now()}`;
    await titleInput.clear();
    await titleInput.fill(noteTitle);

    // Wait for auto-save
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Open search via icon (Cmd+K is blocked while focus is in the title input)
    await page.getByLabel("Search notes").click();
    const searchInput = page.getByPlaceholder("Search notes...");
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    await searchInput.fill("SearchTest");

    // Wait for results
    await expect(page.getByText(noteTitle)).toBeVisible({ timeout: 10000 });
  });
});
