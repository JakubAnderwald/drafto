# Account Approval — End-to-End Regression Test

Semi-automated regression runbook for the full signup → admin-notification → one-click-approve → user-confirmed flow introduced in PR #290 and fixed in PR #292.

**Why not a Playwright test in CI?** Verifying that emails actually leave the system and land in the admin's inbox requires a real Gmail account. CI can't read it. These scripts are designed to be run locally via Claude Code, which has a Gmail MCP tool for email assertions.

## What this test covers

1. Public signup form submission (`/signup` → Supabase Auth `/auth/v1/signup`)
2. `handle_new_user` trigger → `public.profiles` INSERT
3. `notify_admin_new_signup` trigger → `net.http_post` → `/api/webhooks/new-signup`
4. Webhook endpoint (bypasses auth middleware, verifies `WEBHOOK_SECRET`)
5. Admin notification email delivery (Resend → admin inbox)
6. One-click approve link (signed token + admin-session guard)
7. User-approved email delivery
8. Pending-state gate (idempotent re-clicks don't re-email)
9. Cleanup of the test user

## Prerequisites

| Requirement                                          | How                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linked prod Supabase project                         | `pnpm supabase:link:prod`                                                                                                                        |
| Vault secrets populated on prod                      | `select count(*) from vault.decrypted_secrets where name in ('webhook_url','webhook_secret');` → must return 2                                   |
| `main` deployed to Vercel with middleware fix (#292) | `curl -sw '%{http_code}' -X POST -H 'x-webhook-secret: wrong' https://drafto.eu/api/webhooks/new-signup -d '{}'` → must return **401** (not 307) |
| Admin email is `jakub@anderwald.info`                | `select email from auth.users where id in (select id from profiles where is_admin=true);`                                                        |
| Node + Playwright installed                          | `pnpm install` + `pnpm exec playwright install chromium`                                                                                         |

## Running the test

From this directory:

```bash
# 1. Sign up a fresh test user via the public UI
node 01-signup.mjs
# → writes /tmp/e2e-approval/state.json with testEmail + testUserId

# 2. Poll pg_net + Supabase until webhook returns 200 and user row exists
node 02-verify-webhook.mjs

# 3. Ask Claude Code to read Gmail and confirm the admin email arrived:
#    "Search for 'from:hello@drafto.eu subject:\"New Drafto signup\" newer_than:5m'"

# 4. Extract the approve URL from that email and open it in the admin's
#    signed-in browser. Claude Code can paste the URL for you; you click.
#    Expected: redirect to /admin?approved=approved, green flash banner.

# 5. Poll the profile row to confirm the flip
node 03-verify-approved.mjs

# 6. Ask Claude Code: "Search Gmail for 'Your Drafto account is approved newer_than:5m'"
#    Must arrive at jakub+<stamp>@anderwald.info

# 7. Cleanup
node 99-cleanup.mjs
```

## Test email addressing

Test emails use the form `jakub+draftoe2e-<timestamp>@anderwald.info`. Gmail-style plus-addressing routes these to `jakub@anderwald.info`'s inbox, so Supabase auth confirmations, the admin notification, and the user-approved email all land where Claude Code can read them via the Gmail MCP tool.

## What each script does

- **`01-signup.mjs`** — Launches headless Chromium, navigates to `https://drafto.eu/signup`, fills `jakub+draftoe2e-<ts>@anderwald.info` + a random password, submits the form via `form.requestSubmit()` (more reliable than button click), captures the Supabase signup response, and saves state to `/tmp/e2e-approval/state.json`.
- **`02-verify-webhook.mjs`** — Polls `auth.users` + `public.profiles` for the new row, then polls `net._http_response` for a 200 response from the webhook. Fails loudly if the response is 307/401/405 or if it doesn't show up within 30s.
- **`03-verify-approved.mjs`** — Polls `profiles.is_approved` until it flips to `true` (fails after 60s if the admin hasn't clicked yet).
- **`99-cleanup.mjs`** — `DELETE FROM auth.users WHERE email LIKE 'jakub+draftoe2e-%@anderwald.info';` — relies on the FK cascade to clean `profiles`.

## Known gotchas (lessons from the first run)

- **Middleware must exempt `/api/webhooks`** or the trigger gets 307 → /login (redirected) → pg_net follows as GET → 405. Verified in prerequisites.
- **Supabase vault secrets can be wiped across sessions** in edge cases (exact cause unknown — possibly a Supabase-internal rekey after migrations). Always run the vault `count(*)` prerequisite check first. Re-insert with `select vault.create_secret(...)` if missing; values are in `~/drafto-secrets/account-approval-secrets.env`.
- **Supabase rate-limits signups to 30 per 5 min per IP**. Don't run this test in a tight loop.
- **The `+` in plus-addressing is valid** — Supabase accepts it, Resend delivers it. Don't be tempted to strip it "just in case".
- **Query the right Supabase project** before asserting DB state. `pnpm supabase:link:prod` returns silently on success; `supabase projects list` shows the `●` marker next to the currently-linked project.

## Failure modes + triage

| Symptom                                               | Check                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `02-verify-webhook.mjs` reports 307/401/405           | Middleware fix rolled back, or `WEBHOOK_SECRET` drifted between Vercel and vault                                                                                 |
| No admin email in Gmail but webhook returned 200      | Resend delivery logs (resend.com → Logs). DKIM/SPF records may have been removed.                                                                                |
| User row created but trigger didn't fire              | `select tgenabled from pg_trigger where tgname = 'on_profile_insert_notify_admin';` — must be `O` (enabled)                                                      |
| Approve link returns `error=invalid_or_expired_token` | `APPROVAL_LINK_SECRET` drifted between the signing deploy and the verifying deploy — happens if someone rotated the secret without also rotating the server side |
| Approve link returns `error=forbidden`                | Admin profile doesn't have `is_admin=true`, or the admin isn't signed in at the moment of click                                                                  |
