# Local Mobile Builds: Migration from EAS Build

## Problem

The current mobile build infrastructure relies on Expo Application Services (EAS Build), a cloud service with monthly build limits and costs. The goal is to migrate to a fully local build pipeline on macOS that is:

- **Zero-click** — single command to build + sign + submit to stores
- **Zero-cost** — no paid tools beyond the Apple Developer account ($99/year, already paid)
- **Fully automated** — build, code sign, submit to Google Play / TestFlight, post release notes

## Current Setup

| Step                   | Tool               | Details                                                |
| ---------------------- | ------------------ | ------------------------------------------------------ |
| Build (iOS)            | EAS Build (cloud)  | `eas build --profile beta --platform ios`              |
| Build (Android)        | EAS Build (cloud)  | `eas build --profile beta --platform android`          |
| Code signing (iOS)     | EAS-managed        | EAS creates/manages certs and provisioning profiles    |
| Code signing (Android) | EAS-managed        | EAS manages the upload keystore                        |
| Submit (iOS)           | EAS Submit         | `--auto-submit` to TestFlight                          |
| Submit (Android)       | EAS Submit         | `--auto-submit` to Google Play internal track          |
| Build numbers          | EAS auto-increment | Remote version tracking                                |
| Release notes          | Custom scripts     | `generate-release-notes.sh` + `post-release-notes.mjs` |
| CI trigger             | GitHub Actions     | `beta-release.yml` dispatches EAS builds               |

## Recommended Solution: Fastlane + Local macOS Builds

### Why Fastlane

- **Free and open source** (MIT license) — no paid tiers, no build limits
- **Industry standard** — used by millions of apps, actively maintained, well-documented
- **Single command** — `fastlane ios beta` does prebuild + build + sign + submit
- **Credentials reuse** — works with the Google Play service account JSON and App Store Connect API keys we already have
- **CI-portable** — same Fastfile works locally AND on GitHub Actions/Codemagic

### Architecture

```text
pnpm build:beta:ios          pnpm build:beta:android
        |                              |
   fastlane ios beta            fastlane android beta
        |                              |
   expo prebuild                 expo prebuild
        |                              |
   match (signing)              keystore (signing)
        |                              |
   gym (xcodebuild)            gradle bundleRelease
        |                              |
   pilot (TestFlight)          supply (Google Play)
        |                              |
   post-release-notes.mjs      post-release-notes.mjs
```

### Alternatives Considered

| Approach                              | Cost                       | Pros                                                | Cons                                                          |
| ------------------------------------- | -------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| **Fastlane + local** (recommended)    | Free                       | No limits, full control, battle-tested, CI-portable | Requires Mac to be on, Ruby dependency, one-time setup effort |
| **GitHub Actions**                    | Free (200 macOS min/month) | CI/CD integration, no local Mac needed              | 10x minute multiplier limits iOS to ~10 builds/month          |
| **Codemagic**                         | Free (500 min/month)       | 500 M2 Mac minutes, native Expo support             | Vendor lock-in, limits may tighten, still a cloud dependency  |
| **Raw scripts** (xcodebuild + gradle) | Free                       | No Ruby dependency                                  | More maintenance, no signing management, reinventing fastlane |
| **Keep EAS Build**                    | $15+/month                 | Zero migration effort, proven workflow              | Monthly cost, build limits, cloud dependency                  |

### Key Risks and Mitigations

| Risk                                    | Impact                                | Mitigation                                                                      |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| Android upload key migration            | Builds rejected by Google Play        | Export key from EAS or reset upload key in Google Play Console before migrating |
| iOS signing setup complexity            | Blocked on first build                | Use fastlane match with a private Git repo; one-time 30-min setup               |
| Build number drift                      | Store rejects duplicate build numbers | Use fastlane `increment_build_number` / `increment_version_code` actions        |
| expo prebuild overwrites signing config | Build fails                           | Use Expo config plugins to inject signing config, or apply after prebuild       |
| Mac must be on for builds               | Can't build remotely                  | Fallback: Codemagic free tier (500 min/month) for remote builds                 |

## Implementation Plan

### Phase 1: Foundation (Local Android Builds)

Android is simpler (no code signing complexity like iOS), so start here.

#### 1.1 Generate Release Keystore

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore ~/drafto-secrets/drafto-release.keystore \
  -alias drafto -keyalg RSA -keysize 2048 -validity 10000
```

- Store keystore outside the repository (e.g., `~/drafto-secrets/`) — never commit it
- Save password securely (e.g., macOS Keychain or a password manager)
- Set `ANDROID_KEYSTORE_PATH` environment variable pointing to the keystore file
- **Critical**: Before generating, check if EAS's upload key can be exported. If EAS generated the original upload key, you must either:
  - Export it via `eas credentials` and convert to a local keystore, OR
  - Generate a new key and reset the upload key in Google Play Console

#### 1.2 Install Fastlane

```bash
# Option A: Bundler (recommended for version pinning)
cd apps/mobile
echo 'source "https://rubygems.org"\ngem "fastlane"' > Gemfile
bundle install

# Option B: Direct install
gem install fastlane
```

#### 1.3 Initialize Fastlane for Android

```bash
cd apps/mobile
fastlane init
```

Create `apps/mobile/fastlane/Fastfile`:

```ruby
default_platform(:android)

platform :android do
  desc "Build and submit to Google Play internal track"
  lane :beta do
    # 1. Prebuild native project
    sh("npx", "expo", "prebuild", "--platform", "android", "--clean")

    # 2. Increment version code (requires: fastlane add_plugin versioning_android)
    android_set_version_code(
      gradle_file: "android/app/build.gradle",
      version_code: google_play_track_version_codes(
        json_key: "google-play-service-account.json",
        package_name: "eu.drafto.mobile",
        track: "internal"
      ).max + 1
    )

    # 3. Build AAB
    gradle(
      task: "bundle",
      build_type: "Release",
      project_dir: "android"
    )

    # 4. Upload to Google Play
    upload_to_play_store(
      track: "internal",
      aab: "android/app/build/outputs/bundle/release/app-release.aab",
      json_key: "google-play-service-account.json",
      package_name: "eu.drafto.mobile",
      skip_upload_metadata: true,
      skip_upload_images: true,
      skip_upload_screenshots: true
    )

    # 5. Post release notes (reuse existing script)
    notes = sh("bash", "../scripts/generate-release-notes.sh", "--max-chars", "500")
    sh("node", "../scripts/post-release-notes.mjs", "--platform", "android", "--notes", notes)
  end
end
```

#### 1.4 Configure Gradle Signing

Create Expo config plugin or post-prebuild script to inject signing config into `android/app/build.gradle`:

```groovy
signingConfigs {
    release {
        storeFile file(System.getenv("ANDROID_KEYSTORE_PATH") ?: System.getProperty("user.home") + "/drafto-secrets/drafto-release.keystore")
        storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
        keyAlias "drafto"
        keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: ""
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
    }
}
```

#### 1.5 Test Android Pipeline

```bash
cd apps/mobile
fastlane android beta
```

Verify:

- [ ] AAB is produced
- [ ] AAB is uploaded to Google Play internal track
- [ ] Release notes appear in Google Play Console

### Phase 2: iOS Builds

#### 2.1 Set Up Fastlane Match

```bash
# Create a private Git repo for certificates (e.g., github.com/JakubAnderwald/ios-certificates)
cd apps/mobile
fastlane match init
# Choose: git
# Enter repo URL: git@github.com:JakubAnderwald/ios-certificates.git
# Enter passphrase: <choose a secure passphrase>
```

```bash
# Create App Store distribution certificate + provisioning profile
fastlane match appstore --app_identifier eu.drafto.mobile
```

This creates and encrypts the certificate + profile in the private Git repo. On subsequent runs, match fetches and installs them automatically.

#### 2.2 Configure App Store Connect API Key

Create `apps/mobile/fastlane/Appfile`:

```ruby
app_identifier("eu.drafto.mobile")
apple_id("your@email.com")  # Apple ID
team_id("4J2USPSG2U")       # Apple Developer Team ID
```

Store App Store Connect API credentials as environment variables (the Fastfile reads from `ENV[]`):

```bash
export ASC_API_KEY_ID="<your-key-id>"
export ASC_API_ISSUER_ID="<your-issuer-id>"
export ASC_API_KEY_P8_PATH="/path/to/AuthKey.p8"
```

#### 2.3 Add iOS Lane to Fastfile

```ruby
platform :ios do
  desc "Build and submit to TestFlight"
  lane :beta do
    # 1. Prebuild native project
    sh("npx", "expo", "prebuild", "--platform", "ios", "--clean")

    # 2. Fetch signing credentials
    api_key = app_store_connect_api_key(
      key_id: ENV["ASC_API_KEY_ID"],
      issuer_id: ENV["ASC_API_ISSUER_ID"],
      key_filepath: ENV["ASC_API_KEY_P8_PATH"]
    )

    match(
      type: "appstore",
      app_identifier: "eu.drafto.mobile",
      api_key: api_key,
      readonly: true
    )

    # 3. Increment build number
    increment_build_number(
      build_number: latest_testflight_build_number(api_key: api_key) + 1,
      xcodeproj: "ios/Drafto.xcodeproj"
    )

    # 4. Build IPA
    build_app(
      workspace: "ios/Drafto.xcworkspace",
      scheme: "Drafto",
      export_method: "app-store",
      output_directory: "ios/build"
    )

    # 5. Upload to TestFlight
    upload_to_testflight(
      api_key: api_key,
      ipa: "ios/build/Drafto.ipa",
      skip_waiting_for_build_processing: true
    )

    # 6. Post release notes (reuse existing script)
    notes = sh("bash", "../scripts/generate-release-notes.sh", "--max-chars", "4000")
    sh("node", "../scripts/post-release-notes.mjs", "--platform", "ios", "--notes", notes)
  end
end
```

#### 2.4 Test iOS Pipeline

```bash
cd apps/mobile
fastlane ios beta
```

Verify:

- [ ] IPA is produced and code-signed
- [ ] Build appears in TestFlight
- [ ] Release notes appear in App Store Connect

### Phase 3: Automation and CI Integration

#### 3.1 Add Convenience Scripts to package.json

```json
{
  "scripts": {
    "release:beta:android": "bundle exec fastlane android beta",
    "release:beta:ios": "bundle exec fastlane ios beta",
    "release:beta:all": "bundle exec fastlane android beta && bundle exec fastlane ios beta"
  }
}
```

#### 3.2 Update GitHub Actions Workflow

Replace EAS build steps in `beta-release.yml` with fastlane:

```yaml
# Android job (runs on ubuntu-latest — free)
- name: Set up Google Play credentials
  run: |
    cd apps/mobile
    echo '${{ secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY }}' > google-play-service-account.json
- name: Build & Submit Android
  run: |
    cd apps/mobile
    bundle exec fastlane android beta
  env:
    ANDROID_KEYSTORE_PATH: ${{ runner.temp }}/drafto-release.keystore
    ANDROID_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
    ANDROID_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}

# iOS job (runs on macos-latest — uses macOS minutes)
- name: Build & Submit iOS
  run: |
    cd apps/mobile
    bundle exec fastlane ios beta
  env:
    MATCH_PASSWORD: ${{ secrets.MATCH_PASSWORD }}
    MATCH_GIT_PRIVATE_KEY: ${{ secrets.MATCH_GIT_PRIVATE_KEY }}
    ASC_API_KEY_ID: ${{ secrets.ASC_API_KEY_ID }}
    ASC_API_ISSUER_ID: ${{ secrets.ASC_API_ISSUER_ID }}
    ASC_API_KEY_P8: ${{ secrets.ASC_API_KEY_P8 }}
```

**Note**: Android builds can run on Linux runners (no macOS minute cost). Only iOS requires macOS.

#### 3.3 Update CLAUDE.md

Update build documentation to reflect the new fastlane-based workflow. Remove EAS-specific instructions and add fastlane commands.

### Phase 4: Cleanup

- Remove EAS build profiles from `eas.json` (keep submit config as reference during migration)
- Remove `EXPO_TOKEN` from GitHub secrets (no longer needed for builds)
- Update `apps/mobile/package.json` to remove EAS build scripts
- Archive/document the old EAS workflow in an ADR

## Migration Checklist

- [ ] **Phase 0**: Export and backup existing EAS credentials and configuration
- [ ] **Phase 1.1**: Export or regenerate Android upload key
- [ ] **Phase 1.2**: Install fastlane
- [ ] **Phase 1.3**: Write Android lane in Fastfile
- [ ] **Phase 1.4**: Configure Gradle signing
- [ ] **Phase 1.5**: Test local Android build + submit
- [ ] **Phase 2.1**: Set up fastlane match (private cert repo)
- [ ] **Phase 2.2**: Configure App Store Connect API key
- [ ] **Phase 2.3**: Write iOS lane in Fastfile
- [ ] **Phase 2.4**: Test local iOS build + submit
- [ ] **Phase 3.1**: Add convenience scripts to package.json
- [ ] **Phase 3.2**: Update GitHub Actions workflows
- [ ] **Phase 3.3**: Update CLAUDE.md documentation
- [ ] **Phase 4**: Remove EAS build config, clean up secrets

## Estimated Effort

| Phase             | Effort    | Complexity                                        |
| ----------------- | --------- | ------------------------------------------------- |
| Phase 1 (Android) | 2-3 hours | Low-Medium (upload key migration is the wildcard) |
| Phase 2 (iOS)     | 3-4 hours | Medium (signing setup, match configuration)       |
| Phase 3 (CI)      | 1-2 hours | Low                                               |
| Phase 4 (Cleanup) | 30 min    | Low                                               |

## References

- [Fastlane documentation](https://docs.fastlane.tools/)
- [Fastlane match](https://docs.fastlane.tools/actions/match/)
- [Expo local builds](https://docs.expo.dev/guides/local-app-production/)
- [React Native Android signing](https://reactnative.dev/docs/signed-apk-android)
- [Codemagic pricing](https://codemagic.io/pricing/) (fallback option)
