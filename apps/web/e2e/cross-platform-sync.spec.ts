import { test, expect } from "@playwright/test";

/**
 * Cross-platform data consistency E2E tests.
 *
 * Verifies that the format conversion layer correctly handles:
 * 1. Notes stored in TipTap format (by mobile) render correctly on web
 * 2. Notes created on web are stored in BlockNote format
 * 3. The defensive API conversion repairs corrupted (TipTap) content
 *
 * These tests operate on real data via the authenticated API context,
 * using the same Supabase dev database that the mobile Maestro tests use.
 * The note title includes "XPlat" so the Maestro flow can find it.
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

  test.beforeAll(async ({ request }) => {
    // Find the first notebook to use for tests
    const res = await request.get("/api/notebooks");
    expect(res.ok()).toBe(true);
    const notebooks: { id: string; name: string }[] = await res.json();
    expect(notebooks.length).toBeGreaterThan(0);
    notebookId = notebooks[0].id;
  });

  test("TipTap content injected via API renders correctly on web and is repaired to BlockNote", async ({
    page,
    request,
  }) => {
    // 1. Create a note via API
    const createRes = await request.post(`/api/notebooks/${notebookId}/notes`);
    expect(createRes.ok()).toBe(true);
    const note: { id: string } = await createRes.json();

    try {
      // 2. PATCH the note with TipTap-formatted content (simulating mobile save)
      const title = `XPlat TipTap ${Date.now()}`;
      const patchRes = await request.patch(`/api/notes/${note.id}`, {
        data: { title, content: TIPTAP_DOC },
      });
      expect(patchRes.ok()).toBe(true);

      // 3. GET the note via API — defensive conversion should return BlockNote array
      const getRes = await request.get(`/api/notes/${note.id}`);
      expect(getRes.ok()).toBe(true);
      const fetched = await getRes.json();
      expect(Array.isArray(fetched.content)).toBe(true);
      expect(fetched.content[0].type).toBe("heading");
      expect(fetched.content[0].props.level).toBe(1);
      expect(fetched.content[1].type).toBe("paragraph");
      expect(fetched.content[2].type).toBe("bulletListItem");

      // 4. Open the note in the web editor and verify content renders
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

      // Find and click the note
      await expect(page.getByText(title)).toBeVisible({ timeout: 10000 });
      await page.getByText(title).click();

      // Verify the editor loaded with the content
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

  test("note created on web is stored in BlockNote format, readable by mobile", async ({
    page,
    request,
  }) => {
    let createdNoteId: string | undefined;

    try {
      // 1. Open the app and create a note via the UI
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

      await page.getByRole("button", { name: "New note", exact: true }).click();
      const titleInput = page.getByRole("textbox", { name: "Note title" });
      await expect(titleInput).toBeVisible({ timeout: 5000 });

      // Use a title the Maestro test can find
      const title = `XPlat Web ${Date.now()}`;
      await titleInput.clear();
      await titleInput.fill(title);

      // 2. Type formatted content in the BlockNote editor
      const editor = page.locator("[contenteditable='true']").first();
      await expect(editor).toBeVisible({ timeout: 5000 });
      await editor.click();

      // Type a heading
      await page.keyboard.type("# Heading from web");
      await page.keyboard.press("Enter");

      // Type bold text
      await page.keyboard.press("ControlOrMeta+b");
      await page.keyboard.type("Bold text");
      await page.keyboard.press("ControlOrMeta+b");
      await page.keyboard.type(" and normal text");
      await page.keyboard.press("Enter");

      // Type a bullet list
      await page.keyboard.type("- List item one");
      await page.keyboard.press("Enter");
      await page.keyboard.type("List item two");

      // 3. Wait for auto-save
      await expect(page.getByText("Saved")).toBeVisible({ timeout: 15000 });

      // 4. Fetch the note via API and verify content is in BlockNote format
      const notesRes = await request.get(`/api/notebooks/${notebookId}/notes`);
      expect(notesRes.ok()).toBe(true);
      const notes: { id: string; title: string }[] = await notesRes.json();
      const createdNote = notes.find((n) => n.title === title);
      expect(createdNote).toBeDefined();
      createdNoteId = createdNote!.id;

      // GET full note with content
      const noteRes = await request.get(`/api/notes/${createdNoteId}`);
      expect(noteRes.ok()).toBe(true);
      const noteData = await noteRes.json();

      // Content should be an array (BlockNote format), not an object with type:"doc"
      expect(Array.isArray(noteData.content)).toBe(true);
      // Should not be a TipTap doc
      expect(noteData.content).not.toHaveProperty("type", "doc");

      // Verify we have some blocks with content
      expect(noteData.content.length).toBeGreaterThan(0);
    } finally {
      if (createdNoteId) {
        await deleteNote(request, createdNoteId);
      }
    }
  });

  test("round-trip: create on web, simulate mobile save with TipTap, verify web still reads correctly", async ({
    request,
  }) => {
    // 1. Create note via API with BlockNote content (web format)
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

      // 2. Verify it reads back as BlockNote
      let getRes = await request.get(`/api/notes/${note.id}`);
      let fetched = await getRes.json();
      expect(Array.isArray(fetched.content)).toBe(true);
      expect(fetched.content[0].type).toBe("heading");

      // 3. Simulate mobile overwriting with TipTap format
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

      // 4. GET again — should be converted back to BlockNote by the API
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
});
