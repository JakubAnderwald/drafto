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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const baseStyles = `
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #18181b;
  line-height: 1.5;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`;

const primaryButtonStyles = `
  display: inline-block;
  background: #2563eb;
  color: #ffffff !important;
  text-decoration: none;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 16px;
`;

const secondaryLinkStyles = `
  display: inline-block;
  color: #2563eb;
  text-decoration: underline;
  font-size: 14px;
`;

export function newSignupAdminEmail(input: NewSignupAdminEmailInput): EmailContent {
  const { userEmail, userDisplayName, signupAt, approveUrl, adminUrl } = input;
  const safeEmail = escapeHtml(userEmail);
  const safeName = userDisplayName ? escapeHtml(userDisplayName) : null;
  const signupAtFormatted = signupAt.toUTCString();

  const html = `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;">
    <div style="${baseStyles}">
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;">New Drafto signup</h1>
      <p style="margin:0 0 8px;color:#52525b;">Someone just signed up and is waiting for your approval.</p>
      <table role="presentation" style="margin:24px 0;border-collapse:collapse;width:100%;background:#fafafa;border-radius:8px;">
        <tr>
          <td style="padding:12px 16px;color:#71717a;font-size:14px;">Email</td>
          <td style="padding:12px 16px;font-weight:600;">${safeEmail}</td>
        </tr>
        ${
          safeName
            ? `<tr>
          <td style="padding:12px 16px;color:#71717a;font-size:14px;border-top:1px solid #e4e4e7;">Name</td>
          <td style="padding:12px 16px;border-top:1px solid #e4e4e7;">${safeName}</td>
        </tr>`
            : ""
        }
        <tr>
          <td style="padding:12px 16px;color:#71717a;font-size:14px;border-top:1px solid #e4e4e7;">Signed up</td>
          <td style="padding:12px 16px;border-top:1px solid #e4e4e7;">${signupAtFormatted}</td>
        </tr>
      </table>
      <p style="margin:0 0 24px;">
        <a href="${approveUrl}" style="${primaryButtonStyles}">Approve ${safeEmail}</a>
      </p>
      <p style="margin:0 0 8px;">
        <a href="${adminUrl}" style="${secondaryLinkStyles}">Review all pending signups</a>
      </p>
      <p style="margin:32px 0 0;color:#a1a1aa;font-size:12px;">
        This one-click approval link expires in 72 hours. You must be signed in to Drafto as an admin for it to work.
      </p>
    </div>
  </body>
</html>`;

  const text = [
    "New Drafto signup",
    "",
    `Email: ${userEmail}`,
    safeName ? `Name: ${userDisplayName}` : null,
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
  const greetingName = displayName ? escapeHtml(displayName) : "there";

  const html = `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;">
    <div style="${baseStyles}">
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;">You&rsquo;re in 🎉</h1>
      <p style="margin:0 0 16px;">Hi ${greetingName},</p>
      <p style="margin:0 0 16px;">
        Your Drafto account has been approved. You can sign in now and start taking notes.
      </p>
      <p style="margin:24px 0;">
        <a href="${loginUrl}" style="${primaryButtonStyles}">Open Drafto</a>
      </p>
      <p style="margin:32px 0 0;color:#a1a1aa;font-size:12px;">
        Drafto runs on the web (drafto.eu), iOS, Android, and macOS. Download the app from the App Store or Google Play with the same account.
      </p>
    </div>
  </body>
</html>`;

  const text = [
    `Hi ${displayName ?? "there"},`,
    "",
    "Your Drafto account has been approved. Sign in and start taking notes:",
    loginUrl,
    "",
    "Drafto runs on the web, iOS, Android, and macOS \u2014 sign in with the same account from any platform.",
  ].join("\n");

  return {
    subject: "Your Drafto account is approved",
    html,
    text,
  };
}
