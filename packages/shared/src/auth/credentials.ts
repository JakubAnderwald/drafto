import { validateEmailField } from "./email";

/** Supabase Auth's minimum password length for this project (Authentication → Policies). */
export const MIN_PASSWORD_LENGTH = 6;
export const PASSWORD_REQUIRED_MESSAGE = "Please enter your password.";
export const PASSWORD_TOO_SHORT_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;

/** A form field an auth error can be shown under. */
export type AuthField = "email" | "password";
/** Inline errors keyed by field; a field without an entry has none. */
export type AuthFieldErrors = Partial<Record<AuthField, string>>;

/**
 * `signup` also enforces the minimum password length; `login` only needs a password, so an
 * account made under an older, looser policy can still log in.
 */
export type CredentialsMode = "signup" | "login";

export interface Credentials {
  email: string;
  password: string;
}

/**
 * Every inline error an email + password form has, checked together so the user sees all of
 * them on one submit (PrimeTestLab 11035 M-02). Empty when the form may be sent.
 */
export function validateCredentials(
  { email, password }: Credentials,
  mode: CredentialsMode,
): AuthFieldErrors {
  const errors: AuthFieldErrors = {};

  const emailError = validateEmailField(email);
  if (emailError) errors.email = emailError;

  if (!password) {
    errors.password = PASSWORD_REQUIRED_MESSAGE;
  } else if (mode === "signup" && password.length < MIN_PASSWORD_LENGTH) {
    errors.password = PASSWORD_TOO_SHORT_MESSAGE;
  }

  return errors;
}

/** Whether `errors` holds at least one inline error. */
export function hasFieldErrors(errors: AuthFieldErrors): boolean {
  return Boolean(errors.email || errors.password);
}
