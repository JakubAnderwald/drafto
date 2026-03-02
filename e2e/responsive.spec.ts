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
  test.beforeEach(({ page }) => {
    const vp = page.viewportSize();
    test.skip(!vp || vp.width >= 640, "Mobile-only test (viewport < 640px)");
  });

  test("initial view shows notebooks panel", async ({ page }) => {
    await page.goto("/");

    // The sidebar (notebooks) should be visible as the first panel
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });

    // The note list (middle panel) should NOT be visible
    await expect(page.getByText("Select a notebook")).not.toBeVisible();
  });

  test("navigate: notebooks → notes → editor → back to notes → back to notebooks", async ({
    page,
  }) => {
    await page.goto("/");

    // --- Step 1: Notebooks panel is visible ---
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });

    // Wait for notebooks to load
    const sidebar = page.locator("aside");
    await expect(sidebar.locator("nav li").first()).toBeVisible({ timeout: 10000 });

    // --- Step 2: Tap a notebook → should navigate to notes panel ---
    await sidebar.locator("nav li").first().click();

    // "Back to notebooks" button should appear (mobile-only)
    await expect(page.getByLabel("Back to notebooks")).toBeVisible({ timeout: 5000 });

    // The notes header should be visible
    await expect(page.getByText("Notes").first()).toBeVisible({ timeout: 5000 });

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
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });

    // Tap trash button
    await page.getByRole("button", { name: /Trash/i }).click();

    // Should navigate to trash view with back button
    await expect(page.getByLabel("Back to notebooks")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Trash").first()).toBeVisible();

    // Go back to notebooks
    await page.getByLabel("Back to notebooks").click();
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Tablet tests — collapsible sidebar
// ---------------------------------------------------------------------------

test.describe("tablet sidebar", () => {
  test.beforeEach(({ page }) => {
    const vp = page.viewportSize();
    test.skip(
      !vp || vp.width < 640 || vp.width >= 1024,
      "Tablet-only test (640px ≤ viewport < 1024px)",
    );
  });

  test("hamburger toggle button is visible", async ({ page }) => {
    await page.goto("/");

    // Wait for the app to load
    await expect(page.getByLabel("Toggle sidebar")).toBeVisible({ timeout: 10000 });
  });

  test("sidebar is hidden by default, opens on hamburger click", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByLabel("Toggle sidebar")).toBeVisible({ timeout: 10000 });

    // Sidebar should be off-screen (translated left) — not visually accessible
    // The "Notebooks" heading exists but sidebar is translated off-screen
    const aside = page.locator("aside");
    await expect(aside).toHaveCSS("transform", /matrix.*-240|translateX\(-/);

    // Click hamburger to open sidebar
    await page.getByLabel("Toggle sidebar").click();

    // Sidebar should slide in — backdrop should appear
    await expect(page.getByTestId("sidebar-backdrop")).toBeVisible({ timeout: 3000 });

    // Sidebar should now be translated to 0 (visible)
    await expect(aside).not.toHaveCSS("transform", /matrix.*-240|translateX\(-/);
  });

  test("clicking backdrop closes sidebar", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByLabel("Toggle sidebar")).toBeVisible({ timeout: 10000 });

    // Open sidebar
    await page.getByLabel("Toggle sidebar").click();
    await expect(page.getByTestId("sidebar-backdrop")).toBeVisible({ timeout: 3000 });

    // Click backdrop to close
    await page.getByTestId("sidebar-backdrop").click();

    // Backdrop should disappear
    await expect(page.getByTestId("sidebar-backdrop")).not.toBeVisible({ timeout: 3000 });
  });

  test("selecting a notebook closes sidebar", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByLabel("Toggle sidebar")).toBeVisible({ timeout: 10000 });

    // Open sidebar
    await page.getByLabel("Toggle sidebar").click();
    await expect(page.getByTestId("sidebar-backdrop")).toBeVisible({ timeout: 3000 });

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
    await page.goto("/");

    await expect(page.getByLabel("Toggle sidebar")).toBeVisible({ timeout: 10000 });

    // Open sidebar to select a notebook
    await page.getByLabel("Toggle sidebar").click();
    await expect(page.getByTestId("sidebar-backdrop")).toBeVisible({ timeout: 3000 });

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
