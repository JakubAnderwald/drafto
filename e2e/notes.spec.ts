import { test, expect } from "@playwright/test";

test.describe("Note editing flow", () => {
  test("create note, edit title, type content, verify auto-save, and reload to confirm persistence", async ({
    page,
  }) => {
    await page.goto("/");

    // Wait for the app shell to load — notebooks sidebar should be visible
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    // Wait for a notebook to be auto-selected (shows "Notes" heading in middle panel)
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // --- Create a new note ---
    await page.getByRole("button", { name: "New note" }).click();

    // The editor panel should appear with a title input
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // --- Edit the title ---
    const noteTitle = `E2E Test Note ${Date.now()}`;
    await titleInput.clear();
    await titleInput.fill(noteTitle);

    // --- Type content in the BlockNote editor ---
    // BlockNote renders a contenteditable div
    const editor = page.locator("[contenteditable='true']").first();
    await expect(editor).toBeVisible({ timeout: 5000 });
    await editor.click();
    await page.keyboard.type("Hello from E2E test");

    // --- Wait for auto-save to complete ---
    // The save indicator shows "Saving..." then "Saved"
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // --- Verify the note appears in the note list with the correct title ---
    const noteList = page.locator("section").nth(1);
    await expect(noteList.getByText(noteTitle)).toBeVisible();

    // --- Reload the page and verify persistence ---
    await page.reload();

    // Wait for app to reload
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Find and click the note we created
    await page.getByText(noteTitle).click();

    // The title input should have our title
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(noteTitle, {
      timeout: 5000,
    });

    // The editor should contain our text
    await expect(page.getByText("Hello from E2E test")).toBeVisible({ timeout: 5000 });
  });

  test("create multiple notes and switch between them", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Create first note
    await page.getByRole("button", { name: "New note" }).click();
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    const title1 = `First Note ${Date.now()}`;
    await titleInput.clear();
    await titleInput.fill(title1);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Create second note
    await page.getByRole("button", { name: "New note" }).click();
    // Wait for the new note editor to load (title should reset)
    await expect(titleInput).toHaveValue("Untitled", { timeout: 5000 });

    const title2 = `Second Note ${Date.now()}`;
    await titleInput.clear();
    await titleInput.fill(title2);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Both notes should be in the list
    const noteList = page.locator("section").nth(1);
    await expect(noteList.getByText(title1)).toBeVisible();
    await expect(noteList.getByText(title2)).toBeVisible();

    // Switch to first note
    await noteList.getByText(title1).click();
    await expect(titleInput).toHaveValue(title1, { timeout: 5000 });

    // Switch back to second note
    await noteList.getByText(title2).click();
    await expect(titleInput).toHaveValue(title2, { timeout: 5000 });
  });
});
