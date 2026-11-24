/**
 * Client-side email checks shared by every sign-up, log-in and forgot-password form
 * (PrimeTestLab 11035 M-02). A malformed address is caught before any request, so the user
 * never sees Supabase's raw "Unable to validate email address: invalid format".
 */

/** Shown under an empty email field. 06-forgot-password.yaml asserts this exact text. */
export const EMAIL_REQUIRED_MESSAGE = "Please enter your email address.";
/** Shown under an email field whose value is not an address, and for Supabase's own refusal. */
export const INVALID_EMAIL_MESSAGE = "Enter a valid email address, like name@example.com.";

const MAX_LOCAL_PART_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 253;
// A DNS label holds at most 63 octets (RFC 1035), counted on its ASCII (punycode) form.
const MAX_DOMAIN_LABEL_LENGTH = 63;
// "xn--" in front of a punycode label: the shortest ASCII form of an internationalised label is
// this plus one character for each of its code points, so a label that can't fit even then is
// rejected without encoding it.
const PUNYCODE_PREFIX_LENGTH = 4;

// RFC 5322 "atext" plus dots, and any non-ASCII character (internationalised local parts).
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~¡-￿.-]+$/;
// One domain label: letters, digits and inner hyphens, non-ASCII allowed for IDNs.
const DOMAIN_LABEL = /^[A-Za-z0-9¡-￿](?:[A-Za-z0-9¡-￿-]*[A-Za-z0-9¡-￿])?$/;
// The top-level domain: two or more letters, or a punycode label.
const TOP_LEVEL_DOMAIN = /^(?:[A-Za-z¡-￿]{2,}|xn--[A-Za-z0-9-]+)$/;

/**
 * Whether `label` can fit the 63-octet DNS limit. An ASCII label is its own ASCII form. An
 * internationalised one is checked against the shortest punycode it could encode to, so a
 * label too long in any encoding is refused and every one that might fit is left to the server.
 */
function fitsDnsLabel(label: string): boolean {
  if (/^[A-Za-z0-9-]*$/.test(label)) return label.length <= MAX_DOMAIN_LABEL_LENGTH;
  // Code points, not UTF-16 units: an emoji is two units but one punycode character at least.
  const shortestAsciiLength = Array.from(label).length + PUNYCODE_PREFIX_LENGTH;
  return shortestAsciiLength <= MAX_DOMAIN_LABEL_LENGTH;
}

/**
 * Whether `email` (surrounding whitespace ignored) looks like a deliverable address: exactly one
 * `@`, a non-empty local part without leading, trailing or doubled dots, and a domain of at least
 * two labels ending in a plausible top-level domain. Pragmatic, not a full RFC 5322 parser:
 * quoted local parts and IP-literal domains are refused, as Supabase refuses them too.
 */
export function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;

  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return false;

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (local.length > MAX_LOCAL_PART_LENGTH || !LOCAL_PART.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;

  if (!domain || domain.length > MAX_DOMAIN_LENGTH) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label) && fitsDnsLabel(label))) return false;

  return TOP_LEVEL_DOMAIN.test(labels[labels.length - 1]);
}

/** The inline error for an email field's value, or `undefined` when it is fine. */
export function validateEmailField(email: string): string | undefined {
  if (!email.trim()) return EMAIL_REQUIRED_MESSAGE;
  if (!isValidEmail(email)) return INVALID_EMAIL_MESSAGE;
  return undefined;
}
