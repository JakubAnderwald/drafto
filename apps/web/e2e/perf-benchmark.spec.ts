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
import { test, expect, type Locator, type Page } from "@playwright/test";

const ITERATIONS = 5;

// Specs name the notebooks they create `<Name> <Date.now()>` and may delete them
// while this spec runs, so the benchmarks time the account's own notebooks: the
// ones without a trailing run timestamp.
async function ownNotebookIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const res = await fetch("/api/notebooks");
    if (!res.ok) throw new Error(`GET /api/notebooks answered ${res.status}`);
    const notebooks: Array<{ id: string; name: string }> = await res.json();
    return notebooks.filter((nb) => !/ \d{10,13}$/.test(nb.name)).map((nb) => nb.id);
  });
}

// The note list has rendered once it shows a note or its empty state. Only note
// rows carry an "Actions for <title>" button; `nav ul li` also matches the
// notebooks sidebar, which renders first.
function noteListSettled(page: Page): Locator {
  return page
    .getByRole("button", { name: /^Actions for / })
    .first()
    .or(page.getByText("No notes yet. Create one to get started."));
}

interface TimingResult {
  metric: string;
  values: number[];
  p50: number;
  p95: number;
  avg: number;
}

function summarize(metric: string, values: number[]): TimingResult {
  // An empty sample reports NaN and still passes. The note list benchmark did that
  // unnoticed once the layout began server-rendering notebooks.
  expect(values.length, `${metric}: timings collected`).toBeGreaterThan(0);
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

    // --- Benchmark 1: API response time for /api/notebooks/{id}/notes ---
    // Use page.evaluate to make raw fetch calls and measure timing.
    // The layout server-renders the notebooks, so the page itself never requests
    // /api/notebooks: fetch it directly to get a notebook to time.
    const [notebookId] = await ownNotebookIds(page);
    // Every account gets a default notebook, so none at all is a failure.
    expect(notebookId, "the account should have a notebook of its own to time").toBeTruthy();

    const apiTimings: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const elapsed = await page.evaluate(async (nbId) => {
        const start = performance.now();
        const res = await fetch(`/api/notebooks/${nbId}/notes`);
        if (!res.ok) throw new Error(`GET /api/notebooks/{id}/notes answered ${res.status}`);
        await res.json();
        return Math.round(performance.now() - start);
      }, notebookId);
      apiTimings.push(elapsed);
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
      await expect(noteListSettled(page)).toBeVisible({ timeout: 15000 });
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

    // --- Benchmark 3: API response time for /api/notes/{id} ---
    // Get note IDs by fetching the list via API, from the first of the account's
    // own notebooks that holds notes.
    const notebookNotesData = await page.evaluate(
      async (notebookIds) => {
        for (const notebookId of notebookIds) {
          const res = await fetch(`/api/notebooks/${notebookId}/notes`);
          if (!res.ok) throw new Error(`GET /api/notebooks/{id}/notes answered ${res.status}`);
          const notes: Array<{ id: string }> = await res.json();
          if (notes.length > 0) return notes.map((n) => n.id);
        }
        return [];
      },
      await ownNotebookIds(page),
    );
    // Unlike a notebook, a note depends on the account's data, so none skips.
    test.skip(notebookNotesData.length === 0, "the account's own notebooks hold no notes to time");

    const apiTimings: number[] = [];
    for (let i = 0; i < Math.min(ITERATIONS, notebookNotesData.length); i++) {
      const noteId = notebookNotesData[i];
      const elapsed = await page.evaluate(async (id) => {
        const start = performance.now();
        const res = await fetch(`/api/notes/${id}`);
        if (!res.ok) throw new Error(`GET /api/notes/{id} answered ${res.status}`);
        await res.json();
        return Math.round(performance.now() - start);
      }, noteId);
      apiTimings.push(elapsed);
    }

    const apiResult = summarize("/api/notes/{id}", apiTimings);
    console.log("\n=== INDIVIDUAL NOTE API TIMING ===");
    console.log(`  Values: ${apiResult.values.join(", ")} ms`);
    console.log(`  Avg: ${apiResult.avg} ms | P50: ${apiResult.p50} ms | P95: ${apiResult.p95} ms`);

    // Note: Click-to-render timing is unreliable due to client-side cache.
    // Clicking a note that's already cached doesn't trigger a new API call,
    // so the editor may not re-render. Use the raw API timing above instead.
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
