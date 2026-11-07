import { MAX_FILE_NAME_LENGTH } from "../constants";

/**
 * Every character outside the set Supabase Storage accepts in an object key
 * AND survives being placed raw in a URL path.
 *
 * Attachment keys are `<userId>/<noteId>/<fileName>`, and supabase-js appends
 * the key to the request URL without encoding it (upload, signed upload,
 * sign, download). So:
 * - `#` starts the URL fragment: the server stores a cut-short key while the
 *   client saves the full one in `attachments.file_path`, and every later
 *   call that sends the key in a JSON body (`remove()`) misses the object.
 * - `%`, `~`, `[`, `]`, `{`, `}`, `^`, `` ` `` and the like are rejected by
 *   Storage with a 400, so the upload fails.
 * The allowed set below was checked against the Storage API for upload, sign
 * and signed download. `/ \ : * ? " < > |` stay out because they are unsafe in
 * a path or on a filesystem.
 */
const UNSAFE_STORAGE_FILE_NAME_CHARS = /[^A-Za-z0-9 _!\-.'()&$@=;+,]/g;

/** Combining diacritical marks (U+0300-U+036F), left behind by NFD. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Longest extension kept when a name is shortened (".mp3", ".docx" - not 200 chars). */
const MAX_EXTENSION_LENGTH = 20;

/**
 * Replace every character that is unsafe in a storage key or a local filename
 * with `_`. Accented letters keep their base letter. Does not cap the length.
 */
export function toStorageSafeFileName(name: string): string {
  return name
    .normalize("NFD")
    .replaceAll(COMBINING_MARKS, "")
    .replaceAll(UNSAFE_STORAGE_FILE_NAME_CHARS, "_")
    .replaceAll("..", "_");
}

/** True when `name` needs no change to be used as a storage key segment. */
export function isStorageSafeFileName(name: string): boolean {
  return name.length > 0 && toStorageSafeFileName(name) === name;
}

function splitExtension(name: string): { base: string; extension: string } {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return { base: name, extension: "" };
  return {
    base: name.slice(0, dotIndex),
    extension: name.slice(dotIndex).slice(0, MAX_EXTENSION_LENGTH),
  };
}

/**
 * Shorten `name` to at most `maxLength` characters, cutting the base name and
 * keeping the extension. Always leaves at least one base character.
 */
export function truncateFileName(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const { base, extension } = splitExtension(name);
  return `${base.slice(0, Math.max(1, maxLength - extension.length))}${extension}`;
}

/** The attachment's display name: storage-safe and at most 255 characters. */
export function safeAttachmentFileName(rawName: string): string {
  return truncateFileName(toStorageSafeFileName(rawName), MAX_FILE_NAME_LENGTH);
}

function uniqueSuffix(): string {
  // Timestamp + random hex, so two uploads of the same name (even in the same
  // millisecond) never share a key. Math.random keeps this usable on Hermes,
  // which has no crypto.randomUUID; collision-safety does not need crypto.
  const random = Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, "0");
  return `-${Date.now()}-${random}`;
}

/**
 * Build a unique storage key `<userId>/<noteId>/<fileName>` for an upload.
 * `fileName` is the storage-safe name plus a unique suffix before the
 * extension, capped at 255 characters.
 */
export function buildAttachmentStoragePath(
  rawName: string,
  userId: string,
  noteId: string,
): { fileName: string; filePath: string } {
  const { base, extension } = splitExtension(toStorageSafeFileName(rawName));
  const suffix = uniqueSuffix();
  const maxBaseLength = MAX_FILE_NAME_LENGTH - extension.length - suffix.length;
  const fileName = `${base.slice(0, Math.max(1, maxBaseLength))}${suffix}${extension}`;
  return { fileName, filePath: `${userId}/${noteId}/${fileName}` };
}

/**
 * Name for the device-local copy of an attachment: `<id>_<safe name>`, kept
 * within the 255-byte filename limit of APFS / ext4 with the extension intact.
 */
export function localAttachmentFileName(id: string, rawName: string): string {
  const prefix = `${id}_`;
  return `${prefix}${truncateFileName(toStorageSafeFileName(rawName), MAX_FILE_NAME_LENGTH - prefix.length)}`;
}
