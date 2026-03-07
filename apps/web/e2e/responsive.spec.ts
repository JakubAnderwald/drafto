import { test, expect } from "@playwright/test";

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
