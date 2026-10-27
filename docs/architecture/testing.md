# Testing

Drafto has seven test suites across four platforms. This doc consolidates the test matrix that is scattered across the "Testing Requirements" and "Pre-push verification" sections of [`CLAUDE.md`](../../CLAUDE.md). Per-package scripts live in each app's `package.json` (`apps/web/package.json`, `apps/mobile/package.json`, `apps/desktop/package.json`, `packages/shared/package.json`).

## Test matrix

| Platform | Test type          | Command                                                                          | Location                                                      | What breaks CI                        |
| -------- | ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------- |
| Web      | Unit + integration | `cd apps/web && pnpm test`                                                       | `apps/web/__tests__/unit/`, `apps/web/__tests__/integration/` | vitest fail                           |
| Web      | E2E (Playwright)   | `set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e` | `apps/web/e2e/`                                               | playwright fail                       |
| Web      | Coverage           | `cd apps/web && pnpm test:coverage`                                              | same as web unit + integration                                | SonarCloud quality gate (~80% on new) |
| Shared   | Unit               | `cd packages/shared && pnpm test`                                                | `packages/shared/__tests__/`                                  | vitest fail                           |
| Mobile   | Unit               | `cd apps/mobile && pnpm test`                                                    | `apps/mobile/__tests__/`                                      | jest fail                             |
| Mobile   | E2E (Maestro)      | `maestro test apps/mobile/e2e/ --platform android`                               | `apps/mobile/e2e/`                                            | manual (not wired into CI yet)        |
| Desktop  | Unit               | `cd apps/desktop && pnpm test`                                                   | `apps/desktop/__tests__/`                                     | jest fail                             |

Turborepo aggregates these at the root: `pnpm test` fans out to every workspace that defines a `test` script, and `pnpm typecheck` / `pnpm lint` do the same for their respective tasks.

## Pre-push checklist

Before any push, run every row of the matrix above (all seven suites) plus `pnpm lint && pnpm typecheck` from the repo root. Do not push if any step fails.

Never skip a suite because "it's unrelated" — CI will run all of them and a failure blocks the merge.

## Prerequisites

### Playwright (web E2E)

- Requires `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` in `apps/web/.env.local`. Playwright does not load `.env.local` automatically, so the command prefix `set -a && source apps/web/.env.local && set +a` is required.
- The referenced account must exist in the **dev** Supabase project (`huhzactreblzcogqkbsd`) with `profiles.is_approved = true`.
- Optional: `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` and `SUPABASE_SERVICE_ROLE_KEY` together enable the `setup-admin` project (the admin login in `apps/web/e2e/admin.setup.ts`) and the `chromium-admin` project, which runs `apps/web/e2e/admin.spec.ts`. Unless all three are set, neither project is registered and the admin specs don't run. Only `chromium-admin` depends on `setup-admin`, so a failed admin login skips the admin specs but not the rest of the suite. CI passes the three only on `main` (a push, or a manual run from `main`) and never to pull-request runs, because those execute unmerged code and the service-role key bypasses RLS. So in CI the admin specs run only on `main`, and only once the matching repository secrets exist. The service-role key must be the **dev** project's: `/admin` builds a service-role client on every render and errors without it. The account must be a **separate** user in the dev project with both `profiles.is_approved = true` and `profiles.is_admin = true` — don't make the `E2E_TEST_EMAIL` user an admin, or every other spec sees the admin UI.
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

### Maestro (mobile E2E)

- A running Android emulator (or physical device with USB debugging).
- The Expo dev client must be running: `cd apps/mobile && npx expo start --dev-client`.
- `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` must be exported in the shell.
- In a worktree, Metro on port 8081 may clash with the main checkout's Metro. Start on a different port and redirect: `pnpm start --port 8082 && adb reverse tcp:8081 tcp:8082`.
- **Before shipping an iOS release, launch a Release build on the iOS 27 simulator** (runtime `com.apple.CoreSimulator.SimRuntime.iOS-27-0`). Build it with `xcodebuild … -configuration Release -sdk iphonesimulator` after `expo prebuild` with `.env.production` sourced, then check that the app reaches the Log In screen. Then quit it with `xcrun simctl terminate <sim> eu.drafto.mobile` and check that `xcrun simctl openurl <sim> "drafto://reset-password"` lands on the reset screen. Quitting first makes this a true cold start, through `scene(_:willConnectTo:options:)`. With the app still running, the link goes through `scene(_:openURLContexts:)` instead. iOS 27 stops apps built with its SDK that skip the UIScene lifecycle, and older simulators don't show it ([ADR-0046](../adr/0046-ios-uiscene-lifecycle.md)).

### Mobile / desktop unit tests

- Jest in both apps. In a worktree, run `pnpm install` first — worktrees do not share `node_modules`.
- Mobile tests under `apps/mobile/__tests__/` cover `components/`, `hooks/`, `lib/`, `providers/`, `screens/`, `performance/`, and shared `helpers/`.
- Desktop tests under `apps/desktop/__tests__/` cover `components/`, `db/`, `hooks/`, `lib/`, `screens/`, and shared `helpers/`.

### Shared package

- Vitest against `packages/shared/__tests__/` and `packages/shared/src/editor/__tests__/` (attachment-url, format-converter, resolve-urls, and the editor-local tests).
- No external services required.

### Dev live tests (`pnpm test:live:supabase`)

Two opt-in tests run against the real **dev** Supabase project (`huhzactreblzcogqkbsd`). They aren't in the matrix above, and CI skips them. An operator runs them from an interactive session when a change touches what they cover, as the feature docs' Verify blocks note:

- `scripts/__tests__/profile-privilege-guard.live.test.mjs` (`--only profile-guard`) checks the `profiles` privilege guard ([auth](../features/auth.md)).
- `apps/web/__tests__/integration/account-deletion.live.test.ts` (`--only account-deletion`) checks `deleteUserAccount`.

```bash
pnpm test:live:supabase                          # both
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
- **A missing key fails the run; it doesn't skip.** The runner sets `DRAFTO_LIVE_REQUIRED=1`. With that set, a live test that can't reach dev fails and names the missing variables, so a skipped run can't pass for a green one. Without it, as in CI and a plain `pnpm test`, both tests skip.
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
- **The real password-recovery link on mobile and desktop** ([ADR-0034](../adr/0034-password-recovery-deep-links-on-mobile-and-desktop.md)). `apps/mobile/e2e/06-forgot-password.yaml` covers everything up to and including the deep link being claimed by the app: it opens `drafto://reset-password` with no credentials and asserts the in-app reset screen renders rather than an unmatched route, the website, or the notebook list. It then opens a forged link carrying session tokens and asserts it signs no one in ([ADR-0045](../adr/0045-mobile-auth-uses-pkce.md)). What it cannot do is mint a real code — a genuine link arrives by email and is single-use. So the last leg is checked by hand, once per platform: request a reset in the app, open the emailed link on that same device, confirm it lands on the reset screen (not the browser, not the main app), set a new password, and confirm the old one no longer signs in.
  - It must be the same device that requested the reset, on mobile as well as macOS, because both apps run PKCE and the `code_verifier` is local to that install.
  - Open one link more than 5 minutes after requesting it. Supabase times a PKCE reset from the request, so this measures the hosted flow-state window ([ADR-0045](../adr/0045-mobile-auth-uses-pkce.md)), and the app should say the link expired, not show a raw error.
  - **On Android, also sign in with Apple** once. It is the only mobile flow that returns through a `drafto://` redirect, and before PKCE it most likely signed nobody in.
  - **On macOS**, the link first lands on the drafto.eu hand-off page (`/auth/desktop/recovery`, [ADR-0044](../adr/0044-desktop-auth-web-handoff.md)), which opens the app. Confirm three things: the tab shows "Opening Drafto to reset your password", not a blank loading tab; clicking its "Open Drafto" button afterwards leaves the reset form in place (the app ignores the repeated, already-used link); and opening the same email on a phone shows "Open this link on your Mac".
  - `apps/web/e2e/desktop-handoff.spec.ts` covers the page itself, but not the browser-to-app hand-off.
- **The desktop OAuth leg** ([ADR-0044](../adr/0044-desktop-auth-web-handoff.md)). Sign in to the macOS app with Google and with Apple, in Chrome and with Safari as the default browser. Confirm three things: after the account click the tab ends on "Finishing sign-in in Drafto", not Google's frozen "in progress" page; the app signs in; and clicking "Open Drafto" again does nothing harmful. The real provider round trip cannot be automated.
- **The Supabase redirect-URL allowlist.** Each must be allowed under Supabase Auth → URL Configuration → Redirect URLs in dev (`huhzactreblzcogqkbsd`) and prod (`tbmjbxxseonkciqovnpl`):
  - `drafto://reset-password` (mobile recovery).
  - `https://drafto.eu/auth/desktop/recovery` and `https://drafto.eu/auth/desktop/callback` (desktop). Both hosted projects already allow `https://drafto.eu/**`, which covers these.
  - `https://drafto.eu/login?confirmed=1`, where the mobile and desktop sign-up confirmation email lands. Also covered by `https://drafto.eu/**`. If it is missing, the link still confirms the address but lands on the Site URL without the "Email confirmed" notice.
  - The old `eu.drafto.desktop://auth/recovery` and `eu.drafto.desktop://auth/callback` entries. Keep them for already-installed desktop builds.

  Nothing in the test suite can observe this. If an entry is missing, Supabase rejects the redirect, falls back to the Site URL, and the manual checks above fail at the email link or the account click.

- **Factory In-Test scenarios on macOS** can be run hands-off against the TestFlight build and production with [`apps/desktop/e2e/in-test/`](../../apps/desktop/e2e/in-test/) ([guide](../operations/macos-in-test-automation.md), [ADR-0043](../adr/0043-automated-macos-in-test-scenarios.md)). A person starts each full run, because it writes to production, so it is not part of the matrix above or of CI.
- **Applying the Realtime migration.** `supabase/migrations/20260906000001_enable_notes_realtime.sql` must be applied to dev before the push path can be exercised at all; the `visibilitychange` E2E tests pass without it.

## Common failure patterns

- **Missing test coverage** — new files with no tests drag coverage below the gate. Add tests in the same PR.
- **E2E depends on migrations** — if a feature requires a new migration, apply it to dev before running `pnpm test:e2e`, otherwise the test hits missing columns.
- **Module-level state in React 19 tests** — components using `use()` with a module-level promise cache need `vi.resetModules()` + re-import between tests, or state leaks across cases.
- **Locator overlap** — Playwright `getByRole("button", { name: "New note" })` also matches "New notebook". Use `{ exact: true }`.
- **Worktree + Metro** — port 8081 clashes with the main checkout. Start Metro on a different port and use `adb reverse`.
- **Web E2E passes in CI but fails under `pnpm dev`** — check that the middleware still runs locally. It must sit at `apps/web/src/middleware.ts`, next to `src/app`. At the web root `next dev` ignores it, while `next build` still finds it. So CI's production build passes and local signed-out specs fail: `/` redirects to `/login` instead of showing the landing page. `__tests__/unit/next-convention-files.test.ts` guards the location.

## Related

- [`CLAUDE.md`](../../CLAUDE.md) — Testing Requirements and Pre-push verification sections (authoritative).
- [`../operations/local-dev-setup.md`](../operations/local-dev-setup.md) — first-time machine setup (emulator, Playwright browsers, etc.).
- [`./environments.md`](./environments.md) — which backend each test suite runs against.
