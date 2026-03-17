# 0011 — App Store Deployment Strategy

- **Status**: Accepted
- **Date**: 2026-03-08
- **Authors**: Jakub

## Context

The Drafto mobile app (Expo/React Native) needs to be distributed to users via the Apple App Store and Google Play Store. We need a build, submission, and update strategy that supports:

- Development builds for local testing (iOS Simulator, Android Emulator)
- Internal preview builds for ad-hoc testing on physical devices
- Production builds for app store submission
- Over-the-air (OTA) updates for non-native JS changes
- A beta testing phase before public release (TestFlight, Google Play Internal Testing)
- Automated version incrementing to avoid manual bookkeeping

The app uses Expo SDK 53+ with `expo-router`, `expo-secure-store`, and `@nozbe/watermelondb` (native module). The bundle identifier is `eu.drafto.mobile` on both platforms.

## Decision

### EAS Build for all build profiles

We use **Expo Application Services (EAS) Build** to build the app in the cloud. Three profiles are configured in `apps/mobile/eas.json`:

| Profile       | Purpose                          | Distribution | Auto-increment |
| ------------- | -------------------------------- | ------------ | -------------- |
| `development` | Dev client for local testing     | Internal     | No             |
| `preview`     | Internal testing on real devices | Internal     | No             |
| `production`  | App store submission             | Store        | Yes            |

- **Development** builds include the Expo dev client and target iOS Simulator by default (`"simulator": true`). Android dev builds work on emulator out of the box.
- **Preview** builds are signed for internal distribution (ad-hoc on iOS, APK on Android) for testing on physical devices before submitting to stores.
- **Production** builds use `"autoIncrement": true` with `appVersionSource: "remote"` — EAS tracks and increments the build number automatically, eliminating manual version management.

### EAS Submit for store submission

We use **EAS Submit** to upload production builds to both stores:

- **iOS**: Submits to App Store Connect. Requires Apple ID, App Store Connect App ID, and Apple Team ID (configured in `eas.json` submit section). Builds go to TestFlight first for beta testing.
- **Android**: Submits to Google Play Console via service account key. Initial submissions target the `internal` testing track.

### Beta testing workflow

1. Build production profile: `eas build --profile production --platform all`
2. Submit to stores: `eas submit --platform all`
3. **iOS**: Build appears in TestFlight. Internal testers are invited via App Store Connect. External TestFlight review takes ~24-48h for first build.
4. **Android**: Build appears in Google Play Internal Testing track. Testers added via Google Play Console. Promote to Closed Testing, then Open Testing, then Production.
5. Collect feedback, fix issues, rebuild and resubmit as needed.
6. When stable, promote to public release on both stores.

### OTA updates via EAS Update

Non-native JavaScript changes can be deployed instantly via **EAS Update** without going through app store review:

- Runtime version policy: `"appVersion"` — a new native build is required only when the app version changes (indicating native code changes)
- Update URL: configured in `app.config.ts` under `updates.url`
- OTA updates are scoped to the matching runtime version — users on older native builds won't receive incompatible updates
- Critical bug fixes in JS can ship within minutes via `eas update --branch production`

OTA updates **cannot** be used when native modules change (e.g., WatermelonDB version bump, new Expo plugin). Those require a full store build and review cycle.

### Version strategy

- `version` in `app.config.ts` represents the user-facing version (semver, e.g., `1.0.0`), read from `apps/mobile/package.json`
- Build numbers (iOS `buildNumber`, Android `versionCode`) are auto-incremented by EAS via `appVersionSource: "remote"`
- Version bumps use `pnpm version:mobile [patch|minor|major] --no-git-tag-version` from the repo root

**When to bump:**

- **Patch**: Bug fixes, performance improvements, or dependency updates with no user-visible behavior change
- **Minor**: New features, new screens, or meaningful UX changes visible to users
- **Major**: Breaking changes to local data (e.g., WatermelonDB schema migration requiring fresh install) or fundamental app redesign — requires explicit user confirmation

**When NOT to bump:**

- Chore/docs/CI-only changes that don't touch mobile app code
- Changes only in `apps/web/` or `packages/shared/` (unless the shared change affects mobile behavior)
- Refactors with no user-visible effect

Version bumps are committed as part of the feature/fix PR. The CI `beta-release.yml` workflow handles git tagging (`mobile@X.Y.Z`) on deploy.

### CI pipeline (no CI builds)

CI runs lint, typecheck, and unit/integration tests only (on Linux runners). EAS builds are triggered manually by the developer, not by CI. This keeps CI fast and free — EAS cloud builds handle the expensive native compilation.

E2E tests (Maestro) run locally on the developer's machine before triggering a production build. They are not part of CI.

### Release checklist

Before each store submission:

1. All CI checks green (lint, typecheck, unit/integration tests)
2. Full Maestro E2E suite passing on iOS Simulator and Android Emulator
3. Preview build tested on physical devices
4. Changelog updated
5. `eas build --profile production --platform all`
6. `eas submit --platform all`
7. Monitor TestFlight / Play Internal Testing feedback
8. Promote to public when stable

## Consequences

- **Positive**: EAS Build eliminates the need for local Xcode/Android Studio build environments — builds run in the cloud with managed signing
- **Positive**: Auto-increment build numbers remove a common source of submission rejection (duplicate build numbers)
- **Positive**: OTA updates via EAS Update enable rapid JS-only fixes without app store review delays
- **Positive**: Three-profile strategy (dev/preview/production) provides clear separation between testing and release builds
- **Positive**: Beta testing via TestFlight and Play Internal Testing catches issues before public release
- **Negative**: EAS Build is a paid service beyond the free tier (30 builds/month free, then $99/month for additional builds). Acceptable for a small team
- **Negative**: iOS submissions require an Apple Developer account ($99/year) and Android requires a Google Play Developer account ($25 one-time)
- **Negative**: First App Store review can take 1-3 days and may result in rejection requiring resubmission. Mitigated by following Apple/Google guidelines strictly
- **Neutral**: OTA updates are limited to JS changes — native module updates always require a full store build cycle

## Alternatives Considered

### Local builds with Xcode and Android Studio

Rejected because local builds require maintaining Xcode and Android Studio environments, managing signing certificates manually, and dealing with platform-specific build tooling. EAS Build abstracts all of this away. Local builds are still possible as a fallback but not the primary workflow.

### Fastlane for build automation

Rejected because EAS Build provides equivalent functionality (cloud builds, auto-signing, store submission) with tighter Expo integration. Fastlane would add complexity without clear benefits for an Expo-managed project. If we ever eject from Expo, Fastlane becomes a viable option.

### CodePush (App Center) for OTA updates

Rejected because Microsoft App Center has been retired. EAS Update is the Expo-native equivalent and integrates seamlessly with the Expo runtime version system.

### Self-hosted builds (GitHub Actions + macOS runners)

Rejected because macOS runners for iOS builds are expensive ($0.08/min on GitHub Actions) and require managing signing certificates in CI secrets. EAS Build is purpose-built for this and handles signing automatically.
