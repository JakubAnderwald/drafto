# Email and approval

**Status:** shipped **Updated:** 2026-11-08

## What it is

Transactional email delivered through Resend from `hello@drafto.eu`, plus an admin-notification and one-click-approve flow triggered when a new user signs up. The same Resend account powers Supabase auth emails (confirmation, password reset) so signup volume is never throttled by Supabase's built-in 2/hour mailer.

## Current state

Shipped in production. A Postgres `after insert on auth.users` trigger calls `/api/webhooks/new-signup`, which emails all `profiles.is_admin = true` users a "New signup" message containing a signed one-click approve link. Clicking the link hits `/api/admin/approve-user/one-click`, flips `profiles.is_approved`, and sends the new user a "You're approved" email. The approval UI at `/admin` covers the same flow interactively. It also lets an admin permanently delete a pending signup through `/api/admin/delete-user`, which refuses approved users and sends no email. For any account that holds no notes, approved or not, an operator can run `pnpm users:delete` (`scripts/delete-users.mjs`) from an interactive session, and add `--notify` to email each deleted user — see [Deleting accounts from the terminal](#deleting-accounts-from-the-terminal). Platform coverage: the email pipeline is web-only (runs on Vercel); mobile and desktop rely on the same `is_approved` gate and simply see the approval take effect on their next auth check.

## Storage quotas on the admin page

Below the approval list, `/admin` has a **Storage quotas** table of every user (`admin-storage-list.tsx`), filled from the `admin_storage_usage()` RPC called through the admin's own session (it raises `42501` for anyone else). If the RPC fails, the approval list still renders, and the table is replaced by a "could not be loaded" notice, with the error sent to Sentry.

- **Columns.** _User_ (email, looked up with the service-role client, as the approval list does), _Storage used_ (the sum of the user's attachment rows, trashed notes included), and _Quota_, which shows the current value and an editor: a whole number of MB, or an **Unlimited** checkbox, with a **Save** button per row. Saving POSTs `{ userId, quotaMb }` to `/api/admin/storage-quota` (`quotaMb` is a positive integer up to 1,000,000, or `null` for Unlimited). The route updates `profiles.storage_quota_bytes` through the admin's own session, never the service role, so the privilege guard and the "Admins can update all profiles" policy both apply. Success or the error shows inline on the row.
- **Enforced by the database, not the page.** A trigger on `public.attachments` and the attachments bucket's storage policies refuse an upload that would take a user over their quota, on every platform. The page only edits the number. See [ADR 0069](../adr/0069-per-user-attachment-storage-quota.md) and `supabase/migrations/20261108000001_per_user_storage_quota.sql`.
- **Defaults.** New users get 50 MB (`DEFAULT_STORAGE_QUOTA_BYTES` in `packages/shared`). The migration set every existing admin to Unlimited (`NULL`). Promoting someone to admin later does **not** change their quota: they keep 50 MB until an admin ticks Unlimited for them here. The column is the only source of truth.
- Users can't change their own quota: `guard_profile_privilege_columns` now guards `storage_quota_bytes` alongside `is_admin` and `is_approved`.

## Code paths

| Concern                                 | Path                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Resend client wrapper                   | `apps/web/src/lib/email/client.ts`                                       |
| Email templates (new signup, approved)  | `apps/web/src/lib/email/templates.ts`                                    |
| Supabase-triggered signup webhook       | `apps/web/src/app/api/webhooks/new-signup/route.ts`                      |
| Interactive approve API                 | `apps/web/src/app/api/admin/approve-user/route.ts`                       |
| One-click approve (signed link) API     | `apps/web/src/app/api/admin/approve-user/one-click/route.ts`             |
| Interactive delete-pending-user API     | `apps/web/src/app/api/admin/delete-user/route.ts`                        |
| Operator account deletion + email       | `scripts/delete-users.mjs`                                               |
| Signed approval token (HMAC)            | `apps/web/src/lib/approval-tokens.ts`                                    |
| Admin UI                                | `apps/web/src/app/(app)/admin/page.tsx`                                  |
| Admin user list component               | `apps/web/src/app/(app)/admin/admin-user-list.tsx`                       |
| Admin flash message component           | `apps/web/src/app/(app)/admin/admin-flash-message.tsx`                   |
| Admin storage quota editor              | `apps/web/src/app/(app)/admin/admin-storage-list.tsx`                    |
| Admin set-storage-quota API             | `apps/web/src/app/api/admin/storage-quota/route.ts`                      |
| Admin bootstrap migration (first admin) | `supabase/migrations/20260420000001_admin_bootstrap.sql`                 |
| New-signup webhook trigger migration    | `supabase/migrations/20260421000001_new_signup_webhook.sql`              |
| Webhook hardening migration             | `supabase/migrations/20260421000002_new_signup_webhook_harden.sql`       |
| Privilege-column guard (approval/admin) | `supabase/migrations/20260922000001_guard_profile_privilege_columns.sql` |

## Related ADRs

- [0019 — Email Infrastructure and Approval Flow](../adr/0019-email-infrastructure-and-approval-flow.md)
- [0024 — Real-Time Support Agent](../adr/0024-realtime-support-agent.md) — inbound `support@drafto.eu` (independent pipeline, Zoho Mail rather than Resend); see [`docs/features/support-agent.md`](./support-agent.md).
- [0055 — Trigger Guard on Profile Privilege Columns](../adr/0055-profile-privilege-column-guard.md)

## Cross-platform notes

- The entire email + approval pipeline is **web-only** — it runs in Vercel API routes. Mobile and desktop never send email and never receive the admin notification.
- What mobile/desktop do care about is the **result**: `profiles.is_approved` flipping to `true`. Their `AuthProvider` (see `apps/mobile/src/providers/auth-provider.tsx`, `apps/desktop/src/providers/auth-provider.tsx`) re-queries `profiles.is_approved` on app resume and on an explicit "refresh" action, so approval propagates without a code change on those platforms.
- Shared pieces: the `profiles.is_approved` / `profiles.is_admin` columns, the RLS policies, the trigger that guards those two columns, and the admin-bootstrap migration — all defined in `supabase/migrations/` and consumed identically by every client.

## Modifying safely

- **Invariants:**
  - The webhook route at `/api/webhooks/new-signup` must remain public in the middleware allowlist (`apps/web/src/lib/supabase/middleware.ts` → `PUBLIC_ROUTES` includes `/api/webhooks`). Authenticity is enforced by `WEBHOOK_SECRET`, not by Supabase session.
  - One-click approve tokens are short-lived (72h) and signed with `APPROVAL_LINK_SECRET`. Rotating this secret invalidates every outstanding email link — coordinate with any in-flight admin actions.
  - Only an admin or a privileged server-side role can change `profiles.is_approved`, `profiles.is_admin` or `profiles.storage_quota_bytes`. RLS alone does not enforce this: the "Users can update own profile" policy checks row ownership only. The `guard_profile_privilege_columns` trigger (`supabase/migrations/20260922000001_guard_profile_privilege_columns.sql`; `20261108000001_per_user_storage_quota.sql` redefines the function to guard `storage_quota_bytes` too) rejects a change to `is_approved`, `is_admin` or `storage_quota_bytes` from the `authenticated` / `anon` API roles with `42501` (HTTP 403) unless `public.is_admin()` is true. `service_role` and `postgres` are not gated, so both approval routes and the admin bootstrap keep working. The trigger function must stay `SECURITY INVOKER`, or `current_user` becomes the owner and the guard lets everyone through.
  - When there are zero admins in `profiles`, the webhook falls back to `EMAIL_ADMIN_FALLBACK`. Do not remove this fallback without first proving an admin exists in every environment.
- **Tests that will catch regressions:**
  - `apps/web/__tests__/unit/new-signup-webhook.test.ts` — HMAC verification, admin discovery, fallback behavior.
  - `apps/web/__tests__/unit/admin-approve-user.test.ts` — interactive admin approval auth and state transitions.
  - `apps/web/__tests__/unit/admin-delete-user.test.ts` — admin-only deletion of pending signups; approved users are refused (409) and no email is sent.
  - `apps/web/__tests__/unit/admin-storage-quota.test.ts` — the set-quota route: admin-only, `userId` and `quotaMb` validation, MB → bytes, `null` → Unlimited, 404 and 500, and no service-role client.
  - `apps/web/__tests__/integration/admin-storage-list.test.tsx` + `admin-page-storage.test.tsx` — the storage table and its editor, and the admin page loading it next to the approval list (and surviving an RPC failure).
  - `apps/web/e2e/storage-quota.admin.spec.ts` — admin E2E (runs only with the admin E2E variables): a user with a 1 KB quota is refused an upload with the storage-full message, then the admin sees them in the table and sets them to Unlimited.
  - `apps/web/__tests__/unit/approve-user-one-click.test.ts` — signed-link verification and approval flow.
  - `apps/web/__tests__/unit/approval-tokens.test.ts` — HMAC signing, TTL, tamper detection.
  - `scripts/__tests__/profile-privilege-guard.test.mjs` — static check of every migration that defines the guard (runs in CI): the exact condition of the newest definition, the 42501 raise, `SECURITY INVOKER`, that no migration alters, drops or disables it, and migration ordering.
  - `scripts/__tests__/profile-privilege-guard.live.test.mjs` — opt-in check against the **dev** project: a user's own `PATCH` of `is_approved`, `is_admin` or `storage_quota_bytes` gets 403, a `display_name` edit still works, and an admin session and the service role can still approve. Skips unless the dev URL, anon key and service-role key are all set. Run it with `pnpm test:live:supabase -- --only profile-guard`, which sets them from the local key files and fails, rather than skips, when one is missing.
  - `apps/web/__tests__/unit/email-client.test.ts` + `email-templates.test.ts` — Resend transport and template rendering.
  - `scripts/__tests__/delete-users.test.mjs` — the operator deletion script: argument parsing, refusals (admins, accounts with notes, unattended sessions), the storage → auth → verify → email order, and the deletion email.
- **Files that must change together:**
  - Changing the webhook payload shape: update `apps/web/src/app/api/webhooks/new-signup/route.ts` **and** `supabase/migrations/20260421000001_new_signup_webhook.sql` (the trigger builds the body). Add a new migration rather than editing the old one.
  - Adding a new transactional email: update `apps/web/src/lib/email/templates.ts`, add a sender call, and extend `email-templates.test.ts`.
  - Rotating `APPROVAL_LINK_SECRET`, `WEBHOOK_SECRET`, or the Resend API key: follow the [Rotating secrets](#rotating-secrets) section below.

## Verify

```bash
# Web unit + integration (covers webhook, approve-user, approval-tokens, email)
cd apps/web && pnpm test

# Targeted unit tests for this feature
cd apps/web && pnpm test -- new-signup-webhook admin-approve-user admin-delete-user admin-storage-quota admin-storage-list admin-page-storage approve-user-one-click approval-tokens email-client email-templates

# Guard on is_approved / is_admin: static check, then the live check against the DEV project.
# Interactive sessions only. The runner reads the service-role key from
# ~/drafto-secrets/dev-supabase-admin.env (Mac mini) or the DEV: line of
# "supabase service keys.txt", and the anon key from apps/web/.env.local. It refuses
# any other project and fails, rather than skips, when a key is missing.
node --test scripts/__tests__/profile-privilege-guard.test.mjs
pnpm test:live:supabase -- --only profile-guard

# Web E2E (signup + approval happy path)
set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e -- auth

# Manual end-to-end verification steps are in "Verifying the setup end-to-end" below.
```

---

# Email setup (Resend + drafto.eu) — runbook

Drafto sends all outbound email via **Resend** from `hello@drafto.eu`. The same Resend account handles Supabase auth emails (signup confirmation, password reset) _and_ Drafto's own transactional emails (admin signup notifications, user approval confirmations).

See [ADR 0019](../adr/0019-email-infrastructure-and-approval-flow.md) for the rationale.

This document is the operational runbook — follow it top-to-bottom when setting up a new environment, or jump to individual sections when rotating a credential.

---

## Deleting accounts from the terminal

`scripts/delete-users.mjs` permanently deletes accounts by email. It runs the same steps as the app's own account deletion (`apps/web/src/lib/account/delete-user.ts`): a strict sweep of the user's attachment files, then the auth user (which cascades to the profile, notebooks, notes, note history and API keys), a second sweep, and a check that nothing is left.

```bash
# Plan only: prints each user's id and what they own; deletes nothing
pnpm users:delete -- --project prod someone@example.com other@example.com

# Delete, then email each user once their deletion is confirmed
pnpm users:delete -- --project prod --execute --notify [--reason "<one sentence>"] someone@example.com
```

- **Refusals.** It skips admins and any account that owns a note, trashed notes included, and checks again right before the delete in case a note synced in the meantime. The privacy policy ("Account approval") says only that we may delete an unapproved sign-up or an account that holds no notes, so widen the script and the policy together. It refuses to run at all in an unattended session (`DRAFTO_UNATTENDED=1`) or under `node --test`, and the verification lane's guard denies any command naming it.
- **Production.** Running it with `--execute --project prod` is a production database operation: state the project, the accounts and what they own (the plan output) and get an explicit "yes" first.
- **Keys.** The service-role key comes from the `PROD:` / `DEV:` line of `~/drafto-secrets/supabase service keys.txt` (`--keys-txt` to override). With `--notify`, the Resend key comes from `RESEND_API_KEY` in the environment or `~/drafto-secrets/account-approval-secrets.env` (`--resend-env`). Neither is printed.
- **Errors.** An error with one account is logged and the run moves on to the next; check that account by hand before rerunning.
- **Email.** Sent from `hello@drafto.eu` with `support@drafto.eu` as reply-to, only after the deletion check passes. A failed email is reported and makes the run exit 1, but the account stays deleted; send it by hand if needed.
- Apple-linked accounts: unlike in-app deletion, this cannot ask Apple to end Drafto's access to the user's Apple ID, because that needs a fresh authorization code from the user.

## One-time setup

### 1. Verify `drafto.eu` in Resend

1. Log in to [resend.com](https://resend.com) with the `jakub@anderwald.info` account.
2. Domains → Add domain → `drafto.eu`.
3. Add the DNS records Resend provides to the `drafto.eu` zone at your registrar (currently GoDaddy). Resend auto-generates the exact records in the dashboard — copy them verbatim rather than from this doc. They typically include:
   - `TXT resend._domainkey` — DKIM key on the root domain.
   - `TXT send.drafto.eu` — SPF `v=spf1 include:amazonses.com ~all` on the return-path subdomain (Resend uses a `send.` subdomain for bounce isolation).
   - `MX send.drafto.eu` → `feedback-smtp.<region>.amazonses.com` (priority 10) — required for bounce handling.
   - Optional: `TXT _dmarc` — `v=DMARC1; p=quarantine; rua=mailto:jakub@anderwald.info`.
4. Wait for Resend to show "Verified" (usually <30 minutes).

### 2. Generate a Resend API key

- Resend → API Keys → Create API Key.
- Scope: **Sending access** (not full access).
- Copy the key (format `re_...`) — you'll paste it in two places below.

### 3. Configure Supabase Dashboard

Configure auth emails to use Resend so the built-in Supabase mailer is bypassed and the 2/hour rate limit disappears.

- Dashboard → your project → Authentication → **Emails**:
  - Sender email: `hello@drafto.eu`
  - Sender name: `Drafto`
  - SMTP provider settings:
    - Host: `smtp.resend.com`
    - Port: `465`
    - Username: `resend`
    - Password: the Resend API key from step 2.
- Dashboard → Authentication → **Rate Limits**:
  - Set "Rate limit for sending emails" to `60` emails/hour (matches `supabase/config.toml`).

Repeat for both the **prod** (`tbmjbxxseonkciqovnpl`) and **dev** (`huhzactreblzcogqkbsd`) Supabase projects.

### 4. Install the new-signup webhook (via migration + Vault)

The trigger itself ships in `supabase/migrations/20260421000001_new_signup_webhook.sql` — apply it like any other migration. The trigger no-ops on any project where the Vault secrets below aren't set, so it's safe to apply everywhere.

To **activate** the webhook on a project, insert the URL + secret into Supabase Vault (Dashboard → SQL Editor, or `psql`):

```sql
-- Production only (dev stays inert so test signups don't spam the admin):
select vault.create_secret('https://drafto.eu/api/webhooks/new-signup', 'webhook_url');
select vault.create_secret('<WEBHOOK_SECRET value from Vercel>',        'webhook_secret');
```

To rotate either value later, update the existing Vault secret (`select vault.update_secret(id, new_value)`).

### 5. Set Vercel environment variables

Vercel → Project → Settings → Environment Variables. Add these to **Production**, **Preview**, and **Development** scopes:

| Variable               | Value                                                                              | Notes                                                    |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `RESEND_API_KEY`       | `re_...`                                                                           | Same key used in Supabase SMTP.                          |
| `EMAIL_FROM`           | `Drafto <hello@drafto.eu>`                                                         | Sender identity.                                         |
| `EMAIL_ADMIN_FALLBACK` | `jakub@anderwald.info`                                                             | Used only when no `profiles.is_admin = true` rows exist. |
| `APPROVAL_LINK_SECRET` | 32+ random bytes hex                                                               | `openssl rand -hex 32`. Signs one-click approve tokens.  |
| `APP_URL`              | `https://drafto.eu` (prod) / preview URL (preview) / `http://localhost:3000` (dev) | Base for links in emails.                                |
| `WEBHOOK_SECRET`       | matches the value entered in step 4                                                | Verifies incoming Supabase webhook calls.                |

### 6. Bootstrap the first admin

The migration `supabase/migrations/20260420000001_admin_bootstrap.sql` flips `is_admin` and `is_approved` for `jakub@anderwald.info`. It's idempotent — a no-op if already set or if the user doesn't exist yet.

```bash
pnpm supabase:link:dev && pnpm supabase:push
pnpm supabase:link:prod && pnpm supabase:push
```

---

## Verifying the setup end-to-end

1. Sign in at `/login` as the bootstrapped admin (`jakub@anderwald.info`). The "Admin" link should appear in the app menu.
2. Open an incognito tab and sign up a throwaway test email at `/signup`. Land on `/waiting-for-approval`.
3. Check your inbox — you should receive a "New Drafto signup: …" email from `Drafto <hello@drafto.eu>` within ~30 seconds.
4. Click "Approve …" in the email. You should land on `/admin?approved=…` with a success flash. The approved user should receive a "Your Drafto account is approved" email.
5. Back in the incognito tab, refresh — the waiting page should redirect into the app.

---

## Local development

- Resend works from localhost, but the Supabase `pg_net` trigger can't reach localhost directly. For local end-to-end testing of the new-signup webhook, expose your dev server via a tunnel (ngrok, Cloudflare Tunnel, or `vercel dev`) and set the dev project's `webhook_url` Vault secret to that tunnel URL (same `select vault.create_secret(...)` pattern as prod). Remove the secret again when done to keep dev inert.
- For unit tests and simple flows, the webhook is mocked — you don't need a live trigger connection to run `pnpm test`.

---

## Rotating secrets

- **Resend API key**: generate a new key in Resend, paste into Supabase Dashboard SMTP (both projects) _and_ Vercel's `RESEND_API_KEY` env var. Revoke the old key after the next deploy.
- **`WEBHOOK_SECRET`**: update the matching Supabase Vault secret **and** Vercel env var in lockstep. In the prod Supabase SQL Editor run `select vault.update_secret((select id from vault.secrets where name = 'webhook_secret'), '<new-value>');`, then update Vercel's `WEBHOOK_SECRET`. Between the two updates, webhook calls will 401 — briefly silencing signup notifications.
- **`APPROVAL_LINK_SECRET`**: rotating invalidates all outstanding one-click approval emails. Tell any in-flight admins to use the `/admin` page instead until new emails arrive.
