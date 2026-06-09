import { test, expect } from "@playwright/test";

test.describe("Evernote export", () => {
  test("opens the export dialog from the app menu", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("app-menu-trigger").click();

    const exportButton = page.getByTestId("export-evernote-button");
    await expect(exportButton).toBeVisible();
    await exportButton.click();

    const dialog = page.getByTestId("export-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("export-start-button")).toBeVisible();
    await expect(page.getByTestId("export-select-all")).toBeVisible();
    await expect(page.getByTestId("export-deselect-all")).toBeVisible();
  });

  test("selecting a notebook and exporting triggers a .enex download", async ({ page }) => {
    // Ensure at least one notebook exists so the export has something to ship.
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    const notebookName = `Export NB ${Date.now()}`;
    await page.getByRole("button", { name: "New notebook" }).click();
    const createInput = page.getByPlaceholder("Notebook name");
    await expect(createInput).toBeVisible();
    await createInput.fill(notebookName);
    await createInput.press("Enter");
    await expect(page.getByText(notebookName)).toBeVisible();

    await page.getByText(notebookName).click();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10_000 });

    // Create a note and wait for it to persist — without this the GET
    // /api/export/evernote can race the note's POST and report zero notes,
    // which makes the subsequent POST /api/export/evernote return 404.
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 10_000 });
    await titleInput.fill(`Export Test Note ${Date.now()}`);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10_000 });

    // Open the export dialog.
    await page.getByTestId("app-menu-trigger").click();
    await page.getByTestId("export-evernote-button").click();

    const dialog = page.getByTestId("export-dialog");
    await expect(dialog).toBeVisible();

    // Wait until the notebook list has loaded — the loading state goes away
    // once the GET /api/export/evernote response is in.
    await expect(page.getByTestId("export-loading")).toBeHidden({ timeout: 10_000 });

    // The dialog pre-selects every notebook that has notes. On the shared dev
    // Supabase project this can include hundreds of accumulated notebooks,
    // and exporting all of them takes far longer than the test's download
    // timeout. Scope the export to just the notebook this test created so the
    // assertion stays fast and deterministic.
    await page.getByTestId("export-deselect-all").click();
    await page.getByRole("checkbox", { name: notebookName, exact: true }).check();

    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByTestId("export-start-button").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.enex$/);

    // Verify the file body parses as XML containing en-export.
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf-8");
    expect(body).toContain("<en-export");
    expect(body).toContain("</en-export>");
  });
});
