import { Directory, Paths } from "expo-file-system";
import { ATTACHMENT_CACHE_DIR_NAME } from "@drafto/shared";

import { excludeFromBackup } from "@/lib/backup-exclusion";

// The attachment cache's folder, <Documents>/attachment-cache/ (ADR-0086),
// kept out of iCloud and device backups (ADR-0107): everything in it is a
// copy the app can download again. On iOS a flag on the folder covers all of
// it. The flag belongs to the folder, so a sign-out wipe, which deletes the
// folder, takes it with it. This file doesn't load the database, so
// editor-page.ts can use it too.

// Whether this launch has flagged the current folder.
let excluded = false;

export function getAttachmentCacheDir(): Directory {
  return new Directory(Paths.document, ATTACHMENT_CACHE_DIR_NAME);
}

/**
 * The cache folder, created if it is missing and flagged to stay out of
 * backups. The flag is set once per launch, and again on the next call after
 * `forgetAttachmentCacheRoot()` or a failed attempt. A flag that can't be set
 * is logged and never blocks the write: the folder also holds picked images
 * waiting to upload. Throws only when the folder can't be created.
 */
export function ensureAttachmentCacheRoot(): Directory {
  const dir = getAttachmentCacheDir();
  dir.create({ intermediates: true, idempotent: true });
  if (!excluded) excluded = excludeFromBackup(dir);
  return dir;
}

/** The cache folder was deleted (sign-out): flag the next one again. */
export function forgetAttachmentCacheRoot(): void {
  excluded = false;
}
