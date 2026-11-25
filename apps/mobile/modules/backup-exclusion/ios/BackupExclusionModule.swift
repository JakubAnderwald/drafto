import ExpoModulesCore

// Keeps a folder out of iCloud and device backups by setting
// NSURLIsExcludedFromBackupKey on it, which also covers everything inside it
// (ADR-0099). expo-file-system has no way to set it. The attachment cache
// calls it through apps/mobile/src/lib/backup-exclusion.ts.
public class BackupExclusionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BackupExclusion")

    // Takes the folder's file:// URI. Throws when it isn't a file URL or the
    // value can't be set (the folder is missing, for one).
    Function("excludeFromBackup") { (uri: String) in
      guard var url = URL(string: uri), url.isFileURL else {
        throw NotAFileUrlException(uri)
      }
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    }
  }
}

internal final class NotAFileUrlException: GenericException<String> {
  override var reason: String {
    "Not a file URL: \(param)"
  }
}
