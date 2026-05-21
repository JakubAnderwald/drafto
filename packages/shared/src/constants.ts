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
