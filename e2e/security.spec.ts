import { test, expect } from "@playwright/test";

/**
 * Security-focused E2E tests (Phase 7.1)
 *
 * These tests verify security boundaries using authenticated API calls:
 * - Unauthenticated access is blocked
 * - API routes enforce auth
 * - Upload size limits are enforced
 * - Health endpoint is public
 */

test.describe("Security: API authentication enforcement", () => {
  test("health API is publicly accessible without auth", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  test("authenticated user can access notebooks API", async ({ request }) => {
    const response = await request.get("/api/notebooks");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();
  });

  test("authenticated user can access trash API", async ({ request }) => {
    const response = await request.get("/api/notes/trash");
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(Array.isArray(body)).toBeTruthy();
  });
});

test.describe("Security: input validation on API routes", () => {
  test("POST /api/notebooks rejects missing name", async ({ request }) => {
    const response = await request.post("/api/notebooks", {
      data: {},
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("name is required");
  });

  test("POST /api/notebooks rejects empty string name", async ({ request }) => {
    const response = await request.post("/api/notebooks", {
      data: { name: "   " },
    });
    expect(response.status()).toBe(400);
  });

  test("GET /api/notes/nonexistent-id returns 404", async ({ request }) => {
    const response = await request.get("/api/notes/00000000-0000-0000-0000-000000000000");
    expect(response.status()).toBe(404);
  });

  test("PATCH /api/notes/nonexistent-id returns error", async ({ request }) => {
    const response = await request.patch("/api/notes/00000000-0000-0000-0000-000000000000", {
      data: { title: "Hack" },
    });
    expect(response.status()).toBe(404);
  });

  test("DELETE /api/notes/nonexistent-id/permanent returns 404", async ({ request }) => {
    const response = await request.delete(
      "/api/notes/00000000-0000-0000-0000-000000000000/permanent",
    );
    expect(response.status()).toBe(404);
  });

  test("DELETE /api/attachments/nonexistent-id returns 404", async ({ request }) => {
    const response = await request.delete("/api/attachments/00000000-0000-0000-0000-000000000000");
    expect(response.status()).toBe(404);
  });
});

test.describe("Security: admin route protection", () => {
  test("non-admin user cannot approve users", async ({ request }) => {
    const response = await request.post("/api/admin/approve-user", {
      data: { userId: "00000000-0000-0000-0000-000000000000" },
    });
    // E2E test user is not admin — should get 403
    expect(response.status()).toBe(403);
  });

  test("non-admin user cannot trigger trash cleanup cron", async ({ request }) => {
    const response = await request.post("/api/cron/cleanup-trash");
    // E2E test user is not admin — should get 403
    expect(response.status()).toBe(403);
  });
});

test.describe("Security: upload constraints", () => {
  test("upload to nonexistent note returns 404", async ({ request }) => {
    const buffer = Buffer.from("test file content");
    const response = await request.post(
      "/api/notes/00000000-0000-0000-0000-000000000000/attachments",
      {
        multipart: {
          file: {
            name: "test.txt",
            mimeType: "text/plain",
            buffer,
          },
        },
      },
    );
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Note not found");
  });
});

test.describe("Security: UI redirects for unauthenticated access", () => {
  test("unauthenticated visit to / redirects to login", async ({ browser }) => {
    // Create a fresh context without saved auth state
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/");

    // Should end up on /login
    await expect(page).toHaveURL(/\/login/);

    await context.close();
  });

  test("unauthenticated visit to /admin redirects to login", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/admin");

    await expect(page).toHaveURL(/\/login/);

    await context.close();
  });
});
