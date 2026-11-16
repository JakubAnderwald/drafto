import type { Page } from "@playwright/test";
import { STORAGE_QUOTA_EXCEEDED_CODE } from "@drafto/shared/constants";
import { recordRunNotebook } from "./helpers/run-notebooks";
import { test, expect } from "./helpers/test";

/**
 * A storage-full refusal in the web editor (issue #794): the "Storage full" banner
 * is the only message, and the file block BlockNote inserted for the upload is
 * removed, so neither BlockNote's own "Upload failed" nor an empty block is left.
 *
 * The quota refusal is stubbed (the upload-url route answers the quota 413 the
 * real route sends), so this runs as the shared E2E user without filling their
 * storage, and nothing is stored. `storage-quota.admin.spec.ts` covers the real
 * refusal with a user at a 1 KB quota.
 */

const USED_BYTES = 52428800;
const QUOTA_BYTES = 52428800;

async function stubQuotaRefusal(page: Page) {
  await page.route("**/api/notes/*/attachments/upload-url", (route) =>
    route.fulfill({
      status: 413,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Storage full",
        code: STORAGE_QUOTA_EXCEEDED_CODE,
        usedBytes: USED_BYTES,
        quotaBytes: QUOTA_BYTES,
      }),
    }),
  );
}

test.describe("Storage full in the editor", () => {
  let notebookName: string;
  let notebookId: string;

  test.beforeAll(async ({ request }, testInfo) => {
    notebookName = `Quota NB ${Date.now()}`;
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
    return editor;
  }

  async function expectOnlyTheBanner(page: Page) {
    await expect(page.getByTestId("note-editor-upload-error")).toContainText(
      "Storage full: you've used 50 MB of your 50 MB.",
      { timeout: 10000 },
    );
    // The refused block is gone, and BlockNote's own error with it.
    await expect(page.locator("[data-content-type='file']")).toHaveCount(0);
    await expect(page.locator("[data-content-type='image']")).toHaveCount(0);
    await expect(page.locator(".bn-error-text")).toHaveCount(0);
  }

  test("a pasted file refused for storage leaves only the banner", async ({ page }) => {
    const editor = await openNewNote(page, `Quota paste ${Date.now()}`);
    await stubQuotaRefusal(page);

    await editor.click();
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(2048)], "quota.txt", { type: "text/plain" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });

    await expectOnlyTheBanner(page);
  });

  test("an image picked in BlockNote's file panel and refused leaves only the banner", async ({
    page,
  }) => {
    const editor = await openNewNote(page, `Quota panel ${Date.now()}`);
    await stubQuotaRefusal(page);

    // The slash menu inserts an empty image block and opens its file panel.
    await editor.click();
    await page.keyboard.type("/image");
    await expect(page.getByRole("option", { name: /^Image/ })).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-content-type='image']")).toHaveCount(1);

    await page
      .locator("input[type='file']")
      .first()
      .setInputFiles({ name: "quota.png", mimeType: "image/png", buffer: Buffer.alloc(2048) });

    await expectOnlyTheBanner(page);
  });
});
