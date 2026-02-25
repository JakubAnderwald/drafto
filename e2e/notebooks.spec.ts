import { test, expect } from "@playwright/test";

test.describe("Notebook management lifecycle", () => {
  test("create, rename, and delete a notebook", async ({ page }) => {
    await page.goto("/");

    // Should see the sidebar with "Notebooks" heading
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    // --- Create a new notebook ---
    const newNotebookName = `Test Notebook ${Date.now()}`;

    await page.getByRole("button", { name: "New notebook" }).click();

    // An inline input should appear
    const createInput = page.getByPlaceholder("Notebook name");
    await expect(createInput).toBeVisible();
    await createInput.fill(newNotebookName);
    await createInput.press("Enter");

    // The new notebook should appear in the sidebar and be selected
    await expect(page.getByText(newNotebookName)).toBeVisible();

    // --- Rename the notebook ---
    const renamedName = `Renamed ${Date.now()}`;

    // Double-click to enter edit mode
    const notebookListItem = page.locator("li").filter({ hasText: newNotebookName });
    await notebookListItem.dblclick();

    const editInput = notebookListItem.locator("input[type='text']");
    await editInput.clear();
    await editInput.fill(renamedName);
    await editInput.press("Enter");

    // The renamed notebook should appear
    await expect(page.getByText(renamedName)).toBeVisible();
    await expect(page.getByText(newNotebookName)).not.toBeVisible();

    // --- Delete the notebook ---
    // The delete button is revealed on hover
    const notebookItem = page.getByText(renamedName);
    await notebookItem.hover();

    await page.getByRole("button", { name: `Delete ${renamedName}` }).click();

    // The notebook should be gone
    await expect(page.getByText(renamedName)).not.toBeVisible();
  });

  test("default notebook exists on first visit", async ({ page }) => {
    await page.goto("/");

    // The app layout creates a "Notes" notebook if user has none
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    // There should be at least one notebook in the sidebar
    const sidebar = page.locator("aside");
    await expect(sidebar.locator("nav li").first()).toBeVisible({ timeout: 5000 });
  });
});
