# 0106 — Factory Device Lane: Maestro on an Android Emulator and an iOS Simulator

- **Status**: Accepted
- **Date**: 2026-11-25
- **Authors**: Jakub Anderwald (with Claude Code)
- **Amends**: [0053](./0053-pre-in-test-verification-stage.md) (decision 8), [0096](./0096-factory-test-run-screenshots-on-github.md) (a third evidence source), [0091](./0091-interactive-issue-driving.md) (the "Devices" row)

## Context

The Testing stage ([ADR-0053](./0053-pre-in-test-verification-stage.md)) runs a shell lane and a browser lane. Decision 8 deferred device lanes, so every iOS and Android step in a scenario goes to the manual list. For #874 (PR #926), the change was only to `apps/mobile/e2e/ios-all.yaml`. The report could check nothing that mattered, and the operator asked the card "why don't you run the simulator?". The factory had to answer that its rules forbid it.

`docs/features/factory-verification.md` listed what a device lane would need. Checking that list against the Mac mini and the code adds four facts:

- **The machine.** The Mac mini is an M4 with 16 GB of RAM. An emulator takes 2–3 GB and a Gradle or Xcode build 3–4 GB, so a device run can't overlap a beta build. The build volume (`/Volumes/DraftoFactory`) has room for an AVD and build caches. The internal disk doesn't. Xcode 27 has no Simulator.app, so `simctl` is the only way to drive a simulator.
- **A "dev" build can still reach production.** `apps/mobile/src/providers/auth-provider.tsx` falls back to `https://drafto.eu` when `EXPO_PUBLIC_API_URL` is unset. Using `apps/mobile/.env` (dev Supabase) isn't enough on its own.
- **Beta builds can't be reused.** They're built against production, and their build roots are hard-reset for every build.
- **A comment can't trigger a run.** Any owner comment on an In Test card is feedback, and it rolls the card back to In Progress.

## Decision

Add a **device lane**: a node supervisor (`scripts/lib/device-lane.mjs`) that builds a dev-backed app from the PR head, runs Maestro flows on a headless Android emulator and an iOS simulator, one at a time, and reports the results as evidence. It never gates the card ([ADR-0035](./0035-factory-code-review-gate.md)). It's off by default (`FACTORY_VERIFY_DEVICE=0`). macOS stays manual ([ADR-0043](./0043-automated-macos-in-test-scenarios.md)).

1. **No claude session touches a device.** The supervisor builds the app, boots the devices, runs Maestro and shuts the devices down. `maestro`, `adb`, `emulator`, `xcrun`, `xcodebuild` and `gradle` stay denied in the shell lane's guard.
2. **What runs.**
   - **Repo flows, with no model.** `scripts/lib/device-plan.mjs` derives the platforms and flows from the PR diff and the scenario's headings. The combined `<platform>-all.yaml` flow always runs. The PR's changed standalone flows run too, except destructive ones (`07-delete-account`, `05-cross-platform-sync`) and the `run-*.sh` runners.
   - **The scenario's iOS and Android steps.** A guarded claude session translates them into Maestro YAML in its run directory, never in the repo. It can't run Maestro. It writes YAML and asks the supervisor through a `device-run` wrapper, the same pattern as `preview-curl` and `live-tests` ([ADR-0073](./0073-factory-verification-data-checks-live-tests-uploads-admin-js.md)). The supervisor runs a YAML file only after a validator passes it. The validator allows a fixed list of Maestro commands for the app `eu.drafto.mobile`. It denies `runScript`, `evalScript`, `openLink` (except `drafto://`), `clearKeychain`, `addMedia`, `startRecording`, and any variable other than `${RUN_ID}`.
3. **Dev-only builds with the JS bundle embedded, so no Metro is needed.**
   - **Env:** the build reads only `apps/mobile/.env`, checked for the dev project ref. The build root may not hold a `.env.production*` file.
   - **API URL:** the build sets `EXPO_PUBLIC_API_URL=https://device-lane.invalid`, so a missing value fails closed.
   - **Artifact check:** before anything is installed, the artifact must contain the dev ref and must not contain the prod ref or `drafto.eu`. If it fails, that platform is reported as unavailable.
   - **Android:** an `assembleRelease` build signed with a factory debug keystore through Gradle's injected-signing properties. The release keystore and `~/drafto-secrets` aren't used.
   - **iOS:** a Release build for `iphonesimulator`, ad-hoc signed as in the screenshot generator.
4. **Its own build roots, devices and lock, serialised against betas.**
   - **Build roots:** `/Volumes/DraftoFactory/drafto-device-{android,ios}`. `expo prebuild --clean` runs only when a fingerprint of the native inputs changes.
   - **Devices:** a dedicated AVD `drafto-factory` (an android-35 `google_apis` image, under its own `ANDROID_AVD_HOME`, on console port 5580) and a dedicated simulator `drafto-factory-iphone`. The simulator is erased before each run. Both are shut down on every exit path, and a run that outlives its supervisor is reaped by that port and UDID. The operator's own emulators and simulators are never touched.
   - **Lock:** the lane holds `drafto-device.lock`. It doesn't start while a beta build root is locked, under memory pressure, or when either disk is low. Beta dispatch, in turn, waits a tick while the device lock is held.
5. **A dedicated dev account.** Device runs sign in to a dev account of their own (`FACTORY_DEVICE_ACCOUNT_FILE`, mode 600), so a sign-out on a device doesn't end the browser lane's session. Maestro gets the password through `MAESTRO_E2E_TEST_PASSWORD` in its environment, never on a command line. No claude session ever sees it. `RUN_ID` is an epoch timestamp, so the E2E clean-up patterns match what a run creates.
6. **A run doesn't hold the card.** A run takes 45–90 minutes. The Testing stage waits for the device lane only `FACTORY_VERIFY_DEVICE_WAIT_MIN` (default 30). After that the report's device rows read "running — results follow", and the card goes on to In Test. When the run ends, the supervisor posts one follow-up comment with the device results. The comment carries a factory marker, so the feedback detectors ignore it and the card doesn't move.
7. **On demand: the `factory-device-run` label.** On a card in Testing or In Test, the label starts a run on the PR head, with one allowance past the per-commit attempt cap. The factory removes the label once the run has started. The run ends with the same follow-up comment, and the card doesn't move.
8. **Provenance of device screenshots (amends ADR-0096).** A device screenshot is published only if all of these hold:
   - the supervisor captured it itself (`adb exec-out screencap` or `simctl io screenshot`, after each flow);
   - no claude process for the run was alive at the time;
   - it's listed with its sha256 in the supervisor's `shots.json`, and the hash still matches at upload.

   The scenario session's own screenshots are never published. After the session exits, the supervisor validates its YAML again and re-runs it, and only that final pass is evidence. The images go through the same OCR secret scan and selftest gate as the other sources.

## Consequences

- **Positive:**
  - A mobile change gets checked on real Android and iOS builds before a person picks it up. Flow changes such as #874 can be proven on a device.
  - The manual list on mobile cards gets shorter.
  - The operator can ask for a run on any card without the request being taken as feedback.
- **Negative:**
  - A device run takes 45–90 minutes of the Mac mini's CPU and RAM, and betas wait while it runs.
  - The lane depends on the Android SDK, Xcode's simulator runtime, Maestro and a JDK on the Mac mini. An upgrade of any of them can break it until it's fixed.
  - The build volume holds about 25 GB more: an AVD, two build roots, the Gradle cache and DerivedData.
  - The lane adds one more dev account and one more knob family to maintain.
- **Neutral:**
  - **Privacy policy: no change.** Runs use dev Supabase and a dev test account. The only data that leaves the Mac mini is scanned report text and supervisor-captured screenshots of dev data, the same kind the Web lane already publishes.
  - The human gates are unchanged. A person still reads the evidence and approves at In Test.

## Alternatives Considered

- **Reuse the pre-merge betas.** They're production-backed, and they reach the device through the stores. That's slow and can't be automated against a simulator.
- **Debug builds with Metro.** Every slot would need its own Metro port. The emulator loads from the host's 8081, which needs `adb root` plus a `metro.host` override. Airplane-mode flows lose Metro. An embedded bundle avoids all three.
- **Let the shell lane's session run Maestro itself.** A Bash session that can run Maestro can also run `adb shell` or `simctl` commands, and can write any bytes into its evidence. With the supervisor running everything and a validator in front of YAML, the boundary can be checked.
- **Trigger on-demand runs by comment.** Owner comments on In Test cards are feedback by design. Adding a command syntax would complicate every feedback detector. A label is already how the operator signals the factory (`migration-approved`, `hosted-config-applied`).
- **Keep devices manual.** That's the status quo this ADR replaces. It leaves the operator to build, boot and run every mobile scenario by hand.
