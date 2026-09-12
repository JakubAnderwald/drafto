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
- Browsers are installed on first run (`pnpm exec playwright install`).

### Maestro (mobile E2E)

- A running Android emulator (or physical device with USB debugging).
- The Expo dev client must be running: `cd apps/mobile && npx expo start --dev-client`.
- `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` must be exported in the shell.
- In a worktree, Metro on port 8081 may clash with the main checkout's Metro. Start on a different port and redirect: `pnpm start --port 8082 && adb reverse tcp:8081 tcp:8082`.

### Mobile / desktop unit tests

- Jest in both apps. In a worktree, run `pnpm install` first — worktrees do not share `node_modules`.
- Mobile tests under `apps/mobile/__tests__/` cover `components/`, `hooks/`, `lib/`, `providers/`, `screens/`, `performance/`, and shared `helpers/`.
- Desktop tests under `apps/desktop/__tests__/` cover `components/`, `db/`, `hooks/`, `lib/`, `screens/`, and shared `helpers/`.

### Shared package

- Vitest against `packages/shared/__tests__/` and `packages/shared/src/editor/__tests__/` (attachment-url, format-converter, resolve-urls, and the editor-local tests).
- No external services required.

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
- **The real password-recovery link on mobile and desktop** ([ADR-0034](../adr/0034-password-recovery-deep-links-on-mobile-and-desktop.md)). `apps/mobile/e2e/06-forgot-password.yaml` covers everything up to and including the deep link being claimed by the app: it opens `drafto://reset-password` with no credentials and asserts the in-app reset screen renders rather than an unmatched route, the website, or the notebook list. What it cannot do is mint a token — a genuine link arrives by email and is single-use. So the last leg is checked by hand, once per platform: request a reset in the app, open the emailed link on that same device, confirm it lands on the reset screen (not the browser, not the main app), set a new password, and confirm the old one no longer signs in. On macOS this must be the same Mac that requested it — the PKCE `code_verifier` is local to that install.
- **The Supabase redirect-URL allowlist.** `drafto://reset-password` and `eu.drafto.desktop://auth/recovery` must both be listed under Supabase Auth → URL Configuration → Redirect URLs in dev (`huhzactreblzcogqkbsd`) and prod (`tbmjbxxseonkciqovnpl`). Nothing in the test suite can observe this; if it is missing, every recovery link is rejected by Supabase and the manual check above fails at the email link.
- **Applying the Realtime migration.** `supabase/migrations/20260906000001_enable_notes_realtime.sql` must be applied to dev before the push path can be exercised at all; the `visibilitychange` E2E tests pass without it.

## Common failure patterns

- **Missing test coverage** — new files with no tests drag coverage below the gate. Add tests in the same PR.
- **E2E depends on migrations** — if a feature requires a new migration, apply it to dev before running `pnpm test:e2e`, otherwise the test hits missing columns.
- **Module-level state in React 19 tests** — components using `use()` with a module-level promise cache need `vi.resetModules()` + re-import between tests, or state leaks across cases.
- **Locator overlap** — Playwright `getByRole("button", { name: "New note" })` also matches "New notebook". Use `{ exact: true }`.
- **Worktree + Metro** — port 8081 clashes with the main checkout. Start Metro on a different port and use `adb reverse`.

## Related

- [`CLAUDE.md`](../../CLAUDE.md) — Testing Requirements and Pre-push verification sections (authoritative).
- [`../operations/local-dev-setup.md`](../operations/local-dev-setup.md) — first-time machine setup (emulator, Playwright browsers, etc.).
- [`./environments.md`](./environments.md) — which backend each test suite runs against.
