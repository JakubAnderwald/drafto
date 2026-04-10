/**
 * Sanitize a filename and generate a unique storage path.
 *
 * Strips path traversal, dangerous characters, and appends a timestamp
 * to prevent collisions when the same file is re-uploaded.
 */
export function sanitizeAndBuildPath(
  rawName: string,
  userId: string,
  noteId: string,
): { fileName: string; filePath: string } {
  const sanitized = rawName
    .replace(/[/\\]/g, "_") // no path separators
    .replace(/\.\./g, "_") // no directory traversal
    .replace(/[<>:"|?*\x00-\x1f]/g, "_") // no shell/HTML-special chars
    .slice(0, 255); // cap length

  const dotIndex = sanitized.lastIndexOf(".");
  const baseName = dotIndex > 0 ? sanitized.slice(0, dotIndex) : sanitized;
  const extension = dotIndex > 0 ? sanitized.slice(dotIndex) : "";
  const fileName = `${baseName}-${Date.now()}${extension}`;
  const filePath = `${userId}/${noteId}/${fileName}`;

  return { fileName, filePath };
}
