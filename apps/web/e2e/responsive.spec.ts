import { test, expect } from "./helpers/test";

/**
 * Responsive E2E tests for mobile and tablet viewports.
 *
 * Breakpoints (Tailwind CSS):
 *   Mobile:  < 640px  (sm) — single-panel navigation stack
 *   Tablet:  640px–1023px  — collapsible sidebar overlay + two panels
 *   Desktop: ≥ 1024px (lg) — all three static panels
 */

// ---------------------------------------------------------------------------
// Mobile tests — single-panel navigation stack
// ---------------------------------------------------------------------------

test.describe("mobile navigation", () => {
  test.beforeEach(async ({ page }) => {
    const vp = page.viewportSize();
    test.skip(!vp || vp.width >= 640, "Mobile-only test (viewport < 640px)");

    // Navigate and ensure we're on the notebooks panel.
    // Auto-selection may have already moved us to the notes panel on mobile.
    await page.goto("/");
    const notebooksHeading = page.getByRole("heading", { name: "Notebooks" });
    const backButton = page.getByLabel("Back to notebooks");
    await expect(notebooksHeading.or(backButton)).toBeVisible({ timeout: 10000 });

    // If auto-selection moved us to notes, go back to notebooks
    if (await backButton.isVisible()) {
      await backButton.click();
      await expect(notebooksHeading).toBeVisible({ timeout: 5000 });
    }
  });

  test("initial view shows notebooks panel", async ({ page }) => {
    // beforeEach already ensured we're on the notebooks panel
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    // The note list (middle panel) should NOT be visible
    await expect(page.getByText("Select a notebook")).not.toBeVisible();
  });

  test("navigate: notebooks → notes → editor → back to notes → back to notebooks", async ({
    page,
  }) => {
    // --- Step 1: Notebooks panel is visible (ensured by beforeEach) ---
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    // Wait for notebooks to load
    const sidebar = page.locator("aside");
    await expect(sidebar.locator("nav li").first()).toBeVisible({ timeout: 10000 });

    // --- Step 2: Tap a notebook → should navigate to notes panel ---
    await sidebar.locator("nav li").first().click();

    // "Back to notebooks" button should appear (mobile-only)
    await expect(page.getByLabel("Back to notebooks")).toBeVisible({ timeout: 5000 });

    // The notes heading should be visible
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 5000 });

    // Sidebar should be hidden on mobile now
    await expect(page.getByRole("heading", { name: "Notebooks" })).not.toBeVisible();

    // --- Step 3: Create a note and navigate to editor ---
    await page.getByRole("button", { name: "New note", exact: true }).click();

    // Editor should appear with title input
    const titleInput = page.getByRole("textbox", { name: "Note title" });
    await expect(titleInput).toBeVisible({ timeout: 5000 });

    // "Back to notes" button should appear
    await expect(page.getByLabel("Back to notes")).toBeVisible();

    // Note list should be hidden on mobile in editor view
    await expect(page.getByLabel("Back to notebooks")).not.toBeVisible();

    // --- Step 4: Go back to notes ---
    await page.getByLabel("Back to notes").click();

    // Note list should be visible again
    await expect(page.getByLabel("Back to notebooks")).toBeVisible({ timeout: 5000 });

    // Editor should be hidden
    await expect(page.getByLabel("Back to notes")).not.toBeVisible();

    // --- Step 5: Go back to notebooks ---
    await page.getByLabel("Back to notebooks").click();

    // Notebooks should be visible
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 5000 });

    // Notes panel should be hidden
    await expect(page.getByLabel("Back to notebooks")).not.toBeVisible();
  });

  test("navigate to trash and back", async ({ page }) => {
    // beforeEach already navigated and ensured notebooks panel is visible
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    // Tap trash button
    await page.getByRole("button", { name: /Trash/i }).click();

    // Should navigate to trash view with back button
    await expect(page.getByLabel("Back to notebooks")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();

    // Go back to notebooks
    await page.getByLabel("Back to notebooks").click();
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Tablet tests — collapsible sidebar
// ---------------------------------------------------------------------------

/** Opens the tablet sidebar and waits for slide-in animation to complete */
async function openSidebar(page: import("@playwright/test").Page) {
  await page.getByLabel("Toggle sidebar").click();
  await expect(page.getByTestId("sidebar-backdrop")).toBeVisible({ timeout: 3000 });
  // Wait for the 200ms CSS slide-in animation to complete.
  // Tailwind v4 uses the `translate` property (not `transform`), so check that
  // the sidebar is no longer at a negative x-translation.
  const aside = page.locator("aside");
  await expect(aside).not.toHaveCSS("translate", /-\d+/, { timeout: 3000 });
}

test.describe("tablet sidebar", () => {
  test.beforeEach(async ({ page }) => {
    const vp = page.viewportSize();
    test.skip(
      !vp || vp.width < 640 || vp.width >= 1024,
      "Tablet-only test (640px ≤ viewport < 1024px)",
    );

    // Navigate and wait for auto-selection to complete.
    // NotebooksSidebar auto-selects the first notebook, which calls
    // handleSelectNotebook → setSidebarOpen(false). If we open the sidebar
    // before auto-selection completes, the sidebar would close mid-animation.
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });
  });

  test("hamburger toggle button is visible", async ({ page }) => {
    // beforeEach already navigated and waited for auto-selection
    await expect(page.getByLabel("Toggle sidebar")).toBeVisible();
  });

  test("sidebar is hidden by default, opens on hamburger click", async ({ page }) => {
    await expect(page.getByLabel("Toggle sidebar")).toBeVisible();

    // Sidebar should be off-screen (translated left) — not visually accessible
    // Tailwind v4 uses the `translate` property (not `transform`)
    const aside = page.locator("aside");
    await expect(aside).toHaveCSS("translate", /-\d+/);

    // Click hamburger to open sidebar and wait for animation
    await openSidebar(page);

    // Sidebar should now be translated to 0 (visible)
    await expect(aside).not.toHaveCSS("translate", /-\d+/);
  });

  test("clicking backdrop closes sidebar", async ({ page }) => {
    // beforeEach already navigated and waited for auto-selection

    // Open sidebar
    await page.getByLabel("Toggle sidebar").click();
    await expect(page.getByTestId("sidebar-backdrop")).toBeVisible({ timeout: 3000 });

    // Click backdrop to close
    await page.getByTestId("sidebar-backdrop").click();

    // Backdrop should disappear
    await expect(page.getByTestId("sidebar-backdrop")).not.toBeVisible({ timeout: 3000 });
  });

  test("selecting a notebook closes sidebar", async ({ page }) => {
    // beforeEach already navigated and waited for auto-selection

    // Open sidebar and wait for animation
    await openSidebar(page);

    // Wait for notebooks to load in sidebar
    const sidebar = page.locator("aside");
    await expect(sidebar.locator("nav li").first()).toBeVisible({ timeout: 5000 });

    // Click a notebook
    await sidebar.locator("nav li").first().click();

    // Sidebar should close automatically
    await expect(page.getByTestId("sidebar-backdrop")).not.toBeVisible({ timeout: 3000 });

    // Note list or "Select a notebook" should be visible in the middle panel
    const section = page.locator("section");
    await expect(section).toBeVisible();
  });

  test("two panels visible: note list + editor", async ({ page }) => {
    // beforeEach already navigated and waited for auto-selection

    // Open sidebar and wait for animation
    await openSidebar(page);

    const sidebar = page.locator("aside");
    await expect(sidebar.locator("nav li").first()).toBeVisible({ timeout: 5000 });
    await sidebar.locator("nav li").first().click();

    // Wait for notes to load
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });

    // Both middle panel (section) and main panel should be visible
    await expect(page.locator("section")).toBeVisible();
    await expect(page.locator("main")).toBeVisible();

    // "Select a note" should be visible in the editor panel
    await expect(page.getByText("Select a note")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Touch-only pointers — row actions can't rely on hover (#863)
// ---------------------------------------------------------------------------

test.describe("touch row actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const hoverNone = await page.evaluate(() => matchMedia("(hover: none)").matches);
    test.skip(!hoverNone, "Touch-only pointer test (@media (hover: none))");
  });

  const isPhone = (page: import("@playwright/test").Page) =>
    (page.viewportSize()?.width ?? 0) < 640;

  /**
   * Phones open on whichever panel auto-selection leaves them on (both headings are in
   * the DOM, one hidden). Tablets open on the note list once a notebook is auto-selected.
   */
  async function settleOnPanel(page: import("@playwright/test").Page) {
    const notesHeading = page.getByRole("heading", { name: "Notes" });
    if (!isPhone(page)) {
      await expect(notesHeading).toBeVisible({ timeout: 10000 });
      return;
    }
    const notebooksHeading = page.getByRole("heading", { name: "Notebooks" });
    await expect(notesHeading.or(notebooksHeading).filter({ visible: true }).first()).toBeVisible({
      timeout: 10000,
    });
  }

  // Playwright's toBeVisible ignores opacity, so these read the computed opacity.

  test("note-row actions are shown without hover and open on tap", async ({ page }) => {
    await settleOnPanel(page);
    const notesHeading = page.getByRole("heading", { name: "Notes" });
    if (isPhone(page) && !(await notesHeading.isVisible())) {
      await page.locator("aside nav li").first().click();
    }
    await expect(notesHeading).toBeVisible({ timeout: 5000 });

    // A note of this test's own, so the list has a row (the fixture deletes it).
    await page.getByRole("button", { name: "New note", exact: true }).click();
    if (isPhone(page)) {
      // The phone opens the editor once the note is created; go back to the list.
      const backToNotes = page.getByLabel("Back to notes");
      await expect(backToNotes).toBeVisible({ timeout: 10000 });
      await backToNotes.click();
    }

    const noteList = page.locator("section").filter({ has: notesHeading });
    const actions = noteList.getByLabel(/^Actions for /).first();
    await expect(actions).toBeVisible({ timeout: 10000 });
    await expect(actions).toHaveCSS("opacity", "1");

    await actions.tap();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  });

  test("notebook delete is shown without hover", async ({ page }) => {
    await settleOnPanel(page);
    if (!isPhone(page)) {
      await openSidebar(page);
    } else {
      const backToNotebooks = page.getByLabel("Back to notebooks");
      if (await backToNotebooks.isVisible()) await backToNotebooks.click();
    }

    const deleteNotebook = page
      .locator("aside nav")
      .getByLabel(/^Delete /)
      .first();
    await expect(deleteNotebook).toBeVisible({ timeout: 10000 });
    await expect(deleteNotebook).toHaveCSS("opacity", "1");
  });

  // #899: a finger needs a 44×44 px tap target. The icons stay small; the buttons grow.
  // Other workers sign in as the same user and add rows to the same lists, so each test
  // reads every box it compares in one evaluate, when the rows can't move in between.

  type Box = { x: number; y: number; width: number; height: number };

  function expectTapTarget(box: Box) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  function intersects(a: Box, b: Box): boolean {
    return (
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    );
  }

  test("note-row actions have a 44 px tap target clear of the next row and the title", async ({
    page,
  }) => {
    await settleOnPanel(page);
    const notesHeading = page.getByRole("heading", { name: "Notes" });
    if (isPhone(page) && !(await notesHeading.isVisible())) {
      await page.locator("aside nav li").first().click();
    }
    await expect(notesHeading).toBeVisible({ timeout: 5000 });

    const noteList = page.locator("section").filter({ has: notesHeading });
    const rows = noteList.locator("li").filter({ has: page.getByLabel(/^Actions for /) });

    // Two notes of this test's own, so the list has two neighbouring rows (the fixture
    // deletes them).
    for (let i = 0; i < 2; i++) {
      const created = page.waitForResponse(
        (res) =>
          res.request().method() === "POST" &&
          /^\/api\/notebooks\/[^/]+\/notes$/.test(new URL(res.url()).pathname),
      );
      await page.getByRole("button", { name: "New note", exact: true }).click();
      await created;
      if (isPhone(page)) {
        // The phone opens the editor once the note is created; go back to the list.
        const backToNotes = page.getByLabel("Back to notes");
        await expect(backToNotes).toBeVisible({ timeout: 10000 });
        await backToNotes.click();
        await expect(notesHeading).toBeVisible({ timeout: 5000 });
      }
    }
    await expect(rows.nth(1)).toBeVisible({ timeout: 10000 });
    await expect(rows.nth(0).getByLabel(/^Actions for /)).toHaveCSS("opacity", "1");

    // The create refetches the list, which shows a skeleton meanwhile, so retry until
    // the rows are back.
    await expect(async () => {
      const measured = await rows.evaluateAll((lis) =>
        lis.slice(0, 2).map((li) => {
          const rectOf = (el: Element | null) => {
            if (!el) throw new Error("Missing part of a note row");
            const { x, y, width, height } = el.getBoundingClientRect();
            return { x, y, width, height };
          };
          return {
            row: rectOf(li),
            title: rectOf(li.querySelector("button p")),
            actions: rectOf(li.querySelector('[aria-label^="Actions for "]')),
          };
        }),
      );
      expect(measured).toHaveLength(2);
      const [first, second] = measured;

      expectTapTarget(first.actions);
      expectTapTarget(second.actions);
      // Neighbouring rows' targets don't overlap …
      expect(intersects(first.actions, second.actions)).toBe(false);
      // … each target stays inside its own row …
      expect(first.actions.y).toBeGreaterThanOrEqual(first.row.y);
      expect(first.actions.y + first.actions.height).toBeLessThanOrEqual(
        first.row.y + first.row.height,
      );
      // … and the title truncates before it.
      expect(first.title.x + first.title.width).toBeLessThanOrEqual(first.actions.x);
    }).toPass({ timeout: 10000 });

    // The whole target takes the tap, not just the icon at its centre.
    const actions = rows.nth(0).getByLabel(/^Actions for /);
    await actions.tap({ position: { x: 4, y: 4 } });
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();

    // The menu opens below the target, so a second tap on the ⋮ can't hit a menu item.
    const [actionsBox, menuBox] = await Promise.all([
      actions.boundingBox(),
      page.getByRole("menu").boundingBox(),
    ]);
    if (!actionsBox || !menuBox) throw new Error("Missing a bounding box");
    expect(menuBox.y).toBeGreaterThanOrEqual(actionsBox.y + actionsBox.height);
  });

  test("notebook delete has a 44 px tap target, even beside a long name", async ({ page }) => {
    await settleOnPanel(page);
    if (!isPhone(page)) {
      await openSidebar(page);
    } else {
      const backToNotebooks = page.getByLabel("Back to notebooks");
      if (await backToNotebooks.isVisible()) await backToNotebooks.click();
    }

    // A notebook of this test's own, with a name long enough to be truncated, so the
    // delete button would shrink if it could (the fixture records it for teardown).
    const name = `Touch Target NB With A Name Long Enough To Truncate In The Sidebar ${Date.now()}`;
    await page.getByRole("button", { name: "New notebook", exact: true }).click();
    const createInput = page.getByPlaceholder("Notebook name");
    await expect(createInput).toBeVisible();
    await createInput.fill(name);
    await createInput.press("Enter");

    // Creating a notebook selects it, which leaves the notebook list: go back to it.
    if (isPhone(page)) {
      const backToNotebooks = page.getByLabel("Back to notebooks");
      await expect(backToNotebooks).toBeVisible({ timeout: 10000 });
      await backToNotebooks.click();
    } else {
      await expect(page.getByTestId("sidebar-backdrop")).not.toBeVisible({ timeout: 5000 });
      await openSidebar(page);
    }

    const label = `Delete ${name}`;
    const deleteLong = page.locator("aside nav").getByLabel(label, { exact: true });
    await expect(deleteLong).toBeVisible({ timeout: 10000 });
    await expect(deleteLong).toHaveCSS("opacity", "1");

    // This row's target, and its neighbour's: the row below, or above for the last row.
    const { target, neighbour, nameTruncated } = await page
      .locator("aside nav")
      .getByLabel(/^Delete /)
      .evaluateAll((buttons, ownLabel) => {
        const rectOf = (el: Element | undefined) => {
          if (!el) throw new Error("Missing a notebook row's delete button");
          const { x, y, width, height } = el.getBoundingClientRect();
          return { x, y, width, height };
        };
        const index = buttons.findIndex((el) => el.getAttribute("aria-label") === ownLabel);
        const own = buttons[index];
        const nameSpan = own?.previousElementSibling;
        return {
          target: rectOf(own),
          neighbour: rectOf(buttons[index + 1] ?? buttons[index - 1]),
          nameTruncated: !!nameSpan && nameSpan.scrollWidth > nameSpan.clientWidth,
        };
      }, label);

    expect(nameTruncated).toBe(true);
    expectTapTarget(target);
    expectTapTarget(neighbour);
    expect(intersects(target, neighbour)).toBe(false);
  });
});
