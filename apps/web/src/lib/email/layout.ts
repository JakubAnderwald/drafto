/**
 * The shared frame of every transactional email: palette, escaping and layout.
 */

/** What an email template returns: the subject plus an HTML body and its text alternative. */
export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

// Inline palette for transactional emails. Values mirror the tokens defined in
// apps/web/src/app/globals.css (warm neutrals + primary indigo). HTML email
// clients strip <style> tags and cannot resolve CSS variables, so these must
// be kept in sync with globals.css manually. See ADR 0020.
export const EMAIL_COLORS = {
  primary: "#3525cd", // --color-primary-600
  fg: "#1f1b17", // --color-neutral-900
  fgMuted: "#6b6360", // --color-neutral-500
  fgSubtle: "#9c9590", // --color-neutral-400
  bg: "#fff8f5", // --color-neutral-50
  bgSubtle: "#fcf2eb", // --color-neutral-100
  border: "#eae1da", // --color-neutral-300
  warningBg: "#fff4e0", // --warning-bg (light)
  warningText: "#855300", // --warning-text (light)
  errorText: "#ba1a1a", // --error-text (light)
  successText: "#005338", // --success-text (light)
} as const;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Inlined into a double-quoted style attribute: never use a double quote inside it.
const baseStyles = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: ${EMAIL_COLORS.fg};
  line-height: 1.5;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
`;

export function renderEmailLayout(args: { title: string; bodyHtml: string }): string {
  const { title, bodyHtml } = args;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
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
