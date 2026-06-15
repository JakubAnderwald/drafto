/**
 * Trigger a browser download for an in-memory Blob.
 * Creates a hidden anchor with `download="…"`, clicks it, then revokes the
 * object URL on the next tick so memory doesn't leak across exports.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Use setTimeout so the click handler fully finishes before we revoke.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/filename\s*=\s*"?([^";]+)"?/i);
  return match?.[1] ?? null;
}
