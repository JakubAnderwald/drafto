import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Cookie,
  type Page,
} from "@playwright/test";

/**
 * Security-focused E2E tests (Phase 7.1)
 *
 * These tests verify security boundaries using authenticated API calls:
 * - Unauthenticated access is blocked
 * - API routes enforce auth
 * - Upload size limits are enforced
 * - Health endpoint is public
 */

// A signed-out API call must get a 401 with a JSON body. A 307 to /login would be followed by
// the browser's `fetch()`, handing the client the login page's HTML instead of a 401 (#460).
async function expectUnauthorizedJson(response: Response) {
  expect(response.status).toBe(401);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = await response.json();
  expect(typeof body.error).toBe("string");
}

test.describe("Security: API authentication enforcement", () => {
  test("unauthenticated fetch of a protected API route gets 401 JSON, not a redirect", async () => {
    const response = await fetch("http://localhost:3000/api/notebooks", { redirect: "manual" });
    await expectUnauthorizedJson(response);
  });

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
  test("unauthenticated user cannot access admin approve endpoint", async () => {
    const response = await fetch("http://localhost:3000/api/admin/approve-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "00000000-0000-0000-0000-000000000000" }),
      redirect: "manual",
    });
    // Middleware refuses a signed-out API call with 401 JSON, not a redirect to /login.
    await expectUnauthorizedJson(response);
  });

  test("unauthenticated user cannot access admin delete-user endpoint", async () => {
    const response = await fetch("http://localhost:3000/api/admin/delete-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "00000000-0000-0000-0000-000000000000" }),
      redirect: "manual",
    });
    // Middleware refuses a signed-out API call with 401 JSON, not a redirect to /login.
    await expectUnauthorizedJson(response);
  });

  test("unauthenticated user cannot access cleanup-trash endpoint", async () => {
    const response = await fetch("http://localhost:3000/api/cron/cleanup-trash", {
      method: "POST",
      redirect: "manual",
    });
    await expectUnauthorizedJson(response);
  });

  test("unauthenticated call cannot trigger the weekly-metrics email", async () => {
    const response = await fetch("http://localhost:3000/api/cron/weekly-metrics", {
      redirect: "manual",
    });
    await expectUnauthorizedJson(response);
  });

  test("a wrong cron secret cannot trigger the weekly-metrics email", async () => {
    const response = await fetch("http://localhost:3000/api/cron/weekly-metrics", {
      headers: { Authorization: "Bearer not-the-cron-secret" },
      redirect: "manual",
    });
    await expectUnauthorizedJson(response);
  });
});

test.describe("Security: upload constraints", () => {
  test("upload to nonexistent note returns 404", async ({ request }) => {
    const response = await request.post(
      "/api/notes/00000000-0000-0000-0000-000000000000/attachments/upload-url",
      {
        data: {
          fileName: "test.txt",
          fileSize: 17,
          mimeType: "text/plain",
        },
      },
    );
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Note not found");
  });
});

test.describe("Security: UI redirects for unauthenticated access", () => {
  test("unauthenticated visit to / gets the public landing page, not the app", async () => {
    // Use fetch with redirect: "manual" to see the server's own answer
    // (browser.newContext() can inherit dev-mode state in Next.js)
    const response = await fetch("http://localhost:3000/", { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const body = await response.text();
    expect(body).toContain("What Drafto does");
    expect(body).not.toContain("New notebook");
  });

  test("unauthenticated visit to /admin redirects to login", async () => {
    const response = await fetch("http://localhost:3000/admin", { redirect: "manual" });
    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/login");
  });

  test("unauthenticated visit to /admin/stats redirects to login", async () => {
    const response = await fetch("http://localhost:3000/admin/stats", { redirect: "manual" });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });
});

test.describe("Security: preview-only test sign-in", () => {
  test("test sign-in route answers 404 outside a Vercel preview (no VERCEL_ENV locally)", async () => {
    // The factory browser runner's one-time-link sign-in works only on a dev-backed Vercel
    // preview (ADR-0051). Local and CI servers set no VERCEL_ENV, so a signed-out request gets
    // past the middleware (it is a public route) and the route itself answers 404.
    const response = await fetch("http://localhost:3000/auth/test-sign-in?token_hash=x", {
      redirect: "manual",
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});

test.describe("Security: admin pages for a signed-in non-admin", () => {
  test("a non-admin visiting /admin/stats is sent to /", async ({ page }) => {
    await page.goto("/admin/stats");
    await page.waitForURL((url) => url.pathname === "/", { timeout: 15000 });
    // The chromium project signs in as the non-admin E2E user (auth.setup.ts). The app shell
    // proves this was a signed-in redirect: a signed-out visit goes to /login, and the public
    // landing page at / has no notebooks pane.
    await expect(page.getByTestId("notebooks-pane")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Product metrics" })).toBeHidden();
  });
});

// --- Tampered session cookie -------------------------------------------------------------------
//
// The middleware verifies the session's access token itself with `getClaims()` (ADR-0097), so a
// token with a broken signature must read as signed out. These helpers copy the signed-in E2E
// user's Supabase auth cookie into a fresh browser context, optionally with the token tampered.

// @supabase/ssr names the cookie `sb-<project ref>-auth-token`, split into `.0`, `.1`… chunks once
// the value passes 3180 characters. The value is `base64-` + base64url(JSON session).
const AUTH_COOKIE_NAME = /^(sb-.+-auth-token)(?:\.(0|[1-9]\d*))?$/;
const SESSION_ENCODING_PREFIX = "base64-";
const MAX_COOKIE_CHUNK_LENGTH = 3180;

type StoredSession = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  [field: string]: unknown;
};

type AuthCookie = { key: string; chunks: Cookie[] };

function findAuthCookie(cookies: Cookie[]): AuthCookie {
  const parts = cookies.flatMap((cookie) => {
    const match = AUTH_COOKIE_NAME.exec(cookie.name);
    if (!match) return [];
    return [{ cookie, key: match[1], index: match[2] === undefined ? -1 : Number(match[2]) }];
  });
  if (parts.length === 0) {
    throw new Error("The signed-in storage state has no sb-<ref>-auth-token cookie");
  }
  const key = parts[0].key;
  const ofKey = parts.filter((part) => part.key === key);
  // Like @supabase/ssr's combineChunks: an unchunked cookie wins over chunks.
  const whole = ofKey.find((part) => part.index === -1);
  const chunks = whole
    ? [whole.cookie]
    : ofKey.sort((a, b) => a.index - b.index).map((part) => part.cookie);
  return { key, chunks };
}

function decodeSession(chunks: Cookie[]): StoredSession {
  const raw = chunks.map((chunk) => chunk.value).join("");
  if (!raw.startsWith(SESSION_ENCODING_PREFIX)) {
    throw new Error("Expected the auth cookie in @supabase/ssr's base64- encoding");
  }
  const json = Buffer.from(raw.slice(SESSION_ENCODING_PREFIX.length), "base64url").toString("utf8");
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("The auth cookie does not hold a session object");
  }
  const record = parsed as Record<string, unknown>;
  const { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt } = record;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new Error("The auth cookie's session has no access_token / refresh_token");
  }
  return {
    ...record,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: typeof expiresAt === "number" ? expiresAt : undefined,
  };
}

// Same name scheme and chunk size as @supabase/ssr. base64url characters need no URI escaping,
// so the string length is the length the chunker measures.
function encodeSessionCookies(key: string, template: Cookie, session: StoredSession): Cookie[] {
  const value =
    SESSION_ENCODING_PREFIX + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  if (value.length <= MAX_COOKIE_CHUNK_LENGTH) {
    return [{ ...template, name: key, value }];
  }
  const chunks: Cookie[] = [];
  for (let start = 0; start < value.length; start += MAX_COOKIE_CHUNK_LENGTH) {
    chunks.push({
      ...template,
      name: `${key}.${chunks.length}`,
      value: value.slice(start, start + MAX_COOKIE_CHUNK_LENGTH),
    });
  }
  return chunks;
}

// An hour ahead, so neither the middleware nor the browser client tries a refresh: the request
// must stand or fall on the access token alone.
function withFutureExpiry(session: StoredSession): StoredSession {
  const inAnHour = Math.floor(Date.now() / 1000) + 3600;
  return { ...session, expires_at: Math.max(session.expires_at ?? 0, inAnHour) };
}

// Changes the signature's first characters, not its last: the final base64url character can carry
// unused padding bits, so editing it may decode to the very same signature bytes.
function tamperSignature(jwt: string): string {
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature || signature.length < 8) {
    throw new Error("The access token is not a signed JWT");
  }
  // An access token already past its `exp` reads as signed out without any signature check, and
  // the test would pass for the wrong reason. auth.setup.ts signs in fresh on every run.
  const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    exp?: unknown;
  };
  if (typeof exp !== "number" || exp <= Math.floor(Date.now() / 1000) + 60) {
    throw new Error("The signed-in access token has expired: re-run the setup project");
  }
  const changed = [...signature.slice(0, 4)].map((char) => (char === "A" ? "B" : "A")).join("");
  return `${header}.${payload}.${changed}${signature.slice(4)}`;
}

function tamperedSession(session: StoredSession): StoredSession {
  return {
    ...withFutureExpiry(session),
    access_token: tamperSignature(session.access_token),
    // A refresh can't rescue the session either.
    refresh_token: "tampered-refresh-token",
  };
}

// A fresh context holding only the (transformed) auth cookie, not the original chunks.
async function contextWithSessionCookie(
  browser: Browser,
  signedIn: BrowserContext,
  transform: (session: StoredSession) => StoredSession,
): Promise<{ context: BrowserContext; cookies: Cookie[] }> {
  const { key, chunks } = findAuthCookie(await signedIn.cookies());
  const cookies = encodeSessionCookies(key, chunks[0], transform(decodeSession(chunks)));
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await context.addCookies(cookies);
  return { context, cookies };
}

type FetchResult = { status: number; location: string | null; errorType: string };

async function fetchNotebooksFromPage(page: Page): Promise<FetchResult> {
  return page.evaluate(async () => {
    const response = await fetch("/api/notebooks", { redirect: "manual" });
    const body: unknown = await response.json().catch(() => null);
    const error =
      typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    return {
      status: response.status,
      location: response.headers.get("location"),
      errorType: typeof error,
    };
  });
}

test.describe("Security: tampered session cookie", () => {
  // The default context is the signed-in E2E user (`e2e/.auth/user.json` from auth.setup.ts).
  test("an access token with a broken signature is treated as signed out", async ({
    browser,
    context: signedIn,
  }) => {
    const { context, cookies } = await contextWithSessionCookie(browser, signedIn, tamperedSession);
    try {
      const page = await context.newPage();
      await page.goto("/settings");
      await page.waitForURL((url) => url.pathname === "/login", { timeout: 15000 });

      // Put the tampered cookie back in case the redirect cleared it, so the API call below is
      // judged on the tampered token and not on a missing cookie.
      await context.addCookies(cookies);
      const result = await fetchNotebooksFromPage(page);
      expect(result).toEqual({ status: 401, location: null, errorType: "string" });
    } finally {
      await context.close();
    }
  });

  // Control: the same copy without the tampering still signs in, so the test above fails for the
  // signature and not because the cookie was copied wrong.
  test("an untampered copy of the same session cookie stays signed in", async ({
    browser,
    context: signedIn,
  }) => {
    const { context } = await contextWithSessionCookie(browser, signedIn, withFutureExpiry);
    try {
      const page = await context.newPage();
      await page.goto("/settings");
      expect(new URL(page.url()).pathname).toBe("/settings");

      const result = await fetchNotebooksFromPage(page);
      expect(result.status).toBe(200);
    } finally {
      await context.close();
    }
  });
});
