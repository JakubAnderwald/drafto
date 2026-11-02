export const MAX_TITLE_LENGTH = 255;
export const MAX_NOTEBOOK_NAME_LENGTH = 100;
export const MAX_FILE_SIZE = 52428800; // 50MB in bytes
export const MAX_FILE_SIZE_MB = MAX_FILE_SIZE / (1024 * 1024);
// Keep these literals next to the size constant so the Sentry ignoreErrors
// filter in instrumentation-client.ts stays in lockstep with the runtime throw.
export const FILE_TOO_LARGE_MESSAGE = `File size exceeds ${MAX_FILE_SIZE_MB}MB limit`;
export const FILE_EMPTY_MESSAGE = "File is empty";
export const MAX_FILE_NAME_LENGTH = 255;
export const DEBOUNCE_MS = 500;
export const BUCKET_NAME = "attachments";
export const SIGNED_URL_EXPIRY_SECONDS = 604800; // 7 days
export const ATTACHMENT_URL_PREFIX = "attachment://";
// The exact text a user must type before an account deletion is sent.
export const ACCOUNT_DELETE_CONFIRMATION = "DELETE";
// Shown on the login screen of every platform once the user's own account deletion succeeded.
export const ACCOUNT_DELETED_MESSAGE = "Your account has been deleted.";

// Where the sign-up confirmation email sends mobile and desktop users. Both apps run PKCE, so
// the code Supabase appends is useless in a browser: the web login page only reads
// `confirmed=1` and says the address is confirmed. Web signs up through its own `/auth/callback`.
export const SIGNUP_EMAIL_REDIRECT_URL = "https://drafto.eu/login?confirmed=1";
// Shown after a sign-up that returned no session, i.e. email confirmation is required. Neutral
// on purpose: for an address that already has an account Supabase sends no email and answers
// exactly as for a new one, so the copy must not claim that an account was just created.
export const SIGNUP_CONFIRMATION_SENT =
  "If this address is new to Drafto, we've sent it a link to confirm your account. Open the link, then log in. If you already have an account, just log in.";
// The web login page's notice for `?confirmed=1`, where that confirmation link lands.
export const EMAIL_CONFIRMED = "Email confirmed. Log in to continue, here or in the Drafto app.";
