# 0016 — Local Fastlane Builds

- **Status**: Accepted
- **Date**: 2026-03-31
- **Authors**: Jakub
- **Supersedes**: [0011 — App Store Deployment Strategy](./0011-app-store-deployment-strategy.md)

## Context

The mobile build pipeline (ADR 0011) relies on Expo Application Services (EAS Build), a cloud service with monthly build limits and costs ($15+/month beyond the free tier of 30 builds/month). As the app matures and release cadence increases, EAS becomes a bottleneck:

- **Cost**: Each additional build beyond the free tier costs money
- **Limits**: Cloud build queue times and monthly caps slow development
- **Cloud dependency**: Builds cannot run without EAS servers being available
- **Opacity**: Signing credentials are managed remotely with limited visibility

The goal is a fully local build pipeline that is zero-click (single command), zero-cost (no paid services beyond the Apple Developer account), and fully automated (build, sign, submit, post release notes).

## Decision

### Migrate to Fastlane for local builds

Replace EAS Build with **Fastlane** — a free, open-source (MIT) build automation tool — for all native builds and store submissions. Fastlane is the industry standard for mobile CI/CD, used by millions of apps, and is actively maintained.

### Build architecture

```text
bundle exec fastlane android beta     bundle exec fastlane ios beta
        |                                      |
   expo prebuild                          expo prebuild
        |                                      |
   signing (local keystore)              match (cert repo)
        |                                      |
   gradle bundleRelease                  gym (xcodebuild)
        |                                      |
   supply (Google Play)                  pilot (TestFlight)
        |                                      |
   post-release-notes.mjs               post-release-notes.mjs
```

### Key components

- **Fastlane** installed via Bundler (`apps/mobile/Gemfile`) for version pinning
- **Expo config plugin** (`plugins/with-android-signing.js`) injects signing config into `build.gradle` during `expo prebuild`
- **Fastlane match** manages iOS certificates in a private Git repository
- **Existing release notes scripts** (`generate-release-notes.sh`, `post-release-notes.mjs`) are reused unchanged
- **Build numbers** are queried from store APIs (Google Play / TestFlight) and auto-incremented

### CI integration

- **Android** builds run on `ubuntu-latest` (free Linux runners) — no macOS cost
- **iOS** builds run on `macos-latest` — uses macOS minutes but eliminates EAS cloud dependency
- Same Fastfile works locally and in CI

### Signing strategy

- **Android**: Upload keystore exported from EAS, stored locally at `~/drafto-secrets/` and as a base64-encoded GitHub secret for CI
- **iOS**: Fastlane match with a private Git repo for certificates and provisioning profiles

## Consequences

- **Positive**: Zero recurring cost — no EAS Build subscription needed
- **Positive**: No build limits — build as often as needed
- **Positive**: Full control over signing credentials — keystore and certificates stored locally
- **Positive**: CI-portable — same Fastfile works locally and on any CI provider
- **Positive**: Faster iteration — no cloud queue wait times
- **Negative**: Requires a Mac to be available for iOS builds (mitigated: Codemagic free tier as fallback)
- **Negative**: Ruby dependency added (Bundler + Fastlane)
- **Negative**: One-time migration effort for keystore export and match setup
- **Neutral**: EAS remains available as a fallback if needed — `eas.json` can be kept

## Alternatives Considered

### Keep EAS Build (status quo)

Rejected because of ongoing costs, build limits, and cloud dependency. The app's release cadence is increasing beyond what the free tier supports cost-effectively.

### GitHub Actions with macOS runners

Rejected because macOS runners use a 10x minute multiplier, limiting iOS to ~10 builds/month on the free tier. Android could work on Linux runners, but splitting the build system adds complexity.

### Codemagic

Rejected as the primary solution due to vendor lock-in and limits that may tighten. Retained as a fallback option (500 free M2 Mac minutes/month).

### Raw scripts (xcodebuild + gradle)

Rejected because it would mean reinventing fastlane's signing management, store submission, and version tracking. More maintenance for no clear benefit.
