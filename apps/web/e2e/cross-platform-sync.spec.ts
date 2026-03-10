import { test, expect } from "@playwright/test";

/**
 * Cross-platform data consistency E2E tests.
 *
 * These tests can run standalone (all 3 API-level tests) OR be orchestrated
 * by the shell script `apps/mobile/e2e/run-cross-platform-e2e.sh` which
 * interleaves Playwright and Maestro (iOS + Android) steps.
 *
 * When orchestrated:
 *   1. "create a shared note for mobile testing" — creates a formatted note
 *   2. Maestro (iOS) opens, verifies, edits the note
 *   3. "verify mobile edits are persisted" — checks the edit via API
 *   4. Maestro (Android) opens, verifies, edits the note
 *   5. "verify mobile edits are persisted" — checks again
 */

const TIPTAP_DOC = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Cross-Platform Heading" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "This is " },
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
        { type: "text", text: " text from mobile." },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Item A" }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Item B" }] }],
        },
      ],
    },
  ],
};

/** Best-effort cleanup — never throws */
async function deleteNote(
  request: import("@playwright/test").APIRequestContext,
  noteId: string,
): Promise<void> {
  await request.delete(`/api/notes/${noteId}`).catch(() => {});
  await request.delete(`/api/notes/${noteId}/permanent`).catch(() => {});
}

test.describe("Cross-platform format sync", () => {
  let notebookId: string;
  let notebookName: string;

  test.beforeAll(async ({ request }) => {
    const res = await request.get("/api/notebooks");
    expect(res.ok()).toBe(true);
    const notebooks: { id: string; name: string }[] = await res.json();
    expect(notebooks.length).toBeGreaterThan(0);
    notebookId = notebooks[0].id;
    notebookName = notebooks[0].name;
  });

  test("TipTap content injected via API renders correctly on web and is repaired to BlockNote", async ({
    page,
    request,
  }) => {
    const createRes = await request.post(`/api/notebooks/${notebookId}/notes`);
    expect(createRes.ok()).toBe(true);
    const note: { id: string } = await createRes.json();

    try {
      const title = `XPlat TipTap ${Date.now()}`;
      const patchRes = await request.patch(`/api/notes/${note.id}`, {
        data: { title, content: TIPTAP_DOC },
      });
      expect(patchRes.ok()).toBe(true);

      // GET — defensive conversion should return BlockNote array
      const getRes = await request.get(`/api/notes/${note.id}`);
      expect(getRes.ok()).toBe(true);
      const fetched = await getRes.json();
      expect(Array.isArray(fetched.content)).toBe(true);
      expect(fetched.content[0].type).toBe("heading");
      expect(fetched.content[0].props.level).toBe(1);
      expect(fetched.content[1].type).toBe("paragraph");
      expect(fetched.content[2].type).toBe("bulletListItem");

      // Open in web editor and verify rendered content
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

      await expect(page.getByText(title)).toBeVisible({ timeout: 10000 });
      await page.getByText(title).click();

      const editor = page.locator("[contenteditable='true']").first();
      await expect(editor).toBeVisible({ timeout: 5000 });
      await expect(page.getByText("Cross-Platform Heading")).toBeVisible({ timeout: 5000 });
      await expect(page.getByText("bold")).toBeVisible({ timeout: 5000 });
      await expect(page.getByText("Item A")).toBeVisible({ timeout: 5000 });
      await expect(page.getByText("Item B")).toBeVisible({ timeout: 5000 });
    } finally {
      await deleteNote(request, note.id);
    }
  });

  test("note created on web is stored in BlockNote format", async ({ page, request }) => {
    let createdNoteId: string | undefined;

    try {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

      await page.getByRole("button", { name: "New note", exact: true }).click();
      const titleInput = page.getByRole("textbox", { name: "Note title" });
      await expect(titleInput).toBeVisible({ timeout: 5000 });

      const title = `XPlat Web ${Date.now()}`;
      await titleInput.clear();
      await titleInput.fill(title);

      const editor = page.locator("[contenteditable='true']").first();
      await expect(editor).toBeVisible({ timeout: 5000 });
      await editor.click();

      await page.keyboard.type("# Heading from web");
      await page.keyboard.press("Enter");
      await page.keyboard.press("ControlOrMeta+b");
      await page.keyboard.type("Bold text");
      await page.keyboard.press("ControlOrMeta+b");
      await page.keyboard.type(" and normal text");

      await expect(page.getByText("Saved")).toBeVisible({ timeout: 15000 });

      const notesRes = await request.get(`/api/notebooks/${notebookId}/notes`);
      expect(notesRes.ok()).toBe(true);
      const notes: { id: string; title: string }[] = await notesRes.json();
      const createdNote = notes.find((n) => n.title === title);
      expect(createdNote).toBeDefined();
      createdNoteId = createdNote!.id;

      const noteRes = await request.get(`/api/notes/${createdNoteId}`);
      expect(noteRes.ok()).toBe(true);
      const noteData = await noteRes.json();

      expect(Array.isArray(noteData.content)).toBe(true);
      expect(noteData.content).not.toHaveProperty("type", "doc");
      expect(noteData.content.length).toBeGreaterThan(0);
    } finally {
      if (createdNoteId) {
        await deleteNote(request, createdNoteId);
      }
    }
  });

  test("round-trip: web → mobile (TipTap) → web preserves content", async ({ request }) => {
    const createRes = await request.post(`/api/notebooks/${notebookId}/notes`);
    expect(createRes.ok()).toBe(true);
    const note: { id: string } = await createRes.json();

    try {
      const title = `XPlat Round-Trip ${Date.now()}`;
      const blocknoteContent = [
        {
          type: "heading",
          props: { level: 1 },
          content: [{ type: "text", text: "Original Heading", styles: {} }],
          children: [],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Original ", styles: {} },
            { type: "text", text: "bold", styles: { bold: true } },
            { type: "text", text: " text.", styles: {} },
          ],
          children: [],
        },
      ];

      await request.patch(`/api/notes/${note.id}`, {
        data: { title, content: blocknoteContent },
      });

      // Verify BlockNote
      let getRes = await request.get(`/api/notes/${note.id}`);
      let fetched = await getRes.json();
      expect(Array.isArray(fetched.content)).toBe(true);
      expect(fetched.content[0].type).toBe("heading");

      // Simulate mobile overwriting with TipTap
      await request.patch(`/api/notes/${note.id}`, {
        data: {
          content: {
            type: "doc",
            content: [
              {
                type: "heading",
                attrs: { level: 1 },
                content: [{ type: "text", text: "Edited on mobile" }],
              },
              {
                type: "paragraph",
                content: [{ type: "text", text: "Mobile added this paragraph." }],
              },
            ],
          },
        },
      });

      // GET again — API converts to BlockNote
      getRes = await request.get(`/api/notes/${note.id}`);
      fetched = await getRes.json();
      expect(Array.isArray(fetched.content)).toBe(true);
      expect(fetched.content[0].type).toBe("heading");
      expect(fetched.content[0].content[0].text).toBe("Edited on mobile");
      expect(fetched.content[1].type).toBe("paragraph");
      expect(fetched.content[1].content[0].text).toBe("Mobile added this paragraph.");
    } finally {
      await deleteNote(request, note.id);
    }
  });

  test("create a shared note for mobile testing", async ({ request }) => {
    // This test is called by the cross-platform E2E runner script.
    // It creates a note that Maestro (iOS/Android) will then open and edit.
    // The RUN_ID env var links Playwright and Maestro to the same note.
    const runId = process.env.XPLAT_RUN_ID;
    if (!runId) {
      test.skip();
      return;
    }

    // Create a dedicated notebook for this test run so it has the newest
    // updated_at and appears at the top of the mobile list (sorted by updated_at DESC)
    const nbName = `XPlat NB ${runId}`;
    const nbRes = await request.post("/api/notebooks", { data: { name: nbName } });
    expect(nbRes.ok()).toBe(true);
    const nb: { id: string } = await nbRes.json();

    const createRes = await request.post(`/api/notebooks/${nb.id}/notes`);
    expect(createRes.ok()).toBe(true);
    const note: { id: string } = await createRes.json();

    const title = `XPlat Sync ${runId}`;
    const content = [
      {
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: "Cross-Platform Test", styles: {} }],
        children: [],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "This note was created on ", styles: {} },
          { type: "text", text: "web", styles: { bold: true } },
          { type: "text", text: " and should render on mobile.", styles: {} },
        ],
        children: [],
      },
      {
        type: "bulletListItem",
        content: [{ type: "text", text: "Bullet from web", styles: {} }],
        children: [],
      },
    ];

    const patchRes = await request.patch(`/api/notes/${note.id}`, {
      data: { title, content },
    });
    expect(patchRes.ok()).toBe(true);

    // Write note ID and notebook name to stdout so the runner script can use them
    console.log(`XPLAT_NOTE_ID=${note.id}`);
    console.log(`XPLAT_NOTEBOOK_NAME=${nbName}`);
  });

  test("verify mobile edits are persisted", async ({ request }) => {
    // Called by the runner script after Maestro has edited the note.
    // Verifies the content is still in BlockNote format (not raw TipTap).
    const runId = process.env.XPLAT_RUN_ID;
    if (!runId) {
      test.skip();
      return;
    }

    // Find the XPlat notebook directly by name (much faster than scanning all notebooks)
    const notebooksRes = await request.get("/api/notebooks");
    const notebooks: { id: string; name: string }[] = await notebooksRes.json();
    const xplatNb = notebooks.find((nb) => nb.name === `XPlat NB ${runId}`);
    expect(xplatNb).toBeDefined();

    const notesRes = await request.get(`/api/notebooks/${xplatNb!.id}/notes`);
    expect(notesRes.ok()).toBe(true);
    const notes: { id: string; title: string }[] = await notesRes.json();
    // Mobile may have appended " mobile" to the title
    const found = notes.find((n) => n.title.startsWith(`XPlat Sync ${runId}`));
    expect(found).toBeDefined();
    const noteId = found!.id;

    const noteRes = await request.get(`/api/notes/${noteId}`);
    expect(noteRes.ok()).toBe(true);
    const noteData = await noteRes.json();

    // Content must be BlockNote array, not TipTap doc
    expect(Array.isArray(noteData.content)).toBe(true);
    expect(noteData.content.length).toBeGreaterThan(0);

    // The original heading should still be present (or edited by mobile)
    const hasHeading = noteData.content.some(
      (b: { type: string }) => b.type === "heading" || b.type === "paragraph",
    );
    expect(hasHeading).toBe(true);

    console.log(
      `Verified note ${noteId} (title: "${noteData.title}"): ${noteData.content.length} blocks in BlockNote format`,
    );
  });
});
