import * as SecureStore from "expo-secure-store";

import { database } from "@/db";
import { deleteAllLocalAttachments } from "@/lib/data/attachment-queue";

const LAST_USER_ID_KEY = "drafto_last_user_id";

const IDENTITY_TABLES = ["notebooks", "notes", "attachments"] as const;

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
 * Best-effort: storage read/write and reset failures are logged and swallowed
 * so a guard failure never blocks the app from loading. The id is never cleared
 * on sign-out — only overwritten on the next sign-in — so a different user is
 * still recognised even when the sign-out-time reset was skipped.
 */
export async function ensureLocalIdentity(userId: string): Promise<void> {
  let lastUserId: string | null;
  try {
    lastUserId = await getLastUserId();
  } catch (error) {
    // Can't determine the previous identity — do NOT reset, to avoid wiping a
    // matching user's data on a transient storage error.
    console.warn("[local-identity] Failed to read last signed-in user id:", error);
    return;
  }

  if (lastUserId === userId) {
    return;
  }

  // A different user is signing in. Only reset when we know the previous user
  // differed AND the local database actually holds data — a fresh install
  // (empty DB) or an unknown previous id (null) must not trigger a wipe.
  if (lastUserId !== null) {
    try {
      if (await localDatabaseHasData()) {
        await database.write(() => database.unsafeResetDatabase());
        await deleteAllLocalAttachments();
      }
    } catch (error) {
      console.error("[local-identity] Failed to reset local data on user change:", error);
    }
  }

  try {
    await persistUserId(userId);
  } catch (error) {
    console.warn("[local-identity] Failed to persist signed-in user id:", error);
  }
}
