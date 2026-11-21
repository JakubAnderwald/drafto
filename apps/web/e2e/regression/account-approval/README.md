# Account Approval — End-to-End Regression Test

Semi-automated regression runbook for the signup → admin-notice → account-active flow. PR #290 introduced it with a one-click approve link (fixed in PR #292). Since open signup ([ADR 0094](../../../../../docs/adr/0094-open-signup-with-admin-suspend.md)) a new account is active from the start and the admin email is a notice, so step 6 below now checks the account is already active instead of waiting for a click. The suspend/reactivate loop is covered in CI by `e2e/account-suspend.admin.spec.ts`.

**Why not a Playwright test in CI?** Verifying that emails actually leave the system and land in the admin's inbox requires a real Gmail account. CI can't read it. These scripts are designed to be run locally via Claude Code, which has a Gmail MCP tool for email assertions.

## What this test covers

1. Public signup form submission (`/signup` → Supabase Auth `/auth/v1/signup`)
2. `handle_new_user` trigger → `public.profiles` INSERT
3. `notify_admin_new_signup` trigger → `net.http_post` → `/api/webhooks/new-signup`
4. Webhook endpoint (bypasses auth middleware, verifies `WEBHOOK_SECRET`)
5. Admin notice email delivery (Resend → admin inbox), saying the account is already active
6. The new profile is active (`is_approved = true`) with no admin action
7. Cleanup of the test user

## Prerequisites

| Requirement                                          | How                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linked prod Supabase project                         | `pnpm supabase:link:prod`                                                                                                                                                                                                                    |
| Vault secrets populated on prod                      | `select count(*) from vault.decrypted_secrets where name in ('webhook_url','webhook_secret');` → must return 2                                                                                                                               |
| `main` deployed to Vercel with middleware fix (#292) | `curl -sw '%{http_code}' -X POST -H 'Sec-Fetch-Mode: navigate' -H 'x-webhook-secret: wrong' https://drafto.eu/api/webhooks/new-signup -d '{}'` → must return **401** (not 307). Keep the `Sec-Fetch-Mode` header: see the first gotcha below |
| Admin email is `jakub@anderwald.info`                | `select email from auth.users where id in (select id from profiles where is_admin=true);`                                                                                                                                                    |
| Node + Playwright installed                          | `pnpm install` + `pnpm exec playwright install chromium`                                                                                                                                                                                     |

## Running the test

From this directory:

```bash
# 1. Sign up a fresh test user via the public UI
node 01-signup.mjs
# → writes /tmp/e2e-approval/state.json with testEmail + testUserId

# 2. Poll pg_net + Supabase until webhook returns 200 and user row exists
node 02-verify-webhook.mjs

# 3. Ask Claude Code to read Gmail and confirm the admin notice arrived:
#    "Search for 'from:hello@drafto.eu subject:\"New Drafto signup\" newer_than:5m'"
#    Expected: "Their account is already active", a link to /admin, and no approve link.

# 4. Confirm the new profile is active without any admin action
node 03-verify-approved.mjs

# 5. Cleanup
node 99-cleanup.mjs
```

## Test email addressing

Test emails use the form `jakub+draftoe2e-<timestamp>@anderwald.info`. Gmail-style plus-addressing routes these to `jakub@anderwald.info`'s inbox, so Supabase auth confirmations and the admin notice all land where Claude Code can read them via the Gmail MCP tool.

## What each script does

- **`01-signup.mjs`** — Launches headless Chromium, navigates to `https://drafto.eu/signup`, fills `jakub+draftoe2e-<ts>@anderwald.info` + a random password, submits the form via `form.requestSubmit()` (more reliable than button click), captures the Supabase signup response, and saves state to `/tmp/e2e-approval/state.json`.
- **`02-verify-webhook.mjs`** — Polls `auth.users` + `public.profiles` for the new row, then polls `net._http_response` for a 200 response from the webhook. Fails loudly if the response is 307/401/405 or if it doesn't show up within ~40s.
- **`03-verify-approved.mjs`** — Checks that the new profile has `is_approved = true` straight after signup, with no admin action (open signup, ADR 0094).
- **`99-cleanup.mjs`** — `DELETE FROM auth.users WHERE email LIKE 'jakub+draftoe2e-%@anderwald.info';` — relies on the FK cascade to clean `profiles`.

## Known gotchas (lessons from the first run)

- **Middleware must exempt `/api/webhooks`** or it answers the trigger with 401 `{"error":"Unauthorized"}` itself, before the route runs (before #460 it was a 307 → /login, which pg_net followed as a GET → 405). The route answers a wrong secret with the same 401, so a plain curl can't tell the two apart. The prerequisite check sends `Sec-Fetch-Mode: navigate`, which middleware treats as a page load: without the exemption it answers 307 → /login, and with it the route still answers 401.
- **Supabase vault secrets can be wiped across sessions** in edge cases (exact cause unknown — possibly a Supabase-internal rekey after migrations). Always run the vault `count(*)` prerequisite check first. Re-insert with `select vault.create_secret(...)` if missing; values are in `~/drafto-secrets/account-approval-secrets.env`.
- **Supabase rate-limits signups to 30 per 5 min per IP**. Don't run this test in a tight loop.
- **The `+` in plus-addressing is valid** — Supabase accepts it, Resend delivers it. Don't be tempted to strip it "just in case".
- **Query the right Supabase project** before asserting DB state. `pnpm supabase:link:prod` returns silently on success; `supabase projects list` shows the `●` marker next to the currently-linked project.

## Failure modes + triage

| Symptom                                              | Check                                                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `02-verify-webhook.mjs` reports 307/401/405          | Middleware fix rolled back, or `WEBHOOK_SECRET` drifted between Vercel and vault                                                                                       |
| No admin email in Gmail but webhook returned 200     | Resend delivery logs (resend.com → Logs). DKIM/SPF records may have been removed.                                                                                      |
| User row created but trigger didn't fire             | `select tgenabled from pg_trigger where tgname = 'on_profile_insert_notify_admin';` — must be `O` (enabled)                                                            |
| `03-verify-approved.mjs` finds `is_approved = false` | The open-signup default is gone: check `select column_default from information_schema.columns where table_name = 'profiles' and column_name = 'is_approved';` → `true` |
