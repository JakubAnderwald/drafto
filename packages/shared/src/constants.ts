export const MAX_TITLE_LENGTH = 255;
export const MAX_NOTEBOOK_NAME_LENGTH = 100;
export const MAX_FILE_SIZE = 52428800; // 50MB in bytes
export const MAX_FILE_SIZE_MB = MAX_FILE_SIZE / (1024 * 1024);
// Keep these literals next to the size constant so the Sentry ignoreErrors
// filter in instrumentation-client.ts stays in lockstep with the runtime throw.
export const FILE_TOO_LARGE_MESSAGE = `File size exceeds ${MAX_FILE_SIZE_MB}MB limit`;
export const FILE_EMPTY_MESSAGE = "File is empty";
export const MAX_FILE_NAME_LENGTH = 255;
// Per-user attachment storage quota (issue #794, ADR 0072). The database default of
// profiles.storage_quota_bytes; NULL there means unlimited (admins). Keep in step with
// supabase/migrations/20261113000001_per_user_storage_quota.sql.
export const DEFAULT_STORAGE_QUOTA_BYTES = 52428800; // 50MB in bytes
// The message the attachments quota trigger raises, and the `code` of the web API's
// quota 413. Every platform recognises a refused upload by it (isStorageQuotaError).
export const STORAGE_QUOTA_EXCEEDED_CODE = "storage_quota_exceeded";
// The `error` text of the web API's quota 413 (its `code` tells it apart from the
// per-file FILE_TOO_LARGE_MESSAGE 413).
export const STORAGE_QUOTA_EXCEEDED_MESSAGE = "Storage quota exceeded";
// Per-user note content quota (ADR 0090). The database default of
// profiles.content_quota_bytes; NULL there means unlimited (admins). Keep in step with
// supabase/migrations/20261121000001_per_user_content_quota.sql.
export const DEFAULT_CONTENT_QUOTA_BYTES = 26214400; // 25MB in bytes
// The message the notes quota trigger raises, and the `code` of the web API's content
// quota 413. Every platform recognises a refused save by it (isContentQuotaError).
export const CONTENT_QUOTA_EXCEEDED_CODE = "content_quota_exceeded";
// The `error` text of the web API's content quota 413.
export const CONTENT_QUOTA_EXCEEDED_MESSAGE = "Note content quota exceeded";
// Usage above this share of the quota shows the warning tone; at or over 1, danger.
export const STORAGE_WARNING_RATIO = 0.9;
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

// The screen an account with `profiles.is_approved = false` sees on every platform: a signup
// still pending from before open signup (ADR 0094), or an account an admin suspended. The
// route keeps its old name, `waiting-for-approval`.
export const SUPPORT_EMAIL = "support@drafto.eu";
export const ACCOUNT_INACTIVE_TITLE = "Account not active";
export const ACCOUNT_INACTIVE_MESSAGE = `This account isn't active, so it can't reach its notes. If you think this is a mistake, contact ${SUPPORT_EMAIL}.`;
export const ACCOUNT_STILL_INACTIVE = "This account still isn't active.";
export const ACCOUNT_STATUS_CHECK_FAILED = "Couldn't check the account. Please try again.";
export const ACCOUNT_STATUS_CHECK_LABEL = "Check again";

// The `x-drafto-client` tags (ADR 0023), one per client. `usage_daily.client`
// (20261113000003_usage_daily.sql) mirrors this list in its check constraint,
// and record_activity rejects any other tag; packages/shared's
// client-tags-drift test keeps the two in step.
export const DRAFTO_CLIENT_TAGS = [
  "web",
  "mobile-ios",
  "mobile-android",
  "desktop-macos",
  "web-mcp",
] as const;
export type DraftoClientTag = (typeof DRAFTO_CLIENT_TAGS)[number];
// Activity days (ADR 0088): how many UTC days a device keeps queued while it
// can't reach the server (the newest are kept), and how many record_activity
// accepts per call. The server also ignores days more than 30 days back.
export const ACTIVITY_QUEUE_MAX_DAYS = 30;
export const RECORD_ACTIVITY_MAX_DAYS = 31;

// Offline attachment cache (ADR-0086). Mobile and desktop keep a copy of each attachment
// under <Documents>/attachment-cache/, keyed by its storage path, so images show offline.
export const ATTACHMENT_CACHE_DIR_NAME = "attachment-cache";
// The editor shows a cached image through a file:// src that ends in this fragment plus
// the URL-encoded storage path. The save path maps such a src back to attachment://, so
// a device path never reaches the database (migrateSignedUrlsToAttachmentUrls).
export const LOCAL_ATTACHMENT_FRAGMENT = "#drafto-attachment=";
// One prefetch pass (after a sync) downloads at most this many images...
export const ATTACHMENT_PREFETCH_MAX_FILES = 25;
// ...and at most this many bytes.
export const ATTACHMENT_PREFETCH_MAX_BYTES = 104857600; // 100MB in bytes
// Images bigger than this are cached only once they are viewed, never prefetched.
export const ATTACHMENT_PREFETCH_MAX_FILE_BYTES = 20971520; // 20MB in bytes

// The confirmation mobile Settings and the desktop app menu show before every sign-out, which
// wipes the device's local database and attachment files (useSafeSignOut). With unsynced changes
// it says how many will be lost and confirms with SIGN_OUT_ANYWAY_LABEL instead.
export const SIGN_OUT_CONFIRM_TITLE = "Sign out?";
export const SIGN_OUT_SYNCED_MESSAGE =
  "Everything is synced. Your notes will be here when you sign back in.";
// When the unsynced count could not be read, so the dialog cannot promise nothing is lost.
export const SIGN_OUT_UNKNOWN_MESSAGE = "Any changes that haven't synced yet will be lost.";
export const SIGN_OUT_CONFIRM_LABEL = "Sign out";
export const SIGN_OUT_ANYWAY_LABEL = "Sign out anyway";

// Accessible names of the show/hide toggle on every password field (login, sign-up, reset
// password) on every platform. Web e2e locators match the field's own "Password" label with
// `exact: true`, because "Show password" contains it.
export const PASSWORD_VISIBILITY_LABELS = {
  show: "Show password",
  hide: "Hide password",
} as const;

// --- Public drafto.eu pages (PrimeTestLab 11035 S-01) ---
// The About section of mobile and web Settings links these. Always the prod site: the
// privacy policy and support page are not per-environment, so a dev or preview build still
// links drafto.eu.
export const DRAFTO_WEB_ORIGIN = "https://drafto.eu";
export const PRIVACY_POLICY_URL = `${DRAFTO_WEB_ORIGIN}/privacy`;
export const SUPPORT_URL = `${DRAFTO_WEB_ORIGIN}/support`;
