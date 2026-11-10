import { Alert } from "react-native";

export const STORAGE_FULL_ALERT_TITLE = "Storage Full";

/**
 * The database provider is the only reporter of refused uploads: each pass of a sync
 * run alerts for the refusals its upload run counted, the attachment picker's own
 * included. A follow-up pass (such as the rerun a second pick asks for) can refuse
 * another attachment moments later. Within this window a second storage-full alert is
 * dropped, so the user dismisses one sheet for a burst of refusals.
 */
export const STORAGE_FULL_ALERT_DEDUPE_MS = 3_000;

let lastShownAt: number | null = null;

/** Shows the storage-full alert (issue #794) unless one was just shown. */
export function showStorageFullAlert(message: string): void {
  const now = Date.now();
  if (lastShownAt !== null && now - lastShownAt < STORAGE_FULL_ALERT_DEDUPE_MS) return;
  lastShownAt = now;
  Alert.alert(STORAGE_FULL_ALERT_TITLE, message);
}

/** Test seam: forget the last alert. */
export function resetStorageFullAlert(): void {
  lastShownAt = null;
}
