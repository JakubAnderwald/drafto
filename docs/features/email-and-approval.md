# Email and approval

**Status:** shipped **Updated:** 2026-04-21

## What it is

Transactional email delivered through Resend from `hello@drafto.eu`, plus an admin-notification and one-click-approve flow triggered when a new user signs up. The same Resend account powers Supabase auth emails (confirmation, password reset) so signup volume is never throttled by Supabase's built-in 2/hour mailer.

## Current state

Shipped in production. A Postgres `after insert on auth.users` trigger calls `/api/webhooks/new-signup`, which emails all `profiles.is_admin = true` users a "New signup" message containing a signed one-click approve link. Clicking the link hits `/api/admin/approve-user/one-click`, flips `profiles.is_approved`, and sends the new user a "You're approved" email. The approval UI at `/admin` covers the same flow interactively. Platform coverage: the email pipeline is web-only (runs on Vercel); mobile and desktop rely on the same `is_approved` gate and simply see the approval take effect on their next auth check.

## Code paths

| Concern                                 | Path                                                               |
| --------------------------------------- | ------------------------------------------------------------------ |
| Resend client wrapper                   | `apps/web/src/lib/email/client.ts`                                 |
| Email templates (new signup, approved)  | `apps/web/src/lib/email/templates.ts`                              |
| Supabase-triggered signup webhook       | `apps/web/src/app/api/webhooks/new-signup/route.ts`                |
| Interactive approve API                 | `apps/web/src/app/api/admin/approve-user/route.ts`                 |
| One-click approve (signed link) API     | `apps/web/src/app/api/admin/approve-user/one-click/route.ts`       |
| Signed approval token (HMAC)            | `apps/web/src/lib/approval-tokens.ts`                              |
| Admin UI                                | `apps/web/src/app/(app)/admin/page.tsx`                            |
| Admin user list component               | `apps/web/src/app/(app)/admin/admin-user-list.tsx`                 |
| Admin flash message component           | `apps/web/src/app/(app)/admin/admin-flash-message.tsx`             |
| Admin bootstrap migration (first admin) | `supabase/migrations/20260420000001_admin_bootstrap.sql`           |
| New-signup webhook trigger migration    | `supabase/migrations/20260421000001_new_signup_webhook.sql`        |
| Webhook hardening migration             | `supabase/migrations/20260421000002_new_signup_webhook_harden.sql` |

## Related ADRs

- [0019 — Email Infrastructure and Approval Flow](../adr/0019-email-infrastructure-and-approval-flow.md)
- [0024 — Real-Time Support Agent](../adr/0024-realtime-support-agent.md) — inbound `support@drafto.eu` (independent pipeline, Zoho Mail rather than Resend); see [`docs/features/support-agent.md`](./support-agent.md).

## Cross-platform notes

- The entire email + approval pipeline is **web-only** — it runs in Vercel API routes. Mobile and desktop never send email and never receive the admin notification.
- What mobile/desktop do care about is the **result**: `profiles.is_approved` flipping to `true`. Their `AuthProvider` (see `apps/mobile/src/providers/auth-provider.tsx`, `apps/desktop/src/providers/auth-provider.tsx`) re-queries `profiles.is_approved` on app resume and on an explicit "refresh" action, so approval propagates without a code change on those platforms.
- Shared pieces: the `profiles.is_approved` / `profiles.is_admin` columns, the RLS policies, and the admin-bootstrap migration — all defined in `supabase/migrations/` and consumed identically by every client.

## Modifying safely

- **Invariants:**
  - The webhook route at `/api/webhooks/new-signup` must remain public in the middleware allowlist (`apps/web/src/lib/supabase/middleware.ts` → `PUBLIC_ROUTES` includes `/api/webhooks`). Authenticity is enforced by `WEBHOOK_SECRET`, not by Supabase session.
  - One-click approve tokens are short-lived (72h) and signed with `APPROVAL_LINK_SECRET`. Rotating this secret invalidates every outstanding email link — coordinate with any in-flight admin actions.
  - Only service-role code should flip `profiles.is_approved`. RLS blocks direct user writes to that column.
  - When there are zero admins in `profiles`, the webhook falls back to `EMAIL_ADMIN_FALLBACK`. Do not remove this fallback without first proving an admin exists in every environment.
- **Tests that will catch regressions:**
  - `apps/web/__tests__/unit/new-signup-webhook.test.ts` — HMAC verification, admin discovery, fallback behavior.
  - `apps/web/__tests__/unit/admin-approve-user.test.ts` — interactive admin approval auth and state transitions.
  - `apps/web/__tests__/unit/approve-user-one-click.test.ts` — signed-link verification and approval flow.
  - `apps/web/__tests__/unit/approval-tokens.test.ts` — HMAC signing, TTL, tamper detection.
  - `apps/web/__tests__/unit/email-client.test.ts` + `email-templates.test.ts` — Resend transport and template rendering.
- **Files that must change together:**
  - Changing the webhook payload shape: update `apps/web/src/app/api/webhooks/new-signup/route.ts` **and** `supabase/migrations/20260421000001_new_signup_webhook.sql` (the trigger builds the body). Add a new migration rather than editing the old one.
  - Adding a new transactional email: update `apps/web/src/lib/email/templates.ts`, add a sender call, and extend `email-templates.test.ts`.
  - Rotating `APPROVAL_LINK_SECRET`, `WEBHOOK_SECRET`, or the Resend API key: follow the [Rotating secrets](#rotating-secrets) section below.

## Verify

```bash
# Web unit + integration (covers webhook, approve-user, approval-tokens, email)
cd apps/web && pnpm test

# Targeted unit tests for this feature
cd apps/web && pnpm test -- new-signup-webhook admin-approve-user approve-user-one-click approval-tokens email-client email-templates

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
