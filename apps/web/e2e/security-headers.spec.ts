import type { Page } from "@playwright/test";
import { recordRunNotebook } from "./helpers/run-notebooks";
import { test, expect } from "./helpers/test";

/**
 * The web app's security headers and its nonce-based Content-Security-Policy (ADR-0069, #492).
 * `src/middleware.ts` builds the policy per request; `next.config.ts` adds the static headers.
 *
 * The browser checks collect CSP violations from the page itself. A positive control proves the
 * collector sees a blocked script, so an empty list means nothing was blocked. The Playwright
 * config doesn't set `bypassCSP`, and this spec must not either.
 */

const ORIGIN = "http://localhost:3000";
const NONCE_SOURCE = /'nonce-([A-Za-z0-9+/_-]+={0,2})'/;

interface CspViolation {
  directive: string;
  blocked: string;
  source: string;
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
    /** Whether `<html>` had `dark` when `<body>` was parsed, before any React code ran. */
    __darkAtBody?: boolean | null;
    __controlRan?: boolean;
  }
}

/**
 * Runs before any of the page's own scripts. It records CSP violations, and whether the inline
 * theme script had set `dark` by the time `<body>` was parsed. `use-theme.ts` sets the class
 * again after hydration, so checking it after load would pass even with the script blocked.
 */
function recordBeforeHydration(): void {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__cspViolations?.push({
      directive: event.effectiveDirective,
      blocked: event.blockedURI,
      source: event.sourceFile,
    });
  });

  window.__darkAtBody = null;
  const observer = new MutationObserver(() => {
    if (!document.body) return;
    window.__darkAtBody = document.documentElement.classList.contains("dark");
    observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}

/** CSP errors Chrome logs to the console, a second record next to the page's own events. */
function collectCspConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  return errors;
}

async function violations(page: Page): Promise<CspViolation[]> {
  return page.evaluate(() => window.__cspViolations ?? []);
}

/** Lets late requests (analytics, Sentry, lazy chunks) go out before violations are read. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.evaluate(
    () => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 5000 })),
  );
  await page.waitForTimeout(1000);
}

function nonceOf(policy: string | undefined): string | undefined {
  const scriptSrc = policy
    ?.split(";")
    .find((directive) => directive.trim().startsWith("script-src"));
  return scriptSrc?.match(NONCE_SOURCE)?.[1];
}

test.describe("Security headers", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/login carries the enforced CSP and the hardening headers", async ({ request }) => {
    const response = await request.get("/login");

    expect(response.status()).toBe(200);
    const headers = response.headers();
    const policy = headers["content-security-policy"];
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/_-]+={0,2}' 'strict-dynamic'/);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
    // Each header exactly once: Playwright joins repeated headers with a newline.
    expect(headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  });

  test("every script on the page carries the response's nonce", async ({ request }) => {
    const response = await request.get("/login");
    const nonce = nonceOf(response.headers()["content-security-policy"]);
    const scripts = (await response.text()).match(/<script\b[^>]*>/g) ?? [];

    expect(nonce).toBeDefined();
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  test("each response gets a fresh nonce", async ({ request }) => {
    const first = await request.get("/login");
    const second = await request.get("/login");

    expect(nonceOf(first.headers()["content-security-policy"])).not.toBe(
      nonceOf(second.headers()["content-security-policy"]),
    );
  });

  test("the apple-app-site-association file stays JSON", async ({ request }) => {
    const response = await request.get("/.well-known/apple-app-site-association", {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  });
});

test.describe("CSP in the browser, signed out", () => {
  test.use({
    storageState: {
      cookies: [],
      origins: [{ origin: ORIGIN, localStorage: [{ name: "theme", value: "dark" }] }],
    },
  });

  // `/` is the landing page through the middleware's rewrite, a separate path for the nonce.
  for (const path of ["/login", "/"]) {
    test(`${path} runs the nonce'd theme script before hydration and blocks nothing`, async ({
      page,
    }) => {
      const consoleErrors = collectCspConsoleErrors(page);
      await page.addInitScript(recordBeforeHydration);

      await page.goto(path);
      await settle(page);

      expect(await page.evaluate(() => window.__darkAtBody)).toBe(true);
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      expect(await violations(page)).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });
  }

  test("the sign-in form hydrates and reaches Supabase under the policy", async ({ page }) => {
    // The error alert only appears once React has hydrated the form and supabase-js got an answer
    // from Supabase Auth, which `connect-src` must allow. Typing into the server-rendered inputs
    // alone would pass with every script blocked.
    const consoleErrors = collectCspConsoleErrors(page);
    await page.addInitScript(recordBeforeHydration);
    await page.goto("/login");

    await page.getByLabel("Email").fill("nonexistent-e2e-user@example.com");
    await page.getByLabel("Password").fill("some-password-123");
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
    expect(await violations(page)).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("blocks an inline script without the nonce (positive control)", async ({ page }) => {
    // Proves the collector sees violations, so the empty lists above mean nothing was blocked.
    // The control is an unsigned `<script>` in the server's HTML, as an injection sink would
    // put it there, served with the page's real CSP header. A script added from a test with
    // `page.addScriptTag` or `createElement` wouldn't do: `'strict-dynamic'` trusts any script
    // another script creates, and Chrome exempts Playwright's isolated world from the CSP.
    await page.route("**/login", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      const html = (await response.text()).replace(
        "</head>",
        "<script>window.__controlRan = true;</script></head>",
      );
      await route.fulfill({ response, body: html });
    });
    await page.addInitScript(recordBeforeHydration);

    await page.goto("/login");
    await settle(page);

    await expect
      .poll(async () => (await violations(page)).map((violation) => violation.directive))
      .toContain("script-src-elem");
    expect(await page.evaluate(() => window.__controlRan)).toBeUndefined();
    // On the same page, the nonce'd theme script ran.
    expect(await page.evaluate(() => window.__darkAtBody)).toBe(true);
  });
});

// A small but valid PNG (1×1) and WAV (0.25 s of silence), uploaded through the editor.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function silentWav(): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate / 4;
  const wav = Buffer.alloc(44 + samples, 128);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28); // byte rate: 8-bit mono
  wav.writeUInt16LE(1, 32); // block align
  wav.writeUInt16LE(8, 34); // bits per sample
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples, 40);
  return wav;
}

/** Inserts a media block from the slash menu and uploads `file` through its Upload tab. */
async function uploadThroughEditor(
  page: Page,
  kind: "image" | "audio",
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.keyboard.type(`/${kind}`);
  await expect(
    page.getByRole("option", { name: new RegExp(`^${kind}`, "i") }).first(),
  ).toBeVisible();
  await page.keyboard.press("Enter");

  const chooser = page.waitForEvent("filechooser");
  await page.getByText(`Upload ${kind}`, { exact: true }).click();
  await (await chooser).setFiles(file);
}

test.describe("CSP in the signed-in app", () => {
  test("a note with an uploaded image and audio file loads both with no violation", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://invalid").host;

    // A notebook of the test's own, so a parallel worker's notebook can't be the one opened.
    const notebookName = `CSP NB ${Date.now()}`;
    const notebookRes = await page.request.post("/api/notebooks", { data: { name: notebookName } });
    expect(notebookRes.ok()).toBe(true);
    const notebookId = ((await notebookRes.json()) as { id: string }).id;
    recordRunNotebook(testInfo, notebookId);

    const consoleErrors = collectCspConsoleErrors(page);
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.addInitScript(recordBeforeHydration);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible({ timeout: 10000 });
    await page
      .locator("nav li")
      .filter({ hasText: notebookName })
      .locator('[role="button"]')
      .first()
      .click();
    await expect(page.locator('[data-testid="notebook-item-active"]')).toContainText(notebookName);

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/notebooks/${notebookId}/notes`),
    );
    await page.getByRole("button", { name: "New note", exact: true }).click();
    const noteId = ((await (await created).json()) as { id: string }).id;

    try {
      const editor = page.locator("[contenteditable='true']").first();
      await expect(editor).toBeVisible({ timeout: 5000 });
      await editor.click();

      await uploadThroughEditor(page, "image", {
        name: "csp-check.png",
        mimeType: "image/png",
        buffer: PNG,
      });
      const image = editor.locator(`img[src*="${supabaseHost}"]`);
      await expect(image).toHaveCount(1, { timeout: 20000 });
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
          timeout: 15000,
        })
        .toBeGreaterThan(0);

      // The slash menu leaves the cursor in the empty paragraph after the image block.
      await editor.locator("p").last().click();
      await uploadThroughEditor(page, "audio", {
        name: "csp-check.wav",
        mimeType: "audio/wav",
        buffer: silentWav(),
      });
      const audio = editor.locator(`audio[src*="${supabaseHost}"]`);
      await expect(audio).toHaveCount(1, { timeout: 20000 });
      await expect
        .poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration), {
          timeout: 15000,
        })
        .toBeGreaterThan(0);

      // The open note's realtime channel connects over `wss:`.
      await expect
        .poll(() => sockets.some((url) => url.includes(supabaseHost)), { timeout: 15000 })
        .toBe(true);

      await settle(page);
      expect(await violations(page)).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      // Deleting the note (the fixture does) drops the attachment rows but leaves the files in
      // Storage. The attachment API removes both.
      const listed = await page.request.get(`/api/notes/${noteId}/attachments`);
      if (listed.ok()) {
        for (const { id } of (await listed.json()) as Array<{ id: string }>) {
          await page.request.delete(`/api/attachments/${id}`);
        }
      }
    }
  });
});
