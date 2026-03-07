# Drafto — App Store Metadata

This directory contains App Store (iOS) and Google Play Store (Android) metadata.

## Files

- `en-US.json` — English (US) store listing metadata
- `privacy-policy.md` — Privacy policy (source of truth, also served at drafto.eu/privacy)

## App Store (iOS) — App Store Connect

| Field              | Value                         |
| ------------------ | ----------------------------- |
| App Name           | Drafto                        |
| Subtitle           | Notes, offline & synced       |
| Primary Category   | Productivity                  |
| Secondary Category | Utilities                     |
| Content Rating     | 4+ (no objectionable content) |
| Price              | Free                          |
| Privacy Policy URL | https://drafto.eu/privacy     |
| Support URL        | https://drafto.eu/support     |
| Marketing URL      | https://drafto.eu             |

## Google Play Store — Play Console

| Field              | Value                     |
| ------------------ | ------------------------- |
| App Name           | Drafto                    |
| Short Description  | Notes, offline & synced   |
| Category           | Productivity              |
| Content Rating     | Everyone                  |
| Price              | Free                      |
| Privacy Policy URL | https://drafto.eu/privacy |

## Screenshots

Screenshots are stored in `../screenshots/` with platform and size prefixes:

- `ios-6.7/` — iPhone 6.7" (1290x2796) — required
- `ios-6.5/` — iPhone 6.5" (1284x2778) — required
- `ios-5.5/` — iPhone 5.5" (1242x2208) — required for older devices
- `android-phone/` — Phone (1080x1920 min) — required
- `android-tablet-7/` — 7" tablet (1080x1920 min) — optional
- `android-tablet-10/` — 10" tablet (1920x1200 min) — optional

### Required screenshot set (at least 3, max 10 per size)

1. `01-notebooks.png` — Notebooks list view
2. `02-notes.png` — Notes list within a notebook
3. `03-editor.png` — Rich text editor with formatted content
4. `04-dark-mode.png` — Dark mode variant of editor
5. `05-offline.png` — Offline indicator with sync status

Screenshots should be captured from a real device or simulator. Use `maestro screenshot` or Xcode/Android Studio screenshot tools.
