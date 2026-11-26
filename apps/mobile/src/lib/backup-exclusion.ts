import { requireOptionalNativeModule } from "expo";
import type { Directory } from "expo-file-system";

// Keeps a folder out of iCloud and device backups (ADR-0107), through the
// app's own iOS module in apps/mobile/modules/backup-exclusion: expo-file-system
// can't set NSURLIsExcludedFromBackupKey. Android has no such module: its Auto
// Backup already leaves the app's Documents folder out (see ADR-0107).

interface BackupExclusionNativeModule {
  excludeFromBackup(uri: string): void;
}

/**
 * Flag `dir` (and everything in it) to stay out of backups. True when the flag
 * is set; false when there is no module (Android, or a build without it) or
 * setting it failed, which is logged. Never throws.
 */
export function excludeFromBackup(dir: Directory): boolean {
  const nativeModule = requireOptionalNativeModule<BackupExclusionNativeModule>("BackupExclusion");
  if (!nativeModule) return false;
  try {
    nativeModule.excludeFromBackup(dir.uri);
    return true;
  } catch (error) {
    console.warn("Failed to exclude a folder from backups:", error);
    return false;
  }
}
