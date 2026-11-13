// Reads ~/drafto-secrets/supabase service keys.txt, the MacBook Air's file of
// Supabase service-role keys: one "<TAG>: <key>" line per project, with TAG
// DEV (huhzactreblzcogqkbsd) or PROD (tbmjbxxseonkciqovnpl). Used by
// migration-stats.mjs, delete-users.mjs and user-stats.mjs, and by
// run-dev-live-tests.mjs when the Mac mini's dev-supabase-admin.env isn't there.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const SERVICE_KEYS_TXT = "supabase service keys.txt";

// The two projects by the name the operator scripts take (--project prod|dev).
export const PROJECTS = Object.freeze({
  prod: Object.freeze({ ref: "tbmjbxxseonkciqovnpl", tag: "PROD" }),
  dev: Object.freeze({ ref: "huhzactreblzcogqkbsd", tag: "DEV" }),
});

/** ~/drafto-secrets/supabase service keys.txt under <home>. */
export function defaultKeysTxtPath(home = homedir()) {
  return path.join(home, "drafto-secrets", SERVICE_KEYS_TXT);
}

// The file's tag for each project ref (docs/architecture/environments.md).
export const SERVICE_KEY_TAGS = Object.freeze({
  huhzactreblzcogqkbsd: "DEV",
  tbmjbxxseonkciqovnpl: "PROD",
});

/** "DEV" or "PROD" for the two known refs; null for any other project. */
export function serviceKeyTagFor(projectRef) {
  return Object.hasOwn(SERVICE_KEY_TAGS, String(projectRef)) ? SERVICE_KEY_TAGS[projectRef] : null;
}

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

/**
 * The service-role key for <project> ("prod" or "dev") from the <tag>: line of
 * <keysTxt>: {ref, tag, serviceKey}. Throws naming the file and the tag, never
 * the key; the caller must not print serviceKey either.
 */
export function readServiceKey({ project, keysTxt, readFile = readFileSync }) {
  if (!Object.hasOwn(PROJECTS, String(project))) {
    throw new Error(`unknown project ${JSON.stringify(project)}: use prod or dev`);
  }
  const { ref, tag } = PROJECTS[project];
  const serviceKey = serviceKeyFromText(readFile(keysTxt, "utf8"), tag);
  if (!serviceKey) throw new Error(`no ${tag}: line in ${keysTxt}`);
  return { ref, tag, serviceKey };
}
