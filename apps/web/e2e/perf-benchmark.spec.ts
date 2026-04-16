/**
 * Performance benchmark — measures API and UI loading times.
 *
 * Run against production:
 *   BASE_URL=https://drafto.eu npx playwright test e2e/perf-benchmark.spec.ts --project=chromium
 *
 * Run against preview:
 *   BASE_URL=https://<preview>.vercel.app npx playwright test e2e/perf-benchmark.spec.ts --project=chromium
 *
 * Requires E2E_TEST_EMAIL and E2E_TEST_PASSWORD in env.
 */
import { test, expect } from "@playwright/test";

const ITERATIONS = 5;

interface TimingResult {
  metric: string;
  values: number[];
  p50: number;
  p95: number;
  avg: number;
}

function summarize(metric: string, values: number[]): TimingResult {
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  return { metric, values, p50, p95, avg };
}

test.describe("Performance benchmarks", () => {
  test("measure note list loading time (API + render)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 15000 });

    // Collect notebook IDs from the sidebar for switching
    const notebookButtons = page.locator('[data-testid="notebook-item"]');
    const count = await notebookButtons.count();

    // --- Benchmark 1: API response time for /api/notebooks/{id}/notes ---
    // Use page.evaluate to make raw fetch calls and measure timing
    const apiTimings: number[] = [];

    // Get the first notebook ID from the network
    const notebookApiPromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/notebooks") &&
        !res.url().includes("/notes") &&
        res.status() === 200,
      { timeout: 15000 },
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 15000 });
    let notebookResponse;
    try {
      notebookResponse = await notebookApiPromise;
    } catch {
      // Notebooks may already be cached, fetch directly
    }
    const notebooks = notebookResponse ? await notebookResponse.json() : [];
    const notebookId = notebooks[0]?.id;

    if (notebookId) {
      for (let i = 0; i < ITERATIONS; i++) {
        const elapsed = await page.evaluate(async (nbId) => {
          const start = performance.now();
          const res = await fetch(`/api/notebooks/${nbId}/notes`);
          await res.json();
          return Math.round(performance.now() - start);
        }, notebookId);
        apiTimings.push(elapsed);
      }
    }

    const apiResult = summarize("/api/notebooks/{id}/notes", apiTimings);
    console.log("\n=== NOTE LIST API TIMING ===");
    console.log(`  Values: ${apiResult.values.join(", ")} ms`);
    console.log(`  Avg: ${apiResult.avg} ms | P50: ${apiResult.p50} ms | P95: ${apiResult.p95} ms`);

    // --- Benchmark 2: Full page load to notes visible ---
    const fullLoadTimings: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = Date.now();
      await page.reload();
      await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 15000 });
      // Wait for at least one note item to appear (list rendered)
      await page
        .locator("nav ul li")
        .first()
        .waitFor({ state: "visible", timeout: 15000 })
        .catch(() => {});
      fullLoadTimings.push(Date.now() - start);
    }

    const fullResult = summarize("Full page load → notes visible", fullLoadTimings);
    console.log("\n=== FULL PAGE LOAD → NOTES VISIBLE ===");
    console.log(`  Values: ${fullResult.values.join(", ")} ms`);
    console.log(
      `  Avg: ${fullResult.avg} ms | P50: ${fullResult.p50} ms | P95: ${fullResult.p95} ms`,
    );
  });

  test("measure individual note loading time (API + render)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 15000 });

    // Wait for note list to populate
    const noteItems = page.locator("nav ul li button");
    await noteItems.first().waitFor({ state: "visible", timeout: 15000 });
    const noteCount = await noteItems.count();

    // --- Benchmark 3: API response time for /api/notes/{id} ---
    // First, get note IDs from the UI by fetching the notebook notes API
    const noteIds: string[] = [];
    for (let i = 0; i < Math.min(ITERATIONS, noteCount); i++) {
      const noteText = await noteItems.nth(i).textContent();
      if (noteText) noteIds.push(noteText); // We'll get IDs from network below
    }

    // Get note IDs by fetching the list via API
    const notebookNotesData = await page.evaluate(async () => {
      // Find the notebook notes API from the current page
      const res = await fetch("/api/notebooks");
      const notebooks = await res.json();
      if (!notebooks[0]?.id) return [];
      const notesRes = await fetch(`/api/notebooks/${notebooks[0].id}/notes`);
      const notes = await notesRes.json();
      return notes.map((n: { id: string }) => n.id);
    });

    const apiTimings: number[] = [];
    for (let i = 0; i < Math.min(ITERATIONS, notebookNotesData.length); i++) {
      const noteId = notebookNotesData[i];
      const elapsed = await page.evaluate(async (id) => {
        const start = performance.now();
        const res = await fetch(`/api/notes/${id}`);
        await res.json();
        return Math.round(performance.now() - start);
      }, noteId);
      apiTimings.push(elapsed);
    }

    const apiResult = summarize("/api/notes/{id}", apiTimings);
    console.log("\n=== INDIVIDUAL NOTE API TIMING ===");
    console.log(`  Values: ${apiResult.values.join(", ")} ms`);
    console.log(`  Avg: ${apiResult.avg} ms | P50: ${apiResult.p50} ms | P95: ${apiResult.p95} ms`);

    // --- Benchmark 4: Click note → editor visible (render timing) ---
    const renderTimings: number[] = [];
    for (let i = 0; i < Math.min(ITERATIONS, noteCount); i++) {
      const noteIdx = i % noteCount;
      const renderStart = Date.now();
      await noteItems.nth(noteIdx).click();
      await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({
        timeout: 15000,
      });
      renderTimings.push(Date.now() - renderStart);
    }

    const renderResult = summarize("Click note → editor visible", renderTimings);
    console.log("\n=== NOTE CLICK → EDITOR VISIBLE ===");
    console.log(`  Values: ${renderResult.values.join(", ")} ms`);
    console.log(
      `  Avg: ${renderResult.avg} ms | P50: ${renderResult.p50} ms | P95: ${renderResult.p95} ms`,
    );
  });

  test("measure auth overhead (getUser + profile check)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 15000 });

    // Measure raw API call timing including auth overhead
    const timings: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = Date.now();
      const response = await page.evaluate(async () => {
        const res = await fetch("/api/notebooks");
        const data = await res.json();
        return { status: res.status, count: Array.isArray(data) ? data.length : 0 };
      });
      timings.push(Date.now() - start);
      expect(response.status).toBe(200);
    }

    const result = summarize("/api/notebooks (auth + query)", timings);
    console.log("\n=== AUTH + NOTEBOOKS FETCH ===");
    console.log(`  Values: ${result.values.join(", ")} ms`);
    console.log(`  Avg: ${result.avg} ms | P50: ${result.p50} ms | P95: ${result.p95} ms`);
  });

  test("measure middleware overhead via navigation timing", async ({ page }) => {
    // Measure full navigation including middleware session check
    const timings: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = Date.now();
      await page.goto("/");
      // Middleware completes when the page starts rendering (not redirected to /login)
      await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({
        timeout: 15000,
      });
      timings.push(Date.now() - start);
    }

    const result = summarize("Navigation to / (middleware + SSR + hydration)", timings);
    console.log("\n=== FULL NAVIGATION TIMING ===");
    console.log(`  Values: ${result.values.join(", ")} ms`);
    console.log(`  Avg: ${result.avg} ms | P50: ${result.p50} ms | P95: ${result.p95} ms`);
  });
});
