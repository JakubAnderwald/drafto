import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  removeAllUserAttachments,
  removeUserAttachments,
} from "@/lib/storage/remove-user-attachments";

export type DeleteUserAccountResult = { ok: true } | { ok: false; stage: "storage" | "auth" };

/**
 * Permanently deletes a user: their attachment files, their auth user, and —
 * through the `on delete cascade` foreign keys — every public row they own.
 *
 * Order matters, because the cascade never touches Storage:
 *
 * 1. **Strict storage sweep.** Any list or remove error stops here with
 *    `stage: "storage"` and the auth user untouched, so the account is intact
 *    and the caller can simply retry (removal is idempotent).
 * 2. **Delete the auth user.** An error returns `stage: "auth"`. Storage is
 *    already empty at that point; a retry re-runs step 1, which is cheap.
 * 3. **Best-effort sweep** to catch an upload that landed between steps 1 and
 *    2. The user is gone by now, so a failure only leaves orphaned objects and
 *    is reported to Sentry without failing the deletion.
 *
 * Failures are reported to Sentry here; callers only map `stage` to a response.
 * There is no authorization in this function — `admin` must be a service-role
 * client and the caller must already have decided `userId` may be deleted.
 */
export async function deleteUserAccount(
  admin: SupabaseClient<Database>,
  userId: string,
): Promise<DeleteUserAccountResult> {
  try {
    await removeAllUserAttachments(admin, userId);
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "delete-user-account:storage", userId } });
    return { ok: false, stage: "storage" };
  }

  try {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "delete-user-account:deleteUser", userId } });
    return { ok: false, stage: "auth" };
  }

  await removeUserAttachments(admin, userId);

  return { ok: true };
}
