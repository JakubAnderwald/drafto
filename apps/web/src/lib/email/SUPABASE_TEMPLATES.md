# Supabase Auth Email Templates — Branding Runbook

The Supabase Auth email templates (Confirm signup, Reset password, Magic link, Reauthentication) live in the Supabase Dashboard and are **not** checked into this repository. They therefore cannot be updated via a PR. This file is the canonical runbook for keeping them visually consistent with Drafto's code-rendered transactional emails (`apps/web/src/lib/email/templates.ts`).

See [ADR 0020 — Email Design Tokens](../../../../../docs/adr/0020-email-design-tokens.md) for rationale.

## Which templates need Drafto branding

Supabase Auth fires these four templates when users take the corresponding auth action:

1. **Confirm signup** — sent after a new email+password signup (sign-up confirmation link).
2. **Reset password** — sent when a user requests a password reset.
3. **Magic link** — sent when a user requests a passwordless sign-in link.
4. **Reauthentication** — sent when Supabase needs to verify an in-session identity (e.g. sensitive setting changes).

Each template supports `{{ .ConfirmationURL }}`, `{{ .Token }}`, `{{ .TokenHash }}`, `{{ .Email }}`, and `{{ .SiteURL }}` variables depending on the type.

## Canonical palette (copy into each template)

These hex values mirror `EMAIL_COLORS` in `templates.ts`. Do **not** invent new shades in the dashboard.

| Role       | Hex       | Use for                                  |
| ---------- | --------- | ---------------------------------------- |
| Primary    | `#3525cd` | Button background, link color            |
| Foreground | `#1f1b17` | Body text                                |
| FG muted   | `#6b6360` | Muted body copy, footer link color       |
| FG subtle  | `#9c9590` | Smallest secondary text (footer caption) |
| Background | `#fff8f5` | Body/page background                     |
| BG subtle  | `#fcf2eb` | Tables, highlighted callouts             |
| Border     | `#eae1da` | Horizontal rules, table borders          |

## Step-by-step application

Perform these steps **on dev first**, verify by triggering the relevant auth flow, then repeat on prod only after explicit user confirmation.

1. Open the Supabase Dashboard.
2. Select the project:
   - **Development** — ref `huhzactreblzcogqkbsd` (`drafto-dev`)
   - **Production** — ref `tbmjbxxseonkciqovnpl` (`drafto.eu`)
3. Navigate to **Authentication → Emails → Templates** (URL: `https://supabase.com/dashboard/project/<ref>/auth/templates`).
4. For each of the four template types (Confirm signup, Reset password, Magic link, Reauthentication):
   - Click the template.
   - Replace the HTML body with the corresponding paste-block below.
   - Leave the **Subject** line intact (or align it with the subject defaults below).
   - Click **Save template**.
5. Verify:
   - **Dev**: sign up a throwaway account; trigger password reset; trigger magic link; trigger reauthentication. Confirm each email renders with the Drafto palette.
   - **Prod**: only after user confirmation, repeat using a test account.

## Paste blocks

Each block is self-contained HTML with inline styles mirroring the code templates. Titles, body copy, and CTAs are already filled in — adjust wording to taste.

### Confirm signup

**Subject**: `Confirm your Drafto account`

```html
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fff8f5;">
    <div
      style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1b17;line-height:1.5;max-width:560px;margin:0 auto;padding:32px 24px;"
    >
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#1f1b17;">
        Confirm your Drafto account
      </h1>
      <p style="margin:0 0 16px;">
        Tap the button below to confirm your email address and finish setting up your Drafto
        account.
      </p>
      <p style="margin:24px 0;">
        <a
          href="{{ .ConfirmationURL }}"
          style="display:inline-block;background:#3525cd;color:#ffffff !important;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:16px;"
          >Confirm email</a
        >
      </p>
      <p style="margin:0 0 8px;color:#6b6360;font-size:14px;">
        Or copy this link into your browser:
      </p>
      <p style="margin:0 0 16px;word-break:break-all;color:#3525cd;font-size:14px;">
        {{ .ConfirmationURL }}
      </p>
      <hr style="margin:32px 0 16px;border:0;border-top:1px solid #eae1da;" />
      <p style="margin:0;font-size:12px;color:#9c9590;">
        Drafto · <a href="https://drafto.eu" style="color:#6b6360;">drafto.eu</a>
      </p>
    </div>
  </body>
</html>
```

### Reset password

**Subject**: `Reset your Drafto password`

```html
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fff8f5;">
    <div
      style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1b17;line-height:1.5;max-width:560px;margin:0 auto;padding:32px 24px;"
    >
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#1f1b17;">
        Reset your Drafto password
      </h1>
      <p style="margin:0 0 16px;">
        We received a request to reset the password for your Drafto account. If this was you, tap
        the button below to choose a new one.
      </p>
      <p style="margin:24px 0;">
        <a
          href="{{ .ConfirmationURL }}"
          style="display:inline-block;background:#3525cd;color:#ffffff !important;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:16px;"
          >Reset password</a
        >
      </p>
      <p style="margin:0 0 8px;color:#6b6360;font-size:14px;">
        If you didn't request a reset, you can safely ignore this email — your password will not
        change.
      </p>
      <hr style="margin:32px 0 16px;border:0;border-top:1px solid #eae1da;" />
      <p style="margin:0;font-size:12px;color:#9c9590;">
        Drafto · <a href="https://drafto.eu" style="color:#6b6360;">drafto.eu</a>
      </p>
    </div>
  </body>
</html>
```

### Magic link

**Subject**: `Your Drafto sign-in link`

```html
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fff8f5;">
    <div
      style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1b17;line-height:1.5;max-width:560px;margin:0 auto;padding:32px 24px;"
    >
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#1f1b17;">
        Sign in to Drafto
      </h1>
      <p style="margin:0 0 16px;">
        Use the button below to sign in to Drafto. This link is single-use and expires shortly.
      </p>
      <p style="margin:24px 0;">
        <a
          href="{{ .ConfirmationURL }}"
          style="display:inline-block;background:#3525cd;color:#ffffff !important;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:16px;"
          >Sign in</a
        >
      </p>
      <p style="margin:0 0 8px;color:#6b6360;font-size:14px;">
        Or enter this code: <strong style="color:#1f1b17;">{{ .Token }}</strong>
      </p>
      <hr style="margin:32px 0 16px;border:0;border-top:1px solid #eae1da;" />
      <p style="margin:0;font-size:12px;color:#9c9590;">
        Drafto · <a href="https://drafto.eu" style="color:#6b6360;">drafto.eu</a>
      </p>
    </div>
  </body>
</html>
```

### Reauthentication

**Subject**: `Confirm your Drafto identity`

```html
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fff8f5;">
    <div
      style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1b17;line-height:1.5;max-width:560px;margin:0 auto;padding:32px 24px;"
    >
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#1f1b17;">
        Confirm your identity
      </h1>
      <p style="margin:0 0 16px;">
        For a sensitive change on your Drafto account we need to reconfirm it's you. Enter this code
        in the browser window that prompted you:
      </p>
      <p
        style="margin:24px 0;font-size:24px;font-weight:700;letter-spacing:2px;color:#1f1b17;background:#fcf2eb;border:1px solid #eae1da;border-radius:8px;padding:16px 20px;display:inline-block;"
      >
        {{ .Token }}
      </p>
      <p style="margin:16px 0 0;color:#6b6360;font-size:14px;">
        If you did not request this, you can safely ignore the email and no change will be made.
      </p>
      <hr style="margin:32px 0 16px;border:0;border-top:1px solid #eae1da;" />
      <p style="margin:0;font-size:12px;color:#9c9590;">
        Drafto · <a href="https://drafto.eu" style="color:#6b6360;">drafto.eu</a>
      </p>
    </div>
  </body>
</html>
```

## Final note

**Apply to dev first, verify, then require explicit user confirmation before applying to prod.** Supabase email templates affect real user flows and are not versioned by this repository — a bad change cannot be rolled back via `git revert`.
