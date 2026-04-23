export function sanitizeFileName(name: string): string {
  return (
    name
      // Decompose combining marks so accented chars become base + mark (e.g. "ö" → "o" + U+0308),
      // then strip the marks. Supabase Storage rejects non-ASCII keys; this lossy normalisation
      // preserves the readable base letter instead of falling back to an underscore.
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      // Any remaining non-printable-ASCII (emoji, CJK, control chars) becomes "_"
      .replace(/[^\x20-\x7e]/g, "_")
      // Filesystem-unsafe ASCII chars
      .replace(/[/\\<>:"|?*]/g, "_")
      // Path traversal
      .replace(/\.\./g, "_")
      .slice(0, 255)
  );
}
