import * as SecureStore from "expo-secure-store";

import { database } from "@/db";
import { deleteAllLocalAttachments } from "@/lib/data/attachment-queue";

const LAST_USER_ID_KEY = "drafto_last_user_id";

const IDENTITY_TABLES = ["notebooks", "notes", "attachments"] as const;

/**
 * Outcome of the cross-account guard.
 *
 * - `"ready"` — the local database holds no other user's records; safe to sync.
 * - `"unsafe"` — another user's records are still present locally because the
 *   reset failed. The caller must not sync: the push would carry the previous
 *   user's `user_id`, RLS would reject it, and the stale rows would surface in
 *   this user's UI.
 */
export type LocalIdentityStatus = "ready" | "unsafe";

async function getLastUserId(): Promise<string | null> {
  return SecureStore.getItemAsync(LAST_USER_ID_KEY);
}

async function persistUserId(userId: string): Promise<void> {
  await SecureStore.setItemAsync(LAST_USER_ID_KEY, userId);
}

async function localDatabaseHasData(): Promise<boolean> {
  for (const table of IDENTITY_TABLES) {
    const count = await database.get(table).query().fetchCount();
    if (count > 0) return true;
  }
  return false;
}

/**
 * Cross-account safety guard, run before the initial sync for a signed-in user.
 *
 * Persists the last signed-in user id. When a session is established for a
 * *different* user id and the local WatermelonDB still holds the previous
 * user's records, the local database and cached attachment files are wiped
 * before any sync can push another user's data or surface it in the UI. This
 * catches sign-outs that never ran the sign-out-time reset (force-quit,
 * expired session, reinstall-over-data), and is the backstop for a sign-out
 * whose own reset failed.
 *
 * Best-effort: storage read/write failures are logged and swallowed so a guard
 * failure never blocks the app from loading. The id is never cleared on
 * sign-out — only overwritten on the next sign-in — so a different user is
 * still recognised even when the sign-out-time reset was skipped.
 *
 * Resolves to `"unsafe"` when another user's records could not be cleared; the
 * caller must not sync in that case. Never rejects.
 */
export async function ensureLocalIdentity(userId: string): Promise<LocalIdentityStatus> {
  let lastUserId: string | null;
  try {
    lastUserId = await getLastUserId();
  } catch (error) {
    // Can't determine the previous identity — do NOT reset, to avoid wiping a
    // matching user's data on a transient storage error. Sync stays allowed:
    // the sign-out-time reset is the primary defence, and parking sync on every
    // transient storage hiccup would strand legitimate users on stale data.
    console.warn("[local-identity] Failed to read last signed-in user id:", error);
    return "ready";
  }

  if (lastUserId === userId) {
    return "ready";
  }

  // A different user is signing in. Only reset when we know the previous user
  // differed AND the local database actually holds data — a fresh install
  // (empty DB) or an unknown previous id (null) must not trigger a wipe.
  if (lastUserId !== null) {
    try {
      if (await localDatabaseHasData()) {
        await database.write(() => database.unsafeResetDatabase());
      }
      // Attachment files live on the filesystem, independent of the local DB.
      // A prior sign-out may have reset the DB but failed to delete files,
      // leaving an empty DB with orphaned attachments; always clean them on a
      // different-user sign-in so that failure can't leak files across accounts.
      await deleteAllLocalAttachments();
    } catch (error) {
      console.error("[local-identity] Failed to reset local data on user change:", error);
      // Deliberately leave the PREVIOUS user's id stored. Persisting the new id
      // here would make every later launch take the `lastUserId === userId`
      // early return above and permanently disarm the guard while the other
      // user's records are still on disk. Keeping the mismatch visible makes
      // the next launch retry the reset, and "unsafe" tells the caller not to
      // sync — a push under this session would carry the other user's user_id,
      // be rejected by RLS, and wedge sync.
      return "unsafe";
    }
  }

  try {
    await persistUserId(userId);
  } catch (error) {
    // Escalated to error (not warn): a failed persist leaves the guard's stored
    // identity stale, so the next launch for this same user re-triggers a
    // destructive reset. Surface it rather than swallow it quietly.
    console.error("[local-identity] Failed to persist signed-in user id:", error);
  }

  return "ready";
}
