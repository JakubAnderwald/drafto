import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { Database } from "@drafto/shared";
import { STORAGE_QUOTA_EXCEEDED_CODE } from "@drafto/shared/constants";
import { ADMIN_E2E_SKIP_REASON, getAdminCredentials } from "./helpers/admin-credentials";
import { assertNotProduction } from "./helpers/e2e-supabase";
import { fillSecret } from "./helpers/secret-fields";

/**
 * Per-user attachment storage quota (issue #794).
 *
 * Runs in the `chromium-admin` project (the file name matches its `admin.spec.ts`
 * pattern), which is only registered when E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and
 * SUPABASE_SERVICE_ROLE_KEY are set; the skip below covers running it some other way.
 *
 * It creates its own user with the dev project's service-role key, approves it and
 * gives it a 1 KB quota, so the shared E2E user's storage is never touched. That user
 * is refused an upload, then the admin sees it in the storage table and sets it to
 * Unlimited. afterAll deletes the user, which cascades to its notebook and notes; no
 * file is ever stored, because every upload is refused.
 *
 * The tests share the user, so they run in order in one worker.
 */
const hasAdminCredentials = getAdminCredentials() !== null;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const canRun = hasAdminCredentials && supabaseUrl !== "" && serviceRoleKey !== "";
const SKIP_REASON = `${ADMIN_E2E_SKIP_REASON}, or NEXT_PUBLIC_SUPABASE_URL is missing`;

/** Small enough that any real file goes over it. */
const TINY_QUOTA_BYTES = 1024;
const UPLOAD_SIZE_BYTES = 2048;
const NOTE_TITLE = "Storage quota note";

interface QuotaUser {
  id: string;
  email: string;
  password: string;
}

function serviceRoleClient(): SupabaseClient<Database> {
  assertNotProduction(supabaseUrl);
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-drafto-client": "web-e2e-storage-quota" } },
  });
}

async function createQuotaUser(admin: SupabaseClient<Database>): Promise<QuotaUser> {
  const email = `storage-quota-e2e+${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Could not create the quota test user: ${error?.message ?? "no user"}`);
  }

  const { error: profileError } = await admin
    .from("profiles")
    .update({ is_approved: true, storage_quota_bytes: TINY_QUOTA_BYTES })
    .eq("id", data.user.id);
  if (profileError) {
    await admin.auth.admin.deleteUser(data.user.id);
    throw new Error(`Could not set up the quota test user: ${profileError.message}`);
  }

  return { id: data.user.id, email, password };
}

async function signIn(page: Page, user: QuotaUser) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await fillSecret(page.getByLabel("Password"), user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
}

test.describe("Storage quota", () => {
  test.skip(!canRun, SKIP_REASON);
  test.describe.configure({ mode: "serial" });

  let admin: SupabaseClient<Database>;
  let quotaUser: QuotaUser | null = null;

  test.beforeAll(async () => {
    admin = serviceRoleClient();
    quotaUser = await createQuotaUser(admin);
  });

  test.afterAll(async () => {
    if (!quotaUser) return;
    const { error } = await admin.auth.admin.deleteUser(quotaUser.id);
    if (error) console.warn(`[storage-quota e2e] could not delete ${quotaUser.id}:`, error);
  });

  test.describe("as a user over the quota", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("an upload is refused with the storage-full message", async ({ page }) => {
      const user = quotaUser;
      if (!user) throw new Error("beforeAll did not create the quota test user");
      await signIn(page, user);

      const notebookRes = await page.request.post("/api/notebooks", {
        data: { name: "Storage quota E2E" },
      });
      expect(notebookRes.ok()).toBe(true);
      const notebookId = ((await notebookRes.json()) as { id: string }).id;
      const noteRes = await page.request.post(`/api/notebooks/${notebookId}/notes`);
      expect(noteRes.ok()).toBe(true);
      const noteId = ((await noteRes.json()) as { id: string }).id;
      const patchRes = await page.request.patch(`/api/notes/${noteId}`, {
        data: { title: NOTE_TITLE },
      });
      expect(patchRes.ok()).toBe(true);

      // The API refuses before handing out a signed upload URL.
      const uploadUrlRes = await page.request.post(`/api/notes/${noteId}/attachments/upload-url`, {
        data: { fileName: "quota.txt", fileSize: UPLOAD_SIZE_BYTES, mimeType: "text/plain" },
      });
      expect(uploadUrlRes.status()).toBe(413);
      const refusal = (await uploadUrlRes.json()) as { code?: string; quotaBytes?: number | null };
      expect(refusal.code).toBe(STORAGE_QUOTA_EXCEEDED_CODE);
      expect(refusal.quotaBytes).toBe(TINY_QUOTA_BYTES);

      // The editor shows the refusal when a file is pasted into the note. The user's
      // only notebook opens by default; retry the click until the list has hydrated.
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });
      const editor = page.locator("[contenteditable='true']").first();
      await expect(async () => {
        await page.getByRole("button", { name: NOTE_TITLE }).click({ timeout: 1000 });
        await expect(editor).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 15000 });
      await editor.click();
      await editor.evaluate(
        (element, { name, size }) => {
          const data = new DataTransfer();
          data.items.add(new File([new Uint8Array(size)], name, { type: "text/plain" }));
          element.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        },
        { name: "quota.txt", size: UPLOAD_SIZE_BYTES },
      );

      await expect(page.getByTestId("note-editor-upload-error")).toContainText("Storage full:", {
        timeout: 10000,
      });
    });
  });

  test.describe("as the admin", () => {
    test("the admin page lists storage and sets a quota to Unlimited", async ({ page }) => {
      const user = quotaUser;
      if (!user) throw new Error("beforeAll did not create the quota test user");

      await page.goto("/admin");
      const table = page.getByTestId("admin-storage-table");
      await expect(table).toBeVisible({ timeout: 10000 });
      await expect(table.getByRole("columnheader", { name: "Storage used" })).toBeVisible();
      await expect(table.getByRole("columnheader", { name: "Quota" })).toBeVisible();

      const row = table.locator("tr", { hasText: user.email });
      await expect(row).toContainText("Current: < 0.1 MB");

      // The page is server-rendered: retry until the hydrated checkbox disables the input.
      const unlimited = row.getByLabel(`Unlimited storage for ${user.email}`);
      const quotaInput = row.getByLabel(`Quota in MB for ${user.email}`);
      await expect(async () => {
        await unlimited.check({ timeout: 1000 });
        await expect(quotaInput).toBeDisabled({ timeout: 1000 });
      }).toPass({ timeout: 15000 });

      await row.getByRole("button", { name: `Save quota for ${user.email}` }).click();
      await expect(row.getByRole("status")).toHaveText("Saved", { timeout: 10000 });
      await expect(row).toContainText("Current: Unlimited");

      const { data, error } = await admin
        .from("profiles")
        .select("storage_quota_bytes")
        .eq("id", user.id)
        .single();
      expect(error).toBeNull();
      expect(data?.storage_quota_bytes).toBeNull();
    });
  });
});
