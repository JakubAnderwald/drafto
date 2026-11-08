import { Alert } from "react-native";

export const STORAGE_FULL_ALERT_TITLE = "Storage Full";

/**
 * One refusal can reach two reporters at once: the attachment picker, after the upload
 * it started, and the database provider, which counts every refusal of a sync's upload
 * run. Within this window a second storage-full alert is dropped, so the user dismisses
 * one sheet per refusal.
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
