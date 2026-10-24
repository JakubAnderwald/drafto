import { test, expect, type Page } from "@playwright/test";

/**
 * The /api/notebooks endpoint and the SSR layout prefetch both order by
 * updated_at desc, so the auto-selected notebook on `page.goto("/")` is
 * whichever was last touched — including by other parallel workers.
 *
 * Capture the currently-active notebook's name so the test can deterministically
 * re-select it after a reload (the active row carries data-testid).
 */
async function getActiveNotebookName(page: Page): Promise<string> {
  const active = page.locator('[data-testid="notebook-item-active"]');
  await active.waitFor({ timeout: 10000 });
  return (await active.innerText()).trim();
}

async function selectNotebookByName(page: Page, name: string): Promise<void> {
  await page.locator("nav li").filter({ hasText: name }).locator('[role="button"]').first().click();
}

// What React logs when hydration fails or a boundary falls back to a client render:
// #418 / "Hydration failed" for a mismatch, #419 / "Switched to client rendering"
// for a server render error (production builds print the minified codes).
const HYDRATION_ERROR =
  /#41[89]\b|Hydration failed|Switched to client rendering|server rendering errored|Failed to parse URL/i;

test.describe("Server-rendered note list", () => {
  test("first page load serves the notes in the HTML and hydrates without errors", async ({
    page,
  }) => {
    // A notebook holding one known note, so the server's HTML can be checked for its
    // row. Neither is deleted afterwards: the test keeps its notebook on top, so other
    // workers' tests open it by default. Deleting it could pull it out from under a test
    // that hasn't added its note yet, or take that test's trashed notes with it (the API
    // only refuses while a notebook holds live notes).
    const stamp = Date.now();
    const notebookName = `SSR NB ${stamp}`;
    const noteTitle = `SSR Note ${stamp}`;
    const notebookRes = await page.request.post("/api/notebooks", { data: { name: notebookName } });
    expect(notebookRes.ok()).toBe(true);
    const notebookId = ((await notebookRes.json()) as { id: string }).id;

    const noteRes = await page.request.post(`/api/notebooks/${notebookId}/notes`);
    expect(noteRes.ok()).toBe(true);
    const noteId = ((await noteRes.json()) as { id: string }).id;
    const patchRes = await page.request.patch(`/api/notes/${noteId}`, {
      data: { title: noteTitle },
    });
    expect(patchRes.ok()).toBe(true);

    // The server's HTML holds the seeded note's row, and no Suspense boundary was
    // handed to the client after a server error (`<!--$!-->`). The title is matched
    // as an element's text: the RSC payload in the same response carries the
    // layout's notes as JSON props, so a bare substring would match even if the
    // list never rendered. The skeleton's markup can still be there: once a page's
    // HTML passes React's chunk size, React streams a finished boundary after its
    // fallback, in the same response, and an inline script swaps it in.
    //
    // The layout renders the most recently updated notebook, and other workers
    // create notebooks in parallel. Renaming the notebook to its own name bumps its
    // `updated_at`, which puts it back on top before each attempt.
    let html = "";
    await expect(async () => {
      const bumpRes = await page.request.patch(`/api/notebooks/${notebookId}`, {
        data: { name: notebookName },
      });
      expect(bumpRes.ok()).toBe(true);
      const response = await page.request.get("/");
      expect(response.ok()).toBe(true);
      html = await response.text();
      expect(html).toContain(`>${noteTitle}</p>`);
    }).toPass({ timeout: 20000 });
    expect(html).toMatch(/<h2[^>]*>Notes<\/h2>/);
    expect(html).not.toContain("<!--$!-->");

    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // React reports a failed hydration when it commits. Let the page finish loading
    // and the main thread go idle so that has happened before checking.
    await page.waitForLoadState("load");
    await page.evaluate(
      () => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 5000 })),
    );

    expect(errors.filter((text) => HYDRATION_ERROR.test(text))).toEqual([]);
    await expect(page.getByTestId("list-skeleton")).toHaveCount(0);
  });
});

test.describe("Note editing flow", () => {
  test("create note, edit title, type content, verify auto-save, and reload to confirm persistence", async ({
    page,
  }) => {
    await page.goto("/");

    // Wait for the app shell to load — notebooks sidebar should be visible
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    // Wait for a notebook to be auto-selected (shows "Notes" heading in middle panel)
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    const activeNotebook = await getActiveNotebookName(page);

    // --- Create a new note ---
    await page.getByRole("button", { name: "New note", exact: true }).click();

    // The editor panel should appear with a title input
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // A new note's title field starts empty, with "Untitled" only as its placeholder,
    // so typing replaces it rather than appending to it.
    await expect(titleInput).toHaveValue("");
    await expect(titleInput).toHaveAttribute("placeholder", "Untitled");

    // --- Edit the title ---
    // Type key by key with no clear() first. fill() empties the field itself, so it
    // would pass even if the title were still "Untitled" text that typing appends to.
    const noteTitle = `E2E Test Note ${Date.now()}`;
    await titleInput.click();
    await titleInput.pressSequentially(noteTitle);
    await expect(titleInput).toHaveValue(noteTitle);

    // --- Type content in the BlockNote editor ---
    // BlockNote renders a contenteditable div
    const editor = page.locator("[contenteditable='true']").first();
    await expect(editor).toBeVisible({ timeout: 5000 });
    await editor.click();
    await page.keyboard.type("Hello from E2E test");

    // --- Wait for auto-save to complete ---
    // The save indicator shows "Saving..." then "Saved"
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // --- The note's list row picks up the saved title without a reload ---
    await expect(page.locator('[data-testid="note-item-active"]')).toContainText(noteTitle, {
      timeout: 5000,
    });

    // --- Reload the page and verify persistence ---
    await page.reload();

    // Wait for app to reload
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    await selectNotebookByName(page, activeNotebook);
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
    // The note starts in a notebook made for this test. One picked from the sidebar
    // can be gone after the reload below: the e2e account can hold more notebooks than
    // a query returns (Supabase caps it at 1000 rows, most recently updated first), and
    // creating a notebook re-sorts the sidebar by name, so its first entry can be the
    // oldest one listed, which the new notebook has already pushed out of the query.
    // Another worker can also delete a notebook it created.
    //
    // The source isn't deleted afterwards: until Target exists it can be the newest
    // notebook, which other workers' tests open by default. Deleting it could pull it
    // out from under a test that hasn't added its note yet, or take that test's trashed
    // notes with it (the API only refuses while a notebook holds live notes).
    const sourceNotebookName = `Move Source ${Date.now()}`;
    const sourceRes = await page.request.post("/api/notebooks", {
      data: { name: sourceNotebookName },
    });
    expect(sourceRes.ok()).toBe(true);

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

    // Creating Target selected it, so switch to the source notebook.
    await selectNotebookByName(page, sourceNotebookName);
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 5000 });

    // Create a note in the source notebook
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    const noteTitle = `Move Me ${Date.now()}`;
    await titleInput.fill(noteTitle);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Reload to get fresh note list with updated title
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    // Re-select the source notebook explicitly — the auto-selected one after
    // reload is whichever is most-recently-updated, which may not be us.
    await selectNotebookByName(page, sourceNotebookName);
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

    const activeNotebook = await getActiveNotebookName(page);

    // Create a note to delete
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    const noteTitle = `Trash Test ${Date.now()}`;
    await titleInput.fill(noteTitle);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Create a second note to test permanent delete
    await page.getByRole("button", { name: "New note", exact: true }).click();
    // The editor has switched once the first note's title is gone and the new note's
    // empty title shows its placeholder.
    await expect(titleInput).toHaveValue("", { timeout: 5000 });
    await expect(titleInput).toHaveAttribute("placeholder", "Untitled");

    const noteTitle2 = `Trash Perm ${Date.now()}`;
    await titleInput.fill(noteTitle2);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Reload to get fresh note list
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    await selectNotebookByName(page, activeNotebook);
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
    await expect(page.getByText(noteTitle)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(noteTitle2)).toBeVisible({ timeout: 10000 });

    // --- Restore the first note ---
    const trashItem = page.getByText(noteTitle).locator("..");
    await trashItem.getByText("Restore").click();
    await expect(page.getByText(noteTitle)).not.toBeVisible({ timeout: 5000 });

    // --- Permanently delete the second note ---
    const trashItem2 = page.getByText(noteTitle2).locator("..");
    await trashItem2.getByText("Delete forever").click();
    await expect(page.getByText(noteTitle2)).not.toBeVisible({ timeout: 5000 });

    // --- Verify restoration: go back to the notebook ---
    await selectNotebookByName(page, activeNotebook);
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 5000 });

    // Reload to verify from server
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    await selectNotebookByName(page, activeNotebook);
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Restored note should be visible in the notebook
    await expect(noteList.getByText(noteTitle)).toBeVisible({ timeout: 5000 });
    // Permanently deleted note should NOT be visible
    await expect(noteList.getByText(noteTitle2)).not.toBeVisible({ timeout: 5000 });
  });

  test("create multiple notes and switch between them", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    const activeNotebook = await getActiveNotebookName(page);

    // Create first note
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    const title1 = `First Note ${Date.now()}`;
    await titleInput.fill(title1);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Create second note
    await page.getByRole("button", { name: "New note", exact: true }).click();
    // Wait for the new note editor to load: the first note's title gives way to the
    // new note's empty title and its placeholder.
    await expect(titleInput).toHaveValue("", { timeout: 5000 });
    await expect(titleInput).toHaveAttribute("placeholder", "Untitled");

    const title2 = `Second Note ${Date.now()}`;
    await titleInput.fill(title2);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 10000 });

    // Reload to get fresh note list with updated titles
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    await selectNotebookByName(page, activeNotebook);
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
