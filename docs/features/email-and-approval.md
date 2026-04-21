# Email setup (Resend + drafto.eu)

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
