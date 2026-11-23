import { PRIVACY_POLICY_PATH, SUPPORT_PATH } from "@drafto/shared";

// The public legal pages every web link list points at: LegalLinks on the signed-out pages and
// the About card in Settings. Relative paths, so a preview links its own copy of each page.
export const LEGAL_PAGES = [
  { key: "privacy", href: PRIVACY_POLICY_PATH, label: "Privacy Policy" },
  { key: "support", href: SUPPORT_PATH, label: "Support" },
] as const;
