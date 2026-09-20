/**
 * @vitest-environment node
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUCKET_NAME } from "@drafto/shared";
import { deleteUserAccount } from "@/lib/account/delete-user";
import { removeUserAttachments } from "@/lib/storage/remove-user-attachments";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Live check of `deleteUserAccount` against the DEV Supabase project: a real
 * user with a notebook, note, attachment row, API key and storage object is
 * deleted, and every trace of it must be gone afterwards.
 *
 * Opt-in: it only runs when `SUPABASE_SERVICE_ROLE_KEY` is exported and
 * `NEXT_PUBLIC_SUPABASE_URL` points at the dev project. Vitest does not load
 * `.env.local`, so a plain `pnpm test` skips it. It refuses any other project,
 * so it can never touch production.
 *
 * Creating the user fires the dev project's new-signup webhook, if dev has one
 * configured. The user is usually gone before the webhook looks it up, in which
 * case no admin email is sent.
 */

const DEV_PROJECT_REF = "huhzactreblzcogqkbsd";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function isDevProject(url: string): boolean {
  try {
    return new URL(url).hostname === `${DEV_PROJECT_REF}.supabase.co`;
  } catch {
    return false;
  }
}

const canRun = serviceRoleKey !== "" && isDevProject(supabaseUrl);

describe.skipIf(!canRun)("deleteUserAccount (live, dev project)", () => {
  let admin: SupabaseClient<Database>;
  let userId: string | null = null;
  let deleted = false;

  afterAll(async () => {
    // Best-effort cleanup when the test failed before the account was deleted.
    if (!userId || deleted) return;
    await removeUserAttachments(admin, userId);
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) console.warn(`[account-deletion.live] cleanup of ${userId} failed:`, error);
  });

  it("removes the auth user, every owned row and every storage object", async () => {
    admin = createClient<Database>(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { "x-drafto-client": "web-admin" } },
    });

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: `account-deletion-live+${Date.now()}-${randomUUID().slice(0, 8)}@example.com`,
      password: randomUUID(),
      email_confirm: true,
    });
    expect(createError).toBeNull();
    const id = created.user!.id;
    userId = id;

    const { error: approveError } = await admin
      .from("profiles")
      .update({ is_approved: true })
      .eq("id", id);
    expect(approveError).toBeNull();

    const { data: notebook, error: notebookError } = await admin
      .from("notebooks")
      .insert({ user_id: id, name: "Account deletion live test" })
      .select("id")
      .single();
    expect(notebookError).toBeNull();

    const { data: note, error: noteError } = await admin
      .from("notes")
      .insert({ user_id: id, notebook_id: notebook!.id, title: "To be deleted" })
      .select("id")
      .single();
    expect(noteError).toBeNull();

    const filePath = `${id}/${note!.id}/file.txt`;
    const fileBody = new TextEncoder().encode("account deletion live test");
    const { error: uploadError } = await admin.storage
      .from(BUCKET_NAME)
      .upload(filePath, fileBody, { contentType: "text/plain" });
    expect(uploadError).toBeNull();

    const { error: attachmentError } = await admin.from("attachments").insert({
      user_id: id,
      note_id: note!.id,
      file_name: "file.txt",
      file_path: filePath,
      file_size: fileBody.byteLength,
      mime_type: "text/plain",
    });
    expect(attachmentError).toBeNull();

    const { error: apiKeyError } = await admin.from("api_keys").insert({
      user_id: id,
      key_prefix: "dk_live0",
      // Unique 64-hex-character stand-in for a SHA-256 digest.
      key_hash: `${randomUUID()}${randomUUID()}`.replaceAll("-", ""),
      name: "Account deletion live test",
    });
    expect(apiKeyError).toBeNull();

    await expect(deleteUserAccount(admin, id)).resolves.toEqual({ ok: true });
    deleted = true;

    const { data: authUser } = await admin.auth.admin.getUserById(id);
    expect(authUser.user).toBeNull();

    const { count: profileCount, error: profileCountError } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("id", id);
    expect(profileCountError).toBeNull();
    expect(profileCount).toBe(0);

    for (const table of ["notebooks", "notes", "attachments", "api_keys"] as const) {
      const { count, error } = await admin
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("user_id", id);
      expect(error).toBeNull();
      expect(count, `${table} rows left behind`).toBe(0);
    }

    const bucket = admin.storage.from(BUCKET_NAME);
    for (const prefix of [id, `${id}/${note!.id}`]) {
      const { data: objects, error: listError } = await bucket.list(prefix);
      expect(listError).toBeNull();
      expect(objects, `storage objects left under ${prefix}`).toEqual([]);
    }
  }, 60_000);
});
