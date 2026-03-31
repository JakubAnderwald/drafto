export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .slice(0, 255);
}
