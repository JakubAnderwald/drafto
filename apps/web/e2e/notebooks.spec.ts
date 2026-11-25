import { recordRunNotebook } from "./helpers/run-notebooks";
import { test, expect } from "./helpers/test";

const TRASHED_NOTES_WARNING = "Trashed notes inside will be permanently deleted.";

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

    // Double-click the notebook name text to enter edit mode
    await page.getByText(newNotebookName).dblclick();

    const editInput = page.locator("li").locator("input[type='text']");
    await expect(editInput).toBeVisible({ timeout: 5000 });
    await editInput.clear();
    await editInput.fill(renamedName);
    await editInput.press("Enter");

    // The renamed notebook should appear
    await expect(page.getByText(renamedName)).toBeVisible();
    await expect(page.getByText(newNotebookName)).not.toBeVisible();

    // --- Delete the notebook ---
    // The delete button is revealed on hover
    const notebookItem = page.locator("nav li").filter({ hasText: renamedName });
    await notebookItem.hover();

    await page.getByRole("button", { name: `Delete ${renamedName}`, exact: true }).click();

    // Confirm the deletion in the dialog
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 3000 });
    const confirmButton = dialog.getByRole("button", { name: "Delete" });

    // Delete is enabled once the dialog has checked for trashed notes. This notebook has
    // none, so the dialog doesn't warn about them.
    await expect(confirmButton).toBeEnabled({ timeout: 10000 });
    await expect(dialog.getByText(TRASHED_NOTES_WARNING)).toHaveCount(0);
    await confirmButton.click();

    // The notebook should be gone
    await expect(notebookItem).not.toBeVisible();
  });

  test("deleting a notebook that holds trashed notes warns that they will be permanently deleted", async ({
    page,
  }, testInfo) => {
    // A notebook whose only note is in the trash. The run-end teardown deletes the notebook
    // if the test fails before it does.
    const stamp = Date.now();
    const notebookName = `Test Notebook ${stamp}`;
    const notebookRes = await page.request.post("/api/notebooks", { data: { name: notebookName } });
    expect(notebookRes.ok()).toBe(true);
    const notebookId = ((await notebookRes.json()) as { id: string }).id;
    recordRunNotebook(testInfo, notebookId);

    // `/` opens the newest notebook, and other workers' tests add notes to whichever one it
    // opens. A newer, empty notebook takes that place, so they write into it rather than the
    // notebook this test deletes. That narrows the window to the round trip before the decoy
    // exists; it can't close it, so the test checks the notebook's contents before deleting
    // it. The run-end teardown deletes the decoy.
    const decoyRes = await page.request.post("/api/notebooks", {
      data: { name: `Decoy NB ${stamp}` },
    });
    expect(decoyRes.ok()).toBe(true);
    recordRunNotebook(testInfo, ((await decoyRes.json()) as { id: string }).id);

    const noteRes = await page.request.post(`/api/notebooks/${notebookId}/notes`);
    expect(noteRes.ok()).toBe(true);
    const noteId = ((await noteRes.json()) as { id: string }).id;
    const trashRes = await page.request.delete(`/api/notes/${noteId}`);
    expect(trashRes.ok()).toBe(true);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    const notebookItem = page.locator("nav li").filter({ hasText: notebookName });
    await expect(notebookItem).toBeVisible({ timeout: 10000 });
    await notebookItem.hover();
    await page.getByRole("button", { name: `Delete ${notebookName}`, exact: true }).click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(dialog.getByText(TRASHED_NOTES_WARNING)).toBeVisible({ timeout: 10000 });

    // Still only this test's trashed note: no other test wrote into the notebook before the
    // decoy existed, so the delete can't take another test's notes with it.
    const activeRes = await page.request.get(`/api/notebooks/${notebookId}/notes`);
    expect(activeRes.ok()).toBe(true);
    expect(await activeRes.json(), "another test added notes to this notebook").toEqual([]);
    const trashBeforeRes = await page.request.get("/api/notes/trash");
    expect(trashBeforeRes.ok()).toBe(true);
    const trashedHere = (
      (await trashBeforeRes.json()) as Array<{ id: string; notebook_id: string }>
    )
      .filter((note) => note.notebook_id === notebookId)
      .map((note) => note.id);
    expect(trashedHere, "another test trashed notes in this notebook").toEqual([noteId]);

    await dialog.getByRole("button", { name: "Delete" }).click();

    // The notebook is gone, and its trashed note went with it
    await expect(notebookItem).not.toBeVisible();
    const trashListRes = await page.request.get("/api/notes/trash");
    expect(trashListRes.ok()).toBe(true);
    const trashed = (await trashListRes.json()) as Array<{ id: string }>;
    expect(trashed.map((note) => note.id)).not.toContain(noteId);
  });

  test("PrimeTestLab 11035 M-01: a taken notebook name is refused, in the API and the sidebar", async ({
    page,
  }, testInfo) => {
    const notebookName = `Test Notebook ${Date.now()}`;
    const notebookRes = await page.request.post("/api/notebooks", { data: { name: notebookName } });
    expect(notebookRes.ok()).toBe(true);
    recordRunNotebook(testInfo, ((await notebookRes.json()) as { id: string }).id);

    // The API refuses the same name in another case with a 409 that names the notebook.
    const duplicateMessage = `A notebook named "${notebookName}" already exists. Choose a different name.`;
    const duplicateRes = await page.request.post("/api/notebooks", {
      data: { name: notebookName.toUpperCase() },
    });
    expect(duplicateRes.status()).toBe(409);
    expect(((await duplicateRes.json()) as { error: string }).error).toBe(duplicateMessage);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();
    const notebookItem = page.locator("nav li").filter({ hasText: notebookName });
    await expect(notebookItem).toBeVisible({ timeout: 10000 });

    // PrimeTestLab 11035 S-03: the row shows its note count. Other workers may add notes to
    // the newest notebook, so only the shape is checked.
    await expect(notebookItem.getByTestId("notebook-note-count")).toHaveText(/^\d+ notes?$/);

    // The sidebar refuses it too, keeps the field open, and creates nothing.
    await page.getByRole("button", { name: "New notebook" }).click();
    const createInput = page.getByPlaceholder("Notebook name");
    await createInput.fill(` ${notebookName.toLowerCase()} `);
    await createInput.press("Enter");
    await expect(page.getByTestId("notebook-name-error")).toHaveText(duplicateMessage);
    await expect(createInput).toBeVisible();

    await createInput.press("Escape");
    await expect(createInput).not.toBeVisible();
    await expect(page.getByTestId("notebook-name-error")).toHaveCount(0);
    await expect(page.locator("nav li").filter({ hasText: notebookName })).toHaveCount(1);
  });

  test("issue #480: creating a notebook with Enter sends one request and lists it first", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    const isCreate = (method: string, url: string) =>
      method === "POST" && new URL(url).pathname === "/api/notebooks";
    let createRequests = 0;
    page.on("request", (request) => {
      if (isCreate(request.method(), request.url())) createRequests += 1;
    });

    const name = `Test Notebook ${Date.now()}`;
    await page.getByRole("button", { name: "New notebook" }).click();
    const createInput = page.getByPlaceholder("Notebook name");
    await expect(createInput).toBeVisible();
    await createInput.fill(name);

    const created = page.waitForResponse((res) =>
      isCreate(res.request().method(), res.request().url()),
    );
    await createInput.press("Enter");
    const res = await created;
    expect(res.ok()).toBe(true);
    recordRunNotebook(testInfo, ((await res.json()) as { id: string }).id);

    // Enter closes the field. Its blur must not send the create a second time.
    await expect(createInput).toBeHidden();
    // Leave a stray second request time to go out before counting.
    await page.waitForTimeout(500);
    expect(createRequests).toBe(1);

    // The sidebar keeps the server's order (newest `updated_at` first), so the new notebook is
    // the first row straight away. Checked before any reload: other workers create notebooks
    // too, and a refetch would list theirs above it.
    await expect(page.getByTestId("notebook-name").first()).toHaveText(name);
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
