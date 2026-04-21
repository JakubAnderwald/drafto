interface NewSignupAdminEmailInput {
  userEmail: string;
  userDisplayName: string | null;
  signupAt: Date;
  approveUrl: string;
  adminUrl: string;
}

interface UserApprovedEmailInput {
  displayName: string | null;
  loginUrl: string;
}

interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

// Inline palette for transactional emails. Values mirror the tokens defined in
// apps/web/src/app/globals.css (warm neutrals + primary indigo). HTML email
// clients strip <style> tags and cannot resolve CSS variables, so these must
// be kept in sync with globals.css manually. See ADR 0020.
const EMAIL_COLORS = {
  primary: "#3525cd", // --color-primary-600
  fg: "#1f1b17", // --color-neutral-900
  fgMuted: "#6b6360", // --color-neutral-500
  fgSubtle: "#9c9590", // --color-neutral-400
  bg: "#fff8f5", // --color-neutral-50
  bgSubtle: "#fcf2eb", // --color-neutral-100
  border: "#eae1da", // --color-neutral-300
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizePlaintext(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

const baseStyles = `
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: ${EMAIL_COLORS.fg};
  line-height: 1.5;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`;

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

function renderEmailLayout(args: { title: string; bodyHtml: string }): string {
  const { title, bodyHtml } = args;
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${EMAIL_COLORS.bg};">
    <div style="${baseStyles}">
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:${EMAIL_COLORS.fg};">${title}</h1>
      ${bodyHtml}
      <hr style="margin:32px 0 16px;border:0;border-top:1px solid ${EMAIL_COLORS.border};" />
      <p style="margin:0;font-size:12px;color:${EMAIL_COLORS.fgSubtle};">Drafto · <a href="https://drafto.eu" style="color:${EMAIL_COLORS.fgMuted};">drafto.eu</a></p>
    </div>
  </body>
</html>`;
}

export function newSignupAdminEmail(input: NewSignupAdminEmailInput): EmailContent {
  const { userEmail, userDisplayName, signupAt, approveUrl, adminUrl } = input;
  const plainEmail = sanitizePlaintext(userEmail);
  const plainName = userDisplayName ? sanitizePlaintext(userDisplayName) : null;
  const safeEmail = escapeHtml(plainEmail);
  const safeName = plainName ? escapeHtml(plainName) : null;
  const signupAtFormatted = signupAt.toUTCString();

  const bodyHtml = `
      <p style="margin:0 0 8px;color:${EMAIL_COLORS.fgMuted};">Someone just signed up and is waiting for your approval.</p>
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
      <p style="margin:0 0 24px;">
        <a href="${approveUrl}" style="${primaryButtonStyles}">Approve ${safeEmail}</a>
      </p>
      <p style="margin:0 0 8px;">
        <a href="${adminUrl}" style="${secondaryLinkStyles}">Review all pending signups</a>
      </p>
      <p style="margin:32px 0 0;color:${EMAIL_COLORS.fgSubtle};font-size:12px;">
        This one-click approval link expires in 72 hours. You must be signed in to Drafto as an admin for it to work.
      </p>`;

  const html = renderEmailLayout({ title: "New Drafto signup", bodyHtml });

  const text = [
    "New Drafto signup",
    "",
    `Email: ${plainEmail}`,
    plainName ? `Name: ${plainName}` : null,
    `Signed up: ${signupAtFormatted}`,
    "",
    `Approve this user: ${approveUrl}`,
    `Review all pending signups: ${adminUrl}`,
    "",
    "The approve link expires in 72 hours. You must be signed in to Drafto as an admin.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    subject: `New Drafto signup: ${userEmail}`,
    html,
    text,
  };
}

export function userApprovedEmail(input: UserApprovedEmailInput): EmailContent {
  const { displayName, loginUrl } = input;
  const plainName = displayName ? sanitizePlaintext(displayName) : null;
  const greetingName = plainName ? escapeHtml(plainName) : "there";

  const bodyHtml = `
      <p style="margin:0 0 16px;">Hi ${greetingName},</p>
      <p style="margin:0 0 16px;">
        Your Drafto account has been approved. You can sign in now and start taking notes.
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
    "Your Drafto account has been approved. Sign in and start taking notes:",
    loginUrl,
    "",
    "Drafto runs on the web, iOS, Android, and macOS — sign in with the same account from any platform.",
  ].join("\n");

  return {
    subject: "Your Drafto account is approved",
    html,
    text,
  };
}
