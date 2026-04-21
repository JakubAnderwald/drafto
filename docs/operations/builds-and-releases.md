# Builds and Releases

Operational runbook for building and releasing Drafto's web, iOS, Android, and macOS apps. This is the single source of truth for build commands, environment variables, and release procedures.

All builds run locally via Fastlane. CI workflows exist but are non-functional (see [CI workflows](#ci-workflows) below).

## Release command reference

| Platform          | Beta (TestFlight / Internal)                  | Production (App Store / Play Store)           |
| ----------------- | --------------------------------------------- | --------------------------------------------- |
| **Android**       | `cd apps/mobile && pnpm release:beta:android` | `cd apps/mobile && pnpm release:prod:android` |
| **iOS**           | `cd apps/mobile && pnpm release:beta:ios`     | `cd apps/mobile && pnpm release:prod:ios`     |
| **macOS**         | `cd apps/desktop && pnpm release:beta`        | `cd apps/desktop && pnpm release:production`  |
| **Android + iOS** | `cd apps/mobile && pnpm release:beta:all`     | `cd apps/mobile && pnpm release:prod:all`     |

## Build environment mapping

### Mobile

| Build Type  | Env File          | Backend     | Supabase Ref           | Command                             |
| ----------- | ----------------- | ----------- | ---------------------- | ----------------------------------- |
| **Debug**   | `.env`            | Development | `huhzactreblzcogqkbsd` | `pnpm android` / `expo run:android` |
| **Release** | `.env.production` | Production  | `tbmjbxxseonkciqovnpl` | `pnpm android:release-local`        |

When asked to build a mobile APK, always confirm which environment (dev or production) the user wants. Release APK output path: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

### Desktop

Desktop uses the same env-file convention: `apps/desktop/.env` for development, `apps/desktop/.env.production` for production.

## Local build prerequisites

- **Ruby**: rbenv with Ruby 3.3.7 (global default), Bundler 4.0.9
- **Fastlane**: Installed via Bundler (`bundle exec fastlane`)
- **Signing secrets**: Loaded automatically from `~/drafto-secrets/android-env.sh` (covers Android keystore, ASC API key, and Match password)
- **Locale**: `LANG=en_US.UTF-8` required for CocoaPods (set in Fastfiles and nightly script)
- **Worktree note**: Git worktrees do not share Ruby gems. Run `bundle install` in the worktree's `apps/mobile/` (or `apps/desktop/`) directory before using Fastlane commands. Also copy `google-play-service-account.json` into the worktree if needed for store submissions.

### Required environment variables

Android builds:

```bash
export ANDROID_KEYSTORE_PATH="$HOME/drafto-secrets/drafto-release.keystore"
export ANDROID_KEYSTORE_PASSWORD="<password>"
export ANDROID_KEY_PASSWORD="<password>"
export ANDROID_KEY_ALIAS="54e4e5b83ca8617c2a3d8dbc2a5dbd87"
```

iOS and macOS builds:

```bash
export ASC_API_KEY_ID="<key-id>"
export ASC_API_ISSUER_ID="<issuer-id>"
export ASC_API_KEY_P8_PATH="/path/to/AuthKey.p8"
```

These are sourced automatically from `~/drafto-secrets/android-env.sh` on local machines set up per [local dev setup](./local-dev-setup.md).

## Android

App package: `eu.drafto.mobile`

### Local debug build

```bash
cd apps/mobile && pnpm android
```

Uses `.env` (development backend).

### Release APK (production backend, no submission)

```bash
cd apps/mobile && pnpm android:release-local
```

Output: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`

### Release to Google Play internal track

```bash
cd apps/mobile && pnpm release:beta:android
```

What it does: `expo prebuild` → Gradle `bundleRelease` (signed AAB) → `upload_to_play_store` (internal track) → post release notes.

### Release to Google Play production track

```bash
cd apps/mobile && pnpm release:prod:android
```

### Android build prerequisites

- `android/local.properties` must have `sdk.dir` pointing to the Android SDK (e.g., `/Users/jakub/Library/Android/sdk`)
- JDK 25+ requires `_JAVA_OPTIONS='--enable-native-access=ALL-UNNAMED'` (already set in the `android:release` script)
- Google Play service account key: `apps/mobile/google-play-service-account.json` (gitignored)
- Android upload keystore: `~/drafto-secrets/drafto-release.keystore` (env var `ANDROID_KEYSTORE_PATH`)
- Signing config injected via Expo config plugin (`plugins/with-android-signing.js`)
- Build numbers auto-incremented from Google Play's latest version code

## iOS

- App Store Connect App ID: `6760675784`
- Apple Developer Team ID: `4J2USPSG2U`
- Signing: Fastlane match with a private Git repo for certificates and provisioning profiles
- Build numbers auto-incremented from TestFlight's latest build number

### Release to TestFlight

```bash
cd apps/mobile && pnpm release:beta:ios
```

What it does: `expo prebuild` → `match` (fetch signing creds) → `gym` (build IPA) → `pilot` (upload to TestFlight) → post release notes.

### Release to App Store

```bash
cd apps/mobile && pnpm release:prod:ios
```

Uses `deliver` instead of `pilot` to upload to the App Store review queue.

### TestFlight notes

- First build requires Apple review (~24-48h), subsequent builds are usually available instantly
- Internal testers are invited via App Store Connect → TestFlight → Internal Testing
- Testers install via the TestFlight app on their iOS device

### First-time iOS setup

```bash
cd apps/mobile && bundle exec fastlane match init
cd apps/mobile && bundle exec fastlane match appstore
```

This configures the certificate repository and creates distribution certificates.

## macOS

- App Store Connect App ID: `6760675784` (shared with iOS — multi-platform app)
- Bundle ID: `eu.drafto.mobile` (shared with iOS)
- Apple Developer Team ID: `4J2USPSG2U`
- Signing: Fastlane match with `platform: "macos"` (same Git repo as iOS certs)
- Build numbers auto-incremented from TestFlight's latest macOS build number

### Release to TestFlight (macOS)

```bash
cd apps/desktop && pnpm release:beta
```

What it does: CocoaPods install → `match` (fetch macOS signing creds) → sync version from `package.json` → `build_mac_app` (signed `.pkg`) → `upload_to_testflight` → post release notes.

### Release to Mac App Store

```bash
cd apps/desktop && pnpm release:production
```

### Local macOS dev build

```bash
cd apps/desktop && npx react-native run-macos
```

### macOS build prerequisites

Same ASC API credentials as iOS (`ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, `ASC_API_KEY_P8_PATH`).

## Versioning

Version bumps follow semver. Build numbers are auto-incremented by Fastlane — only the user-facing version needs manual bumps.

### Mobile versioning

Single source of truth: `apps/mobile/package.json` → `version` (read by `app.config.ts`).

```bash
pnpm version:mobile patch   # Bug fixes, perf, dependency updates with no visible change
pnpm version:mobile minor   # New features, new screens, meaningful UX changes
pnpm version:mobile major   # Breaking changes (e.g., WatermelonDB schema migration requiring fresh install)
```

Commit the changed `package.json` as part of the feature/fix PR. The CI `beta-release.yml` workflow handles git tagging (`mobile@X.Y.Z`) on deploy.

### Desktop versioning

Single source of truth: `apps/desktop/package.json` → `version`.

```bash
pnpm version:desktop patch
pnpm version:desktop minor
pnpm version:desktop major
```

CI creates `desktop@X.Y.Z` tags on deploy.

### When to bump

- **Patch**: Bug fixes, performance improvements, or dependency updates that don't change user-visible behavior. Bump in the same PR as the fix.
- **Minor**: New features, new screens, or meaningful UX changes visible to users. Bump in the same PR as the feature.
- **Major**: Breaking changes to local data (e.g., WatermelonDB schema migration requiring a fresh install) or a fundamental redesign. Requires explicit user confirmation before bumping.

### When NOT to bump

- Chore/docs/CI-only changes that don't touch mobile or desktop app code
- Changes only in `apps/web/` or `packages/shared/` (unless the shared change affects mobile/desktop behavior — then bump accordingly)
- Refactors with no user-visible effect

## Automated release notes

Release notes are auto-generated from conventional commits and posted to both stores after each build submission.

### How it works

1. `apps/mobile/scripts/generate-release-notes.sh` extracts `feat:` and `fix:` commits since the last `mobile@*` git tag.
2. `apps/mobile/scripts/post-release-notes.mjs` posts notes to Google Play (via Publisher API) and TestFlight (via App Store Connect API).
3. CI workflows (when functional) call both scripts after successful build+submit. Local Fastlane lanes invoke them directly.

### Character limits

- Google Play: 500 chars
- TestFlight "What to Test": 4000 chars

### Local usage (after building locally)

```bash
cd apps/mobile
NOTES=$(bash scripts/generate-release-notes.sh --max-chars 500)
node scripts/post-release-notes.mjs --platform android --notes "$NOTES"
```

## Post-merge release flow

When a feature merges to `main`, the full release wave runs in parallel:

- **Web**: Vercel auto-deploys on merge to `main` (no manual step)
- **Android**: `cd apps/mobile && pnpm release:prod:android`
- **iOS**: `cd apps/mobile && pnpm release:prod:ios`
- **macOS**: `cd apps/desktop && pnpm release:production`

The three store releases can run concurrently in separate terminals. Web deploys on its own.

## CI workflows

GitHub Actions workflows exist for Android, iOS, and macOS but are currently non-functional:

- `beta-release.yml` / `production-release.yml` — mobile
- `desktop-beta-release.yml` / `desktop-production-release.yml` — macOS

Known issues:

- **iOS**: Swift 6 concurrency errors on CI Xcode
- **macOS**: Metro bundling hangs

Do not use CI builds until these issues are resolved. All builds run locally via Fastlane.

### Required GitHub Secrets (for when CI is fixed)

| Secret                            | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_KEY` | Google Play service account JSON         |
| `ANDROID_KEYSTORE_BASE64`         | Android upload keystore (base64-encoded) |
| `ANDROID_KEYSTORE_PASSWORD`       | Keystore password                        |
| `ANDROID_KEY_PASSWORD`            | Key password                             |
| `ANDROID_KEY_ALIAS`               | Android signing key alias                |
| `ASC_API_KEY_ID`                  | App Store Connect API Key ID             |
| `ASC_API_ISSUER_ID`               | App Store Connect Issuer ID              |
| `ASC_API_KEY_P8`                  | App Store Connect API private key (.p8)  |
| `MATCH_PASSWORD`                  | Fastlane match encryption passphrase     |
| `MATCH_GIT_PRIVATE_KEY`           | SSH key for match certificate Git repo   |

## Related

- [Local dev setup](./local-dev-setup.md) — first-time machine setup (CLI tools, rbenv, Fastlane)
- [Migrations](./migrations.md) — Supabase migration workflow and safety rails
- [ADR 0011: App Store Deployment Strategy](../adr/0011-app-store-deployment-strategy.md)
- [ADR 0015: Desktop App Technology Choice](../adr/0015-desktop-app-technology-choice.md)
- [ADR 0016: Local Fastlane Builds](../adr/0016-local-fastlane-builds.md)
