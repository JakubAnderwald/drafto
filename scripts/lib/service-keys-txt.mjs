// Reads ~/drafto-secrets/supabase service keys.txt, the MacBook Air's file of
// Supabase service-role keys: one "<TAG>: <key>" line per project, with TAG
// DEV (huhzactreblzcogqkbsd) or PROD (tbmjbxxseonkciqovnpl). Used by
// migration-stats.mjs, and by run-dev-live-tests.mjs when the Mac mini's
// dev-supabase-admin.env isn't there.

export const SERVICE_KEYS_TXT = "supabase service keys.txt";

/**
 * The key on the first "<tag>:" line of <text>, trimmed, or null when no line
 * starts with that tag. Pure: the caller reads the file and never prints the
 * result.
 */
export function serviceKeyFromText(text, tag) {
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith(`${tag}:`)) return line.slice(tag.length + 1).trim();
  }
  return null;
}
