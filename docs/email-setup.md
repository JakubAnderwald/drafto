# Email setup (Resend + drafto.eu)

Drafto sends all outbound email via **Resend** from `hello@drafto.eu`. The same Resend account handles Supabase auth emails (signup confirmation, password reset) _and_ Drafto's own transactional emails (admin signup notifications, user approval confirmations).

See [ADR 0019](./adr/0019-email-infrastructure-and-approval-flow.md) for the rationale.

This document is the operational runbook — follow it top-to-bottom when setting up a new environment, or jump to individual sections when rotating a credential.

---

## One-time setup

### 1. Verify `drafto.eu` in Resend

1. Log in to [resend.com](https://resend.com) with the `jakub@anderwald.info` account.
2. Domains → Add domain → `drafto.eu`.
3. Add the DNS records Resend provides to the `drafto.eu` zone at your registrar (currently GoDaddy). Typically:
   - `TXT resend._domainkey` — DKIM key (1 record).
   - `TXT @` — SPF record `v=spf1 include:amazonses.com ~all`. If another SPF record already exists, merge includes rather than adding a second TXT.
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

### 4. Configure the Supabase Database Webhook

This is what fires the admin notification when a new user signs up.

- Dashboard → Database → **Webhooks** → Create a new webhook:
  - Name: `notify-admin-new-signup`
  - Table: `public.profiles`
  - Events: `INSERT`
  - Type: `HTTP Request`
  - Method: `POST`
  - URL: `https://drafto.eu/api/webhooks/new-signup` (dev project uses the preview URL or localhost tunnel)
  - HTTP headers: add a `x-webhook-secret` header with a 24+ character random value. Save this value — you need it in the Vercel env var step.

Configure on both dev and prod Supabase projects.

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

- Resend works from localhost, but the Supabase Database Webhook can't reach localhost directly. For local end-to-end testing of the new-signup webhook, expose your dev server via a tunnel (ngrok, Cloudflare Tunnel, or Vercel's `vercel dev`) and point the **dev** Supabase webhook at that URL.
- For unit tests and simple flows, the webhook is mocked — you don't need a live webhook connection to run `pnpm test`.

---

## Rotating secrets

- **Resend API key**: generate a new key in Resend, paste into Supabase Dashboard SMTP (both projects) _and_ Vercel's `RESEND_API_KEY` env var. Revoke the old key after the next deploy.
- **`WEBHOOK_SECRET`**: update both the Supabase webhook header and Vercel env var in lockstep. Between the two updates, webhook calls will 401 — briefly silencing signup notifications.
- **`APPROVAL_LINK_SECRET`**: rotating invalidates all outstanding one-click approval emails. Tell any in-flight admins to use the `/admin` page instead until new emails arrive.
