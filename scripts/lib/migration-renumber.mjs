#!/usr/bin/env node
// Mechanical migration renumber for factory PRs (ADR-0077).
//
// Two factory PRs written on the same day used the same migration version (#802
// and #829 both added 20261111000001). Once one merged, the other only went red
// after an update-branch, then took an LLM fix pass, a re-review and a second
// Approved drag. This module renames such a PR's migrations itself, in a way a
// check can prove is only a rename, so the card keeps its approval.
//
// The rules, all enforced here:
//   - The renumber is built on the PR's HEAD, never on a tree merged with main,
//     so the commit carries nothing but the rename. GitHub's update-branch adds
//     main afterwards (factory-agent.sh's migration_renumber_gate).
//   - Which files move comes from checkMigrationOrder(), fed the file set the
//     merge would produce, (main − (mb − head)) ∪ (head − mb) with mb the PR's
//     merge base, judged against main. Feeding it only the head's files would
//     misreport a duplicate as `renamed-base`.
//   - Only lines the PR added (git diff -U0 <mb> <head>) are rewritten, never
//     main's. The full stem `<old>_<name>` is replaced first; a bare `<old>`
//     only when the merge base's tree never mentions it and no other file keeps
//     it, else the result is `manual`. The whole map is applied in one pass.
//   - A PR whose added migrations touch an object (function, table, view,
//     policy, trigger, type, index, sequence) that one of main's migrations
//     added since the merge base also touches is `manual`: renumbering changes
//     which definition runs last, so a person decides.
//   - verifyRenumber() re-derives the commit from its parent and refuses
//     anything that isn't exactly that rename.
//   - The push is never forced and only goes to factory/issue-<n>.
//
// CLI (each prints one JSON object; exit 1 with {error} on a crash):
//   precheck --pr <n> --head <sha> [--root <repo>] [--claimed-json <json>]
//            [--today YYYY-MM-DD] [--where <column>]
//       Read-only for the remote: fetches main and the PR head, plans.
//       {status: clean|fixable|manual|unreachable, head, mb, main, map, reason,
//        overlap, comment?}
//   apply --issue <i> --pr <n> --head <sha> [same options]
//       Plans, writes commit R on the PR head, checks it, pushes it to
//       factory/issue-<i>. {status: clean|manual|pushed|rejected|unreachable,
//       from, to, map, mb, main, reason, comment?}
//   verify --from <sha> --to <sha> --map <json> [--mb <sha>] [--root <repo>]
//          [--issue <i>]
//       {ok, reasons}; exit 0 when ok, 1 when not.
//
// --claimed-json is a JSON array of versions or migration file names other
// open PRs use. Without it, a fixable plan looks them up with gh
// (claimedVersions) and is planned again so two stale PRs never both move to
// the same version.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkMigrationOrder, isValidMigrationName, versionOf } from "./check-migration-order.mjs";
import { ghTimeoutMs } from "./gh-timeout.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const MIGRATIONS_DIR = "supabase/migrations";
export const FACTORY_BRANCH_RE = /^factory\/issue-\d+$/;
export const IDENTITY = { name: "Drafto factory", email: "factory@drafto.eu" };
const REPO = "JakubAnderwald/drafto";
const ZERO_SHA = "0".repeat(40);
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NETWORK_TIMEOUT_MS = Number(process.env.FACTORY_GIT_NETWORK_TIMEOUT_MS ?? 60000);
// How often the plan is redone when a suggested version already occurs in the
// head's or main's tree (as text), so the inverse map stays unambiguous.
const MAX_REPLANS = 5;

// ── names ───────────────────────────────────────────────────────────────────

// `<name>` of `<version>_<name>.sql`.
function nameOf(fileName) {
  return /^\d+_(.+)$/.exec(fileName)?.[1] ?? null;
}

// `<version>_<name>` without the extension: what a reference names.
function stemOf(fileName) {
  return fileName.replace(/\.sql$/, "");
}

function migrationPath(fileName) {
  return `${MIGRATIONS_DIR}/${fileName}`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The merged file set: main's files, less the ones the PR deleted, plus the
// ones it added. What GitHub's merge of the PR into main will contain.
export function mergedMigrationNames({ mbNames, headNames, mainNames }) {
  const mb = new Set(mbNames);
  const head = new Set(headNames);
  const out = new Set(mainNames.filter((n) => !(mb.has(n) && !head.has(n))));
  for (const n of headNames) if (!mb.has(n)) out.add(n);
  return [...out].sort();
}

// ── SQL objects ─────────────────────────────────────────────────────────────

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
const QNAME_PARTS = new RegExp(String.raw`^(${IDENT})(?:\s*\.\s*(${IDENT}))?$`);

function normIdent(id) {
  return id.startsWith('"')
    ? id.slice(1, -1).replaceAll('""', '"').toLowerCase()
    : id.toLowerCase();
}

// `schema.name`, lower-cased, `public` when unqualified.
function qualify(raw) {
  const m = QNAME_PARTS.exec(raw.trim());
  if (!m) return raw.trim().toLowerCase();
  return m[2] ? `${normIdent(m[1])}.${normIdent(m[2])}` : `public.${normIdent(m[1])}`;
}

// SQL with comments, string literals and dollar-quoted bodies blanked out, so
// only top-level statements remain (a function body's DDL is not the
// migration's own).
export function stripSql(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      // Quoted identifiers are names; string literals are blanked.
      out += c === '"' ? sql.slice(i, j + 1) : "''";
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        out += " $$ ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// Names in a `drop <kind> [if exists] a, b(int), c` list.
function dropList(rest) {
  const names = [];
  const re = new RegExp(String.raw`^\s*(${QNAME})\s*(?:\([^)]*\))?\s*(,)?`);
  let s = rest;
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    names.push(qualify(m[1]));
    if (!m[2]) break;
    s = s.slice(m[0].length);
  }
  return names;
}

const KIND_WORD = {
  function: "function",
  procedure: "function",
  table: "table",
  view: "view",
  type: "type",
  index: "index",
  sequence: "sequence",
};

const OBJECT_PATTERNS = [
  [
    new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?(function|procedure)\s+(${QNAME})`, "i"),
    (m) => [`function ${qualify(m[2])}`],
  ],
  [
    new RegExp(String.raw`^alter\s+(function|procedure)\s+(${QNAME})`, "i"),
    (m) => [`function ${qualify(m[2])}`],
  ],
  [
    new RegExp(
      String.raw`^create\s+(?:(?:global|local)\s+)?(?:(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(${QNAME})`,
      "i",
    ),
    (m) => [`table ${qualify(m[1])}`],
  ],
  [
    new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QNAME})`, "i"),
    (m) => [`table ${qualify(m[1])}`],
  ],
  [
    new RegExp(
      String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:(?:recursive|materialized)\s+)?view\s+(?:if\s+not\s+exists\s+)?(${QNAME})`,
      "i",
    ),
    (m) => [`view ${qualify(m[1])}`],
  ],
  [
    new RegExp(String.raw`^alter\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?(${QNAME})`, "i"),
    (m) => [`view ${qualify(m[1])}`],
  ],
  [new RegExp(String.raw`^create\s+type\s+(${QNAME})`, "i"), (m) => [`type ${qualify(m[1])}`]],
  [
    new RegExp(String.raw`^alter\s+type\s+(?:if\s+exists\s+)?(${QNAME})`, "i"),
    (m) => [`type ${qualify(m[1])}`],
  ],
  [
    new RegExp(
      String.raw`^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${QNAME})\s+on\s`,
      "i",
    ),
    (m) => [`index ${qualify(m[1])}`],
  ],
  [
    new RegExp(String.raw`^alter\s+index\s+(?:if\s+exists\s+)?(${QNAME})`, "i"),
    (m) => [`index ${qualify(m[1])}`],
  ],
  [
    new RegExp(
      String.raw`^(?:create|alter|drop)\s+sequence\s+(?:if\s+(?:not\s+)?exists\s+)?(${QNAME})`,
      "i",
    ),
    (m) => [`sequence ${qualify(m[1])}`],
  ],
  [
    new RegExp(
      String.raw`^(?:create|alter|drop)\s+policy\s+(?:if\s+exists\s+)?(${IDENT})\s+on\s+(${QNAME})`,
      "i",
    ),
    (m) => [`policy ${normIdent(m[1])} on ${qualify(m[2])}`],
  ],
  [
    new RegExp(
      String.raw`^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+(${IDENT})\s[\s\S]*?\bon\s+(${QNAME})`,
      "i",
    ),
    (m) => [`trigger ${normIdent(m[1])} on ${qualify(m[2])}`],
  ],
  [
    new RegExp(
      String.raw`^(?:alter|drop)\s+trigger\s+(?:if\s+exists\s+)?(${IDENT})\s+on\s+(${QNAME})`,
      "i",
    ),
    (m) => [`trigger ${normIdent(m[1])} on ${qualify(m[2])}`],
  ],
  [
    /^drop\s+(?:materialized\s+)?(function|procedure|table|view|type|index)\s+(?:concurrently\s+)?(?:if\s+exists\s+)?([\s\S]*)$/i,
    (m) => dropList(m[2]).map((n) => `${KIND_WORD[m[1].toLowerCase()]} ${n}`),
  ],
];

// The objects a migration creates, alters or drops, as sorted
// "<kind> <schema>.<name>" strings (policies and triggers name their table).
export function objectsTouched(sql) {
  const found = new Set();
  for (const raw of stripSql(sql).split(";")) {
    const stmt = raw.replace(/\s+/g, " ").trim();
    if (!stmt) continue;
    for (const [re, toNames] of OBJECT_PATTERNS) {
      const m = re.exec(stmt);
      if (m) {
        for (const n of toNames(m)) found.add(n);
        break;
      }
    }
  }
  return [...found].sort();
}

// Objects both sides touch: [{object, pr: [files], main: [files]}].
export function objectOverlap(prSql, mainSql) {
  const index = (files) => {
    const by = new Map();
    for (const [file, sql] of Object.entries(files)) {
      for (const o of objectsTouched(sql)) by.set(o, [...(by.get(o) ?? []), file]);
    }
    return by;
  };
  const pr = index(prSql);
  const main = index(mainSql);
  return [...pr.keys()]
    .filter((o) => main.has(o))
    .sort()
    .map((o) => ({ object: o, pr: pr.get(o).sort(), main: main.get(o).sort() }));
}

// ── planning ────────────────────────────────────────────────────────────────

// What renumbering the PR needs. Returns {status, map, findings, reason,
// overlap}: `clean` (nothing to move), `fixable` (map old file → new file), or
// `manual` with the reason a person must do it.
export function planRenumber({
  mbNames,
  headNames,
  mainNames,
  extraTaken = [],
  today = new Date(),
  prSql = {},
  mainSql = {},
}) {
  const merged = mergedMigrationNames({ mbNames, headNames, mainNames });
  const findings = checkMigrationOrder({
    localFiles: merged,
    baseFiles: mainNames,
    today,
    extraTaken,
  });
  const result = (status, extra = {}) => ({
    status,
    map: {},
    findings,
    reason: "",
    overlap: [],
    ...extra,
  });
  if (findings.length === 0) return result("clean");

  const mb = new Set(mbNames);
  const head = new Set(headNames);
  const problems = [];
  for (const f of findings) {
    if (f.reason === "shape") {
      problems.push(`\`${f.file}\`'s version isn't 14 digits`);
    } else if (f.reason === "renamed-base") {
      problems.push(`\`${f.file}\` renames \`${(f.others ?? []).join("`, `")}\`, which main has`);
    } else if (!f.suggested) {
      problems.push(`no free version for \`${f.file}\``);
    } else if (mb.has(f.file) || !head.has(f.file)) {
      problems.push(`\`${f.file}\` isn't a migration this PR adds`);
    }
  }
  if (problems.length > 0) return result("manual", { reason: problems.join("; ") });

  const map = Object.fromEntries(findings.map((f) => [f.file, `${f.suggested}_${nameOf(f.file)}`]));
  const overlap = objectOverlap(prSql, mainSql);
  if (overlap.length > 0) {
    const list = overlap.map((o) => `${o.object} (${o.main.join(", ")})`).join("; ");
    return result("manual", {
      map,
      overlap,
      reason:
        `this PR's migrations and main's newer ones touch the same objects: ${list}. ` +
        "Renumbering changes which definition runs last",
    });
  }
  return result("fixable", { map });
}

// ── rewriting references ────────────────────────────────────────────────────

// One-pass rewriter for a map {old file → new file}: stems first (longest
// first), then bare digit-bounded versions. `onBare(version)` sees every bare
// match. Exported for verify and tests.
export function makeRewriter(map) {
  const stems = new Map();
  const versions = new Map();
  for (const [from, to] of Object.entries(map)) {
    stems.set(stemOf(from), stemOf(to));
    versions.set(versionOf(from), versionOf(to));
  }
  if (stems.size === 0) return (line) => line;
  const alt = (keys) =>
    [...keys]
      .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
      .map(escapeRe)
      .join("|");
  const re = new RegExp(
    `(?<!\\d)(?:(${alt(stems.keys())})(?![A-Za-z0-9_])|(${alt(versions.keys())})(?!\\d))`,
    "g",
  );
  return (line, onBare) =>
    line.replace(re, (whole, stem, version) => {
      if (stem) return stems.get(stem);
      onBare?.(version);
      return versions.get(version);
    });
}

function invert(map) {
  return Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
}

// 1-based numbers of the lines a unified -U0 diff adds.
export function addedLineNumbers(diff) {
  const lines = new Set();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

// Text a blob holds, or null when it isn't UTF-8 text git would diff.
function asText(buf) {
  if (buf.includes(0)) return null;
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? text : null;
}

// Rewrites `text`'s lines in `added` (null: all of them). Returns {text, bare}.
export function rewriteLines(text, added, rewrite) {
  const bare = [];
  const lines = text.split("\n").map((line, i) => {
    if (added && !added.has(i + 1)) return line;
    return rewrite(line, (v) => bare.push({ line: i + 1, version: v }));
  });
  return { text: lines.join("\n"), bare };
}

// ── git ─────────────────────────────────────────────────────────────────────

// Strip git plumbing variables a caller (a hook) may have set, so every call
// reads the repo at `cwd` and its real index.
function baseEnv(extra = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extra };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

export function makeGit(cwd) {
  return function git(args, { allowFail = false, input, env, timeoutMs, buffer = false } = {}) {
    const res = spawnSync("git", args, {
      cwd,
      input,
      env: baseEnv(env),
      encoding: buffer ? "buffer" : "utf8",
      maxBuffer: 256 * 1024 * 1024,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    if (res.error && !allowFail) {
      throw new Error(`git ${args.join(" ")} failed: ${res.error.message}`);
    }
    const status = typeof res.status === "number" ? res.status : 128;
    if (status !== 0 && !allowFail) {
      throw new Error(`git ${args.join(" ")} exited ${status}: ${String(res.stderr ?? "").trim()}`);
    }
    return {
      status,
      stdout: res.stdout ?? (buffer ? Buffer.alloc(0) : ""),
      stderr: String(res.stderr ?? ""),
    };
  };
}

function firstLine(res) {
  return String(res.stderr || res.stdout || "")
    .trim()
    .split("\n")[0];
}

function revParse(git, ref) {
  const res = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
  return res.status === 0 ? res.stdout.trim() : null;
}

// Basenames of the *.sql files directly under supabase/migrations in <ref>.
function migrationNamesAt(git, ref) {
  return git(["ls-tree", "-z", "--name-only", ref, "--", `${MIGRATIONS_DIR}/`])
    .stdout.split("\0")
    .filter((p) => p.endsWith(".sql") && path.posix.dirname(p) === MIGRATIONS_DIR)
    .map((p) => path.posix.basename(p));
}

function blobAt(git, ref, filePath) {
  return git(["cat-file", "blob", `${ref}:${filePath}`], { buffer: true }).stdout;
}

function modeAt(git, ref, filePath) {
  const line = git(["ls-tree", "-z", ref, "--", filePath]).stdout.split("\0")[0];
  return /^(\d{6}) /.exec(line)?.[1] ?? null;
}

function changedPaths(git, from, to) {
  return git(["diff", "--name-only", "--no-renames", "-z", from, to, "--"])
    .stdout.split("\0")
    .filter(Boolean);
}

function addedLinesOf(git, mb, head, filePath) {
  const diff = git([
    "diff",
    "-U0",
    "--no-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--diff-algorithm=myers",
    mb,
    head,
    "--",
    filePath,
  ]).stdout;
  return addedLineNumbers(diff);
}

// Does <ref>'s tree mention <text> anywhere, in a path or a file's content?
function treeMentions(git, refs, text) {
  for (const ref of refs) {
    if (git(["grep", "-q", "-F", "-e", text, ref, "--"], { allowFail: true }).status === 0) {
      return true;
    }
    const paths = git(["ls-tree", "-r", "-z", "--name-only", ref]).stdout;
    if (paths.includes(text)) return true;
  }
  return false;
}

// A bare version can be rewritten only if it can mean nothing else: the merge
// base never mentions it (the PR's lines were written against that tree), and
// every head file with that version moves to the same new one. Map: old
// version → boolean.
function bareSafety(git, map, headNames, mb) {
  const out = new Map();
  for (const v of new Set(Object.keys(map).map(versionOf))) {
    const users = headNames.filter((n) => versionOf(n) === v);
    const targets = new Set(users.map((n) => (map[n] ? versionOf(map[n]) : null)));
    out.set(v, !targets.has(null) && targets.size === 1 && !treeMentions(git, [mb], v));
  }
  return out;
}

// ── the renumber ────────────────────────────────────────────────────────────

// Plans the renumber of <head> against <main> and, when it's fixable, works
// out every file change in memory. Nothing is written. Returns the plan plus
// {mb, changes: [{path, removes?, mode, content}]}.
export function computeRenumber({ cwd, head, main, extraTaken = [], today = new Date() }) {
  const git = makeGit(cwd);
  const mb = git(["merge-base", head, main]).stdout.trim();
  const mbNames = migrationNamesAt(git, mb);
  const headNames = migrationNamesAt(git, head);
  const mainNames = migrationNamesAt(git, main);
  const mbSet = new Set(mbNames);
  const read = (ref, names) =>
    Object.fromEntries(
      names
        .filter((n) => !mbSet.has(n))
        .map((n) => [n, blobAt(git, ref, migrationPath(n)).toString("utf8")]),
    );
  const prSql = read(head, headNames);
  const mainSql = read(main, mainNames);
  const base = { head, main, mb };

  let taken = [...extraTaken];
  let plan;
  for (let round = 0; ; round++) {
    plan = planRenumber({
      mbNames,
      headNames,
      mainNames,
      extraTaken: taken,
      today,
      prSql,
      mainSql,
    });
    if (plan.status !== "fixable") return { ...base, ...plan, changes: [] };
    const fresh = Object.values(plan.map).map(versionOf);
    const mentioned = fresh.filter((v) => treeMentions(git, [head, main], v));
    if (mentioned.length === 0) break;
    if (round >= MAX_REPLANS) {
      return {
        ...base,
        ...plan,
        status: "manual",
        changes: [],
        reason: `every version tried already occurs in the repo as text (${mentioned.join(", ")})`,
      };
    }
    taken = [...taken, ...mentioned];
  }

  const map = plan.map;
  const rewrite = makeRewriter(map);
  const oldVersions = [...new Set(Object.keys(map).map(versionOf))];
  const bareSafe = bareSafety(git, map, headNames, mb);

  const changes = [];
  const unsafe = [];
  const mapped = new Set(Object.keys(map).map(migrationPath));
  for (const filePath of changedPaths(git, mb, head)) {
    const mode = modeAt(git, head, filePath);
    if (!mode || mode === "160000" || mode === "120000") continue;
    const buf = blobAt(git, head, filePath);
    const isMapped = mapped.has(filePath);
    const text = asText(buf);
    if (text === null) {
      if (isMapped) {
        return {
          ...base,
          ...plan,
          status: "manual",
          changes: [],
          reason: `\`${filePath}\` isn't text`,
        };
      }
      continue;
    }
    if (!isMapped && !oldVersions.some((v) => text.includes(v))) continue;
    const added = isMapped ? null : addedLinesOf(git, mb, head, filePath);
    const out = rewriteLines(text, added, rewrite);
    for (const b of out.bare) {
      if (!bareSafe.get(b.version)) unsafe.push(`${filePath}:${b.line} (${b.version})`);
    }
    if (isMapped) {
      const newName = map[path.posix.basename(filePath)];
      const target = migrationPath(newName);
      if (modeAt(git, head, target)) {
        return { ...base, ...plan, status: "manual", changes: [], reason: `\`${target}\` exists` };
      }
      changes.push({ path: target, removes: filePath, mode, content: out.text });
    } else if (out.text !== text) {
      changes.push({ path: filePath, mode, content: out.text });
    }
  }
  const renamed = new Set(changes.filter((c) => c.removes).map((c) => c.removes));
  const missing = [...mapped].filter((p) => !renamed.has(p));
  if (missing.length > 0) {
    return {
      ...base,
      ...plan,
      status: "manual",
      changes: [],
      reason: `\`${missing.join("`, `")}\` isn't a file this PR changes`,
    };
  }
  if (unsafe.length > 0) {
    return {
      ...base,
      ...plan,
      status: "manual",
      changes: [],
      reason:
        `lines this PR added name a version without its file name, and the version could ` +
        `mean another migration: ${unsafe.join(", ")}`,
    };
  }
  return { ...base, ...plan, changes };
}

function commitMessage(map) {
  const rows = Object.entries(map).map(([a, b]) => `${a} -> ${b}`);
  return [
    "chore(migrations): renumber this PR's migrations after main moved",
    "",
    ...rows,
    "",
    "Renamed mechanically by the dark factory (ADR-0077): only these file",
    "names and the references this PR added to them changed.",
    "",
  ].join("\n");
}

// Writes commit R (parent <head>) from `changes` with a temporary index, so
// no checkout or worktree is touched. Returns R's SHA.
export function writeRenumberCommit({ cwd, head, changes, map }) {
  const git = makeGit(cwd);
  const dir = mkdtempSync(path.join(tmpdir(), "migration-renumber-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    git(["read-tree", head], { env });
    const records = [];
    for (const ch of changes) {
      if (ch.removes) records.push(`0 ${ZERO_SHA}\t${ch.removes}`);
      const sha = git(["hash-object", "-w", "--no-filters", "--stdin"], {
        input: Buffer.from(ch.content, "utf8"),
      }).stdout.trim();
      records.push(`${ch.mode} ${sha}\t${ch.path}`);
    }
    git(["update-index", "-z", "--index-info"], {
      env,
      input: records.map((r) => `${r}\0`).join(""),
    });
    const tree = git(["write-tree"], { env }).stdout.trim();
    return git(["commit-tree", "--no-gpg-sign", tree, "-p", head, "-F", "-"], {
      input: commitMessage(map),
      env: {
        GIT_AUTHOR_NAME: IDENTITY.name,
        GIT_AUTHOR_EMAIL: IDENTITY.email,
        GIT_COMMITTER_NAME: IDENTITY.name,
        GIT_COMMITTER_EMAIL: IDENTITY.email,
      },
    }).stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── verification ────────────────────────────────────────────────────────────

function checkLines({ oldText, newText, added, forward, inverse, bareSafe, label, reasons }) {
  if (oldText === null || newText === null) {
    reasons.push(`${label} isn't text`);
    return;
  }
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length !== b.length) {
    reasons.push(`${label} gained or lost lines`);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const bare = [];
    if (added && !added.has(i + 1)) {
      reasons.push(`${label}:${i + 1} changes a line this PR didn't add`);
    } else if (forward(a[i], (v) => bare.push(v)) !== b[i] || inverse(b[i]) !== a[i]) {
      reasons.push(`${label}:${i + 1} changes more than the migration names`);
    } else if (bare.some((v) => !bareSafe.get(v))) {
      reasons.push(`${label}:${i + 1} rewrites a version that could mean another migration`);
    }
  }
}

function parseDiffTree(raw) {
  // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0
  const parts = raw.split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i]);
    if (!m) break;
    out.push({ srcMode: m[1], dstMode: m[2], status: m[3], path: parts[i + 1] });
  }
  return out;
}

// Is <to> exactly the mechanical renumber of <from> under <map>? Every changed
// path must be a mapped rename of a migration the PR adds, or a file the PR
// already changes; every changed line must be one the PR added and must map
// back to its old text under the inverse map; and no new version may occur in
// <from>'s tree, so that inverse is unambiguous. <mb> defaults to the merge
// base of <from> and origin/main. Returns {ok, reasons}.
export function verifyRenumber({ cwd, from, to, map, mb, mainRef = "refs/remotes/origin/main" }) {
  const git = makeGit(cwd);
  const reasons = [];
  const entries = Object.entries(map ?? {});
  if (entries.length === 0) reasons.push("the map is empty");
  const targets = new Set();
  for (const [a, b] of entries) {
    const ok =
      isValidMigrationName(a) &&
      isValidMigrationName(b) &&
      a.endsWith(".sql") &&
      b.endsWith(".sql") &&
      nameOf(a) === nameOf(b) &&
      versionOf(a) !== versionOf(b) &&
      !targets.has(b) &&
      !(b in map);
    if (!ok) reasons.push(`bad map entry ${a} -> ${b}`);
    targets.add(b);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const fromSha = revParse(git, from);
  const toSha = revParse(git, to);
  if (!fromSha || !toSha) return { ok: false, reasons: ["a commit isn't in the local repo"] };
  const parents = git(["rev-list", "--parents", "-n", "1", toSha]).stdout.trim().split(" ");
  if (parents.length !== 2 || parents[1] !== fromSha) {
    reasons.push(`${toSha.slice(0, 12)}'s only parent must be ${fromSha.slice(0, 12)}`);
  }
  const base = mb ?? git(["merge-base", fromSha, mainRef], { allowFail: true }).stdout.trim() ?? "";
  if (!base) return { ok: false, reasons: [...reasons, "no merge base with main"] };

  const forward = makeRewriter(map);
  const inverse = makeRewriter(invert(map));
  const mbNames = new Set(migrationNamesAt(git, base));
  const fromList = migrationNamesAt(git, fromSha);
  const fromNames = new Set(fromList);
  const bareSafe = bareSafety(git, map, fromList, base);
  const prChanged = new Set(changedPaths(git, base, fromSha));
  const changed = parseDiffTree(
    git(["diff-tree", "-r", "--no-renames", "-z", fromSha, toSha]).stdout,
  );
  const byPath = new Map(changed.map((e) => [e.path, e]));
  const expected = new Set();
  for (const [a, b] of entries) {
    const oldPath = migrationPath(a);
    const newPath = migrationPath(b);
    expected.add(oldPath);
    expected.add(newPath);
    if (!fromNames.has(a) || mbNames.has(a)) {
      reasons.push(`${a} isn't a migration this PR adds`);
      continue;
    }
    const del = byPath.get(oldPath);
    const add = byPath.get(newPath);
    if (del?.status !== "D" || add?.status !== "A") {
      reasons.push(`${a} wasn't renamed to ${b}`);
      continue;
    }
    if (del.srcMode !== add.dstMode) reasons.push(`${b} changed mode`);
    checkLines({
      oldText: asText(blobAt(git, fromSha, oldPath)),
      newText: asText(blobAt(git, toSha, newPath)),
      added: null,
      forward,
      inverse,
      bareSafe,
      label: newPath,
      reasons,
    });
  }
  for (const e of changed) {
    if (expected.has(e.path)) continue;
    if (e.status !== "M") {
      reasons.push(`${e.path}: unexpected ${e.status}`);
      continue;
    }
    if (!prChanged.has(e.path)) {
      reasons.push(`${e.path} isn't a file this PR changes`);
      continue;
    }
    if (e.srcMode !== e.dstMode) reasons.push(`${e.path} changed mode`);
    checkLines({
      oldText: asText(blobAt(git, fromSha, e.path)),
      newText: asText(blobAt(git, toSha, e.path)),
      added: addedLinesOf(git, base, fromSha, e.path),
      forward,
      inverse,
      bareSafe,
      label: e.path,
      reasons,
    });
  }
  for (const v of new Set(Object.values(map).map(versionOf))) {
    if (treeMentions(git, [fromSha], v))
      reasons.push(`${v} already occurs in ${fromSha.slice(0, 12)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ── remote ──────────────────────────────────────────────────────────────────

// Fetch main and the PR head into <cwd>, the way the verify lane fetches.
// Returns {ok, main, detail}.
export function fetchPr({ cwd, pr, remote = "origin" }) {
  const git = makeGit(cwd);
  const res = git(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      remote,
      `+refs/heads/main:refs/remotes/${remote}/main`,
      `refs/pull/${pr}/head`,
    ],
    { allowFail: true, timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (res.status !== 0) return { ok: false, detail: firstLine(res) };
  return { ok: true, main: revParse(git, `refs/remotes/${remote}/main`) };
}

// Push <sha> to <branch> without force: a branch that moved since the plan
// rejects it. A lost response is told apart from a rejection with ls-remote.
// Returns {pushed, remoteSha?, detail?}.
export function pushRenumber({ cwd, sha, branch, remote = "origin" }) {
  if (!FACTORY_BRANCH_RE.test(branch)) {
    throw new Error(`refusing to push to ${branch}: not a factory branch`);
  }
  const git = makeGit(cwd);
  const res = git(["push", "--quiet", remote, `${sha}:refs/heads/${branch}`], {
    allowFail: true,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (res.status === 0) return { pushed: true };
  const ls = git(["ls-remote", remote, `refs/heads/${branch}`], {
    allowFail: true,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  const remoteSha = ls.status === 0 ? ls.stdout.trim().split(/\s+/)[0] || null : null;
  if (remoteSha === sha) return { pushed: true, confirmed: true };
  return { pushed: false, remoteSha, detail: firstLine(res) };
}

function runGh(args) {
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    timeout: ghTimeoutMs(),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")} failed: ${String(res.stderr ?? res.error ?? "").trim()}`,
    );
  }
  return res.stdout;
}

// Migration files other open PRs add or change: [{pr, file}]. `gh pr diff
// --name-only` has no file cap (`gh pr view --json files` stops at 100).
export function claimedVersions({ excludePr, gh = runGh } = {}) {
  const list = JSON.parse(
    gh(["pr", "list", "--repo", REPO, "--state", "open", "--json", "number", "--limit", "200"]),
  );
  const out = [];
  for (const { number } of list) {
    if (String(number) === String(excludePr)) continue;
    for (const p of gh(["pr", "diff", String(number), "--repo", REPO, "--name-only"]).split("\n")) {
      if (/^supabase\/migrations\/[^/]+\.sql$/.test(p.trim())) {
        out.push({ pr: number, file: path.posix.basename(p.trim()) });
      }
    }
  }
  return out;
}

function claimedToVersions(claimed) {
  return claimed
    .map((c) => (typeof c === "string" ? c : (c?.file ?? "")))
    .map((c) => versionOf(c) ?? (/^\d{14}$/.test(c) ? c : null))
    .filter(Boolean);
}

// ── comments ────────────────────────────────────────────────────────────────

const DOC = "docs/operations/migrations.md";

// The issue comment for a pushed renumber: the map and the dev repair.
export function renumberComment({ pr, to, map, findings = [] }) {
  const rows = Object.entries(map).map(([a, b]) => `| \`${a}\` | \`${b}\` |`);
  const repair = [];
  for (const [a, b] of Object.entries(map)) {
    repair.push(`supabase migration repair --status reverted ${versionOf(a)}`);
    repair.push(`supabase migration repair --status applied ${versionOf(b)}`);
  }
  const shared = findings
    .filter((f) => f.reason === "duplicate-base" && map[f.file])
    .map(
      (f) =>
        `- \`${f.version}\` is also the version of main's \`${(f.others ?? []).join("`, `")}\`. ` +
        "Dev keeps one row per version, so check which of the two files dev actually ran " +
        "(for example, whether its objects exist). Repair only if it ran this PR's file. If it " +
        "ran main's, this PR's migration never ran on dev: `supabase db push` applies it under " +
        "the new version, with no repair.",
    );
  return [
    `🏭 **Renumbered PR #${pr}'s migrations after \`main\` moved.**`,
    "",
    `\`main\` gained migrations that this PR's versions no longer sort after, so the factory ` +
      `renamed them on the branch (\`${to.slice(0, 12)}\`), and GitHub's update-branch merges \`main\` in on top. The ` +
      "commit changes only these file names and the references this PR added to them, and a " +
      "check proves it, so the card keeps its review and approval.",
    "",
    "| Old | New |",
    "| --- | --- |",
    ...rows,
    "",
    "**Dev needs a repair only if it already applied an old version** (`supabase migration list` " +
      "with dev linked shows it). Then, with dev (`huhzactreblzcogqkbsd`) linked:",
    "",
    "```bash",
    ...repair,
    "```",
    "",
    "Both commands only edit dev's migration history; no SQL runs again.",
    ...(shared.length > 0 ? ["", ...shared] : []),
    "",
    `Prod needs nothing: it is pushed only from \`main\`, after the merge. See \`${DOC}\`, ` +
      '"Migration versions must sort last" (ADR-0077).',
  ].join("\n");
}

// The issue comment when the factory can't renumber the PR itself. The card
// isn't held: it takes the path it took before ADR-0077, so the fix loop's
// "Migration order" recipe renumbers it and a person checks that rename.
export function manualComment({ pr, reason, where = "its column" }) {
  const approved = where === "Approved";
  return [
    `🏭 **PR #${pr}'s migrations need renumbering, and the factory can't do it mechanically.**`,
    "",
    `Reason: ${reason}.`,
    "",
    "The fix loop renumbers them instead, as it did before ADR-0077: with CI red for " +
      "migration order, its pass in **In Review** renames them with the `git mv` lines " +
      "`pnpm migration:check` prints, and the card comes back to In Test." +
      (approved
        ? " From **Approved** that means the card goes back to In Review and needs your approval again."
        : "") +
      " Check that rename before you approve it, above all when the reason is SQL that " +
      "touches an object one of main's newer migrations also touches: the new version " +
      `decides which definition runs last. See \`${DOC}\`, "Migration versions must sort last" (ADR-0077).`,
  ].join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseToday(value) {
  if (!value) return new Date();
  const d = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`--today must be YYYY-MM-DD, got ${value}`);
  return d;
}

function requireFlag(flags, name, re = /^\S+$/) {
  const v = flags[name];
  if (v === undefined || !re.test(String(v))) throw new Error(`--${name} is required`);
  return String(v);
}

function summarize(r) {
  return {
    status: r.status,
    head: r.head,
    mb: r.mb,
    main: r.main,
    map: r.map ?? {},
    reason: r.reason ?? "",
    overlap: r.overlap ?? [],
    findings: r.findings ?? [],
  };
}

// precheck and the first half of apply.
function plan(flags, { gh } = {}) {
  const cwd = flags.root ?? DEFAULT_ROOT;
  const pr = requireFlag(flags, "pr", /^\d+$/);
  const head = requireFlag(flags, "head", /^[0-9a-f]{7,40}$/);
  const today = parseToday(flags.today);
  const fetched = fetchPr({ cwd, pr, remote: flags.remote ?? "origin" });
  if (!fetched.ok || !fetched.main) {
    return { status: "unreachable", head, reason: fetched.detail ?? "no origin/main" };
  }
  const git = makeGit(cwd);
  const headSha = revParse(git, head);
  if (!headSha) return { status: "unreachable", head, reason: `${head} isn't in the fetched PR` };
  const given = flags["claimed-json"] !== undefined;
  let claimed = given ? JSON.parse(flags["claimed-json"]) : [];
  if (!Array.isArray(claimed)) throw new Error("--claimed-json must be a JSON array");
  const run = () =>
    computeRenumber({
      cwd,
      head: headSha,
      main: fetched.main,
      extraTaken: claimedToVersions(claimed),
      today,
    });
  let r = run();
  if (r.status === "fixable" && !given) {
    claimed = claimedVersions({ excludePr: pr, gh });
    r = run();
  }
  return { ...r, cwd, claimed };
}

export function main(argv, { gh } = {}) {
  const [sub, ...rest] = argv;
  const { flags } = parseFlags(rest);
  const where = flags.where ?? "its column";
  switch (sub) {
    case "precheck": {
      const r = plan(flags, { gh });
      const out = summarize(r);
      if (r.status === "manual")
        out.comment = manualComment({ pr: flags.pr, reason: r.reason, where });
      return { out, code: 0 };
    }
    case "apply": {
      const issue = requireFlag(flags, "issue", /^\d+$/);
      const branch = `factory/issue-${issue}`;
      if (!FACTORY_BRANCH_RE.test(branch)) throw new Error(`refusing branch ${branch}`);
      const r = plan(flags, { gh });
      const out = { ...summarize(r), from: r.head ?? flags.head };
      if (r.status === "manual") {
        out.comment = manualComment({ pr: flags.pr, reason: r.reason, where });
      }
      if (r.status !== "fixable") return { out, code: 0 };
      const to = writeRenumberCommit({ cwd: r.cwd, head: r.head, changes: r.changes, map: r.map });
      const check = verifyRenumber({ cwd: r.cwd, from: r.head, to, map: r.map, mb: r.mb });
      if (!check.ok) {
        const reason = `the renumber commit failed its own check (${check.reasons.join("; ")})`;
        return {
          out: {
            ...out,
            status: "manual",
            to,
            reason,
            comment: manualComment({ pr: flags.pr, reason, where }),
          },
          code: 0,
        };
      }
      const pushed = pushRenumber({
        cwd: r.cwd,
        sha: to,
        branch,
        remote: flags.remote ?? "origin",
      });
      if (!pushed.pushed) {
        return {
          out: {
            ...out,
            status: "rejected",
            to,
            reason: `push to ${branch} refused (${pushed.detail ?? "no detail"}); the branch is at ${pushed.remoteSha ?? "unknown"}`,
          },
          code: 0,
        };
      }
      return {
        out: {
          ...out,
          status: "pushed",
          to,
          comment: renumberComment({ pr: flags.pr, to, map: r.map, findings: r.findings }),
        },
        code: 0,
      };
    }
    case "verify": {
      const cwd = flags.root ?? DEFAULT_ROOT;
      const from = requireFlag(flags, "from", /^[0-9a-f]{7,40}$/);
      const to = requireFlag(flags, "to", /^[0-9a-f]{7,40}$/);
      const map = JSON.parse(requireFlag(flags, "map", /^[\s\S]+$/));
      const git = makeGit(cwd);
      if ((!revParse(git, from) || !revParse(git, to)) && flags.issue) {
        // Objects from an earlier tick may have been pruned; the PR branch has both.
        git(
          [
            "fetch",
            "--quiet",
            "--no-tags",
            flags.remote ?? "origin",
            `refs/heads/factory/issue-${requireFlag(flags, "issue", /^\d+$/)}`,
          ],
          { allowFail: true, timeoutMs: NETWORK_TIMEOUT_MS },
        );
      }
      const result = verifyRenumber({ cwd, from, to, map, mb: flags.mb });
      return { out: result, code: result.ok ? 0 : 1 };
    }
    default:
      throw new Error(
        "Usage: migration-renumber.mjs <precheck --pr <n> --head <sha>|" +
          "apply --issue <i> --pr <n> --head <sha>|verify --from <sha> --to <sha> --map <json>> " +
          "[--root <repo>] [--claimed-json <json>] [--today YYYY-MM-DD] [--where <column>]",
      );
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const { out, code } = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = code;
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exitCode = 1;
  }
}
