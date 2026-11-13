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
// The hash leaves the PR's own migration versions out, but not their order.
// The factory's mechanical renumber (ADR-0077) changes nothing but those
// versions and keeps their relative order, so it keeps the approval. Any other
// edit voids it, including swapping the versions of two of the PR's
// migrations, which changes the order they run in:
//   - Files: every file under supabase/migrations (any depth, any extension)
//     that the PR adds, changes or deletes, from its merge base with main to
//     its head.
//   - Key: a versioned migration the PR adds (`<digits>_<name>.sql` directly in
//     the folder, as check-migration-order.mjs reads them) is keyed by its rank
//     among the PR's added versioned migrations in version order and its name
//     without the version: `1:create_table.sql`. Every other file is keyed by
//     its full path.
//   - Content: every digit-bounded occurrence of a version the PR adds becomes
//     `@<key>` of the file that has it. Where two added files share a version
//     (a renumber splits them), the `_<name>` that follows picks the file.
//     Contents of every file are normalized: the renumber rewrites those
//     versions in any line the PR added.
//   - The hash: sha256 of the entries sorted by key, first 16 hex characters.
//
// CLI (prints one JSON object; exit 1 with {error} on stderr when it fails):
//   hash --pr <n> --head <sha> [--root <repo>] [--remote <name>]
//       Fetches main and the PR head the way migration-renumber.mjs does, and
//       prints {hash, files}: files are the paths the hash covers.

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { directMigrationNames, versionOf } from "./check-migration-order.mjs";
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
const WORD_CHAR_RE = /[A-Za-z0-9_]/;
// Prefix of the content that stands for a file that isn't UTF-8 text. Text
// never holds a NUL (asText), so no text can equal it.
const BINARY_PREFIX = "\0binary:";

function byString(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// The PR's added versioned migrations, in version order (the order the
// Supabase CLI runs them in), each with the key that stands for it:
// [{file, version, stem, key}].
function addedVersioned(files) {
  return files
    .filter((f) => f.added && !f.deleted)
    .flatMap((file) => {
      const [name] = directMigrationNames([file.path], MIGRATIONS_DIR);
      const version = name === undefined ? null : versionOf(name);
      return version === null ? [] : [{ file, version, rest: name.slice(version.length + 1) }];
    })
    .sort((a, b) => byString(a.version, b.version) || byString(a.rest, b.rest))
    .map((a, i) => ({ ...a, stem: a.rest.replace(/\.sql$/, ""), key: `${i + 1}:${a.rest}` }));
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

// Hash of a PR's migration files with its own versions normalized out.
// `files`: [{path, content, added, deleted?}] for every file under
// supabase/migrations the PR adds, changes or deletes, contents at its head
// (null for a deleted file). Returns 16 hex characters.
export function migrationSqlHash({ files }) {
  const added = addedVersioned(files);
  const keyOf = new Map(added.map((a) => [a.file, a.key]));
  const normalize = makeNormalizer(added);
  const entries = files
    .map((f) => {
      if (f.deleted) return [f.path, "D", null];
      const content = String(f.content ?? "");
      return [
        keyOf.get(f) ?? f.path,
        f.added ? "A" : "M",
        content.startsWith(BINARY_PREFIX) ? content : normalize(content),
      ];
    })
    .sort(
      (a, b) =>
        byString(a[0], b[0]) || byString(a[1], b[1]) || byString(String(a[2]), String(b[2])),
    );
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
}

// A blob as hash input: its text, or for a file that isn't UTF-8 text a
// digest behind BINARY_PREFIX.
function contentOf(buf) {
  const text = asText(buf);
  if (text !== null) return text;
  return `${BINARY_PREFIX}${createHash("sha256").update(buf).digest("hex")}`;
}

// The files under supabase/migrations (any depth) that <head> adds, changes or
// deletes since its merge base with <main>, read at <head>.
// Returns {mb, files: [{path, content, added, deleted?}]}. Throws when git fails.
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
    if (status === "D") {
      files.push({ path: filePath, content: null, added: false, deleted: true });
    } else if (status === "A" || status === "M" || status === "T") {
      files.push({
        path: filePath,
        content: contentOf(blobAt(git, head, filePath)),
        added: status === "A",
      });
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
    files: files.map((f) => f.path).sort(byString),
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
