# Testing

Drafto has nine test suites, across the four app platforms, the shared package and the Mac mini automation in `scripts/`. This doc consolidates the test matrix that is scattered across the "Testing Requirements" and "Pre-push verification" sections of [`CLAUDE.md`](../../CLAUDE.md). Per-package scripts live in each package's `package.json` (`apps/web/package.json`, `apps/mobile/package.json`, `apps/desktop/package.json`, `packages/shared/package.json`, `scripts/package.json`).

## Test matrix

| Platform                      | Test type                    | Command                                                                          | Location                                                      | What breaks CI                         |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| Web                           | Unit + integration           | `cd apps/web && pnpm test`                                                       | `apps/web/__tests__/unit/`, `apps/web/__tests__/integration/` | vitest fail                            |
| Web                           | E2E (Playwright)             | `set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e` | `apps/web/e2e/`                                               | playwright fail                        |
| Web                           | Coverage                     | `cd apps/web && pnpm test:coverage`                                              | same as web unit + integration                                | SonarCloud quality gate (~80% on new)  |
| Shared                        | Unit                         | `cd packages/shared && pnpm test`                                                | `packages/shared/__tests__/`                                  | vitest fail                            |
| Mobile                        | Unit                         | `cd apps/mobile && pnpm test`                                                    | `apps/mobile/__tests__/`                                      | jest fail                              |
| Mobile                        | E2E (Maestro)                | `maestro test apps/mobile/e2e/ --platform android`                               | `apps/mobile/e2e/`                                            | manual (not in CI), a person runs it¹  |
| Desktop                       | Unit                         | `cd apps/desktop && pnpm test`                                                   | `apps/desktop/__tests__/`                                     | jest fail                              |
| Desktop                       | E2E (AppleScript + cliclick) | `cd apps/desktop && pnpm test:e2e`                                               | `apps/desktop/e2e/`                                           | manual (not in CI), a person runs it   |
| Scripts (Mac mini automation) | Unit (`node --test`)         | `cd scripts && pnpm test`                                                        | `scripts/__tests__/`                                          | node --test fail (`scripts-tests` job) |

Turborepo aggregates the workspaces' suites at the root: `pnpm test` fans out to every workspace that defines a `test` script, and `pnpm typecheck` / `pnpm lint` do the same for their respective tasks. `scripts/` is not a workspace: `pnpm-workspace.yaml` lists only `apps/*` and `packages/*`. So the root `pnpm test` never runs the scripts suite, and you must run `cd scripts && pnpm test` on its own. CI runs it in a separate `scripts-tests` job.

## Pre-push checklist

Before any push, run every row of the matrix above (all nine suites) plus `pnpm lint && pnpm typecheck` from the repo root. Do not push if any step fails.

- **A person runs the two manual E2E rows, Mobile E2E and Desktop E2E, in an interactive session.** Unattended sessions, the factory included, never run them. ¹ The one exception is the factory's opt-in device lane ([ADR-0106](../adr/0106-factory-device-lane.md)). It runs selected Maestro flows on its own dedicated emulator and simulator, against dev-backed builds of a PR head, as evidence for the Testing stage. It doesn't replace this row before a push. Each manual row needs a device or app set up first: see [Maestro](#maestro-mobile-e2e) and [Desktop E2E](#desktop-e2e).
- **Desktop E2E can write to production.** It drives the Drafto app that is running, and launches one if none is. On the Mac mini, `/Applications/Drafto.app` is the TestFlight build, which runs against production. Start the debug build first, as [Desktop E2E](#desktop-e2e) describes.

Never skip a suite because "it's unrelated". CI runs every suite not marked manual above, and a failure blocks the merge.

## Prerequisites

### Playwright (web E2E)

- Requires `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` in `apps/web/.env.local`. Playwright does not load `.env.local` automatically, so the command prefix `set -a && source apps/web/.env.local && set +a` is required.
- The referenced account must exist in the **dev** Supabase project (`huhzactreblzcogqkbsd`) with `profiles.is_approved = true`.
- Optional: `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` and `SUPABASE_SERVICE_ROLE_KEY` together enable the `setup-admin` project (the admin login in `apps/web/e2e/admin.setup.ts`) and the `chromium-admin` project, which runs `apps/web/e2e/admin.spec.ts`. Unless all three are set, neither project is registered and the admin specs don't run. Only `chromium-admin` depends on `setup-admin`, so a failed admin login skips the admin specs but not the rest of the suite. CI passes the three only on `main` (a push, or a manual run from `main`) and never to pull-request runs, because those execute unmerged code and the service-role key bypasses RLS. So in CI the admin specs run only on `main`, and only once the matching repository secrets exist. The service-role key must be the **dev** project's: `/admin` builds a service-role client on every render and errors without it. The account must be a **separate** user in the dev project with both `profiles.is_approved = true` and `profiles.is_admin = true` — don't make the `E2E_TEST_EMAIL` user an admin, or every other spec sees the admin UI.
- `apps/web/e2e/usage-daily.spec.ts` checks the web activity ping ([product metrics → Activity days](../features/product-metrics.md#activity-days-usage_daily)). Every run checks that opening the signed-in app sends `record_activity` once, gets a 2xx, and doesn't send it again on a reload in the same session. The check that today's `web` row exists for the E2E user reads `usage_daily` as the service role, so it runs only where `SUPABASE_SERVICE_ROLE_KEY` is set, which in CI means `main` runs. The spec calls the real RPC on dev, so it fails until `20261113000003_usage_daily.sql` is pushed to dev.
- Browsers are installed on first run (`pnpm exec playwright install`). CI doesn't install them: the E2E job runs inside Playwright's own image (`mcr.microsoft.com/playwright:v<version>-noble` in `.github/workflows/ci.yml`), which already has the browsers and their system libraries. When `@playwright/test` is bumped, bump that tag to the same version in the same PR; a scripts test fails until they match.
- The cleanup projects below also need `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which the same `.env.local` provides. They refuse to run against the production project (`tbmjbxxseonkciqovnpl`). Every E2E-user project depends on them, so the whole suite refuses too.

### E2E data hygiene

The web E2E suite runs against the shared dev project, where factory slots, pull-request CI and `main` CI all sign in as the same E2E user. It once had no working cleanup, and that account piled up 1,867 notebooks and 10,090 notes, enough to make specs time out ([#724](https://github.com/JakubAnderwald/drafto/issues/724)). Three layers now remove what the suite creates. All three sign in as the E2E user with the anon key (`apps/web/e2e/helpers/e2e-supabase.ts`), so RLS limits them to that user's rows and no service-role key is needed.

1. **After each test** (pass or fail), the `test` fixture in `apps/web/e2e/helpers/test.ts` hard-deletes the notes the test created in the browser. It does this after the browser context has closed, so a failed test's page snapshot and trace show the page as the test left it. It sees the app's create calls (`POST /api/notebooks`, `POST /api/notebooks/:id/notes`, `POST /api/import/evernote/note`), but not data a test creates over `request`. It never deletes notebooks mid-run: `/` auto-selects the most recently created notebook, which can be another worker's.
2. **At the end of the run**, the `cleanup-run` project (`cleanup-run.teardown.ts`) deletes, with their notes, the notebooks this run created. It runs once every project that depends on `purge-stale` has finished, pass or fail. The fixture records the notebooks it sees, and a spec that creates one over `request` records it with `recordRunNotebook`. It deletes those exact ids and never by name, so it can't touch a concurrent run's data.
3. **Before the run**, the `purge-stale` project (`purge.setup.ts`) pages through all of the E2E user's notebooks and notes, past PostgREST's 1,000-row cap. It deletes the ones whose name matches an E2E pattern (`apps/web/e2e/helpers/e2e-patterns.ts`) and that nothing has touched for 24 hours. A notebook also needs every note in it to be untouched that long. The patterns cover the Maestro and macOS runners' names too, since they sign in as the same user. One legacy rule also matches notebooks named exactly `sample`: before #724, the import spec left one on every run, holding the fixture's notes. Such a notebook only matches while every note in it is the fixture's, untitled or E2E-named. This catches runs killed before their teardown, and data no other layer saw. It's safe because no E2E run reads data from an earlier run: every spec names its data with a fresh timestamp and finds it again within the same run. The longest-lived E2E data, the orchestrated `apps/mobile/e2e/run-cross-platform-e2e.sh`, lives for minutes. An error fails the project and skips the suite: a broken purge means dev is unhealthy.

When you add a spec that creates notebooks or notes:

- Import `test` and `expect` from `./helpers/test`, not from `@playwright/test`.
- Name what it creates `` `<Name> ${Date.now()}` ``, and add `<Name>` to `E2E_NAME_PREFIXES` in `e2e-patterns.ts`. `apps/web/__tests__/unit/e2e-cleanup-patterns.test.ts` fails until you do. It reads the Maestro flows' `inputText: "<Name> ${RUN_ID}"` lines and the runner scripts' `"<Name> $(date +%s)"` names the same way. It also fails when such a spec imports `test` from `@playwright/test`, or creates a notebook over `request` without calling `recordRunNotebook`.

To check the account stays at its baseline, read the `[e2e cleanup]` lines in the Playwright output. The purge logs how many rows it scanned, purged and kept, and the teardown logs how many notebooks it deleted. Successive runs should show the purge's notebook count staying flat. You can cross-check with a count of the E2E user's notebooks on dev. Leftovers from an overlapping run are purged once they have sat untouched for a day.

Only pass `--no-deps` together with `--project` or a spec file. That combination skips the purge and the run-end teardown. Each test still deletes its own notes, and the notebooks it creates wait for the 24-hour purge. Without a filter, `--no-deps` runs `purge-stale` and `cleanup-run` as ordinary projects alongside the tests, so the teardown can delete this run's notebooks while tests are still using them.

- **Credentials stay out of the CI report.** When E2E fails, CI uploads `apps/web/playwright-report` as an artifact, and anyone can download it from this public repo. So:
  - CI records no traces (`trace` is `off` when `CI` is set), because a trace holds request bodies and the Supabase session cookie. To trace a CI failure, reproduce it locally, where traces stay on.
  - A spec that types a real credential uses `fillSecret()` (`apps/web/e2e/helpers/secret-fields.ts`) instead of `fill()`. `fill()` titles its report step `Fill "<value>"`, and a failure saves the page's ARIA snapshot (`error-context.md`, or the assertion's own snapshot), which lists the field's value. `fillSecret()` puts the value in React state, then swaps the input for a copy showing `hidden-by-fillSecret`.
  - Before uploading, CI runs `scripts/scan-playwright-report.mjs`. If it finds an E2E password, the service-role key or a Supabase session token, it withholds the report and lists the files, without the values. A failure involving an API request is withheld this way: a `page.request…` or `request`-fixture call that errors or times out, or a failing `expect(response).toBeOK()`. Playwright puts that request's headers, session cookie included, in the error message. Reproduce such a failure locally. Why it works this way: [ADR-0056](../adr/0056-keep-credentials-out-of-the-e2e-report.md).

### Mobile debug builds

A debug build of a branch runs against the **dev** Supabase project, through the `apps/mobile/.env` that `scripts/worktree-bootstrap.sh` copies. The app has no `expo-dev-client`, so a debug build loads its JavaScript straight from Metro and shows no dev-client launcher. Start Metro first, in its own terminal: `cd apps/mobile && npx expo start`.

- **iOS simulator: don't use `pnpm ios`.** Xcode 27 ships no `Simulator.app` (its `Contents/Applications` has `DeviceHub.app` instead). `expo run:ios` still looks for `Simulator.app` after it installs the pods, and fails with "Can't determine id of Simulator app". `open -a Simulator` fails the same way. Build and install by hand instead:

  ```bash
  cd apps/mobile
  npx expo prebuild --platform ios --clean   # regenerates ios/ and installs the pods
  xcrun simctl list devices available        # pick an iPhone's UDID
  xcrun simctl bootstatus <udid> -b          # boots it unless it's already up
  xcodebuild -workspace ios/Drafto.xcworkspace -scheme Drafto -configuration Debug \
    -sdk iphonesimulator -destination "id=<udid>" -derivedDataPath ios/build build
  xcrun simctl install <udid> ios/build/Build/Products/Debug-iphonesimulator/Drafto.app
  xcrun simctl launch <udid> eu.drafto.mobile
  ```

  - `ios/` is generated and gitignored, so `--clean` loses nothing. It keeps a stale `ios/` from an earlier branch out of the build.
  - The build loads from Metro on port 8081, and the `adb reverse` redirect below is Android-only. So in a worktree, stop any other Metro on 8081 before you launch.
  - To see the screen from a terminal, run `xcrun simctl io <udid> screenshot <file>.png`.

- **Android emulator: Gradle needs JDK 17–24.** On JDK 26, the build fails with `Failed to apply plugin 'com.facebook.react.rootproject'` and then `Unsupported class file major version 70`. Point `JAVA_HOME` at Android Studio's bundled JBR, then build, install and launch with `pnpm android`:

  ```bash
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  cd apps/mobile && pnpm android
  ```

  See [Android build prerequisites](../operations/builds-and-releases.md#android-build-prerequisites).

### Maestro (mobile E2E)

- A device with a debug build of the branch on it (see [Mobile debug builds](#mobile-debug-builds)): a booted iOS simulator, a running Android emulator, or an Android phone with USB debugging. Metro must be serving the build.
- With more than one device up, pick one with `maestro --device <id> test …`. The id is the simulator's UDID, or the `adb devices` serial (such as `emulator-5554`).
- The flows read the test account from Maestro's `-e` variables, not from the shell's environment (`06-forgot-password.yaml` takes none). Load them from the web app's env file and pass them on, from the repo root:

  ```bash
  set -a && source apps/web/.env.local && set +a
  maestro test -e E2E_TEST_EMAIL="$E2E_TEST_EMAIL" -e E2E_TEST_PASSWORD="$E2E_TEST_PASSWORD" \
    -e RUN_ID="$(date +%s)" apps/mobile/e2e/<flow>.yaml
  ```

- **A folder run of `android-only/` or `ios-only/` has no fixed order.** Some flows there leave the device signed out (`android-only/07-auth-callback-link.yaml` starts clean and stays on Log In), so a platform flow that needs a session either starts through `helpers/sign-in-if-needed.yaml`, which signs in as the E2E user only when the app shows Log In, or has a sign-in of its own. A new platform flow that needs a session must do the same: `apps/mobile/__tests__/unit/e2e-platform-flows-sign-in.test.ts` fails for one that only launches the app. Pass the `-e` account variables above on a folder run (an `android-only/` one always needs them, because 07 signs the device out); a flow that has to sign in fails fast without them.

- `11-sign-out-confirm.yaml`'s confirm leg (`-e SIGN_OUT_CONFIRM=1`) signs out a dedicated dev account, `E2E_SIGNOUT_EMAIL` / `E2E_SIGNOUT_PASSWORD` in the same env file, never the shared E2E user. The app's sign-out is global, and on the shared user it ended the session a concurrent web E2E run was using (#877's CI on 2026-11-21). See `apps/mobile/e2e/README.md`.

- **An emulator loads its JavaScript from `10.0.2.2:8081`, not `localhost`.** On a stock emulator React Native asks for the host machine's port 8081 at the emulator's alias for it, `10.0.2.2` (`AndroidInfoHelpers.kt`), and `adb reverse` only redirects the emulator's own `localhost`. So in a worktree, where the main checkout's Metro may already hold 8081:
  - Simplest: stop the other Metro and start this worktree's on 8081 (`cd apps/mobile && npx expo start`).
  - To keep both, start Metro on another port with `pnpm start --port 8082`, then, in a second terminal, point the app at `localhost` and redirect it: `adb root && adb shell setprop metro.host localhost && adb reverse tcp:8081 tcp:8082`, then restart the app (`adb shell am force-stop eu.drafto.mobile`, then launch it again). React Native reads `metro.host` once per app process, so an app that was already running keeps loading from `10.0.2.2:8081`, the main checkout's Metro. The Google APIs emulator images allow `adb root`; the property lasts until the emulator reboots. Metro stays in the foreground, so chaining it with `&&` never runs the rest.
  - A physical phone over USB already loads from `localhost`, so `adb reverse tcp:8081 tcp:8082` alone works there.
- **Airplane mode cuts a debug build off from Metro** (`10.0.2.2` goes with the network), and an offline cold start then shows a red box. Run offline flows on a release APK built against dev: see [Offline flows on Android](#offline-flows-on-android).
- **Before shipping an iOS release, launch a Release build on the iOS 27 simulator** (runtime `com.apple.CoreSimulator.SimRuntime.iOS-27-0`). Build it with `xcodebuild … -configuration Release -sdk iphonesimulator` after `expo prebuild` with `.env.production` sourced, then check that the app reaches the Log In screen. Then quit it with `xcrun simctl terminate <sim> eu.drafto.mobile` and check that `xcrun simctl openurl <sim> "drafto://reset-password"` lands on the reset screen. Quitting first makes this a true cold start, through `scene(_:willConnectTo:options:)`. With the app still running, the link goes through `scene(_:openURLContexts:)` instead. iOS 27 stops apps built with its SDK that skip the UIScene lifecycle, and older simulators don't show it ([ADR-0046](../adr/0046-ios-uiscene-lifecycle.md)).

### Offline flows on Android

The offline flows (`android-only/05`, `06`, and the report-10668 flows below) switch airplane mode on, which a debug build doesn't survive. Build a release APK that talks to the **dev** project instead. Never use `pnpm android:release-local` for this: it sources `.env.production`, the production project.

```bash
cd apps/mobile
npx expo prebuild --platform android --clean     # only when android/ is missing or native config changed
echo "sdk.dir=$HOME/Library/Android/sdk" > android/local.properties
set -a
source .env                                      # dev Supabase; exported values win over .env.production
source ~/drafto-secrets/android-env.sh           # release keystore, read by Gradle at build time; never print it
set +a
export _JAVA_OPTIONS='--enable-native-access=ALL-UNNAMED'
APK=android/app/build/outputs/apk/release/app-release.apk
rm -f "$APK"                                     # a failed build must leave no older APK to install
BUILD_OK=0
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a) && BUILD_OK=1 ||
  echo "STOP: the release build failed; nothing below installs"

# Guard: the APK must name the dev project and never the production one, and
# it installs only when both hold. The Supabase URL is not in the Hermes
# bundle: expo-constants ships it in assets/app.config, so check that file for
# dev and the whole APK for prod. Extract to files first, as the QA runner
# does: in `unzip -p | grep -q` grep stops at the first match, and under
# pipefail unzip's SIGPIPE turns that match into "no match". Any unzip exit
# but 0 stops here too: Info-ZIP exits 1 after skipping an entry, which the
# prod scan would then never see. Nothing installs after a failed build.
CONTENTS="$(mktemp)" && CONFIG="$(mktemp)"
if [ "$BUILD_OK" = 1 ] \
  && unzip -p "$APK" > "$CONTENTS" \
  && unzip -p "$APK" assets/app.config > "$CONFIG" \
  && LC_ALL=C grep -a -q -F huhzactreblzcogqkbsd "$CONFIG" \
  && ! LC_ALL=C grep -a -q -F tbmjbxxseonkciqovnpl "$CONTENTS"; then
  echo "dev APK: OK"
  adb -s emulator-5554 uninstall eu.drafto.mobile  # a release-signed APK can't replace a debug one
  adb -s emulator-5554 install "$APK"
else
  echo "STOP: the build failed, or this APK is not dev-only or couldn't be read; not installing it"
fi
rm -f "$CONTENTS" "$CONFIG"
```

- Gradle needs JDK 17–24, as for a debug build ([Mobile debug builds](#mobile-debug-builds)); Homebrew's `openjdk@17` works too.
- `expo prebuild` needs no signing secrets. The `with-android-signing.js` plugin writes a release signing config that reads the keystore variables from the environment when Gradle runs, so `android-env.sh` only has to be sourced before `assembleRelease`.
- The uninstall wipes the app's local data, so sign in again (flow `01-login.yaml`).
- `run-qa-10668-e2e.sh` runs the same guard on whatever is installed: it pulls the APK and refuses one that names production anywhere or whose `assets/app.config` lacks the dev ref.

**iOS has no airplane mode.** Maestro's `setAirplaneMode` / `toggleAirplaneMode` are Android-only, and the simulator shares the Mac's network. The iOS offline flows (`ios-only/05`, `06` and the report-10668 ones) therefore run in phases (`-e QA_PHASE=prepare|offline|reconnect`, tagged `requires-host-offline`), and the runner below takes the whole Mac offline between them with `apps/desktop/e2e/in-test/lib/net.sh`. That needs `sudo` (the runner keeps its timestamp alive for the run), cuts off everything else on the Mac (a Claude session included) until the leg ends, and is restored by a root watchdog after 300 s at most. net.sh defaults to 120 s, but the runner sets `NET_WATCHDOG_S=300` because one leg's offline phase plus its capture (a fresh Maestro iOS driver, two cold starts with 30 s waits, a 15 s banner wait, then `maestro hierarchy`) can pass 120 s, and a network that comes back early makes the app reconnect before the check reads the screen. Each leg has its own list of disabled services and its own watchdog flag, so an earlier leg's watchdog can't bring the network back during a later leg, and a leg whose restore failed stops the later legs from going offline. Without `--allow-host-offline` a leg is skipped before its online `prepare` phase, which would otherwise create test data that only `reconnect` deletes. Like the in-test harness, it waits for builds, releases and support runs first (`net_busy`, which ignores only Maestro's own iOS driver: `xcodebuild test-without-building` on its `maestro-driver-ios-config.xctestrun`). Run it only in a foreground session you started, and skip those flows in a folder run with `--exclude-tags requires-host-offline`.

### Report 10668 runner and host layout checks

`apps/mobile/e2e/run-qa-10668-e2e.sh [android|ios] [--before] [--allow-host-offline]` runs the PrimeTestLab report 10668 flows (tagged `qa-10668`) and, after each layout flow, a host-side check from `scripts/lib/maestro-layout-checks.mjs`. Maestro can't judge these bugs itself: its `below:` / `above:` selectors compare only the top edges of two elements, and `tapOn` succeeds on a half-covered button, so a covered FAB or Back arrow passes a Maestro assertion before the fix. The checks read what the device reports instead:

| Check                                      | Reads                                            | Passes when                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fab-above-nav-bar` (Android)              | `maestro hierarchy` + `adb shell dumpsys window` | every `add` FAB's bottom is at or above the `navigationBars` frame's top                                                                                                                        |
| `fab-above-home-indicator` (iOS)           | `maestro hierarchy`                              | every `add` FAB's bottom is at or above the screen height − 34 pt                                                                                                                               |
| `banner-clear-of-back`                     | `maestro hierarchy`                              | the offline banner (`offline-banner`, or the text "You are offline") doesn't overlap the back button and starts at or below the header's bottom                                                 |
| `image-rendered`                           | `maestro hierarchy`                              | in an E2E probe build, no `editor-image-missing` status view for the image; otherwise every image labelled with a file name is at least 100 px tall (a broken one is an icon plus its alt text) |
| `nav-bar-dark` / `nav-bar-light` (Android) | a screencap PNG + `dumpsys window`               | the nav bar's luminance is under 0.25 / over 0.6, and the focused Drafto window's `apr=` flags lack / have `LIGHT_NAVIGATION_BARS`                                                              |

- The runner switches the emulator to 3-button navigation (`cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton`) and a light system theme (`cmd uimode night no`), the report's device, and restores both on exit (`--keep-device-state` leaves them). The overlay applies a few seconds later, so the runner waits up to `QA_NAV_MODE_WAIT_S` (20) seconds for `navigation_mode` 0. If it never comes, it stops when a nav-bar or FAB step is selected (gesture navigation draws no contrast scrim, so those checks would pass without measuring anything), and only warns otherwise.
- The nav-bar checks run twice: cases A/B/C after `android-only/11-dark-nav-bar.yaml`, on the Notebooks tab, and cases D (OS Light, app Dark) and E (OS Dark, app Light) after `android-only/12-delete-dialog-nav-bar.yaml`, with the delete-account dialog open ([ADR-0092](../adr/0092-android-dialogs-render-in-the-activity-window.md)). An RN `Modal` is a window of its own whose bar followed the OS, and the checks read the focused window, which was then the dialog's.
- The runner takes `dumpsys window` both before and after the screenshot. The nav-bar checks measure only when both dumps show the same nav-bar frame and Drafto window flags, so the pixels and the flags come from one settled state. A hidden nav bar (`visible=false`) isn't measured either.
- `--before` runs against a build without the fixes and lists a report check as "reproduced" only when it measured the element and found it wrong (the check exits 1). It exits non-zero if one passes, because that check can't tell a fixed build from a broken one, and if one is "NOT MEASURED": a check error, the element or a precondition missing (no FAB on screen, Drafto not focused: the checks exit 2 for these, never 1), a missing flow under `--require-all`, or a report flow that Maestro exited on before any of its commands failed (its driver didn't start, or the YAML didn't parse: the runner looks for a `FAILED` command in Maestro's log). A check that didn't run (an iOS offline leg without `--allow-host-offline`) is listed as skipped.
- Screenshots, hierarchy dumps, logs and `summary.md` go to `--out` (default under `$TMPDIR`). The screenshots show note content, so don't commit them. The runner hands Maestro the test password as `MAESTRO_E2E_TEST_PASSWORD` in the environment, not as a `-e` argument that `ps` would show (`01-login.yaml` reads either), points Maestro's `--debug-output` (its commands JSON and log, typed text included) under `--out` instead of `~/.maestro/tests`, and scrubs the password from every file under `--out`, in its raw and JSON-escaped forms.
- The checks are plain functions with a small CLI (`node scripts/lib/maestro-layout-checks.mjs <check> --hierarchy … --dumpsys … --screenshot …`), unit-tested with recorded fixtures in `scripts/__tests__/maestro-layout-checks.test.mjs`. Use its `bounds --hierarchy <file> --id <regex>` command to look at an element's bounds while writing a flow.

### E2E probe builds

The editor's image render status views (`editor-image-rendered` / `editor-image-missing`, labelled "Image shown: <name>" / "Image not loaded: <name>", [ADR-0086](../adr/0086-offline-attachment-cache.md)) are test-only probes. VoiceOver and TalkBack would read them to real users, so a build has them only when it was made with the flag on. Default is off: store, TestFlight and Play builds, and any build made without the flag, have no probes and no injected reporter.

- **Mobile:** `EXPO_PUBLIC_E2E_PROBES=1`. `app.config.ts` puts it in `extra.e2eProbes` when the config is evaluated, and `src/lib/e2e-probes.ts` reads it. A release build evaluates the config at build time, so export the flag in the shell that builds:
  - **Android release APK against dev** (for the offline flows, the QA 10668 report flows among them): export `EXPO_PUBLIC_E2E_PROBES=1` alongside the dev `.env` before `./gradlew assembleRelease`, so the flag is in the APK's `assets/app.config`. Check with `unzip -p "$APK" assets/app.config | grep -o '"e2eProbes":true'`.
  - **iOS simulator build:** export `EXPO_PUBLIC_E2E_PROBES=1` before `npx expo prebuild --platform ios` and the `xcodebuild … -sdk iphonesimulator` build. A Debug build served by Metro reads the config from Metro, so start Metro with the flag exported instead (`EXPO_PUBLIC_E2E_PROBES=1 npx expo start`).
- **Desktop:** `E2E_PROBES=1`, in the environment when Metro bundles (or in `apps/desktop/.env`, never `.env.production`). react-native-dotenv inlines it; `src/lib/e2e-probes.ts` reads it.
- **Without the flag**, the `09` offline image Maestro flows, which assert on those `testID`s, can't pass. The QA 10668 runner's `image-rendered` host check falls back to the WebView's own `<img>` alt-text nodes in `maestro hierarchy`, which are less reliable: they don't always reach the accessibility tree.

### Desktop E2E

`apps/desktop/e2e/run-e2e.sh` drives the running macOS app through System Events (AppleScript) and clicks with `cliclick`. It finds elements by their accessibility label.

- **A person runs it, in an interactive session.** The factory and other unattended sessions never do (see [Pre-push checklist](#pre-push-checklist)). On the Mac mini, `/Applications/Drafto.app` is the TestFlight build, which runs against production, so the debug build must be running before you start.
- Install `cliclick` with `brew install cliclick`. Without it the runner exits at once.
- The Drafto macOS app must be running before you start. Use a debug build of the branch, served by Metro: run `cd apps/desktop && pnpm start` in one terminal, then build and launch with `cd apps/desktop && pnpm macos` (`npx react-native run-macos`, see [Local macOS dev build](../operations/builds-and-releases.md#local-macos-dev-build)). A debug build reads `apps/desktop/.env`, so it runs against the **dev** Supabase project ([environments](./environments.md)).
  - The runner's first step is `tell application "Drafto" to activate`. If no Drafto is running, that launches whichever Drafto macOS finds, which may be the installed production build: on the Mac mini, the TestFlight build. Start the debug build first.
  - Before that, the runner presses Continue through TestFlight's first-launch pages ("What to Test", then "Share feedback") if they are up. A TestFlight build opened for the first time has no window until they're dismissed. See [macOS In-Test automation](../operations/macos-in-test-automation.md#getting-the-build-from-testflight).
  - Quit the TestFlight build before you launch the debug build. Both are named Drafto and share the bundle id `eu.drafto.mobile`, and the runner finds the app by name (`process "Drafto"`), so with both running it may drive either one. `pgrep -fl Drafto.app/Contents/MacOS/Drafto` should then list one process, and not under `/Applications`.
- **A production `.app` runs the suite against production.** Release builds read `apps/desktop/.env.production`, which points at the prod project (`tbmjbxxseonkciqovnpl`). The run signs in there and creates an `E2E Notebook <timestamp>` notebook with a note. Its teardown tries to delete that notebook, but a failed delete doesn't count as a failed check, so read its `Cleanup:` line even after a run that exits 0. Whatever a run leaves behind stays on prod, because the web suite's `purge-stale` cleanup only touches dev. Against a production build, TEST 9 (Metro) skips rather than fails.
- If the app shows the login screen, the runner signs in with `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD`, the same env contract as the web suite. If the app is already signed in, it runs as that account. It reads the two variables from the environment, not from a file, so export them first, from the repo root:

  ```bash
  set -a && source apps/web/.env.local && set +a
  cd apps/desktop && pnpm test:e2e
  ```

- The terminal you run it from needs two permissions in System Settings → Privacy & Security: **Accessibility**, to read the app's UI and to click, and **Automation → System Events**, for the AppleScript keystrokes. macOS asks on the first run. Grant them, then run it again.
- It drives the real cursor and keyboard, and it overwrites the clipboard (TEST 4 pastes the notebook name). Leave the Mac alone while it runs. It exits with the number of failed checks.
- It saves full-screen screenshots to `/tmp/drafto_e2e_*.png` and leaves them there. They show whatever was on screen, notes included, so delete them after the run: `rm -f /tmp/drafto_e2e_*.png`.

### Mobile / desktop unit tests

- Jest in both apps. In a worktree, run `pnpm install` first — worktrees do not share `node_modules`.
- Mobile tests under `apps/mobile/__tests__/` cover `components/`, `hooks/`, `lib/`, `providers/`, `screens/`, `performance/`, and shared `helpers/`.
- Desktop tests under `apps/desktop/__tests__/` cover `components/`, `db/`, `hooks/`, `lib/`, `screens/`, and shared `helpers/`.

### Shared package

- Vitest against `packages/shared/__tests__/` and `packages/shared/src/editor/__tests__/` (attachment-url, format-converter, resolve-urls, and the editor-local tests).
- No external services required.

### Scripts

- Node's built-in test runner (`node --test`) against `scripts/__tests__/*.test.mjs`, which covers the Mac mini automation: the factory, the support agent and the nightly jobs.
- Node >= 22 (`engines` in `scripts/package.json`).
- Results don't depend on the factory's `FACTORY_*` knobs. The factory runs this suite with its plist's knobs exported (`FACTORY_DEV_INSPECT=1`, `FACTORY_BROWSER_MODEL`…), so a harness that runs factory code builds its child env with `hermeticEnv()` from `scripts/__tests__/helpers/hermetic-env.mjs` rather than spreading `process.env`. `factory-env-hermetic.test.mjs` runs the knob-sensitive files with those knobs exported and fails if one goes red.
- SQL migrations that need executing, not just pattern checks, run in [PGlite](https://pglite.dev) (Postgres compiled to WASM, in process; a root dev dependency, so `pnpm install` first). `note-text-chars.test.mjs` and `product-metrics.test.mjs` run the product-metrics migrations verbatim over stand-in tables, and `usage-daily.test.mjs` does the same for `usage_daily`, `record_activity`, the nightly rollup and the active-user and retention metrics ([product metrics](../features/product-metrics.md)). PGlite has no pg_cron, so a job's schedule goes in a migration of its own (`20261113000004_usage_daily_cron.sql`) and the tests load the main one unchanged.
- No external services required, as long as `SUPABASE_SERVICE_ROLE_KEY` is unset. If it is exported along with the dev URL and anon key, for example after you source an `apps/web/.env.local` that holds the admin specs' key, the glob's `profile-privilege-guard.live.test.mjs`, `product-metrics.live.test.mjs`, `storage-quota.live.test.mjs` and `usage-daily.live.test.mjs` run against dev and create users there. None of them checks `DRAFTO_UNATTENDED`, so an unattended session runs them too. Run `unset SUPABASE_SERVICE_ROLE_KEY` before an ordinary run, and run those tests with [`pnpm test:live:supabase`](#dev-live-tests-pnpm-testlivesupabase).

### Dev live tests (`pnpm test:live:supabase`)

Five opt-in tests run against the real **dev** Supabase project (`huhzactreblzcogqkbsd`). They aren't rows in the matrix above, and CI skips them. The Scripts row's glob does pick up `profile-privilege-guard.live.test.mjs`, `product-metrics.live.test.mjs`, `storage-quota.live.test.mjs` and `usage-daily.live.test.mjs`, but each skips unless the dev project's URL, anon key and service-role key are in the environment, and CI's `scripts-tests` job sets none of them. An operator runs them from an interactive session when a change touches what they cover, as the feature docs' Verify blocks note:

- `scripts/__tests__/profile-privilege-guard.live.test.mjs` (`--only profile-guard`) checks the `profiles` privilege guard ([auth](../features/auth.md)).
- `apps/web/__tests__/integration/account-deletion.live.test.ts` (`--only account-deletion`) checks `deleteUserAccount`.
- `scripts/__tests__/product-metrics.live.test.mjs` (`--only metrics`) checks the product-metrics functions and who may call them ([product metrics](../features/product-metrics.md)). It needs both product-metrics migrations applied to dev.
- `scripts/__tests__/storage-quota.live.test.mjs` (`--only storage-quota`) checks the per-user attachment storage quota: the `attachments` trigger (including a row counted at its object's real size), the upsert retry, the bucket's upload policies and their object byte count, and who may call the usage RPCs ([editor](../features/editor.md), [ADR-0072](../adr/0072-per-user-attachment-storage-quota.md)).
- `scripts/__tests__/usage-daily.live.test.mjs` (`--only usage-daily`) checks `record_activity`'s limits and the `usage_daily` table's RLS: a user can't write another user's row or read the table ([product metrics → Activity days](../features/product-metrics.md#activity-days-usage_daily)). It needs `20261113000003_usage_daily.sql` applied to dev.

```bash
pnpm test:live:supabase                          # all five
pnpm test:live:supabase -- --only profile-guard  # one
pnpm test:live:supabase -- --dry-run             # print the commands and env var names, run nothing
```

- **Interactive sessions only.** The runner reads the dev service-role key, so it refuses before reading any key file in two cases:
  - an unattended session, marked by `DRAFTO_UNATTENDED=1`. The factory, support and nightly scripts export it, and the factory's verification lane sets it in every process it starts.
  - a run under `node --test`.

  The verification lane's guard also denies any command that names the runner or a `test:live` script ([ADR-0053](../adr/0053-pre-in-test-verification-stage.md)). The factory never runs these tests; a factory PR that needs them leaves them to the operator.

- **They write to dev.** Each run creates users on dev and deletes them again; storage-quota also uploads a few tiny objects and deletes them first. Creating a user fires dev's new-signup webhook, if one is configured.
- **Where the keys come from.** `scripts/run-dev-live-tests.mjs` finds them itself:
  - The service-role key comes from `~/drafto-secrets/dev-supabase-admin.env`, which is on the Mac mini, or from `--key-file`. Only when no `--key-file` is given and that default file is missing does the runner read the `DEV:` line of `~/drafto-secrets/supabase service keys.txt` instead. Either file must be mode 600.
  - A key in the legacy JWT format must carry the dev project's `ref` and the `service_role` role. A key in any other format, such as `sb_secret_…`, is used, and `--dry-run` notes that its project couldn't be verified.
  - The anon key comes from `apps/web/.env.local`. In a worktree, `scripts/worktree-bootstrap.sh` copies it there.
  - The runner refuses any project but dev and prints names, never values.
- **A missing key fails the run; it doesn't skip.** The runner sets `DRAFTO_LIVE_REQUIRED=1`. With that set, a live test that can't reach dev fails and names the missing variables, so a skipped run can't pass for a green one. Without it, as in CI and a plain `pnpm test`, they skip.
- **Each test is capped at 15 minutes.** The summary reports a timeout as such.

## Coverage

Web coverage is enforced by SonarCloud with a target of roughly 80% on new code. To see why a specific PR failed the quality gate:

```
https://sonarcloud.io/api/qualitygates/project_status?projectKey=JakubAnderwald_drafto&pullRequest=<PR_NUMBER>
```

The response lists each metric (coverage %, duplication %, etc.) and which condition failed.

Write tests concurrently with new code and check coverage locally (`cd apps/web && pnpm test:coverage`) before pushing — iterating via CI is slow.

## Manual-only coverage

Some behaviour cannot be scripted deterministically and is verified by hand. Note it here rather than leaving a silent gap.

- **Realtime push for externally modified notes** (web, [ADR-0032](../adr/0032-web-realtime-note-sync.md)). `apps/web/e2e/note-sync.spec.ts` covers the `visibilitychange` / `focus` half of the feature — an edit made by a second HTTP client surfaces in the open editor with no page reload. The Supabase `postgres_changes` push itself needs two live authenticated clients and a websocket round-trip, so it is checked manually: open the same note on the web and on a phone, edit on the phone, and confirm the web editor updates within a second or two without touching the tab. Both signals funnel into one reconciliation handler, so the E2E test does cover the shared apply path.
- **No-clobber conflict prompt.** The dirty window is one 500 ms autosave debounce wide, which is too tight to hit reliably from Playwright. It is covered deterministically instead in `apps/web/__tests__/integration/note-sync-reconciliation.test.tsx`.
- **The real password-recovery link on mobile and desktop** ([ADR-0034](../adr/0034-password-recovery-deep-links-on-mobile-and-desktop.md)). `apps/mobile/e2e/06-forgot-password.yaml` covers everything up to and including the deep link being claimed by the app: it opens `drafto://reset-password` with no credentials and asserts the in-app reset screen renders rather than an unmatched route, the website, or the notebook list. It then opens a forged link carrying session tokens and asserts it signs no one in ([ADR-0045](../adr/0045-mobile-auth-uses-pkce.md)). Its request step uses an address with no account, which Supabase answers with the usual confirmation without sending anything, so it needs no mailbox and no email quota. What it cannot do is mint a real code — a genuine link arrives by email and is single-use. So the last leg is checked by hand, once per platform, on a beta build (betas run against production; dev's built-in mailer won't deliver the email, see [environments.md](./environments.md#supabase-projects)): request a reset in the app, open the emailed link on that same device, confirm it lands on the reset screen (not the browser, not the main app), set a new password, and confirm the old one no longer signs in.
  - It must be the same device that requested the reset, on mobile as well as macOS, because both apps run PKCE and the `code_verifier` is local to that install.
  - Open one link more than 5 minutes after requesting it. Supabase times a PKCE reset from the request, so this measures the hosted flow-state window ([ADR-0045](../adr/0045-mobile-auth-uses-pkce.md)), and the app should say the link expired, not show a raw error.
  - **On Android, also sign in with Apple** once. It is the only mobile flow that returns through a `drafto://` redirect, and before PKCE it most likely signed nobody in.
  - **Per-flow verifiers on mobile** ([ADR-0045](../adr/0045-mobile-auth-uses-pkce.md), amendment of 2026-11-01). Request reset A, then start a second flow on the same phone before opening A's email: on Android, start an Apple sign-in and close it; on either platform, sign up with an address that already has an account, which still starts a PKCE flow but sends no mail and creates no user. Don't request a second reset for the same address. Supabase ties A's code to the newest reset request, so A's link then fails whatever the app does, probably even when the second request is refused under the 60-second limit. Open A's link: it must land on the reset form with no error. A lost flow id shows "code challenge does not match previously saved code verifier" instead. Before you open it, read its target: the email link's `redirect_to` must still carry `sb_flow_id`, and the app must open `drafto://reset-password?code=…&sb_flow_id=…`. A `redirect_to` without it, or a link that lands on drafto.eu, means the project's allowlist is missing the `?sb_flow_id=*` entry below. `apps/mobile/__tests__/lib/pkce-flow-ids.test.ts` covers the client side against a fake server, but not Supabase's handling of the redirect.
  - **On macOS**, the link first lands on the drafto.eu hand-off page (`/auth/desktop/recovery`, [ADR-0044](../adr/0044-desktop-auth-web-handoff.md)), which opens the app. Confirm three things: the tab shows "Opening Drafto to reset your password", not a blank loading tab; clicking its "Open Drafto" button afterwards leaves the reset form in place (the app ignores the repeated, already-used link); and opening the same email on a phone shows "Open this link on your Mac".
  - `apps/web/e2e/desktop-handoff.spec.ts` covers the page itself, but not the browser-to-app hand-off.
- **The desktop OAuth leg** ([ADR-0044](../adr/0044-desktop-auth-web-handoff.md)). Sign in to the macOS app with Google and with Apple, in Chrome and with Safari as the default browser. Confirm three things: after the account click the tab ends on "Finishing sign-in in Drafto", not Google's frozen "in progress" page; the app signs in; and clicking "Open Drafto" again does nothing harmful. The real provider round trip cannot be automated.
  - **Check the PKCE challenge method** ([ADR-0062](../adr/0062-desktop-pkce-native-csprng.md)). Note the time and start a Google sign-in. While the browser is on Google's account chooser, find the `auth.flow_state` row the click created and check its `code_challenge_method`. It should be `s256`.
    - Read it before finishing the sign-in, because Supabase Auth may delete the row once the app exchanges the code.
    - TestFlight builds use the prod project (`tbmjbxxseonkciqovnpl`), so this is a read-only `SELECT` in the dashboard's SQL editor: `select code_challenge_method, provider_type, created_at from auth.flow_state where created_at > now() - interval '2 minutes' order by created_at desc;`.
    - Web and mobile write to the same table, both with `s256` (mobile builds from before [#686](https://github.com/JakubAnderwald/drafto/issues/686) send `plain`). Match the row by its time and `provider_type`, and repeat the check if more than one Google row lands in the window.
  - **If the row says `plain`**, sign-in still works, but part of the module was skipped. The app's `[crypto]` warning in Console.app (subsystem `com.facebook.react.log`) says which part:
    - "DraftoCrypto returned no random bytes": the synchronous `randomBytes` call is broken, and the verifier still comes from `Math.random`.
    - "failed its SHA-256 self-test": the async `sha256` is broken, or didn't answer within 5 seconds. The verifier comes from the CSPRNG, but `subtle` was not installed.
    - No `[crypto]` line at all: the module isn't linked. Check its `project.pbxproj` entries.
  - **If sign-in fails before the browser opens**, the login screen shows "Failed to open sign-in. Please try again." and nothing is logged, because `signInWithOAuthBrowser` (`apps/desktop/src/lib/oauth.ts`) swallows the error. There are three possible causes:
    - `getRandomValues` threw on the full-size request after the one-byte probe passed.
    - A `sha256` call failed after the self-test passed. Once `subtle` exists, supabase-js no longer falls back to `plain`.
    - The browser could not be opened.

    The first two are not expected. If a build that signed in before now fails this way, suspect the crypto path.

  - `apps/desktop/__tests__/lib/pkce-challenge.test.ts` checks the same outcomes against supabase-js in Jest, but not the native module itself, which CI does not build.
- **The Supabase redirect-URL allowlist.** Each must be allowed under Supabase Auth → URL Configuration → Redirect URLs in dev (`huhzactreblzcogqkbsd`) and prod (`tbmjbxxseonkciqovnpl`):
  - `drafto://reset-password` (mobile recovery) and `drafto://auth/callback` (Apple sign-in on Android).
  - `drafto://reset-password?sb_flow_id=*` and `drafto://auth/callback?sb_flow_id=*`. Mobile appends its PKCE flow id to both redirects, and Supabase matches the query string too, so the exact entries above stop matching ([ADR-0045](../adr/0045-mobile-auth-uses-pkce.md)). Add them before a build with `appendPkceFlowIdToRedirects` reaches testers, and keep the exact entries for installed builds.
  - `https://drafto.eu/auth/desktop/recovery` and `https://drafto.eu/auth/desktop/callback` (desktop). Both hosted projects already allow `https://drafto.eu/**`, which covers these.
  - `https://drafto.eu/login?confirmed=1`, where the mobile and desktop sign-up confirmation email lands. Also covered by `https://drafto.eu/**`, which also matches mobile's form, `https://drafto.eu/login?confirmed=1&sb_flow_id=…`. An exact entry would not. If it is missing, the link still confirms the address but lands on the Site URL without the "Email confirmed" notice.
  - The old `eu.drafto.desktop://auth/recovery` and `eu.drafto.desktop://auth/callback` entries. Keep them for already-installed desktop builds.

  Nothing in the test suite can observe this. If an entry is missing, Supabase rejects the redirect, falls back to the Site URL, and the manual checks above fail at the email link or the account click.

- **Factory In-Test scenarios on macOS** can be run hands-off against the TestFlight build and production with [`apps/desktop/e2e/in-test/`](../../apps/desktop/e2e/in-test/) ([guide](../operations/macos-in-test-automation.md), [ADR-0043](../adr/0043-automated-macos-in-test-scenarios.md)). A person starts each full run, because it writes to production, so it is not part of the matrix above or of CI.
- **The native activity ping, end to end** ([ADR-0088](../adr/0088-activity-days-instead-of-event-analytics.md)). The mobile and desktop unit tests cover the day queue and the sync wiring against a mocked client, and neither Maestro nor the desktop E2E looks at `usage_daily`. To check a debug build, which runs against dev: sign in, let a sync finish, then in the dev project's SQL editor run `select day, client from public.usage_daily where user_id = '<user id>' order by day desc limit 5;`. Today's `mobile-ios`, `mobile-android` or `desktop-macos` row should be there.
- **The mobile attachment cache stays out of device backups** ([ADR-0107](../adr/0107-mobile-attachment-cache-excluded-from-backups.md)). The unit tests cover the JS side with the native module mocked, and `apps/mobile/__tests__/unit/android-backup-rules.test.ts` pins the Android rules chain, but neither sees a real backup, and CI doesn't build iOS. Check once per platform when the cache, the `backup-exclusion` module or expo-secure-store changes:
  - **iOS** (simulator, after opening a note with an image): `xattr -l "$(xcrun simctl get_app_container booted eu.drafto.mobile data)/Documents/attachment-cache"` lists `com.apple.metadata:com_apple_backup_excludeItem`. Sign out, sign in, open a note with an image again, and repeat: the recreated folder must carry it too.
  - **Android**: in `apps/mobile`, run `npx expo prebuild -p android --no-install` (`android/` is gitignored) and check that `android/app/src/main/AndroidManifest.xml` has `android:allowBackup="true"`, `android:fullBackupContent="@xml/secure_store_backup_rules"` and `android:dataExtractionRules="@xml/secure_store_data_extraction_rules"`, and that prebuild printed no expo-secure-store warning about other backup rules being present. Then take a real backup and restore it, on an emulator with a debug build (`run-as` needs a debuggable app):
    1. Switch to the local transport and turn backups on: `adb shell bmgr transport com.android.localtransport/.LocalTransport`, then `adb shell bmgr enable true`.
    2. Sign in and open a note with an image, so the cache isn't empty: `adb shell run-as eu.drafto.mobile find files/attachment-cache -type f` must list the image's file, not only `.index.json`. An empty cache would pass the check below without proving anything.
    3. Run `adb shell bmgr backupnow eu.drafto.mobile`. It must print `Package eu.drafto.mobile with result: Success`. Any other result means no backup was taken, so stop and fix that first.
    4. Uninstall and reinstall the same APK (`adb uninstall eu.drafto.mobile`, then `adb install <apk>`). Auto Backup restores on install. Before opening the app, `adb shell run-as eu.drafto.mobile ls shared_prefs` must list the restored preferences, which shows the restore ran, and `adb shell run-as eu.drafto.mobile ls files` must not list `attachment-cache`.
- **Applying the Realtime migration.** `supabase/migrations/20260906000001_enable_notes_realtime.sql` must be applied to dev before the push path can be exercised at all; the `visibilitychange` E2E tests pass without it.

## Common failure patterns

- **Missing test coverage** — new files with no tests drag coverage below the gate. Add tests in the same PR.
- **E2E depends on migrations** — if a feature requires a new migration, apply it to dev before running `pnpm test:e2e`, otherwise the test hits missing columns or functions (for example, `usage-daily.spec.ts` fails until dev has `record_activity`).
- **Module-level state in React 19 tests** — components using `use()` with a module-level promise cache need `vi.resetModules()` + re-import between tests, or state leaks across cases.
- **Locator overlap** — Playwright `getByRole("button", { name: "New note" })` also matches "New notebook". Use `{ exact: true }`.
- **Worktree + Metro** — port 8081 clashes with the main checkout. Start Metro on a different port and use `adb reverse`.
- **Web E2E passes in CI but fails under `pnpm dev`** — check that the middleware still runs locally. It must sit at `apps/web/src/middleware.ts`, next to `src/app`. At the web root `next dev` ignores it, while `next build` still finds it. So CI's production build passes and local signed-out specs fail: `/` redirects to `/login` instead of showing the landing page. `__tests__/unit/next-convention-files.test.ts` guards the location.

## Related

- [`CLAUDE.md`](../../CLAUDE.md) — Testing Requirements and Pre-push verification sections (authoritative).
- [`../operations/local-dev-setup.md`](../operations/local-dev-setup.md) — first-time machine setup (emulator, Playwright browsers, etc.).
- [`./environments.md`](./environments.md) — which backend each test suite runs against.
