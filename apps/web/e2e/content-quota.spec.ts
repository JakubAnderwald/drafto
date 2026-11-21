import type { Page, Route } from "@playwright/test";
import { CONTENT_QUOTA_EXCEEDED_CODE } from "@drafto/shared/constants";
import { recordRunNotebook } from "./helpers/run-notebooks";
import { test, expect } from "./helpers/test";

/**
 * Per-user note content quota on the web (ADR 0090), as the shared E2E user.
 *
 * The settings page shows the user's notes usage. The editor's refusal is stubbed (the
 * note PATCH answers the content quota 413 the real route sends), so the shared user's
 * quota is never filled. `content-quota.admin.spec.ts` covers the real refusal with a
 * user at a tiny quota.
 */

const QUOTA_BYTES = 26214400;

test("the settings page shows the notes usage line", async ({ page }) => {
  await page.goto("/settings");

  const section = page.getByTestId("content-usage-section");
  await expect(section.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });
  // "Notes: 1.2 MB of 25 MB used", or "Notes: 1.2 MB used" for an unlimited account.
  await expect(page.getByTestId("content-usage-text")).toHaveText(
    /^Notes: (< )?[\d.]+ MB (of [\d.]+ MB )?used$/,
    { timeout: 10000 },
  );
});

test.describe("Notes full in the editor", () => {
  let notebookName: string;
  let notebookId: string;

  test.beforeAll(async ({ request }, testInfo) => {
    notebookName = `Content quota NB ${Date.now()}`;
    const res = await request.post("/api/notebooks", { data: { name: notebookName } });
    expect(res.ok()).toBe(true);
    notebookId = ((await res.json()) as { id: string }).id;
    // Deleted with its notes by the run-end teardown.
    recordRunNotebook(testInfo, notebookId);
  });

  /** Creates a note over the API and opens it in the editor. */
  async function openNewNote(page: Page, title: string) {
    const noteRes = await page.request.post(`/api/notebooks/${notebookId}/notes`);
    expect(noteRes.ok()).toBe(true);
    const noteId = ((await noteRes.json()) as { id: string }).id;
    const patchRes = await page.request.patch(`/api/notes/${noteId}`, { data: { title } });
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

    const editor = page.locator("[contenteditable='true']").first();
    await expect(editor).toBeVisible({ timeout: 10000 });
    return { editor, noteId };
  }

  test("a save refused for the content quota shows the banner and keeps the edit", async ({
    page,
  }) => {
    const { editor, noteId } = await openNewNote(page, `Content quota ${Date.now()}`);

    let refused = 0;
    const refuseSaves = (route: Route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      refused += 1;
      return route.fulfill({
        status: 413,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Note content quota exceeded",
          code: CONTENT_QUOTA_EXCEEDED_CODE,
          usedBytes: QUOTA_BYTES,
          quotaBytes: QUOTA_BYTES,
        }),
      });
    };
    await page.route(`**/api/notes/${noteId}`, refuseSaves);

    await editor.click();
    await page.keyboard.type("Refused text");

    await expect(page.getByTestId("note-sync-banner")).toContainText(
      "Notes full: you've used 25 MB of your 25 MB for notes.",
      { timeout: 10000 },
    );
    expect(refused).toBeGreaterThan(0);

    // Once there is room, the next edit sends the refused one with it.
    await page.unroute(`**/api/notes/${noteId}`, refuseSaves);
    await page.keyboard.type("!");
    await expect(page.getByTestId("save-status-badge")).toHaveText("Saved", { timeout: 10000 });
    await expect(page.getByTestId("note-sync-banner")).toHaveCount(0);

    const saved = await page.request.get(`/api/notes/${noteId}`);
    expect(JSON.stringify(await saved.json())).toContain("Refused text!");
  });
});
