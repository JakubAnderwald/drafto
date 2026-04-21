# 0019 — Email Infrastructure and Account Approval Flow

- **Status**: Accepted
- **Date**: 2026-04-20
- **Authors**: Jakub Anderwald

## Context

Drafto is invite-only: new signups land on `/waiting-for-approval` and an admin must flip `profiles.is_approved`. Before this decision, the flow was passive — the admin had no notification when someone signed up, users had no visibility into approval progress, and one-click approval from an email didn't exist.

Additionally, the production Supabase project had no custom SMTP configured. Auth emails (confirm-signup, password reset) ran on Supabase's default mailer with a 2/hour rate limit, and we had no way to send our own transactional emails at all.

## Decision

### 1. Email infrastructure: Resend on drafto.eu

- Send all outbound email (auth + transactional) via **Resend** on the free tier (3k/month, 100/day). Resend is the default because it has (a) an SMTP interface that plugs into Supabase Dashboard's custom-SMTP slot, and (b) a Node SDK suitable for our Next.js API routes.
- Emails are sent from `hello@drafto.eu`. Replies route to the admin inbox for the small-team stage.
- Domain verified in Resend via DNS records on drafto.eu (DKIM + SPF via `amazonses.com` include).
- Supabase Dashboard → Authentication → Emails is configured with the Resend SMTP host/user/password, which routes _all_ Supabase auth emails through the same domain.
- Rate limit `auth.rate_limit.email_sent` raised from 2 to 60 per hour to match expected flow.

### 2. Notification trigger: Supabase Database Webhook

- On INSERT into `public.profiles`, Supabase fires a webhook to `POST /api/webhooks/new-signup`.
- The webhook handler verifies a shared `x-webhook-secret` header (`env.WEBHOOK_SECRET`), looks up the auth user's email via the service-role client, resolves admin recipients (`profiles.is_admin = true` joined to `auth.users.email`), and sends the notification email.
- Falls back to `env.EMAIL_ADMIN_FALLBACK` if no admin profile exists (bootstrap case).

### 3. One-click approve via signed token

- The admin notification email contains a "Approve [email]" button linking to `GET /api/admin/approve-user/one-click?token=...`.
- Tokens are HMAC-SHA256 signed with `env.APPROVAL_LINK_SECRET`, encoded as `v1.<userId>.<expiresAt>.<signature>`, and expire after 72 hours.
- The endpoint verifies the token **and** requires an authenticated admin session (defense-in-depth). A leaked email alone cannot approve.
- On success, the endpoint redirects to `/admin?approved=<email>` where a flash message confirms the action.

### 4. User-facing "you're in" email

- Both the one-click endpoint and the existing `POST /api/admin/approve-user` handler send a `userApprovedEmail` to the newly-approved user after the DB update. Sends are fire-and-forget — a Resend outage does not fail approval.

### 5. Admin identity

- Admin status is stored in `profiles.is_admin`. A new migration (`20260420000001_admin_bootstrap.sql`) flips this for `jakub@anderwald.info` so the system has at least one admin out of the box.

## Consequences

**Positive**

- New signups get admin attention within minutes, not days.
- Users receive explicit confirmation instead of polling the waiting page.
- One-click approval keeps the admin loop tight without opening a browser tab first.
- Supabase auth emails no longer throttle at 2/hour.
- Email domain matches the product domain (drafto.eu), boosting trust and deliverability.

**Negative**

- Two new secrets to manage (`WEBHOOK_SECRET`, `APPROVAL_LINK_SECRET`) plus the Resend API key, across Vercel + Supabase Dashboard.
- Manual setup steps outside the repo (DNS records, Supabase Dashboard SMTP, Supabase Database Webhook configuration) — documented in `docs/email-setup.md`.
- Best-effort email sending means a Resend outage silently drops notifications (Sentry-logged). Acceptable for approval notifications; would not be acceptable for payment receipts or similar.

**Neutral**

- Tight coupling of signup → email notification at the DB-webhook layer. If we ever replace Supabase auth, we'd rewire this trigger.

## Alternatives Considered

- **Supabase default mailer only** — not viable. Only sends auth-triggered emails; no API for arbitrary transactional mail.
- **`pg_net` + Postgres trigger** — would let us call Resend directly from the DB. Rejected because it couples Postgres to an external HTTP API and makes local development awkward (pg_net not available in the local Supabase stack without extra setup).
- **Client-side "notify admin" call after signup** — unreliable; the client might navigate away before the request completes. Server-side trigger is more robust.
- **Supabase Auth Hook (`send-email` hook)** — designed for customizing auth emails (confirm/recovery), not for side-effects like "notify a different user on signup."
- **Postmark / SES / Mailgun** — all viable. Resend chosen for the best Next.js DX and a generous free tier that fits Drafto's scale.
- **Token-only approve (no session check)** — simpler, but a leaked email becomes an approval bomb. Requiring an admin session is a negligible UX cost and a meaningful security win.

## Related

- `apps/web/src/lib/email/client.ts` — Resend wrapper
- `apps/web/src/lib/email/templates.ts` — email HTML/text templates
- `apps/web/src/lib/approval-tokens.ts` — HMAC signed tokens
- `apps/web/src/app/api/webhooks/new-signup/route.ts` — admin notification
- `apps/web/src/app/api/admin/approve-user/one-click/route.ts` — one-click approve
- `supabase/migrations/20260420000001_admin_bootstrap.sql`
- `docs/email-setup.md` — operational runbook
