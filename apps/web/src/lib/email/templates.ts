import { EMAIL_COLORS, escapeHtml, renderEmailLayout, type EmailContent } from "@/lib/email/layout";

interface NewSignupAdminEmailInput {
  userEmail: string;
  userDisplayName: string | null;
  signupAt: Date;
  adminUrl: string;
}

interface AccountActiveEmailInput {
  displayName: string | null;
  loginUrl: string;
}

function sanitizePlaintext(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

const primaryButtonStyles = `
  display: inline-block;
  background: ${EMAIL_COLORS.primary};
  color: #ffffff !important;
  text-decoration: none;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 16px;
`;

const secondaryLinkStyles = `
  display: inline-block;
  color: ${EMAIL_COLORS.primary};
  text-decoration: underline;
  font-size: 14px;
`;

/**
 * The notice every admin gets for a new signup. Since ADR 0094 the account is active from
 * the start, so the email only says who signed up and where to suspend them if needed.
 */
export function newSignupAdminEmail(input: NewSignupAdminEmailInput): EmailContent {
  const { userEmail, userDisplayName, signupAt, adminUrl } = input;
  const plainEmail = sanitizePlaintext(userEmail);
  const plainName = userDisplayName ? sanitizePlaintext(userDisplayName) : null;
  const safeEmail = escapeHtml(plainEmail);
  const safeName = plainName ? escapeHtml(plainName) : null;
  const signupAtFormatted = signupAt.toUTCString();

  const bodyHtml = `
      <p style="margin:0 0 8px;color:${EMAIL_COLORS.fgMuted};">Someone just signed up. Their account is already active.</p>
      <table role="presentation" style="margin:24px 0;border-collapse:collapse;width:100%;background:${EMAIL_COLORS.bgSubtle};border-radius:8px;">
        <tr>
          <td style="padding:12px 16px;color:${EMAIL_COLORS.fgMuted};font-size:14px;">Email</td>
          <td style="padding:12px 16px;font-weight:600;">${safeEmail}</td>
        </tr>
        ${
          safeName
            ? `<tr>
          <td style="padding:12px 16px;color:${EMAIL_COLORS.fgMuted};font-size:14px;border-top:1px solid ${EMAIL_COLORS.border};">Name</td>
          <td style="padding:12px 16px;border-top:1px solid ${EMAIL_COLORS.border};">${safeName}</td>
        </tr>`
            : ""
        }
        <tr>
          <td style="padding:12px 16px;color:${EMAIL_COLORS.fgMuted};font-size:14px;border-top:1px solid ${EMAIL_COLORS.border};">Signed up</td>
          <td style="padding:12px 16px;border-top:1px solid ${EMAIL_COLORS.border};">${signupAtFormatted}</td>
        </tr>
      </table>
      <p style="margin:0 0 8px;">
        <a href="${adminUrl}" style="${secondaryLinkStyles}">Open the admin page</a>
      </p>
      <p style="margin:32px 0 0;color:${EMAIL_COLORS.fgSubtle};font-size:12px;">
        Nothing to do unless this signup looks like spam or abuse. Then suspend it on the admin page: that locks the account out of its data until you reactivate it.
      </p>`;

  const html = renderEmailLayout({ title: "New Drafto signup", bodyHtml });

  const text = [
    "New Drafto signup",
    "",
    "Someone just signed up. Their account is already active.",
    "",
    `Email: ${plainEmail}`,
    plainName ? `Name: ${plainName}` : null,
    `Signed up: ${signupAtFormatted}`,
    "",
    `Admin page: ${adminUrl}`,
    "",
    "Nothing to do unless this signup looks like spam or abuse. Then suspend it on the admin page.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    subject: `New Drafto signup: ${userEmail}`,
    html,
    text,
  };
}

/**
 * Sent when an admin activates an account: a signup still pending from before open signup
 * (ADR 0094), or a suspended account being reactivated.
 */
export function accountActiveEmail(input: AccountActiveEmailInput): EmailContent {
  const { displayName, loginUrl } = input;
  const plainName = displayName ? sanitizePlaintext(displayName) : null;
  const greetingName = plainName ? escapeHtml(plainName) : "there";

  const bodyHtml = `
      <p style="margin:0 0 16px;">Hi ${greetingName},</p>
      <p style="margin:0 0 16px;">
        Your Drafto account is active. You can sign in now and pick up your notes.
      </p>
      <p style="margin:24px 0;">
        <a href="${loginUrl}" style="${primaryButtonStyles}">Open Drafto</a>
      </p>
      <p style="margin:32px 0 0;color:${EMAIL_COLORS.fgSubtle};font-size:12px;">
        Drafto runs on the web (drafto.eu), iOS, Android, and macOS. Download the app from the App Store or Google Play with the same account.
      </p>`;

  const html = renderEmailLayout({ title: "You&rsquo;re in 🎉", bodyHtml });

  const text = [
    `Hi ${plainName ?? "there"},`,
    "",
    "Your Drafto account is active. Sign in and pick up your notes:",
    loginUrl,
    "",
    "Drafto runs on the web, iOS, Android, and macOS — sign in with the same account from any platform.",
  ].join("\n");

  return {
    subject: "Your Drafto account is active",
    html,
    text,
  };
}
