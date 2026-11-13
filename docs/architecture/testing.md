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
| Mobile                        | E2E (Maestro)                | `maestro test apps/mobile/e2e/ --platform android`                               | `apps/mobile/e2e/`                                            | manual (not in CI), a person runs it   |
| Desktop                       | Unit                         | `cd apps/desktop && pnpm test`                                                   | `apps/desktop/__tests__/`                                     | jest fail                              |
| Desktop                       | E2E (AppleScript + cliclick) | `cd apps/desktop && pnpm test:e2e`                                               | `apps/desktop/e2e/`                                           | manual (not in CI), a person runs it   |
| Scripts (Mac mini automation) | Unit (`node --test`)         | `cd scripts && pnpm test`                                                        | `scripts/__tests__/`                                          | node --test fail (`scripts-tests` job) |

Turborepo aggregates the workspaces' suites at the root: `pnpm test` fans out to every workspace that defines a `test` script, and `pnpm typecheck` / `pnpm lint` do the same for their respective tasks. `scripts/` is not a workspace: `pnpm-workspace.yaml` lists only `apps/*` and `packages/*`. So the root `pnpm test` never runs the scripts suite, and you must run `cd scripts && pnpm test` on its own. CI runs it in a separate `scripts-tests` job.

## Pre-push checklist

Before any push, run every row of the matrix above (all nine suites) plus `pnpm lint && pnpm typecheck` from the repo root. Do not push if any step fails.

- **A person runs the two manual E2E rows, Mobile E2E and Desktop E2E, in an interactive session.** Unattended sessions, the factory included, never run them. Each manual row needs a device or app set up first: see [Maestro](#maestro-mobile-e2e) and [Desktop E2E](#desktop-e2e).
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

- In a worktree on Android, Metro on port 8081 may clash with the main checkout's Metro. Start Metro on another port with `pnpm start --port 8082`, then, in a second terminal, redirect the app with `adb reverse tcp:8081 tcp:8082`. Metro stays in the foreground, so chaining the two with `&&` never runs `adb reverse`.
- **Before shipping an iOS release, launch a Release build on the iOS 27 simulator** (runtime `com.apple.CoreSimulator.SimRuntime.iOS-27-0`). Build it with `xcodebuild … -configuration Release -sdk iphonesimulator` after `expo prebuild` with `.env.production` sourced, then check that the app reaches the Log In screen. Then quit it with `xcrun simctl terminate <sim> eu.drafto.mobile` and check that `xcrun simctl openurl <sim> "drafto://reset-password"` lands on the reset screen. Quitting first makes this a true cold start, through `scene(_:willConnectTo:options:)`. With the app still running, the link goes through `scene(_:openURLContexts:)` instead. iOS 27 stops apps built with its SDK that skip the UIScene lifecycle, and older simulators don't show it ([ADR-0046](../adr/0046-ios-uiscene-lifecycle.md)).

### Desktop E2E

`apps/desktop/e2e/run-e2e.sh` drives the running macOS app through System Events (AppleScript) and clicks with `cliclick`. It finds elements by their accessibility label.

- **A person runs it, in an interactive session.** The factory and other unattended sessions never do (see [Pre-push checklist](#pre-push-checklist)). On the Mac mini, `/Applications/Drafto.app` is the TestFlight build, which runs against production, so the debug build must be running before you start.
- Install `cliclick` with `brew install cliclick`. Without it the runner exits at once.
- The Drafto macOS app must be running before you start. Use a debug build of the branch, served by Metro: run `cd apps/desktop && pnpm start` in one terminal, then build and launch with `cd apps/desktop && pnpm macos` (`npx react-native run-macos`, see [Local macOS dev build](../operations/builds-and-releases.md#local-macos-dev-build)). A debug build reads `apps/desktop/.env`, so it runs against the **dev** Supabase project ([environments](./environments.md)).
  - The runner's first step is `tell application "Drafto" to activate`. If no Drafto is running, that launches whichever Drafto macOS finds, which may be the installed production build: on the Mac mini, the TestFlight build. Start the debug build first.
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
- SQL migrations that need executing, not just pattern checks, run in [PGlite](https://pglite.dev) (Postgres compiled to WASM, in process; a root dev dependency, so `pnpm install` first). `note-text-chars.test.mjs` and `product-metrics.test.mjs` run the product-metrics migrations verbatim over stand-in tables, and `usage-daily.test.mjs` does the same for `usage_daily`, `record_activity`, the nightly rollup and the active-user and retention metrics ([product metrics](../features/product-metrics.md)). PGlite has no pg_cron, so a job's schedule goes in a migration of its own (`20261113000004_usage_daily_cron.sql`) and the tests load the main one unchanged.
- No external services required, as long as `SUPABASE_SERVICE_ROLE_KEY` is unset. If it is exported along with the dev URL and anon key, for example after you source an `apps/web/.env.local` that holds the admin specs' key, the glob's `profile-privilege-guard.live.test.mjs`, `product-metrics.live.test.mjs` and `usage-daily.live.test.mjs` run against dev and create users there. None of them checks `DRAFTO_UNATTENDED`, so an unattended session runs them too. Run `unset SUPABASE_SERVICE_ROLE_KEY` before an ordinary run, and run those tests with [`pnpm test:live:supabase`](#dev-live-tests-pnpm-testlivesupabase).

### Dev live tests (`pnpm test:live:supabase`)

Four opt-in tests run against the real **dev** Supabase project (`huhzactreblzcogqkbsd`). They aren't rows in the matrix above, and CI skips them. The Scripts row's glob does pick up `profile-privilege-guard.live.test.mjs`, `product-metrics.live.test.mjs` and `usage-daily.live.test.mjs`, but all three skip unless the dev project's URL, anon key and service-role key are in the environment, and CI's `scripts-tests` job sets none of them. An operator runs them from an interactive session when a change touches what they cover, as the feature docs' Verify blocks note:

- `scripts/__tests__/profile-privilege-guard.live.test.mjs` (`--only profile-guard`) checks the `profiles` privilege guard ([auth](../features/auth.md)).
- `apps/web/__tests__/integration/account-deletion.live.test.ts` (`--only account-deletion`) checks `deleteUserAccount`.
- `scripts/__tests__/product-metrics.live.test.mjs` (`--only metrics`) checks the product-metrics functions and who may call them ([product metrics](../features/product-metrics.md)). It needs both product-metrics migrations applied to dev.
- `scripts/__tests__/usage-daily.live.test.mjs` (`--only usage-daily`) checks `record_activity`'s limits and the `usage_daily` table's RLS: a user can't write another user's row or read the table ([product metrics → Activity days](../features/product-metrics.md#activity-days-usage_daily)). It needs `20261113000003_usage_daily.sql` applied to dev.

```bash
pnpm test:live:supabase                          # all four
pnpm test:live:supabase -- --only profile-guard  # one
pnpm test:live:supabase -- --dry-run             # print the commands and env var names, run nothing
```

- **Interactive sessions only.** The runner reads the dev service-role key, so it refuses before reading any key file in two cases:
  - an unattended session, marked by `DRAFTO_UNATTENDED=1`. The factory, support and nightly scripts export it, and the factory's verification lane sets it in every process it starts.
  - a run under `node --test`.

  The verification lane's guard also denies any command that names the runner or a `test:live` script ([ADR-0053](../adr/0053-pre-in-test-verification-stage.md)). The factory never runs these tests; a factory PR that needs them leaves them to the operator.

- **They write to dev.** Each run creates users on dev and deletes them again. Creating a user fires dev's new-signup webhook, if one is configured.
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
- **The native activity ping, end to end** ([ADR-0080](../adr/0080-activity-days-instead-of-event-analytics.md)). The mobile and desktop unit tests cover the day queue and the sync wiring against a mocked client, and neither Maestro nor the desktop E2E looks at `usage_daily`. To check a debug build, which runs against dev: sign in, let a sync finish, then in the dev project's SQL editor run `select day, client from public.usage_daily where user_id = '<user id>' order by day desc limit 5;`. Today's `mobile-ios`, `mobile-android` or `desktop-macos` row should be there.
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
