import { STORAGE_QUOTA_EXCEEDED_CODE, STORAGE_WARNING_RATIO } from "../constants";

/**
 * Per-user attachment storage quota helpers (issue #794, ADR 0069), shared by web,
 * mobile and desktop. The database enforces the quota; these format it, recognise
 * its refusal, and let clients pre-check an upload.
 */

export const BYTES_PER_MEGABYTE = 1024 * 1024;

/** A user's attachment usage. `quotaBytes` null means unlimited. */
export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number | null;
}

/** A row of the `get_my_storage_usage` / `admin_storage_usage` RPCs. */
export interface StorageUsageRow {
  used_bytes: number;
  quota_bytes: number | null;
}

export type StorageUsageTone = "default" | "warning" | "danger";

export function bytesToMegabytes(bytes: number): number {
  return bytes / BYTES_PER_MEGABYTE;
}

export function megabytesToBytes(megabytes: number): number {
  return Math.round(megabytes * BYTES_PER_MEGABYTE);
}

/**
 * Bytes as megabytes with at most one decimal: "12.4 MB", "50 MB". A non-zero amount
 * that would round to 0 reads "< 0.1 MB", so a small upload never shows as nothing.
 */
export function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const rounded = Math.round(bytesToMegabytes(bytes) * 10) / 10;
  if (rounded === 0) return "< 0.1 MB";
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} MB`;
}

/** "Storage: 12.4 MB of 50 MB used", or "Storage: 12.4 MB used" when unlimited. */
export function formatStorageUsage(usedBytes: number, quotaBytes: number | null): string {
  if (quotaBytes === null) return `Storage: ${formatMegabytes(usedBytes)} used`;
  return `Storage: ${formatMegabytes(usedBytes)} of ${formatMegabytes(quotaBytes)} used`;
}

const FREE_SPACE_ADVICE = "Delete notes with attachments and empty the trash to free space.";

/**
 * The message every platform shows when an upload is refused for the quota. Without
 * known numbers (the refusal came from a path that doesn't report them) it still
 * says what happened and what to do.
 */
export function storageFullMessage(
  usedBytes: number | null | undefined,
  quotaBytes: number | null | undefined,
): string {
  if (typeof usedBytes !== "number" || typeof quotaBytes !== "number") {
    return `Storage full: you've used all of your storage. ${FREE_SPACE_ADVICE}`;
  }
  return `Storage full: you've used ${formatMegabytes(usedBytes)} of your ${formatMegabytes(quotaBytes)}. ${FREE_SPACE_ADVICE}`;
}

/** Thrown by client upload paths when an upload is refused for the quota. */
export class StorageQuotaError extends Error {
  readonly usage: StorageUsage | null;

  constructor(usage: StorageUsage | null = null) {
    super(storageFullMessage(usage?.usedBytes, usage?.quotaBytes));
    this.name = "StorageQuotaError";
    this.usage = usage;
  }
}

const ERROR_TEXT_FIELDS = ["message", "code", "error", "details", "hint"] as const;

/**
 * Whether an error is the quota refusal: a `StorageQuotaError`, the attachments
 * trigger's `storage_quota_exceeded` (a PostgrestError, or an Error wrapping its
 * message), or the web API's quota 413 body (`{ code: "storage_quota_exceeded" }`).
 */
export function isStorageQuotaError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (err instanceof StorageQuotaError) return true;
  if (typeof err === "string") return err.includes(STORAGE_QUOTA_EXCEEDED_CODE);
  if (typeof err !== "object") return false;
  if ((err as { name?: unknown }).name === "StorageQuotaError") return true;
  const record = err as Record<string, unknown>;
  return ERROR_TEXT_FIELDS.some((field) => {
    const value = record[field];
    return typeof value === "string" && value.includes(STORAGE_QUOTA_EXCEEDED_CODE);
  });
}

/**
 * The quota refusal a web API 413 carries (from `upload-url` or `confirm`: its body
 * has the quota code and, when known, the usage), or null for any other failure,
 * the per-file size 413 included. Shared by every web upload path so they all read
 * the body `storageQuotaExceededResponse` writes the same way.
 */
export function storageQuotaErrorFromResponse(
  status: number,
  body: unknown,
): StorageQuotaError | null {
  if (status !== 413 || !isStorageQuotaError(body)) return null;
  const { usedBytes, quotaBytes } = body as { usedBytes?: unknown; quotaBytes?: unknown };
  return new StorageQuotaError(
    typeof usedBytes === "number" && typeof quotaBytes === "number"
      ? { usedBytes, quotaBytes }
      : null,
  );
}

/** Whether adding `fileSize` bytes would go over the quota. Landing exactly on it is allowed. */
export function wouldExceedQuota(usage: StorageUsage, fileSize: number): boolean {
  if (usage.quotaBytes === null) return false;
  return usage.usedBytes + fileSize > usage.quotaBytes;
}

/** Share of the quota used (1 = full), or null when unlimited. */
export function storageUsageRatio(usage: StorageUsage): number | null {
  if (usage.quotaBytes === null) return null;
  if (usage.quotaBytes <= 0) return 1;
  return usage.usedBytes / usage.quotaBytes;
}

/** "danger" at or over the quota, "warning" above 90% of it, otherwise "default". */
export function storageUsageTone(usage: StorageUsage): StorageUsageTone {
  const ratio = storageUsageRatio(usage);
  if (ratio === null) return "default";
  if (ratio >= 1) return "danger";
  if (ratio > STORAGE_WARNING_RATIO) return "warning";
  return "default";
}

function toByteCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * A `get_my_storage_usage` result (one row, or the array PostgREST returns without
 * `.single()`) as a `StorageUsage`, or null when it isn't one. Bigints may arrive as
 * numeric strings.
 */
export function storageUsageFromRow(row: unknown): StorageUsage | null {
  const candidate: unknown = Array.isArray(row) ? row[0] : row;
  if (candidate === null || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  const usedBytes = toByteCount(record.used_bytes);
  if (usedBytes === null) return null;
  if (record.quota_bytes === null || record.quota_bytes === undefined) {
    return { usedBytes, quotaBytes: null };
  }
  const quotaBytes = toByteCount(record.quota_bytes);
  if (quotaBytes === null) return null;
  return { usedBytes, quotaBytes };
}
