# 0086 — Offline Attachment Cache on Mobile and Desktop

- **Status**: Accepted
- **Date**: 2026-11-18
- **Authors**: Jakub Anderwald (with Claude Code); PrimeTestLab report 10668, bug M-02

## Context

PrimeTestLab report 10668 (Android 1.4.7) found that an image attached to a note shows as a broken icon plus its file name once the device is offline. Every platform that edits notes offline does the same:

- Note content stores an image as `attachment://<storage path>`. To show it, the iOS, Android and macOS apps asked Supabase Storage for a signed URL each time a note opened (`createSignedUrl`, a network call). Offline that fails, `resolveTipTapImageUrls` leaves `attachment://`, and the editor's WebView cannot load that scheme.
- The device kept no copy: the upload queue deleted the local file after a successful upload, and images synced from other devices were never downloaded. [ADR-0010](./0010-offline-sync-strategy.md) deferred offline attachment caching to a "Phase 6" that never shipped.
- On mobile an image attached offline was inserted as `attachment://` and broke at once, though its local file existed. On desktop `buildInsertNode` awaited a signed URL with no fallback, so attaching offline inserted nothing at all.
- TenTap loads the editor from an HTML string with no base URL, so the WebView could not load a `file://` image even if one existed (Android also needs `allowFileAccess`).

A Wave 0 device spike showed that `<img src="file://…">` from the app's Documents directory renders in the TenTap WebView on the Android emulator and the iOS simulator, online and in airplane mode, once the editor gets a `file://` base URL (and `allowFileAccess` on Android). It also showed the risk: with no save-path guard, the spike's `file://` src was saved to the dev database and synced to iOS as a broken image.

## Decision

Mobile and desktop keep a durable attachment cache and show cached images from it.

1. **Cache.** Files live under `<Documents>/attachment-cache/<storage path>` (`ATTACHMENT_CACHE_DIR_NAME`), each path segment made filesystem-safe by `attachmentCacheRelativePath`. Mobile uses expo-file-system, desktop react-native-fs, in mirrored `src/lib/data/attachment-cache.ts`. Downloads go to `attachment-cache/.partial/` and are moved into place once complete, one download per attachment at a time. On desktop the cache directory is created with `NSURLIsExcludedFromBackupKey`.
2. **Picked files are the cache.** `queueAttachment` copies a picked file straight to its cache path, the upload reads it from there, and a successful upload keeps it (`retainInCache`). A pending file left in the old `attachments/` folder by an earlier version is moved into the cache after its upload.
3. **Source order** (`attachment-resolver.ts`, used for note loads): a cached image gives `file://…#drafto-attachment=<URL-encoded storage path>` with no network call. Otherwise a signed URL is used and the image downloads into the cache in the background. Otherwise (offline, no copy) the src stays `attachment://`. Links and file blocks keep a signed URL: the resolver now receives `kind: "image" | "link"`. A just-attached image shows its local file at once on both apps, and desktop's insert never throws.
4. **Save-path guard.** `migrateSignedUrlsToAttachmentUrls`, which every content write goes through (`serializeEditorContent`, the mobile attachment insert and the web PATCH route), maps any `file:` src carrying the `#drafto-attachment=` marker back to `attachment://<path>`. No device path can be stored or synced. A note opened with local srcs and not edited still serialises to its stored content, so the #654 no-op-save baseline holds.
5. **WebView.** `webviewBaseURL` is the Documents directory as a `file://` URL. `allowFileAccess` is on (Android needs it), `originWhitelist` adds `about:`, `file:` and `data:`, and `allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs` stay off, so the page can load images but script cannot read files.
6. **Prefetch.** After each successful sync pass, `prefetchAttachmentImages` downloads up to 25 not-yet-cached images (100 MB in all) of notes not in the trash, newest first, on any network. Images over 20 MB are cached only once viewed. A pass never fills the cache past its cap, so prefetching never evicts anything and never refetches what an eviction removed. A pass that found nothing is not repeated for a minute.
7. **Eviction.** The cache is capped at 300 MB on mobile and 1 GB on desktop. Over the cap, the least recently used files go first (the later of the file's write time and its last view this session). A file whose attachment is `pending`, `failed` or `quota_exceeded` is never evicted: it is the only copy.
8. **Sign-out.** `deleteAllLocalAttachments`, which sign-out and the cross-account identity guard already call, also deletes the cache. A download still running is thrown away instead of landing in the next account's cache.
9. **Render status.** A script injected into the editor reports, per image, `img.complete && img.naturalWidth > 0` and its height on screen. The app mirrors it in invisible, untouchable accessible views (`testID` `editor-image-rendered` / `editor-image-missing`, label "Image shown: <name>" / "Image not loaded: <name>"), which the E2E checks read because the WebView's own image nodes do not reliably reach the accessibility tree.

The privacy policy says attachments stay on the device for offline viewing and are erased on sign-out.

## Consequences

- **Positive**: images open offline on iOS, Android and macOS, including right after a cold start and right after being attached offline. Desktop can attach offline. The save-path guard also protects the web PATCH route from any client sending a local src.
- **Positive**: the cache, the source order and the policy are mirrored between the two apps; eviction and prefetch decisions are pure functions in `@drafto/shared` (`planAttachmentCacheEviction`, `selectPrefetchCandidates`).
- **Negative**: the apps use more device storage, up to the cap plus files not yet uploaded. Prefetch uses data on cellular too.
- **Negative**: least-recently-used order only knows views made in the current session; across restarts it falls back to when a file was written. Two legacy storage keys that differ only in characters `toStorageSafeFileName` replaces would share a cache file.
- **Negative**: Android Auto Backup and iCloud backup still include the mobile cache. expo-file-system has no exclude-from-backup call, and excluding the folder on Android means replacing the backup rules expo-secure-store installs. Desktop excludes it from Time Machine.
- **Neutral**: non-image attachments (opening a PDF offline) are still opened through a signed URL; a follow-up covers them. macOS read access to the container's Documents directory from the WebView must be confirmed on a device build.

## Alternatives Considered

- **`data:` URIs for cached images.** Rendered in the spike too, but every `getJSON` round-trip and autosave would carry the base64 image. Kept only as a fallback, not needed.
- **Relying on the WebView's HTTP cache.** Each signed URL carries a new token, and offline no URL can be created, so nothing ever hits the cache.
- **Storing local paths in note content.** A device path is broken on every other device, and the spike showed it spreading through sync. The fragment marker keeps the canonical `attachment://` form in storage.
- **A new database column for the cached path.** Would need a mirrored schema migration on both apps; the cache is keyed by `file_path` instead, so no schema changes.
- **Caching in `Paths.cache` / `Library/Caches`.** Out of backups, but the OS can purge it, and the WebView's `file://` base URL only grants access under its own directory; pending uploads also need a durable home.
