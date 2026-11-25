# 0099 — Mobile Attachment Cache Excluded from Device Backups

- **Status**: Accepted
- **Date**: 2026-11-25
- **Authors**: Jakub Anderwald (with Claude Code); issue #867
- **Amends**: [0086](./0086-offline-attachment-cache.md) (its "Android Auto Backup and iCloud backup still include the mobile cache" consequence)

## Context

[ADR-0086](./0086-offline-attachment-cache.md) keeps a copy of every image attachment under `<Documents>/attachment-cache/` so images show offline. It is a re-downloadable cache of user content, and ADR-0086 left it in device backups on mobile: expo-file-system has no exclude-from-backup call, and excluding the folder on Android looked like it meant replacing the backup rules expo-secure-store installs. Desktop already sets `NSURLIsExcludedFromBackupKey` on the folder through react-native-fs (`ensureDir` in `apps/desktop/src/lib/data/attachment-cache.ts`).

The two platforms turned out to need different work:

- **iOS** backs up `Documents` to iCloud. expo-file-system 55 has no way to set `NSURLIsExcludedFromBackupKey`: nothing in its iOS or JS source mentions backup.
- **Android** already leaves the cache out. Expo's Documents directory there is `context.filesDir` (`FileSystemModule.kt`), which is Auto Backup's `file` domain. Every input to the built manifest's `<application>` backup attributes, as `expo prebuild --platform android --clean` (the release lane) produces them:
  1. Expo's template (`expo/template.tgz`) sets only `android:allowBackup="false"`, with no rules file.
  2. Expo's default `withAllowBackup` rewrites that to `"true"`, because `app.config.ts` sets no `android.allowBackup`.
  3. expo-secure-store's config plugin finds no existing rules, so it sets `android:fullBackupContent="@xml/secure_store_backup_rules"` and `android:dataExtractionRules="@xml/secure_store_data_extraction_rules"`.
  4. Those XMLs (in source and in the prebuilt AAR that ships) have `<include domain="sharedpref" path="."/>` as their only include, in `full-backup-content`, `cloud-backup` and `device-transfer` alike. Once a rules file has an `<include>`, Auto Backup backs up only what is included, so the `file` domain is out.
  5. None of the local plugins in `apps/mobile/plugins/` touches the manifest, and no library manifest or AAR in `node_modules` sets `allowBackup`, `fullBackupContent`, `dataExtractionRules` or `backupAgent`.

## Decision

1. **A local Expo native module for iOS.** `apps/mobile/modules/backup-exclusion/` is the first local native module in `apps/mobile`. It is iOS only (`expo-module.config.json` lists `apple`), and its one synchronous Swift function, `excludeFromBackup(uri)`, sets `URLResourceValues.isExcludedFromBackup = true` on the folder at a `file://` URI. It throws on a non-file URL or when setting the value fails. `expo-modules-autolinking` links `./modules` by default, so no dependency or config change is needed. Its pod gets the same Swift-concurrency and deployment-target patches as every other pod.
2. **A JS wrapper that never throws.** `excludeFromBackup(dir)` in `apps/mobile/src/lib/backup-exclusion.ts` loads the module with `requireOptionalNativeModule`. When the module is missing (Android, Jest, a build without it) it is a no-op that returns `false`. A native error is logged as a warning and returns `false`.
3. **One place creates the cache root.** `ensureAttachmentCacheRoot()` in `apps/mobile/src/lib/data/attachment-cache-root.ts` creates `<Documents>/attachment-cache/` and sets the flag on it. On iOS a flag on a folder excludes everything inside it. It sets the flag once per launch, again after `forgetAttachmentCacheRoot()` (called by the sign-out wipe, which deletes and recreates the folder), and again on the next call after a failure. The module doesn't import the database, so `editor-page.ts` uses it too. Every path that writes into the cache calls it first: `prepareCacheFile` (picked images, uploads kept in the cache, downloads), the `.partial/` folder, the first index load (which flags a folder that already exists, as on installs upgraded from 1.4.x), and `writeEditorPage`.
4. **Writes are never blocked on the flag.** Unlike desktop's `ensureDir`, mobile writes even when the flag can't be set, because the cache is also where a picked image waits to upload: refusing would break attaching images. The worst case is the behaviour before this decision, a copy in a backup.
5. **Android: no runtime change, a guard test instead.** `apps/mobile/__tests__/unit/android-backup-rules.test.ts` pins the chain above. It fails if the expo-secure-store entry in `app.config.ts` passes `configureAndroidBackup: false`, if an installed secure-store rules file includes anything outside `sharedpref`, or if a local plugin starts writing backup attributes.

## Consequences

- **Positive**: on iOS, image copies no longer go into iCloud backups. Android's existing exclusion is now tested rather than incidental.
- **Positive**: one helper owns the cache root and its flag, so the attachment cache and the editor page can't create the folder unflagged.
- **Negative**: CI doesn't build iOS, so only a simulator or TestFlight build proves the Swift module compiles and autolinks after `expo prebuild --clean`. If it is missing, the app falls back to a no-op instead of crashing. The manual check is in [testing.md](../architecture/testing.md#manual-only-coverage).
- **Negative**: copies already in users' iCloud backups from 1.4.x stay there. The flag excludes the folder from the next backup on, and iCloud replaces the older backups over time.
- **Negative**: the Android guard test can't see Maven dependencies. A library that later declares its own backup rules conflicts with the app's attributes and fails the release build's manifest merge instead.
- **Neutral**: on iOS, the `attachments/` folder (non-image files waiting to upload) deliberately stays in backups: it holds the only copy of unsynced files. On Android it is outside backups like the rest of the `file` domain. The WatermelonDB database is untouched.
- **Neutral**: desktop is unchanged; it already excludes the folder from Time Machine.

## Alternatives Considered

- **`react-native-fs` on mobile, as on desktop.** It can set `NSURLIsExcludedFromBackupKey` in `mkdir`, but it is a whole second file library for one attribute, next to expo-file-system.
- **Our own Android backup rules, copied from expo-secure-store's.** The app would then own secure-store's `SecureStore` exclusion, and losing it breaks secure storage after a restore. The cache is already out of backups without them.
- **Blocking cache writes until the flag is set, as desktop's `ensureDir` does.** A picked image waits to upload in the cache, so a failed flag would block attaching images. A copy in a backup is the lesser harm.
- **Moving the cache to `Paths.cache` / `Library/Caches`.** Rejected in ADR-0086: the OS can purge it, and pending uploads need a durable home.
