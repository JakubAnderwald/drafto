# 0056 — Keep Credentials Out of the E2E Report

- **Status**: Accepted
- **Date**: 2026-10-24
- **Authors**: Jakub Anderwald, Claude

## Context

When web E2E fails, CI uploads `apps/web/playwright-report` as an artifact. The repo is public, so anyone can download it. In October 2026 the factory's watcher found the E2E password in one, and a check of the reports still online showed four ways credentials got in:

- **Step titles.** `locator.fill(password)` is recorded as `Fill "<password>"` in the HTML report's step list.
- **Failure snapshots.** Playwright 1.63 saves the page's ARIA snapshot when a test fails, as `error-context.md` or inside the failing assertion's own error, and it lists a password field's value. Assertions take theirs at the moment they fail, before any `afterEach` hook can clean the page.
- **Traces.** `trace: "on-first-retry"` recorded the sign-in request body (the password), the token response, and the Supabase session cookie on every request of a retried test. The cookie carries the refresh token.
- **API errors.** A failed `page.request` or `request`-fixture call, or `expect(response).toBeOK()`, prints the request's headers, cookie included, in its error message.

The CI job log isn't affected: with only the HTML reporter, it doesn't print call logs. The leaked reports were deleted and the test user's sessions revoked.

## Decision

Publish a stripped report, and refuse to publish one that still carries a credential:

1. **No traces on CI.** `playwright.config.ts` sets `trace` to `off` when `CI` is set. They stay on for local runs.
2. **`fillSecret()` for passwords** (`apps/web/e2e/helpers/secret-fields.ts`). It sets the value through the native setter and fires `input`, so React state holds it and the step is a bare `Evaluate`. In the same call it swaps the field for a copy showing `hidden-by-fillSecret`, so no later snapshot can see it. Every spec that types a real password uses it.
3. **A fail-closed scan before upload** (`scripts/scan-playwright-report.mjs`). It reads every file, inside trace zips and the zip `index.html` inlines too. It looks for the E2E and admin passwords and the service-role key, and for session tokens by shape, using the factory browser runner's `SECRET_PATTERNS`. On any hit, an unreadable archive, or a symlink, the CI upload step is skipped.

## Consequences

- **Positive**: The password and session tokens no longer reach the public artifact, and a regression (a new `fill(password)`, traces turned back on) withholds the report instead of publishing it.
- **Negative**: CI reports have no traces; a flaky CI failure is debugged from the report's errors and snapshots, or reproduced locally.
- **Negative**: Withholding is all-or-nothing. A run with one API-request failure uploads no report at all, even for unrelated failures in the same run.
- **Negative**: `fillSecret` relies on the login form submitting from React state. A form that reads the DOM (FormData, a server action) would submit the stand-in. The test would then fail loudly rather than leak.
- **Neutral**: Test-account emails are still entered with `fill()` and appear in reports. They identify the accounts but aren't credentials.

## Alternatives Considered

- **Encrypt the artifact with a repo secret.** It covers every leak path and keeps traces, but it adds a key to manage on each machine, and reading a report needs a decrypt step. Unattended factory agents couldn't read reports. Not chosen.
- **Stop uploading the report.** Simplest, but it drops the failure snapshots that diagnose most CI failures.
- **Scrub secrets out of the report before upload.** It would keep reports that are withheld today, but it means rewriting the zips Playwright embeds, which is fragile across Playwright versions. Could be revisited if withheld reports become a problem.
- **Clear the password field in `afterEach` on failure.** Tried first. It doesn't work: assertions snapshot the page when they fail, before hooks run.
