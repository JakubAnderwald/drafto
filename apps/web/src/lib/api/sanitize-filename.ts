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
    .replace(/[<>:"|?*\x00-\x1f]/g, "_"); // no shell/HTML-special chars

  const dotIndex = sanitized.lastIndexOf(".");
  const hasExtension = dotIndex > 0;
  const baseName = hasExtension ? sanitized.slice(0, dotIndex) : sanitized;
  // Cap extension to a reasonable length (e.g. ".mp3", ".docx" — not 200 chars)
  const rawExtension = hasExtension ? sanitized.slice(dotIndex) : "";
  const extension = rawExtension.slice(0, 20);

  // Append timestamp + random suffix to prevent collisions (even within the same ms)
  const suffix = `-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const maxBaseLength = 255 - extension.length - suffix.length;
  const truncatedBase = baseName.slice(0, Math.max(1, maxBaseLength));
  const fileName = `${truncatedBase}${suffix}${extension}`;
  const filePath = `${userId}/${noteId}/${fileName}`;

  return { fileName, filePath };
}
