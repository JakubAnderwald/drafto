import { CONTENT_QUOTA_EXCEEDED_CODE } from "../constants";
import { formatMegabytes, type StorageUsage } from "./storage-quota";

/**
 * Per-user note content quota helpers (ADR 0090), shared by web, mobile and desktop.
 * The database enforces the quota (a trigger on `notes`); these format it and
 * recognise its refusal. Usage rows have the same shape as the storage quota's, so
 * `storageUsageFromRow`, `storageUsageTone` and friends apply to them unchanged.
 */

/** "Notes: 1.2 MB of 25 MB used", or "Notes: 1.2 MB used" when unlimited. */
export function formatContentUsage(usedBytes: number, quotaBytes: number | null): string {
  if (quotaBytes === null) return `Notes: ${formatMegabytes(usedBytes)} used`;
  return `Notes: ${formatMegabytes(usedBytes)} of ${formatMegabytes(quotaBytes)} used`;
}

const FREE_SPACE_ADVICE = "Delete notes you no longer need and empty the trash to free space.";

/**
 * The message every platform shows when a note save is refused for the quota. Without
 * known numbers it still says what happened and what to do.
 */
export function contentFullMessage(
  usedBytes: number | null | undefined,
  quotaBytes: number | null | undefined,
): string {
  if (typeof usedBytes !== "number" || typeof quotaBytes !== "number") {
    return `Notes full: you've used all of your space for notes. ${FREE_SPACE_ADVICE}`;
  }
  return `Notes full: you've used ${formatMegabytes(usedBytes)} of your ${formatMegabytes(quotaBytes)} for notes. ${FREE_SPACE_ADVICE}`;
}

/** Thrown by client save paths when a note write is refused for the quota. */
export class ContentQuotaError extends Error {
  readonly usage: StorageUsage | null;

  constructor(usage: StorageUsage | null = null) {
    super(contentFullMessage(usage?.usedBytes, usage?.quotaBytes));
    this.name = "ContentQuotaError";
    this.usage = usage;
  }
}

const ERROR_TEXT_FIELDS = ["message", "code", "error", "details", "hint"] as const;

/**
 * Whether an error is the content quota refusal: a `ContentQuotaError`, the notes
 * trigger's `content_quota_exceeded` (a PostgrestError, or an Error wrapping its
 * message), or the web API's content quota 413 body (`{ code: "content_quota_exceeded" }`).
 */
export function isContentQuotaError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (err instanceof ContentQuotaError) return true;
  if (typeof err === "string") return err.includes(CONTENT_QUOTA_EXCEEDED_CODE);
  if (typeof err !== "object") return false;
  if ((err as { name?: unknown }).name === "ContentQuotaError") return true;
  const record = err as Record<string, unknown>;
  return ERROR_TEXT_FIELDS.some((field) => {
    const value = record[field];
    return typeof value === "string" && value.includes(CONTENT_QUOTA_EXCEEDED_CODE);
  });
}

function parseBytes(text: string, key: string): number | null {
  const match = new RegExp(`${key}=(\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * The usage a refusal carries: the trigger's `detail` (`used_bytes=… quota_bytes=…`)
 * on a PostgrestError, or `usedBytes` / `quotaBytes` on a web API 413 body. Null when
 * the error doesn't carry both.
 */
export function contentUsageFromError(err: unknown): StorageUsage | null {
  if (err === null || typeof err !== "object") return null;
  const record = err as Record<string, unknown>;
  if (typeof record.usedBytes === "number" && typeof record.quotaBytes === "number") {
    return { usedBytes: record.usedBytes, quotaBytes: record.quotaBytes };
  }
  if (typeof record.details === "string") {
    const usedBytes = parseBytes(record.details, "used_bytes");
    const quotaBytes = parseBytes(record.details, "quota_bytes");
    if (usedBytes !== null && quotaBytes !== null) return { usedBytes, quotaBytes };
  }
  return null;
}

/**
 * The content quota refusal a web API 413 carries, or null for any other failure.
 * Shared by every web save path so they all read the body the same way.
 */
export function contentQuotaErrorFromResponse(
  status: number,
  body: unknown,
): ContentQuotaError | null {
  if (status !== 413 || !isContentQuotaError(body)) return null;
  return new ContentQuotaError(contentUsageFromError(body));
}
