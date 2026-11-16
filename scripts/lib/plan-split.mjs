#!/usr/bin/env node
// Plan size and split on request (ADR-0083).
//
// Every plan carries a size estimate and a marker,
// <!-- drafto-factory-plan-size:<class>:<estLines> -->, which bash reads from
// the OWNER plan comment to keep the factory-oversize label in step
// (parsePlanSize, in factory-bundle.mjs).
//
// When the operator asks on a Plan Review card for it to be split, the planner
// writes one factory spec per sub-card into <replyDir>/split/NN.md and ends
// with action=split. The planner reads untrusted issue text, and bash files
// the sub-issues publicly under the owner's identity, so these files are
// untrusted data and this module is the gate, not the prompt: bash creates
// nothing unless every file passes `validate`. A file is checked for its
// shape (a title, a "Depends on" line, then the form's sections), its size,
// and the plan probe's secret scan (plan-probe.mjs). Then it is sanitised:
// every HTML comment goes (a forged support footer or factory marker), every
// "drafto-factory" token is broken, and every @mention gets a zero-width space,
// so a sub-issue can't ping anyone. Bash runs the spec gate it runs on a fresh
// issue (spec_missing_section) on each part's parsed spec, then creates the
// issues in order, composing each body with `compose`.
//
// No problem text ever quotes a file's content: the problems go into a public
// comment.
//
// CLI (each prints one JSON document; exit 0, 1 on an error, 2 on a usage
// error):
//   size       stdin: a plan comment body. Prints {sizeClass, estLines} or null.
//   validate   --dir D --account-file F --signin-key-file F --bypass-file F
//              --secrets-dir D
//              Prints {ok, problems, scanProblems, parts}. Each part is
//              {part, file, title, dependsOn, spec, body}.
//   compose    --part K --issue N [--created '{"1":123}']
//              stdin: validate's JSON. Prints part K's issue body, with its
//              "Depends on" line naming the issues already created.

import * as nodeFs from "node:fs";
import path from "node:path";

import { neutralizeMentions, sanitizeVendorText } from "./coderabbit-review.mjs";
import { parsePlanSize, parseSpec } from "./factory-bundle.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { loadSecrets, scanText } from "./plan-probe.mjs";

export const SPLIT_MIN_PARTS = 2;
export const SPLIT_MAX_PARTS = 4;
// A spec, not a plan: GitHub takes 65,536 characters, but a sub-card's spec
// that needs more than this isn't a small card.
export const SPLIT_FILE_MAX_BYTES = 20_000;
export const SPLIT_TITLE_MAX = 120;
const SPLIT_FILE_RE = /^0[1-9]\.md$/;
// The factory's issue titles are conventional-commit subjects (CLAUDE.md).
const TITLE_RE =
  /^(?:feat|fix|chore|docs|refactor|perf|test|build|ci|style)(?:\([a-z0-9][a-z0-9._/-]*\))?!?: \S/;
const DEPENDS_RE = /^(?:\*\*)?depends on:(?:\*\*)?\s*(.*?)\s*$/i;
/** A file name safe to quote in a public comment, or a stand-in for one. */
function safeName(name) {
  return /^[A-Za-z0-9._-]{1,40}$/.test(name) ? name : "(a file with an unusual name)";
}

/**
 * What a sub-issue may carry: no HTML comment, no factory token, and no
 * mention. Every @ GitHub could read as one gets a zero-width space, in code
 * too (coderabbit-review.mjs's neutralizeMentions): a sub-issue is posted under
 * the owner's identity, and telling code from prose is the guess that lets a
 * mention through. No length cap here: the callers check sizes first.
 */
export function sanitiseSplitText(text) {
  return neutralizeMentions(sanitizeVendorText(text, { max: Number.MAX_SAFE_INTEGER })).trim();
}

/** "none" → []; "01, 2" → [1, 2]; anything else → null. */
export function parseDependsOn(value) {
  const v = String(value ?? "").trim();
  if (/^(?:none|nothing|-|—)\.?$/i.test(v)) return [];
  const parts = v.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out = [];
  for (const p of parts) {
    const m = /^#?0?([1-9])$/.exec(p);
    if (!m) return null;
    out.push(Number(m[1]));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Split one file into its title, its "Depends on" list and its spec body (the
 * text from the first `### ` heading on). Problems are short fixed phrases,
 * never the file's own text.
 */
export function parseSplitFile(text) {
  const problems = [];
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const titleMatch = /^#\s+(.+?)\s*$/.exec(lines[i] ?? "");
  let title = "";
  if (titleMatch) {
    title = titleMatch[1];
    i++;
  } else {
    problems.push('the first line isn\'t a "# <title>" heading');
  }
  let dependsOn = null;
  let dependsLines = 0;
  let preambleText = false;
  for (; i < lines.length && !/^###\s/.test(lines[i]); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const d = DEPENDS_RE.exec(line);
    if (d) {
      dependsLines++;
      dependsOn = parseDependsOn(d[1]);
      continue;
    }
    preambleText = true;
  }
  if (dependsLines === 0) problems.push('it has no "Depends on:" line before `### What`');
  else if (dependsLines > 1) problems.push('it has more than one "Depends on:" line');
  else if (dependsOn === null) problems.push('its "Depends on" line isn\'t "none" or part numbers');
  if (preambleText) problems.push("it has text between the title and `### What`");
  const body = lines.slice(i).join("\n").trim();
  if (!body) problems.push("it has no `### ` sections");
  return { title, dependsOn: dependsOn ?? [], body, problems };
}

function isTitleOk(title) {
  return (
    typeof title === "string" &&
    title.length > 0 &&
    title.length <= SPLIT_TITLE_MAX &&
    TITLE_RE.test(title) &&
    // eslint-disable-next-line no-control-regex -- a title is one plain line
    !/[\u0000-\u001f\u007f<>]/.test(title)
  );
}

/**
 * The secrets a split's files are scanned for: the plan probe's, failing
 * closed the same way, except that the browser account and sign-in key files
 * may be absent (a Mac with no browser runner has no such secret to leak; both
 * live in the secrets dir, which is always scanned).
 */
export function loadSplitSecrets(paths, deps = {}) {
  const fs = deps.fs ?? nodeFs;
  const secrets = loadSecrets(paths, deps);
  const absent = (f) => !f || !fs.existsSync(f);
  secrets.problems = secrets.problems.filter(
    (p) =>
      !(p === "account-file" && absent(paths.accountFile)) &&
      !(p === "signin-key-file" && absent(paths.signinKeyFile)),
  );
  return secrets;
}

function readNoFollow(fs, file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Check every file in <dir> before anything is created. Returns
 * {ok, problems, scanProblems, parts}; `parts` is empty unless ok. Bash still
 * runs spec_missing_section on each part's `spec`.
 */
export function validateSplit(dir, { secrets, fs = nodeFs } = {}) {
  const problems = [];
  const fail = (more = [], scanProblems = []) => ({
    ok: false,
    problems: [...problems, ...more],
    scanProblems,
    parts: [],
  });
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return fail(["the planner wrote no split files"]);
  }
  if (!st.isDirectory() || st.isSymbolicLink())
    return fail(["the split directory isn't a directory"]);
  if (!secrets || (secrets.problems ?? []).length > 0) {
    // A scan that couldn't load every secret can't vouch for anything. The
    // names go to the log only: they name files on the Mac mini.
    return fail(
      ["the secret scan couldn't load every secret on the Mac mini (see the factory log)"],
      secrets?.problems ?? ["no-secrets"],
    );
  }
  const names = fs.readdirSync(dir).sort();
  const files = [];
  for (const name of names) {
    if (SPLIT_FILE_RE.test(name)) files.push(name);
    else problems.push(`unexpected entry in the split directory: ${safeName(name)}`);
  }
  if (files.length < SPLIT_MIN_PARTS || files.length > SPLIT_MAX_PARTS) {
    problems.push(
      `there are ${files.length} split files; a split needs ${SPLIT_MIN_PARTS} to ${SPLIT_MAX_PARTS}`,
    );
  }
  if (files.some((name, k) => name !== `0${k + 1}.md`)) {
    problems.push("the split files aren't numbered 01.md, 02.md, … with no gap");
  }
  if (problems.length > 0) return fail();

  const parts = [];
  for (const [k, name] of files.entries()) {
    const part = k + 1;
    const file = path.join(dir, name);
    const fst = fs.lstatSync(file);
    if (fst.isSymbolicLink() || !fst.isFile()) {
      problems.push(`${name}: not a regular file`);
      continue;
    }
    if (fst.nlink > 1) {
      problems.push(`${name}: a hard link`);
      continue;
    }
    if (fst.size > SPLIT_FILE_MAX_BYTES) {
      problems.push(`${name}: larger than ${SPLIT_FILE_MAX_BYTES.toLocaleString("en-US")} bytes`);
      continue;
    }
    const buf = readNoFollow(fs, file);
    if (buf.includes(0)) {
      problems.push(`${name}: not text`);
      continue;
    }
    const raw = buf.toString("utf8");
    if (scanText(raw, secrets).length > 0) {
      problems.push(`${name}: matches the factory's secret scan`);
      continue;
    }
    const parsed = parseSplitFile(raw);
    for (const p of parsed.problems) problems.push(`${name}: ${p}`);
    if (parsed.title && !isTitleOk(parsed.title)) {
      problems.push(
        `${name}: the title isn't a conventional-commit subject (\`feat: …\`) of at most ${SPLIT_TITLE_MAX} characters, with no \`<\` or \`>\``,
      );
    }
    if (parsed.dependsOn.some((d) => d >= part)) {
      problems.push(`${name}: it depends on itself or on a later part`);
    }
    const body = sanitiseSplitText(parsed.body);
    const title = sanitiseSplitText(parsed.title);
    // Scanned again after sanitising: removing an HTML comment can join a
    // secret that the comment split in two.
    if (scanText(`${title}\n${body}`, secrets).length > 0) {
      problems.push(`${name}: matches the factory's secret scan`);
      continue;
    }
    parts.push({
      part,
      file: name,
      title,
      dependsOn: parsed.dependsOn,
      // The gate checks what the issue will carry, so it parses the
      // sanitised body.
      spec: parseSpec(body),
      body,
    });
  }
  if (problems.length > 0) return fail();
  return { ok: true, problems: [], scanProblems: [], parts };
}

/**
 * Part <part>'s issue body: where it came from, what it depends on (the issues
 * already created for earlier parts, from <created>, {"1": 123, …}), then its
 * sanitised spec.
 */
export function composeSplitBody({ split, part, issue, created = {} }) {
  const parts = Array.isArray(split?.parts) ? split.parts : [];
  const p = parts.find((x) => x?.part === part);
  if (!p) throw new Error(`plan-split: no part ${part}`);
  if (!Number.isInteger(issue) || issue <= 0) throw new Error("plan-split: bad --issue");
  const deps = (p.dependsOn ?? []).map((d) => {
    const n = created?.[String(d)];
    if (!Number.isInteger(n) || n <= 0) throw new Error(`plan-split: part ${d} has no issue yet`);
    return `#${n}`;
  });
  return [
    `_Split from #${issue} (part ${part} of ${parts.length}) by the dark factory, at the operator's request._`,
    "",
    `**Depends on:** ${deps.length > 0 ? deps.join(", ") : "nothing; this part can start first"}`,
    "",
    String(p.body ?? "").trim(),
    "",
  ].join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function readStdin() {
  return nodeFs.readFileSync(0, "utf8");
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let flags;
  try {
    ({ flags } = parseFlags(rest));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (cmd === "size") {
    process.stdout.write(`${JSON.stringify(parsePlanSize(readStdin()))}\n`);
    return 0;
  }
  if (cmd === "validate") {
    if (!flags.dir) {
      process.stderr.write("usage: plan-split.mjs validate --dir D --secrets-dir D …\n");
      return 2;
    }
    const secrets = loadSplitSecrets({
      accountFile: flags["account-file"],
      signinKeyFile: flags["signin-key-file"],
      bypassFile: flags["bypass-file"],
      secretsDir: flags["secrets-dir"],
    });
    process.stdout.write(`${JSON.stringify(validateSplit(flags.dir, { secrets }))}\n`);
    return 0;
  }
  if (cmd === "compose") {
    const part = Number(flags.part);
    const issue = Number(flags.issue);
    if (!Number.isInteger(part) || !Number.isInteger(issue)) {
      process.stderr.write("usage: plan-split.mjs compose --part K --issue N [--created JSON]\n");
      return 2;
    }
    const split = JSON.parse(readStdin());
    const created = flags.created ? JSON.parse(flags.created) : {};
    process.stdout.write(composeSplitBody({ split, part, issue, created }));
    return 0;
  }
  process.stderr.write("usage: plan-split.mjs <size|validate|compose> …\n");
  return 2;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exitCode = 1;
  }
}
