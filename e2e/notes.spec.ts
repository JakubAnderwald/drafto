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
    await page.getByRole("button", { name: "New note", exact: true }).click();

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

    // --- Reload the page and verify persistence ---
    await page.reload();

    // Wait for app to reload
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // After reload, the note list should show our title (fresh fetch from API)
    await expect(page.getByText(noteTitle)).toBeVisible({ timeout: 5000 });

    // Find and click the note we created
    await page.getByText(noteTitle).click();

    // The title input should have our title
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(noteTitle, {
      timeout: 5000,
    });

    // The editor should contain our text
    await expect(page.getByText("Hello from E2E test")).toBeVisible({ timeout: 5000 });
  });

  test("move a note between notebooks", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Create a second notebook to move notes to
    const targetNotebook = `Target ${Date.now()}`;
    await page.getByRole("button", { name: "New notebook" }).click();
    const createInput = page.getByPlaceholder("Notebook name");
    await expect(createInput).toBeVisible();
    await createInput.fill(targetNotebook);
    await createInput.press("Enter");
    await expect(page.getByText(targetNotebook)).toBeVisible();

    // Switch back to the first notebook (auto-created "Notes" or whatever is first)
    const sidebar = page.locator("aside");
    const firstNotebook = sidebar.locator("nav li").first();
    await firstNotebook.click();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 5000 });

    // Create a note in the first notebook
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    const noteTitle = `Move Me ${Date.now()}`;
    await titleInput.clear();
    await titleInput.fill(noteTitle);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Reload to get fresh note list with updated title
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Now move the note: click the "..." menu on the note
    const noteList = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Notes" }) });
    const noteItem = noteList.getByText(noteTitle).locator("..");
    await noteItem.hover();
    await page.getByLabel(`Actions for ${noteTitle}`).click();

    // Click the target notebook in the move menu
    await page.getByRole("menuitem", { name: targetNotebook }).click();

    // The note should disappear from the current notebook's list
    await expect(noteList.getByText(noteTitle)).not.toBeVisible({ timeout: 5000 });

    // Switch to the target notebook — the note should be there
    await page.getByText(targetNotebook).click();
    await expect(noteList.getByText(noteTitle)).toBeVisible({ timeout: 10000 });
  });

  test("delete note to trash, view in trash, restore, and permanently delete", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Create a note to delete
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    const noteTitle = `Trash Test ${Date.now()}`;
    await titleInput.clear();
    await titleInput.fill(noteTitle);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Create a second note to test permanent delete
    await page.getByRole("button", { name: "New note", exact: true }).click();
    await expect(titleInput).toHaveValue("Untitled", { timeout: 5000 });

    const noteTitle2 = `Trash Perm ${Date.now()}`;
    await titleInput.clear();
    await titleInput.fill(noteTitle2);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Reload to get fresh note list
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    const noteList = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Notes" }) });

    // --- Delete the first note ---
    await expect(noteList.getByText(noteTitle)).toBeVisible({ timeout: 5000 });
    const noteItem = noteList.getByText(noteTitle).locator("..");
    await noteItem.hover();
    await page.getByLabel(`Actions for ${noteTitle}`).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();

    // Note should disappear from the list
    await expect(noteList.getByText(noteTitle)).not.toBeVisible({ timeout: 5000 });

    // --- Delete the second note ---
    await expect(noteList.getByText(noteTitle2)).toBeVisible({ timeout: 5000 });
    const noteItem2 = noteList.getByText(noteTitle2).locator("..");
    await noteItem2.hover();
    await page.getByLabel(`Actions for ${noteTitle2}`).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(noteList.getByText(noteTitle2)).not.toBeVisible({ timeout: 5000 });

    // --- Switch to Trash view ---
    const sidebar = page.locator("aside");
    await sidebar.getByRole("button", { name: /Trash/i }).click();
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible({ timeout: 5000 });

    // Both deleted notes should appear in trash
    await expect(page.getByText(noteTitle)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(noteTitle2)).toBeVisible({ timeout: 5000 });

    // --- Restore the first note ---
    const trashItem = page.getByText(noteTitle).locator("..");
    await trashItem.getByText("Restore").click();
    await expect(page.getByText(noteTitle)).not.toBeVisible({ timeout: 5000 });

    // --- Permanently delete the second note ---
    const trashItem2 = page.getByText(noteTitle2).locator("..");
    await trashItem2.getByText("Delete forever").click();
    await expect(page.getByText(noteTitle2)).not.toBeVisible({ timeout: 5000 });

    // --- Verify restoration: go back to the notebook ---
    await sidebar.locator("nav li").first().click();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 5000 });

    // Reload to verify from server
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Restored note should be visible in the notebook
    await expect(noteList.getByText(noteTitle)).toBeVisible({ timeout: 5000 });
    // Permanently deleted note should NOT be visible
    await expect(noteList.getByText(noteTitle2)).not.toBeVisible({ timeout: 5000 });
  });

  test("create multiple notes and switch between them", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Create first note
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    const title1 = `First Note ${Date.now()}`;
    await titleInput.clear();
    await titleInput.fill(title1);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Create second note
    await page.getByRole("button", { name: "New note", exact: true }).click();
    // Wait for the new note editor to load (title should reset)
    await expect(titleInput).toHaveValue("Untitled", { timeout: 5000 });

    const title2 = `Second Note ${Date.now()}`;
    await titleInput.clear();
    await titleInput.fill(title2);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Reload to get fresh note list with updated titles
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Both notes should be in the list after reload
    const noteList = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Notes" }) });
    await expect(noteList.getByText(title1)).toBeVisible({ timeout: 5000 });
    await expect(noteList.getByText(title2)).toBeVisible({ timeout: 5000 });

    // Switch to first note
    await noteList.getByText(title1).click();
    await expect(titleInput).toHaveValue(title1, { timeout: 5000 });

    // Switch back to second note
    await noteList.getByText(title2).click();
    await expect(titleInput).toHaveValue(title2, { timeout: 5000 });
  });
});
