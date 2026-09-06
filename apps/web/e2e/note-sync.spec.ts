import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * External-change sync for the open note (issue #262).
 *
 * These drive the `visibilitychange` half of the feature, because it is the half that
 * can be scripted deterministically from a single browser context. The Realtime
 * `postgres_changes` push is exercised manually — see the note in
 * `docs/architecture/testing.md`. Both signals funnel into one reconciliation handler,
 * so what is asserted here (refetch, apply, surface trash) is the shared path.
 *
 * The "XPlat " title prefix is deliberate: it matches the cleanup patterns in
 * `e2e/helpers/cleanup.ts`, so anything these tests leak is swept up later.
 */

/** Best-effort cleanup — never throws. */
async function deleteNote(request: APIRequestContext, noteId: string): Promise<void> {
  await request.delete(`/api/notes/${noteId}`).catch(() => {});
  await request.delete(`/api/notes/${noteId}/permanent`).catch(() => {});
}

/**
 * Simulate the user coming back to the tab. The change is made by a different HTTP
 * client, so as far as the page is concerned this is another device.
 */
async function returnToTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
}

function paragraph(text: string) {
  return [
    {
      type: "paragraph",
      props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
      content: [{ type: "text", text, styles: {} }],
      children: [],
    },
  ];
}

test.describe("External change sync", () => {
  let notebookId: string;
  let notebookName: string;

  test.beforeAll(async ({ request }) => {
    notebookName = `XPlat NB ${Date.now()}`;
    const createRes = await request.post("/api/notebooks", { data: { name: notebookName } });
    expect(createRes.ok()).toBe(true);
    notebookId = ((await createRes.json()) as { id: string }).id;
  });

  test.afterAll(async ({ request }) => {
    if (notebookId) {
      await request.delete(`/api/notebooks/${notebookId}`).catch(() => {});
    }
  });

  /** Create a note via the API and open it in the web editor. */
  async function openNote(page: Page, request: APIRequestContext, title: string): Promise<string> {
    const createRes = await request.post(`/api/notebooks/${notebookId}/notes`);
    expect(createRes.ok()).toBe(true);
    const note = (await createRes.json()) as { id: string };

    const patchRes = await request.patch(`/api/notes/${note.id}`, {
      data: { title, content: paragraph("Original body") },
    });
    expect(patchRes.ok()).toBe(true);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    await page
      .locator("nav li")
      .filter({ hasText: notebookName })
      .locator('[role="button"]')
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });
    await page.getByText(title).click();
    await expect(page.getByLabel("Note title")).toHaveValue(title, { timeout: 10000 });
    await expect(page.getByText("Original body")).toBeVisible({ timeout: 10000 });

    return note.id;
  }

  test("an edit made elsewhere appears in the open editor without a page reload", async ({
    page,
    request,
  }) => {
    const title = `XPlat Sync ${Date.now()}`;
    const noteId = await openNote(page, request, title);

    try {
      const editedTitle = `XPlat Sync Edited ${Date.now()}`;
      const patchRes = await request.patch(`/api/notes/${noteId}`, {
        data: { title: editedTitle, content: paragraph("Edited on another device") },
      });
      expect(patchRes.ok()).toBe(true);

      await returnToTab(page);

      // No page.reload() anywhere in this test — that is the point of the feature.
      await expect(page.getByLabel("Note title")).toHaveValue(editedTitle, { timeout: 15000 });
      await expect(page.getByText("Edited on another device")).toBeVisible({ timeout: 15000 });
      await expect(page.getByText("Original body")).not.toBeVisible();
    } finally {
      await deleteNote(request, noteId);
    }
  });

  test("a note trashed elsewhere is surfaced in the open editor", async ({ page, request }) => {
    const title = `XPlat Sync Trash ${Date.now()}`;
    const noteId = await openNote(page, request, title);

    try {
      const trashRes = await request.delete(`/api/notes/${noteId}`);
      expect(trashRes.ok()).toBe(true);

      await returnToTab(page);

      const banner = page.getByTestId("note-sync-banner");
      await expect(banner).toBeVisible({ timeout: 15000 });
      await expect(banner).toContainText(/Trash/i);
    } finally {
      await deleteNote(request, noteId);
    }
  });
});
