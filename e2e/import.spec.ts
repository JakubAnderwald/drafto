import { test, expect } from "@playwright/test";
import path from "node:path";

test.describe("Evernote Import", () => {
  test("shows import dialog from app menu", async ({ page }) => {
    // Navigate to the app (assumes authenticated session from global setup)
    await page.goto("/");

    // Open app menu
    const menuTrigger = page.getByTestId("app-menu-trigger");
    await menuTrigger.click();

    // Click import from evernote
    const importButton = page.getByTestId("import-evernote-button");
    await expect(importButton).toBeVisible();
    await importButton.click();

    // Dialog should be visible
    const dialog = page.getByTestId("import-dialog");
    await expect(dialog).toBeVisible();

    // Should have file input and notebook name
    await expect(page.getByTestId("notebook-name-input")).toBeVisible();
    await expect(page.getByTestId("file-input")).toBeVisible();
    await expect(page.getByTestId("start-import-button")).toBeVisible();
  });

  test("imports a sample .enex file", async ({ page }) => {
    await page.goto("/");

    // Open import dialog
    await page.getByTestId("app-menu-trigger").click();
    await page.getByTestId("import-evernote-button").click();

    // Upload fixture file
    const fileInput = page.getByTestId("file-input");
    const fixturePath = path.resolve(__dirname, "fixtures/sample.enex");
    await fileInput.setInputFiles(fixturePath);

    // Check notebook name was auto-filled
    const nameInput = page.getByTestId("notebook-name-input");
    await expect(nameInput).toHaveValue("sample");

    // Start import
    await page.getByTestId("start-import-button").click();

    // Wait for completion
    const status = page.getByTestId("import-status");
    await expect(status).toContainText("imported", { timeout: 30000 });
  });

  test("shows logout option in app menu", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("app-menu-trigger").click();

    const logoutButton = page.getByTestId("logout-button");
    await expect(logoutButton).toBeVisible();
    await expect(logoutButton).toHaveText("Log out");
  });
});
