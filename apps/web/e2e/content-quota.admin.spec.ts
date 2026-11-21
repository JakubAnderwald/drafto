import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { Database } from "@drafto/shared";
import { CONTENT_QUOTA_EXCEEDED_CODE } from "@drafto/shared/constants";
import { ADMIN_E2E_SKIP_REASON, getAdminCredentials } from "./helpers/admin-credentials";
import { assertNotProduction } from "./helpers/e2e-supabase";
import { fillSecret } from "./helpers/secret-fields";

/**
 * Per-user note content quota (ADR 0090), against the real notes trigger.
 *
 * Runs in the `chromium-admin` project (the file name matches its `admin.spec.ts`
 * pattern), which is only registered when E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and
 * SUPABASE_SERVICE_ROLE_KEY are set; the skip below covers running it some other way.
 *
 * Like `storage-quota.admin.spec.ts`, it creates its own user with the dev project's
 * service-role key, approves it and gives it a 1-byte content quota, so the shared E2E
 * user's quota is never touched. That user's first edit is refused with the notes-full
 * banner; the quota is then lifted and the kept edit saves. The admin sees the user's
 * notes columns. afterAll resets the quota and deletes the user, which cascades to its
 * notebook and notes.
 *
 * The tests share the user, so they run in order in one worker.
 */
const hasAdminCredentials = getAdminCredentials() !== null;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const canRun = hasAdminCredentials && supabaseUrl !== "" && serviceRoleKey !== "";
const SKIP_REASON = `${ADMIN_E2E_SKIP_REASON}, or NEXT_PUBLIC_SUPABASE_URL is missing`;

/** Smaller than any note content, so the first edit that adds content is refused. */
const TINY_QUOTA_BYTES = 1;
const NOTE_TITLE = "Content quota note";

interface QuotaUser {
  id: string;
  email: string;
  password: string;
}

function serviceRoleClient(): SupabaseClient<Database> {
  assertNotProduction(supabaseUrl);
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-drafto-client": "web-e2e-content-quota" } },
  });
}

async function setContentQuota(
  admin: SupabaseClient<Database>,
  userId: string,
  bytes: number | null,
) {
  const { error } = await admin
    .from("profiles")
    .update({ content_quota_bytes: bytes })
    .eq("id", userId);
  if (error) throw new Error(`Could not set the content quota: ${error.message}`);
}

async function createQuotaUser(admin: SupabaseClient<Database>): Promise<QuotaUser> {
  const email = `content-quota-e2e+${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
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
    .update({ is_approved: true, content_quota_bytes: TINY_QUOTA_BYTES })
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
  await fillSecret(page.getByLabel("Password", { exact: true }), user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
}

test.describe("Content quota", () => {
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
    try {
      await setContentQuota(admin, quotaUser.id, null);
    } finally {
      const { error } = await admin.auth.admin.deleteUser(quotaUser.id);
      if (error) console.warn(`[content-quota e2e] could not delete ${quotaUser.id}:`, error);
    }
  });

  test.describe("as a user over the quota", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("typing into a note shows the notes-full banner, and the edit saves once there's room", async ({
      page,
    }) => {
      const user = quotaUser;
      if (!user) throw new Error("beforeAll did not create the quota test user");
      await signIn(page, user);

      const notebookRes = await page.request.post("/api/notebooks", {
        data: { name: "Content quota E2E" },
      });
      expect(notebookRes.ok()).toBe(true);
      const notebookId = ((await notebookRes.json()) as { id: string }).id;
      const noteRes = await page.request.post(`/api/notebooks/${notebookId}/notes`);
      expect(noteRes.ok()).toBe(true);
      const noteId = ((await noteRes.json()) as { id: string }).id;
      // A title-only update doesn't grow the content, so the quota lets it through.
      const titleRes = await page.request.patch(`/api/notes/${noteId}`, {
        data: { title: NOTE_TITLE },
      });
      expect(titleRes.ok()).toBe(true);

      // The API answers a growing content write with the content quota 413.
      const contentRes = await page.request.patch(`/api/notes/${noteId}`, {
        data: { content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
      });
      expect(contentRes.status()).toBe(413);
      const refusal = (await contentRes.json()) as { code?: string; quotaBytes?: number | null };
      expect(refusal.code).toBe(CONTENT_QUOTA_EXCEEDED_CODE);
      expect(refusal.quotaBytes).toBe(TINY_QUOTA_BYTES);

      // The user's only notebook opens by default; retry the click until the list has hydrated.
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible({ timeout: 10000 });
      const editor = page.locator("[contenteditable='true']").first();
      await expect(async () => {
        // Anchored: a substring match also finds the row's "Actions for <title>" button.
        await page
          .getByRole("button", { name: new RegExp(`^${NOTE_TITLE}`) })
          .click({ timeout: 1000 });
        await expect(editor).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 15000 });

      await editor.click();
      await page.keyboard.type("Over the quota");
      await expect(page.getByTestId("note-sync-banner")).toContainText("Notes full:", {
        timeout: 10000,
      });

      // Lift the quota: the next keystroke sends the kept edit with it.
      await setContentQuota(admin, user.id, null);
      await page.keyboard.type("!");
      await expect(page.getByTestId("save-status-badge")).toHaveText("Saved", { timeout: 10000 });
      await expect(page.getByTestId("note-sync-banner")).toHaveCount(0);

      const saved = await page.request.get(`/api/notes/${noteId}`);
      expect(JSON.stringify(await saved.json())).toContain("Over the quota!");

      // Back to the tiny quota for the admin test below.
      await setContentQuota(admin, user.id, TINY_QUOTA_BYTES);
    });
  });

  test.describe("as the admin", () => {
    test("the admin page shows notes usage and sets the notes quota to Unlimited", async ({
      page,
    }) => {
      const user = quotaUser;
      if (!user) throw new Error("beforeAll did not create the quota test user");

      await page.goto("/admin");
      const table = page.getByTestId("admin-storage-table");
      await expect(table).toBeVisible({ timeout: 10000 });
      await expect(table.getByRole("columnheader", { name: "Notes used" })).toBeVisible();
      await expect(table.getByRole("columnheader", { name: "Notes quota" })).toBeVisible();

      const row = table.locator("tr", { hasText: user.email });
      await expect(row).toContainText("Current: < 0.1 MB");

      // The page is server-rendered: retry until the hydrated checkbox disables the input.
      const unlimited = row.getByLabel(`Unlimited notes for ${user.email}`);
      const quotaInput = row.getByLabel(`Notes quota in MB for ${user.email}`);
      await expect(async () => {
        await unlimited.check({ timeout: 1000 });
        await expect(quotaInput).toBeDisabled({ timeout: 1000 });
      }).toPass({ timeout: 15000 });

      await row.getByRole("button", { name: `Save notes quota for ${user.email}` }).click();
      await expect(row.getByRole("status")).toHaveText("Saved", { timeout: 10000 });

      const { data, error } = await admin
        .from("profiles")
        .select("content_quota_bytes")
        .eq("id", user.id)
        .single();
      expect(error).toBeNull();
      expect(data?.content_quota_bytes).toBeNull();
    });
  });
});
