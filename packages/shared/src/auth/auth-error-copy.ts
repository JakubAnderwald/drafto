import { INVALID_EMAIL_MESSAGE } from "./email";
import type { AuthField } from "./credentials";

export const INVALID_CREDENTIALS_MESSAGE = "Email or password is incorrect.";
export const USER_ALREADY_EXISTS_MESSAGE =
  "An account with this email already exists. Log in instead.";
export const EMAIL_NOT_CONFIRMED_MESSAGE =
  "Confirm your email address first: open the link we sent you, then log in.";
export const AUTH_RATE_LIMITED_MESSAGE = "Too many attempts. Please wait a minute and try again.";
export const WEAK_PASSWORD_MESSAGE = "Choose a stronger password.";
export const AUTH_GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

/** The parts of a Supabase `AuthError` (or any error) the copy depends on. */
export interface AuthErrorLike {
  message?: string;
  code?: string;
  status?: number;
}

/**
 * What a form shows for an auth error: the text, and the field it belongs under. Without a
 * `field`, the form shows it in its top banner.
 */
export interface AuthErrorCopy {
  message: string;
  field?: AuthField;
}

const RATE_LIMIT_CODES = new Set([
  "over_email_send_rate_limit",
  "over_request_rate_limit",
  "over_sms_send_rate_limit",
]);

/**
 * Turns a Supabase Auth error into words a user can act on (PrimeTestLab 11035 M-02). Matches the
 * stable `code` first and the message second, because older GoTrue versions and some proxies send
 * only the message. An unknown error keeps its own message, so nothing is hidden; the result is
 * never empty.
 */
export function describeAuthError(error: AuthErrorLike | null | undefined): AuthErrorCopy {
  const raw = error?.message?.trim() ?? "";
  const message = raw.toLowerCase();
  const code = error?.code ?? "";

  if (RATE_LIMIT_CODES.has(code) || error?.status === 429 || message.includes("rate limit")) {
    return { message: AUTH_RATE_LIMITED_MESSAGE };
  }

  if (
    code === "email_address_invalid" ||
    code === "validation_failed" ||
    message.includes("unable to validate email address") ||
    message.includes("invalid format")
  ) {
    return { message: INVALID_EMAIL_MESSAGE, field: "email" };
  }

  if (code === "invalid_credentials" || message.includes("invalid login credentials")) {
    return { message: INVALID_CREDENTIALS_MESSAGE };
  }

  if (code === "weak_password" || /password should (?:be|contain)/.test(message)) {
    const minLength = /at least (\d+) characters/.exec(message)?.[1];
    if (minLength) {
      return { message: `Password must be at least ${minLength} characters.`, field: "password" };
    }
    return { message: raw || WEAK_PASSWORD_MESSAGE, field: "password" };
  }

  if (
    code === "user_already_exists" ||
    code === "email_exists" ||
    message.includes("user already registered")
  ) {
    return { message: USER_ALREADY_EXISTS_MESSAGE };
  }

  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return { message: EMAIL_NOT_CONFIRMED_MESSAGE };
  }

  return { message: raw || AUTH_GENERIC_ERROR_MESSAGE };
}
