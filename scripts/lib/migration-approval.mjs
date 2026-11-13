#!/usr/bin/env node
// The migration-approved label vouches for one version of a PR's migration SQL
// (ADR-0078).
//
// --release merges a PR that touches supabase/migrations/** only once the
// migration-approved label is on it. The label used to be tied to nothing, so
// SQL edited after it was added merged on the old approval. The factory now
// records a hash of the SQL the label was first seen with
// (migrationApprovedVouched) and removes the label when the hash changes
// (migration_approval_vouch in factory-agent.sh).
//
// The hash leaves the PR's own migration versions out. The factory's
// mechanical renumber (ADR-0077) changes nothing but those versions, so it
// keeps the approval, and any other edit voids it:
//   - Files: the *.sql files directly under supabase/migrations that the PR
//     adds, changes or deletes, from its merge base with main to its head.
//   - Key: an added file's name without its 14-digit version (`<name>.sql`),
//     a changed or deleted file's full name. Two added files with the same
//     name get `#1`, `#2` in version order, which a renumber keeps.
//   - Content: every digit-bounded occurrence of a version the PR adds becomes
//     `@<key>` of the file that has it. Where two added files share a version
//     (a renumber splits them), the `_<name>` that follows picks the file.
//   - The hash: sha256 of the entries sorted by key, first 16 hex characters.
//
// CLI (prints one JSON object; exit 1 with {error} on stderr when it fails):
//   hash --pr <n> --head <sha> [--root <repo>] [--remote <name>]
//       Fetches main and the PR head the way migration-renumber.mjs does, and
//       prints {hash, files}: files are the names the hash covers.

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main.mjs";
import {
  MIGRATIONS_DIR,
  asText,
  blobAt,
  fetchPr,
  makeGit,
  revParse,
} from "./migration-renumber.mjs";
import { parseFlags } from "./parse-flags.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSIONED_RE = /^(\d{14})_(.+)$/;
const WORD_CHAR_RE = /[A-Za-z0-9_]/;

function byString(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// The PR's added, validly versioned files, in version order, each with the
// key that stands for it: {file, version, rest, stem, key}.
function addedVersioned(files) {
  const out = files
    .filter((f) => f.added && !f.deleted && VERSIONED_RE.test(f.name))
    .map((file) => {
      const [, version, rest] = VERSIONED_RE.exec(file.name);
      return { file, version, rest, stem: rest.replace(/\.sql$/, "") };
    })
    .sort((a, b) => byString(a.version, b.version) || byString(a.rest, b.rest));
  const total = new Map();
  for (const a of out) total.set(a.rest, (total.get(a.rest) ?? 0) + 1);
  const seen = new Map();
  for (const a of out) {
    const n = (seen.get(a.rest) ?? 0) + 1;
    seen.set(a.rest, n);
    a.key = total.get(a.rest) > 1 ? `${a.rest}#${n}` : a.rest;
  }
  return out;
}

// Replaces each of the PR's added versions in a text with `@<key>`.
function makeNormalizer(added) {
  const byVersion = new Map();
  for (const a of added) byVersion.set(a.version, [...(byVersion.get(a.version) ?? []), a]);
  if (byVersion.size === 0) return (text) => text;
  const re = new RegExp(`(?<!\\d)(${[...byVersion.keys()].join("|")})(?!\\d)`, "g");
  return (text) =>
    text.replace(re, (version, _v, offset, whole) => {
      const owners = byVersion.get(version);
      if (owners.length === 1) return `@${owners[0].key}`;
      const at = offset + version.length;
      const named = owners
        .filter(
          (o) =>
            whole.startsWith(`_${o.stem}`, at) &&
            !WORD_CHAR_RE.test(whole.charAt(at + 1 + o.stem.length)),
        )
        .sort((a, b) => b.stem.length - a.stem.length)[0];
      return named ? `@${named.key}` : `@{${owners.map((o) => o.key).join("|")}}`;
    });
}

// Hash of a PR's migration SQL with its own versions normalized out.
// `files`: [{name, content, added, deleted?}] for the PR's added, changed and
// deleted *.sql files directly under supabase/migrations, contents at its head
// (null for a deleted file). Returns 16 hex characters.
export function migrationSqlHash({ files }) {
  const added = addedVersioned(files);
  const keyOf = new Map(added.map((a) => [a.file, a.key]));
  const normalize = makeNormalizer(added);
  const entries = files
    .map((f) => {
      if (f.deleted) return [f.name, "D", null];
      return [keyOf.get(f) ?? f.name, f.added ? "A" : "M", normalize(String(f.content ?? ""))];
    })
    .sort(
      (a, b) =>
        byString(a[0], b[0]) || byString(a[1], b[1]) || byString(String(a[2]), String(b[2])),
    );
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
}

// A blob as hash input: its text, or for a file that isn't UTF-8 text (never
// a real migration) a NUL-prefixed digest no text can equal.
function contentOf(buf) {
  const text = asText(buf);
  if (text !== null) return text;
  return `\0binary:${createHash("sha256").update(buf).digest("hex")}`;
}

// The PR's *.sql files directly under supabase/migrations that <head> adds,
// changes or deletes since its merge base with <main>, read at <head>.
// Returns {mb, files}. Throws when git fails.
export function prMigrationFiles({ cwd, head, main }) {
  const git = makeGit(cwd);
  const mb = git(["merge-base", head, main]).stdout.trim();
  const raw = git([
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--name-status",
    "-z",
    mb,
    head,
    "--",
    `${MIGRATIONS_DIR}/`,
  ]).stdout;
  const parts = raw.split("\0");
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i].charAt(0);
    const filePath = parts[i + 1];
    if (path.posix.dirname(filePath) !== MIGRATIONS_DIR || !filePath.endsWith(".sql")) continue;
    const name = path.posix.basename(filePath);
    if (status === "D") {
      files.push({ name, content: null, added: false, deleted: true });
    } else if (status === "A" || status === "M" || status === "T") {
      files.push({ name, content: contentOf(blobAt(git, head, filePath)), added: status === "A" });
    } else {
      throw new Error(`unexpected diff status ${parts[i]} for ${filePath}`);
    }
  }
  return { mb, files };
}

function requireFlag(flags, name, re) {
  const v = flags[name];
  if (v === undefined || !re.test(String(v))) throw new Error(`--${name} is required`);
  return String(v);
}

export function main(argv) {
  const [sub, ...rest] = argv;
  if (sub !== "hash") {
    throw new Error(
      "Usage: migration-approval.mjs hash --pr <n> --head <sha> [--root <repo>] [--remote <name>]",
    );
  }
  const { flags } = parseFlags(rest);
  const cwd = flags.root ?? DEFAULT_ROOT;
  const pr = requireFlag(flags, "pr", /^\d+$/);
  const head = requireFlag(flags, "head", /^[0-9a-f]{7,40}$/);
  const fetched = fetchPr({ cwd, pr, remote: flags.remote ?? "origin" });
  if (!fetched.ok || !fetched.main) {
    throw new Error(`couldn't fetch main and PR #${pr}: ${fetched.detail ?? "no origin/main"}`);
  }
  const headSha = revParse(makeGit(cwd), head);
  if (!headSha) throw new Error(`${head} isn't in the fetched PR #${pr}`);
  const { files } = prMigrationFiles({ cwd, head: headSha, main: fetched.main });
  return {
    hash: migrationSqlHash({ files }),
    files: files.map((f) => f.name).sort(byString),
  };
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exitCode = 1;
  }
}
