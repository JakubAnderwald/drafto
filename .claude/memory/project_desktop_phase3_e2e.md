---
name: Desktop Phase 3 complete — all runtime bugs fixed and merged
description: macOS desktop app Phase 3 complete. 9 runtime bugs + 2 additional bugs (Modal crash, WatermelonDB query) fixed. E2E test suite added.
type: project
---

## Desktop Phase 3 — Complete (2026-03-30)

All runtime bugs fixed and merged to main via PRs #204 and #211.

### Additional Bugs Fixed in PR #211

10. **Search overlay Modal crash** — `Modal` component not fully supported on React Native macOS. Replaced with positioned `View` overlay using `StyleSheet.absoluteFillObject`.
11. **WatermelonDB Q.on query error** — Search query used `Q.on("notebooks", ...)` inside `Q.or()` without `Q.experimentalJoinTables(["notebooks"])`. Fixed in both desktop and mobile apps.

### E2E Test Suite Added

`apps/desktop/e2e/run-e2e.sh` — 15 tests using cliclick + AppleScript:

- App launch, Search/+ buttons, notebook list, Trash, Sign out, Sync status
- Notebook selection, creation, note creation
- Search overlay open/type/close
- Window management, Metro bundler health

### Known macOS Build Gotcha

`RCTThirdPartyComponentsProvider.mm` (generated file) must be patched with nil-safe dictionary building after every `pod install`. The file gets regenerated and will crash without the patch because `NSClassFromString` returns nil for react-native-screens components on macOS.
