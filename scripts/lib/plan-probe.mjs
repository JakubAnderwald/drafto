#!/usr/bin/env node
// The plan stage's browser probe: the `plan` kind of the browser runner
// (ADR-0071, extending ADR-0051).
//
// Why this exists: the planner can't see a running app. It runs --no-chrome,
// and before a PR there is no preview to open. A probe gives it one: bash
// pushes a throwaway branch, factory/plan-probe-<issue>, never a PR, and
// Vercel builds a preview of it on the dev Supabase project. The branch is main
// plus, when the planner wrote one, a minimal spike of its proposed change. The
// locked-down browser runner then runs the planner's checks there, bash
// captures an allowlist of response headers, and the result goes back to the
// planner, which folds it into the plan.
//
// The planner writes only files, into the probe's staging dir:
//   checks.md          Web steps with expected results (required)
//   headers.txt        up to MAX_HEADER_PATHS paths whose headers bash records
//   spike/apps/web/…   complete new contents of the files the spike changes
// Everything else is this module's: it validates and scans those files, builds
// the probe commit with git plumbing (a temp index; no checkout, no hooks, no
// filters), pushes and deletes the branch with leases, reads the preview's
// state, captures headers, composes the one report comment bash posts, and
// keeps the per-issue record (planProbe* in factory-state.json). Bash calls it
// under the factory loop's mutex, so the record is never written concurrently.
//
// The repo is public, and a probe commit stays reachable by SHA after its
// branch is deleted, so nothing leaves the Mac mini unscanned: every file the
// planner wrote is scanned for the factory's secrets (and every value in
// ~/drafto-secrets) before a commit is built, and the commit message is fixed.
// The report is built from model and page output, so every piece of it is
// defanged (no hidden HTML comment, no `drafto-factory` token) and the whole
// comment is scanned again before bash may post it.
//
// CLI (every command prints one JSON line; exit 0, 1 on an error, 2 on a usage
// error):
//   availability --state-file F --issue N --phase P --enabled 0|1 --kind-on 0|1
//                --platforms <csv> --max-rounds M
//   stage        --state-file F --issue N --root D
//   finalize     --state-file F --issue N --root D --repo-root R --action A
//                --main-sha S --max-rounds M --spike 0|1 --account-file F
//                --signin-key-file F --bypass-file F --secrets-dir D [--dry-run 1]
//   candidates   --state-file F
//   preview-state --state-file F --issue N
//   capture-headers --state-file F --issue N --root D --origin O --bypass-file F
//   attempt      --state-file F --issue N --op bump|refund
//   end          --state-file F --issue N --root D --repo-root R --status S
//                [--browser B --verdict V --run-dir D --section F]
//   compose      --state-file F --issue N --root D --out F --account-file F
//                --signin-key-file F --bypass-file F
//   fold-due     --state-file F --issue N --root D --comments-file F --max-folds M
//   fold-begin   --state-file F --issue N
//   fold-end     --state-file F --issue N --comments-file F --max-folds M
//   housekeeping --state-file F --root D --repo-root R --plan-review <csv>
//                --planning <csv> --enabled 0|1 [--boards-ok 0|1] [--now ISO]

import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  COMMENT_MAX_CHARS,
  defangReport,
  literalForms,
  readAccountFile,
  truncateReport,
} from "./browser-report.mjs";
import { FACTORY_PLAN_MARKER } from "./factory-bundle.mjs";
import { getIssue, loadFactoryState, saveFactoryState } from "./factory-state.mjs";
import { ghTimeoutMs } from "./gh-timeout.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import {
  BYPASS_HEADER,
  BYPASS_KEY,
  BYPASS_VALUE_RE,
  PREVIEW_CURL_BIN,
  PREVIEW_CURL_ENV,
  PREVIEW_ORIGIN_RE,
  bypassFileProblem,
  parseEnvFile,
} from "./verify-lane.mjs";
import { readSecretValue, scanLaneText } from "./verify-report.mjs";

export const REPO = "JakubAnderwald/drafto";
export const PROBE_REF_PREFIX = "refs/heads/factory/plan-probe-";
export const PROBE_MARKER_FILE = "apps/web/.factory-plan-probe";
export const REPORT_MARKER_PREFIX = "drafto-factory-plan-probe-report:";
export const ACK_MARKER_PREFIX = "drafto-factory-plan-probe-ack:";
export const PROBE_ID_RE = /^([1-9][0-9]{0,6})-([0-9]{9,12})$/;

export const MAX_CHECK_STEPS = 15;
export const MAX_CHECKS_CHARS = 8000;
export const MAX_HEADER_PATHS = 5;
export const MAX_SPIKE_FILES = 15;
export const MAX_SPIKE_CHANGED_LINES = 400;
export const MAX_SPIKE_FILE_BYTES = 100_000;
// Minutes a queued probe may wait for its preview and a browser before it ends
// with what it has (headers only, or nothing).
export const PROBE_DEADLINE_MIN = 120;
// Probe dirs older than this are removed by housekeeping (log retention).
export const PROBE_DIR_RETENTION_DAYS = 30;

// The response headers a probe may report. Security policy headers only: no
// cookie, no Vercel header (x-vercel-*), nothing that carries a session.
export const HEADER_ALLOWLIST = Object.freeze([
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "content-type",
]);

// A probe that ended, waiting for the planner to fold its result in.
export const AWAITING_FOLD_RE = /^(reported|failed:[a-z-]+|rejected:[a-z-]+)$/;

export const probeRef = (issue) => `${PROBE_REF_PREFIX}${issue}`;
export const ackMarker = (probeId) => `<!-- ${ACK_MARKER_PREFIX}${probeId} -->`;
export const reportMarker = (probeId) => `<!-- ${REPORT_MARKER_PREFIX}${probeId} -->`;
export const commitMessage = (issue) => `chore(factory): plan probe for #${issue} (not for merge)`;

const SHA_RE = /^[0-9a-f]{40}$/;

// ── record helpers ──────────────────────────────────────────────────────────

function num(v) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** "<key>:<count>" → count when <key> matches, else 0. */
export function keyedCount(value, key) {
  const s = String(value ?? "");
  const i = s.lastIndexOf(":");
  if (i <= 0 || s.slice(0, i) !== key) return 0;
  return num(s.slice(i + 1));
}

export function probeDir(root, probeId) {
  if (!PROBE_ID_RE.test(String(probeId ?? ""))) throw new Error(`invalid probe id: ${probeId}`);
  return path.join(root, probeId);
}

// ── availability ────────────────────────────────────────────────────────────

/**
 * Whether the planner may request a probe this run, and why not. The reason
 * reaches the planner, so its reply to an operator who asked for browser
 * checks can say what stands in the way.
 */
export function availability({
  record = {},
  phase,
  enabled,
  kindOn,
  browserDisabled = false,
  platforms = [],
  maxRounds,
}) {
  const roundsUsed = num(record.planProbeRound);
  const base = { roundsUsed, maxRounds, round: roundsUsed + 1 };
  if (String(phase).toUpperCase() === "A") return { available: false, reason: "phase", ...base };
  if (!enabled) return { available: false, reason: "off", ...base };
  if (!kindOn) return { available: false, reason: "kind", ...base };
  if (browserDisabled) return { available: false, reason: "browser-disabled", ...base };
  if (!platforms.includes("web")) return { available: false, reason: "not-web", ...base };
  if (record.planProbeStatus === "queued") return { available: false, reason: "pending", ...base };
  if (roundsUsed >= maxRounds) return { available: false, reason: "cap", ...base };
  return { available: true, reason: null, ...base };
}

// ── validation ──────────────────────────────────────────────────────────────

/** checks.md: 1..MAX_CHECK_STEPS numbered steps, within the size cap. */
export function validateChecks(text) {
  const s = String(text ?? "").trim();
  if (!s) return { ok: false, reason: "checks-empty" };
  if (s.length > MAX_CHECKS_CHARS) return { ok: false, reason: "checks-too-long" };
  const steps = s.split(/\r?\n/).filter((l) => /^\s{0,3}\d{1,2}[.)]\s+\S/.test(l)).length;
  if (steps === 0) return { ok: false, reason: "checks-no-steps" };
  if (steps > MAX_CHECK_STEPS) return { ok: false, reason: "checks-too-many-steps" };
  return { ok: true, steps, text: s };
}

const HEADER_PATH_RE = /^\/[A-Za-z0-9\-._~/%?=&+,;:!*'()]*$/;

/** headers.txt: up to MAX_HEADER_PATHS same-origin paths, one per line. */
export function validateHeaderPaths(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return { ok: true, paths: [] };
  if (lines.length > MAX_HEADER_PATHS) return { ok: false, reason: "headers-too-many-paths" };
  for (const p of lines) {
    if (p.length > 300 || !HEADER_PATH_RE.test(p) || p.startsWith("//") || p.includes("..")) {
      return { ok: false, reason: "headers-bad-path" };
    }
  }
  return { ok: true, paths: [...new Set(lines)] };
}

const SPIKE_DENY_BASENAMES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  ".gitattributes",
  ".gitmodules",
  "vercel.json",
  "vercel.ts",
]);

/** Why <rel> (a repo path) can't be in a spike, or null. */
export function spikePathProblem(rel) {
  const p = String(rel ?? "");
  if (!p || /[\u0000-\u001f\u007f\\]/.test(p)) return "bad-path";
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "bad-path";
  if (segs.some((s) => s.startsWith(".env"))) return "env-file";
  if (SPIKE_DENY_BASENAMES.has(segs.at(-1))) return "denied-file";
  if (p === "apps/web/src/env.ts") return "denied-file";
  if (p.startsWith("apps/web/src/app/auth/test-sign-in/")) return "denied-file";
  if (p === "apps/web/next.config.ts") return null;
  if (!p.startsWith("apps/web/src/")) return "outside-apps-web-src";
  return null;
}

// Speed bumps on the lines a spike adds, not a wall: the planner already has a
// shell. They catch a spike that reaches for the preview's secrets or the
// network, which no plan-time check needs.
export const ADDED_LINE_RULES = Object.freeze([
  ["process-env", /process\.env(?!\.(?:NODE_ENV|VERCEL_ENV)\b)/],
  [
    "secret-name",
    /\b[A-Z0-9_]*(?:SECRET|SERVICE_ROLE|API_KEY|PRIVATE_KEY|ACCESS_TOKEN)[A-Z0-9_]*\b/,
  ],
  ["child-process", /child_process/],
  ["eval", /\beval\s*\(/],
  ["new-function", /\bnew\s+Function\b/],
  ["require", /\brequire\s*\(/],
  ["send-beacon", /sendBeacon/],
  ["websocket", /\bWebSocket\b/],
  ["remote-fetch", /\bfetch\s*\(\s*[`'"]\s*(?:https?:)?\/\//],
  ["remote-import", /\bimport\s*\(\s*[`'"]\s*(?:https?:)?\/\//],
]);

export function addedLineFindings(lines) {
  const hits = new Set();
  for (const line of lines) {
    for (const [name, re] of ADDED_LINE_RULES) if (re.test(line)) hits.add(name);
  }
  return [...hits];
}

/** Multiset line diff: the lines <next> adds and how many of <prev>'s it drops. */
export function lineDiff(prev, next) {
  const counts = new Map();
  for (const l of String(prev ?? "").split("\n")) counts.set(l, (counts.get(l) ?? 0) + 1);
  const added = [];
  for (const l of String(next ?? "").split("\n")) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else added.push(l);
  }
  let removed = 0;
  for (const c of counts.values()) removed += c;
  return { added, removed };
}

/**
 * The files under <dir>/spike, read without following any link. A symlink, a
 * hardlink (nlink > 1: it could share an inode with a secret), a non-regular
 * file, an oversized or binary file, or a path outside the allowlist is a
 * violation, and any violation drops the whole spike.
 */
export function collectSpike(dir, { fs = nodeFs } = {}) {
  const root = path.join(dir, "spike");
  const files = [];
  const violations = [];
  let rootSt;
  try {
    rootSt = fs.lstatSync(root);
  } catch {
    return { files, violations, present: false };
  }
  if (!rootSt.isDirectory()) return { files, violations: ["spike-not-a-dir"], present: true };
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(a);
      if (st.isSymbolicLink()) violations.push(`symlink:${r}`);
      else if (st.isDirectory()) walk(a, r);
      else if (!st.isFile()) violations.push(`not-a-file:${r}`);
      else if (st.nlink > 1) violations.push(`hardlink:${r}`);
      else if (st.size > MAX_SPIKE_FILE_BYTES) violations.push(`too-large:${r}`);
      else {
        const problem = spikePathProblem(r);
        if (problem) {
          violations.push(`${problem}:${r}`);
          continue;
        }
        // O_NOFOLLOW: a file swapped for a link after the lstat isn't read.
        const fd = fs.openSync(a, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        let buf;
        try {
          buf = fs.readFileSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        if (buf.includes(0)) violations.push(`binary:${r}`);
        else files.push({ path: r, content: buf.toString("utf8") });
      }
    }
  };
  walk(root, "");
  if (files.length > MAX_SPIKE_FILES) violations.push("too-many-files");
  return { files, violations, present: true };
}

/**
 * The spike's verdict against main: kept, or dropped with the reason. <prevOf>
 * returns a path's content on main ("" for a new file).
 */
export function judgeSpike(spike, prevOf) {
  if (!spike.present) return { kept: false, reason: null, files: [] };
  // Before the emptiness check: a spike whose only file was refused is a
  // dropped spike, not an absent one.
  if (spike.violations.length > 0) {
    return { kept: false, reason: spike.violations[0].split(":")[0], files: [] };
  }
  if (spike.files.length === 0) return { kept: false, reason: null, files: [] };
  let changed = 0;
  const added = [];
  const summary = [];
  for (const f of spike.files) {
    const d = lineDiff(prevOf(f.path), f.content);
    changed += d.added.length + d.removed;
    added.push(...d.added);
    summary.push({ path: f.path, added: d.added.length, removed: d.removed });
  }
  if (changed > MAX_SPIKE_CHANGED_LINES)
    return { kept: false, reason: "too-many-lines", files: [] };
  const findings = addedLineFindings(added);
  if (findings.length > 0) return { kept: false, reason: `added-${findings[0]}`, files: [] };
  return { kept: true, reason: null, files: spike.files, summary };
}

// ── secrets ─────────────────────────────────────────────────────────────────

const EXTRA_SECRET_PATTERNS = Object.freeze([
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{10,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]);

const LITERAL_MIN = 16;
const TOKEN_RE = /[A-Za-z0-9_\-+/=.]{24,}/g;
const ENV_LINE_RE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;
// Key names that hold a secret whatever the value looks like.
const SECRET_KEY_RE =
  /(?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|KEY|PRIVATE|CREDENTIAL|AUTH|BYPASS|COOKIE|SESSION)/i;
const EMAIL_RE = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+(?:\s*,\s*[^@\s,]+@[^@\s,]+\.[^@\s,]+)*$/;
// A local filesystem path: in a report it is a run dir, never a secret.
const LOCAL_PATH_RE = /^(?:~\/|\/(?:Users|home|opt|usr|var|tmp|private|Volumes|Library|etc)\/)/;

/**
 * Whether <value> (from <key>, when it came from a KEY=VALUE line) is a secret
 * the probe's texts must never carry. Not every value in ~/drafto-secrets is
 * one: the test account's email, the operator allowlist and the projects' URLs
 * are ordinary text a report may and does contain, and counting them would
 * withhold every report. A credential inside a URL still counts.
 */
export function isSecretLiteral(value, key = null) {
  const v = String(value ?? "").trim();
  if (v.length < LITERAL_MIN || LOCAL_PATH_RE.test(v)) return false;
  if (EMAIL_RE.test(v)) return false;
  if (/^https?:\/\//i.test(v)) {
    // Only a URL with a credential in it: userinfo, or a token-ish query.
    return (
      /^https?:\/\/[^/@\s]+@/i.test(v) ||
      /[?&](?:token|key|secret|sig|signature|auth|password)[^=]*=/i.test(v)
    );
  }
  if (key && SECRET_KEY_RE.test(key)) return true;
  // Anything else that looks like a token: no spaces, no '@'.
  return /^[A-Za-z0-9._~+/=:-]+$/.test(v);
}

/**
 * Every secret value in the files directly in <dir> (~/drafto-secrets): the
 * KEY=VALUE values isSecretLiteral counts, plus long token-like runs on every
 * other line (a JSON key file, a PEM, a bare token). `problems` names any file
 * or the dir itself that couldn't be read: the scan is then incomplete, and
 * callers fail closed. Never logs a value.
 */
export function secretDirLiterals(dir, { fs = nodeFs } = {}) {
  const out = [];
  const problems = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { literals: out, readable: false, problems: ["secrets-dir"] };
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let text;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue;
      if (st.size > 1_000_000) {
        problems.push(`secrets-dir:${name}`);
        continue;
      }
      text = fs.readFileSync(file, "utf8");
    } catch {
      problems.push(`secrets-dir:${name}`);
      continue;
    }
    const hit = `secrets-dir:${name}`;
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      if (isSecretLiteral(value, key)) out.push({ name: hit, value: String(value).trim() });
    }
    for (const line of text.split(/\r?\n/)) {
      if (ENV_LINE_RE.test(line)) continue;
      // "name: value" lines (a plain-text account file), judged by the name.
      const kv = /^\s*([A-Za-z][A-Za-z0-9 _-]{0,40}):\s*(\S+)\s*$/.exec(line);
      if (kv && isSecretLiteral(kv[2], kv[1])) out.push({ name: hit, value: kv[2] });
      for (const token of line.match(TOKEN_RE) ?? []) {
        if (isSecretLiteral(token)) out.push({ name: hit, value: token });
      }
    }
  }
  return { literals: out, readable: true, problems };
}

/**
 * The secret literals a probe's texts are scanned for. `problems` lists what
 * couldn't be read: the account file and the sign-in key file must be, the
 * bypass file only when it exists (a Mac mini without one has no bypass secret
 * to leak), and the secrets dir and everything in it. With any problem the
 * scan can't be trusted, and callers push and post nothing.
 */
export function loadSecrets({ accountFile, signinKeyFile, bypassFile, secretsDir }, deps = {}) {
  const fs = deps.fs ?? nodeFs;
  const problems = [];
  let password = null;
  try {
    password = readAccountFile(accountFile).password || null;
  } catch {
    password = null;
  }
  if (!password) problems.push("account-file");
  const signinKey = readSecretValue(signinKeyFile, "DEV_SUPABASE_SERVICE_ROLE_KEY");
  if (!signinKey) problems.push("signin-key-file");
  const bypass = readSecretValue(bypassFile, BYPASS_KEY);
  if (!bypass && bypassFile && fs.existsSync(bypassFile)) problems.push("bypass-file");
  let literals = [];
  if (!secretsDir) problems.push("secrets-dir");
  else {
    const dir = secretDirLiterals(secretsDir, deps);
    literals = dir.literals;
    problems.push(...dir.problems);
  }
  return { password, bypass, signinKey, literals, problems };
}

/** Hit names (never values) for <text> against <secrets>. */
export function scanText(text, secrets = {}) {
  const s = String(text ?? "");
  const hits = new Set(
    scanLaneText(s, {
      password: secrets.password ?? undefined,
      bypass: secrets.bypass ?? undefined,
      signinKey: secrets.signinKey ?? undefined,
    }),
  );
  for (const [name, re] of EXTRA_SECRET_PATTERNS) if (re.test(s)) hits.add(name);
  for (const { name, value } of secrets.literals ?? []) {
    if (literalForms(value).some((form) => s.includes(form))) hits.add(name);
  }
  return [...hits];
}

// ── git ─────────────────────────────────────────────────────────────────────

function defaultGit(repoRoot) {
  return (args, { input, env } = {}) => {
    const r = spawnSync("git", args, {
      cwd: repoRoot,
      input,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

function gitOk(git, args, opts, what) {
  const r = git(args, opts);
  if (r.code !== 0)
    throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return r.stdout.trim();
}

/** A path's content on <sha>, or "" when it doesn't exist there. */
export function contentAt(git, sha, rel) {
  const r = git(["cat-file", "blob", `${sha}:${rel}`]);
  return r.code === 0 ? r.stdout : "";
}

/**
 * The probe commit: <mainSha>'s tree plus the spike's files and the marker
 * file (which makes every probe a distinct commit that touches apps/web, so
 * Vercel always builds it). Built on a temp index with plumbing: nothing is
 * checked out, no hook or .gitattributes filter runs, and the message is fixed.
 */
export function buildCommit({ git, mainSha, issue, probeId, files = [], tmpRoot = os.tmpdir() }) {
  if (!SHA_RE.test(mainSha)) throw new Error(`invalid main sha: ${mainSha}`);
  const dir = nodeFs.mkdtempSync(path.join(tmpRoot, "plan-probe-index-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    gitOk(git, ["read-tree", mainSha], { env }, "read-tree");
    const all = [...files, { path: PROBE_MARKER_FILE, content: `${probeId}\n` }];
    for (const f of all) {
      const blob = gitOk(
        git,
        ["hash-object", "-w", "--no-filters", "--stdin"],
        { input: f.content, env },
        "hash-object",
      );
      gitOk(
        git,
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${f.path}`],
        { env },
        "update-index",
      );
    }
    const tree = gitOk(git, ["write-tree"], { env }, "write-tree");
    return gitOk(
      git,
      ["commit-tree", tree, "-p", mainSha, "-m", commitMessage(issue)],
      { env },
      "commit-tree",
    );
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The SHA <ref> points at on origin, "" when it doesn't exist, null on error. */
export function remoteRefSha(git, ref) {
  const r = git(["ls-remote", "origin", ref]);
  if (r.code !== 0) return null;
  const line = r.stdout.split("\n").find((l) => l.endsWith(`\t${ref}`));
  return line ? line.split("\t")[0] : "";
}

/** Every probe branch on origin: [{ref, sha, issue}], or null on error. */
export function listProbeRefs(git) {
  const r = git(["ls-remote", "origin", `${PROBE_REF_PREFIX}*`]);
  if (r.code !== 0) return null;
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ref] = l.split("\t");
      const m = new RegExp(`^${PROBE_REF_PREFIX}([0-9]+)$`).exec(ref ?? "");
      return m && SHA_RE.test(sha) ? { ref, sha, issue: m[1] } : null;
    })
    .filter(Boolean);
}

const PUSH = ["-c", "core.hooksPath=/dev/null", "push", "--quiet"];

/** Point <ref> at <sha> only if it is still at <expected> ("" = absent). */
export function pushRef(git, ref, sha, expected) {
  return (
    git([...PUSH, `--force-with-lease=${ref}:${expected}`, "origin", `${sha}:${ref}`]).code === 0
  );
}

/** Delete <ref> only if it is still at <expected>. */
export function deleteRef(git, ref, expected) {
  return git([...PUSH, `--force-with-lease=${ref}:${expected}`, "origin", `:${ref}`]).code === 0;
}

// ── preview ─────────────────────────────────────────────────────────────────

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return "";
  }
}

/**
 * The probe preview's state from the GitHub Deployments API, given the
 * Preview deployments for its SHA and each one's statuses (newest first, as
 * the API returns them). Only a `success` counts as ready: a failed Vercel
 * build reports `failure` with an environment_url all the same.
 */
export function previewStateFrom(deployments, statusesById) {
  const mine = (Array.isArray(deployments) ? deployments : [])
    .filter((d) => d?.creator?.login === "vercel[bot]")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (mine.length === 0) return { state: "pending" };
  for (const d of mine) {
    for (const s of statusesById[d.id] ?? []) {
      const origin = originOf(s?.environment_url);
      if (s?.state === "success" && PREVIEW_ORIGIN_RE.test(origin))
        return { state: "ready", url: origin };
    }
  }
  const latest = (statusesById[mine[0].id] ?? [])[0]?.state;
  if (latest === "failure" || latest === "error") return { state: "failed", reason: "build" };
  return { state: "building" };
}

function defaultGh(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: ghTimeoutMs(),
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function previewStateForSha(sha, { gh = defaultGh } = {}) {
  if (!SHA_RE.test(String(sha))) return { state: "unknown" };
  const list = gh(["api", `repos/${REPO}/deployments?sha=${sha}&environment=Preview&per_page=20`]);
  if (list.code !== 0) return { state: "unknown" };
  let deployments;
  try {
    deployments = JSON.parse(list.stdout);
  } catch {
    return { state: "unknown" };
  }
  const statusesById = {};
  for (const d of deployments.filter((x) => x?.creator?.login === "vercel[bot]")) {
    const st = gh(["api", `repos/${REPO}/deployments/${d.id}/statuses?per_page=30`]);
    if (st.code !== 0) return { state: "unknown" };
    try {
      statusesById[d.id] = JSON.parse(st.stdout);
    } catch {
      return { state: "unknown" };
    }
  }
  return previewStateFrom(deployments, statusesById);
}

// ── headers ─────────────────────────────────────────────────────────────────

/**
 * The allowlisted headers of one response (curl -D output). `location` is
 * reported as a same-origin path or as "off-origin", never as a URL.
 */
export function filterHeaders(raw, origin) {
  const lines = String(raw ?? "").split(/\r?\n/);
  // The last response block (curl prints one per hop; no -L means one).
  let start = 0;
  lines.forEach((l, i) => {
    if (/^HTTP\/[0-9.]+ \d{3}/.test(l)) start = i;
  });
  const m = /^HTTP\/[0-9.]+ (\d{3})/.exec(lines[start] ?? "");
  const out = { status: m ? Number(m[1]) : null, headers: [], location: null };
  for (const l of lines.slice(start + 1)) {
    const i = l.indexOf(":");
    if (i <= 0) continue;
    const name = l.slice(0, i).trim().toLowerCase();
    const value = l.slice(i + 1).trim();
    if (name === "location") {
      try {
        const u = new URL(value, origin);
        out.location = u.origin === origin ? `${u.pathname}${u.search}` : "off-origin";
      } catch {
        out.location = "off-origin";
      }
    } else if (HEADER_ALLOWLIST.includes(name)) {
      out.headers.push({ name, value: value.slice(0, 4000) });
    }
  }
  return out;
}

/** The curl config for one header capture: https only, the bypass header. */
export function headerCurlConfig(bypassSecret) {
  const lines = ['proto = "=https"', "max-time = 20", "silent", "show-error"];
  if (bypassSecret) {
    // The same check verify-lane's curlConfigText makes: anything else could
    // add curl directives (a url, an output file, a proxy) to the config.
    if (!BYPASS_VALUE_RE.test(bypassSecret)) throw new Error("bypass secret is malformed");
    lines.push(`header = "${BYPASS_HEADER}: ${bypassSecret}"`);
  }
  return lines.join("\n") + "\n";
}

function defaultCurl(args, input) {
  const r = spawnSync(PREVIEW_CURL_BIN, args, {
    input,
    env: { ...PREVIEW_CURL_ENV },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * GET each path on the probe preview and keep the allowlisted headers. The
 * bypass secret goes to curl on stdin (-K -), never in argv or a file, and
 * curl follows no redirect and keeps no cookies.
 */
export function captureHeaders(
  { origin, paths, bypassFile },
  { curl = defaultCurl, fs = nodeFs } = {},
) {
  if (!PREVIEW_ORIGIN_RE.test(String(origin))) throw new Error(`not a preview origin: ${origin}`);
  const problem = bypassFileProblem(bypassFile, fs);
  const secret = problem ? null : parseEnvFile(fs.readFileSync(bypassFile, "utf8"))[BYPASS_KEY];
  const captured = paths.map((p) => {
    const r = curl(
      ["-q", "-K", "-", "-o", "/dev/null", "-D", "-", "--", `${origin}${p}`],
      headerCurlConfig(secret),
    );
    if (r.code !== 0) return { path: p, error: `curl exit ${r.code}` };
    return { path: p, ...filterHeaders(r.stdout, origin) };
  });
  return { captured, note: problem ? `no-bypass-secret (${problem})` : null };
}

// ── report ──────────────────────────────────────────────────────────────────

const STATUS_TEXT = {
  reported: "it ran on the probe preview.",
  "failed:build":
    "the probe preview didn't build. Vercel reported the deployment as failed, and the factory can't read Vercel's build log.",
  "failed:no-preview": "no preview appeared for the probe commit in time.",
  "failed:push": "the probe branch couldn't be pushed.",
  "failed:branch-moved": "the probe branch was moved or deleted before the probe ran.",
  "failed:expired": "it didn't run before its deadline.",
  "failed:runner": "the browser runner didn't produce a result in its attempts.",
  "rejected:checks": "the checks file wasn't usable (it needs 1 to 15 numbered steps).",
  "rejected:secret":
    "a file the planner wrote matched a secret pattern, so nothing was pushed or posted.",
  "rejected:secret-scan":
    "the factory couldn't read all of its secrets to scan the planner's files, so nothing was pushed.",
  "rejected:cap": "this issue has used all its probe rounds.",
};

const BROWSER_TEXT = {
  ok: null,
  unavailable:
    "The browser was unavailable, so no check ran; only the headers below were captured.",
  "auth-expired": "The preview showed a Vercel login wall, so no check ran.",
  "signin-failed":
    "The one-time sign-in link didn't sign the runner in on the probe preview, so signed-in checks couldn't run. A spike that changes the middleware or auth can cause this.",
  blocked: "The runner stopped early on purpose (a step it refused).",
  malformed: "The runner's output had no status line, so its results can't be trusted.",
  none: "No browser check ran.",
};

/** A code fence longer than any backtick run in <text>. */
function fenceFor(text) {
  const runs = String(text).match(/`+/g) ?? [];
  const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function fenced(text, lang = "") {
  const f = fenceFor(text);
  return `${f}${lang}\n${text}\n${f}`;
}

/**
 * The one comment bash posts for a probe that ended. Every piece of it that a
 * model, a page or the spike could influence is defanged, and the whole body is
 * scanned: on a hit only a withheld notice is posted.
 */
export function composeReport({
  issue,
  record,
  probe = {},
  headers = null,
  section = null,
  result = {},
  checks = "",
  secrets = {},
  runDir = null,
}) {
  const id = record.planProbeId;
  const status = record.planProbeStatus;
  const short = (s) => String(s ?? "").slice(0, 7);
  const lines = [
    `🏭 **Plan browser probe, round ${num(record.planProbeRound) || 1}:** ${
      STATUS_TEXT[status] ?? `it ended (${defangReport(status)}).`
    }`,
    "",
  ];
  if (record.planProbeSha) {
    const spike = probe.spike ?? {};
    const spikeText = spike.kept
      ? `with the planner's spike (${spike.summary?.length ?? 0} file(s))`
      : spike.reason
        ? `without the planner's spike, which was dropped (\`${defangReport(spike.reason)}\`)`
        : "with no spike";
    const branch =
      result.deleted === false
        ? "a throwaway branch that is never a PR (it no longer pointed at the probe commit, so the factory left it; housekeeping deletes it on a later tick)"
        : "a throwaway branch that is never a PR and has now been deleted";
    lines.push(
      `The probe built \`main\` at \`${short(record.planProbeMainSha)}\` ${spikeText}, as \`${short(record.planProbeSha)}\` on ${branch}. The preview runs on the dev Supabase project, so it shows what a deployment does, not what drafto.eu does.`,
      "",
    );
    if (spike.kept && Array.isArray(spike.summary) && spike.summary.length) {
      lines.push("**Spike files:**", "");
      for (const f of spike.summary) {
        lines.push(`- \`${defangReport(f.path).replace(/`/g, "")}\` (+${f.added} / −${f.removed})`);
      }
      lines.push("");
    }
  }
  if (Array.isArray(probe.notes) && probe.notes.length) {
    lines.push(...probe.notes.map((n) => `_${defangReport(n)}_`), "");
  }
  if (headers && Array.isArray(headers.captured) && headers.captured.length) {
    const block = headers.captured
      .map((c) => {
        if (c.error) return `${c.path}\n  (${c.error})`;
        const hs = c.headers.map((h) => `  ${h.name}: ${h.value}`);
        if (c.location) hs.push(`  location: ${c.location}`);
        return [
          `${c.path} → ${c.status ?? "?"}`,
          ...(hs.length ? hs : ["  (none of the recorded headers)"]),
        ].join("\n");
      })
      .join("\n");
    lines.push(
      "**Response headers on the probe preview** (an allowlist; recorded by bash, not the browser):",
      "",
      fenced(defangReport(block), "text"),
      "",
    );
    if (headers.note) lines.push(`_${defangReport(headers.note)}_`, "");
  }
  if (status === "reported" || section) {
    const browser = result.browser ?? "none";
    if (BROWSER_TEXT[browser]) lines.push(BROWSER_TEXT[browser], "");
    if (section) lines.push(defangReport(section), "");
  }
  if (checks) {
    lines.push(
      "<details><summary>The checks the planner asked for</summary>",
      "",
      fenced(defangReport(checks), "markdown"),
      "",
      "</details>",
      "",
    );
  }
  if (runDir)
    lines.push(
      `<sub>Screenshots and the runner's output stay on the Mac mini: \`${defangReport(runDir)}\`.</sub>`,
      "",
    );
  lines.push(`<sub>The planner reads this and revises the plan for #${issue}.</sub>`);

  let body = lines.join("\n");
  // Without every secret loaded the scan proves nothing: withhold.
  const problems = Array.isArray(secrets.problems) ? secrets.problems : [];
  const hits = problems.length > 0 ? [] : scanText(body, secrets);
  if (problems.length > 0 || hits.length > 0) {
    const why =
      problems.length > 0
        ? `the secret scan couldn't read ${problems.join(", ")}, so it can't vouch for the report`
        : `the report matched a secret pattern (${hits.join(", ")})`;
    body = [
      `🏭 **Plan browser probe, round ${num(record.planProbeRound) || 1}:** report withheld.`,
      "",
      `Withheld: ${why}. The run's files stay on the Mac mini${runDir ? ` (\`${runDir}\`)` : ""}.`,
    ].join("\n");
  }
  const marker = reportMarker(id);
  const room = COMMENT_MAX_CHARS - marker.length - 200;
  if (body.length > room) body = `${truncateReport(body, room)}\n\n_…report truncated._`;
  return {
    body: `${body}\n\n${marker}\n`,
    withheld: problems.length > 0 || hits.length > 0,
    hits: problems.length > 0 ? problems.map((p) => `unreadable:${p}`) : hits,
  };
}

// ── state I/O ───────────────────────────────────────────────────────────────

async function withState(stateFile, fn) {
  const state = await loadFactoryState(stateFile);
  const out = fn(state);
  if (out?.save !== false) await saveFactoryState(state, stateFile);
  return out?.value ?? out;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writePrivate(file, text) {
  nodeFs.writeFileSync(file, text, { mode: 0o600 });
  nodeFs.chmodSync(file, 0o600);
}

function readText(file) {
  try {
    return nodeFs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// ── comments (acks) ─────────────────────────────────────────────────────────

// The same test as plan_comment_jq in factory-agent.sh: an OWNER comment that
// starts (after whitespace) with the plan marker.
const PLAN_MARKER_RE = new RegExp(
  `^\\s*${FACTORY_PLAN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
);

/** The bodies of the factory's own plan comments (OWNER, marker first). */
export function ownerPlanBodies(comments) {
  return (Array.isArray(comments) ? comments : [])
    .filter((c) => c?.authorAssociation === "OWNER" && PLAN_MARKER_RE.test(String(c?.body ?? "")))
    .map((c) => String(c.body));
}

export function planAcks(comments, probeId) {
  return ownerPlanBodies(comments).some((b) => b.includes(ackMarker(probeId)));
}

// ── commands ────────────────────────────────────────────────────────────────

const now = (flags) => (flags.now ? new Date(flags.now) : new Date());

function issueFlag(flags) {
  const n = String(flags.issue ?? "");
  if (!/^[1-9][0-9]*$/.test(n)) throw new UsageError(`invalid --issue: ${n}`);
  return n;
}

function cmdAvailability(flags) {
  const issue = issueFlag(flags);
  return withState(flags["state-file"], (state) => ({
    save: false,
    value: availability({
      record: state.issues?.[issue] ?? {},
      phase: flags.phase,
      enabled: flags.enabled === "1",
      kindOn: flags["kind-on"] === "1",
      browserDisabled: Boolean(state.browser?.disabled),
      platforms: String(flags.platforms ?? "")
        .split(",")
        .filter(Boolean),
      maxRounds: num(flags["max-rounds"]),
    }),
  }));
}

function cmdStage(flags) {
  const issue = issueFlag(flags);
  const probeId = `${issue}-${Math.floor(now(flags).getTime() / 1000)}`;
  const dir = probeDir(flags.root, probeId);
  nodeFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  nodeFs.chmodSync(dir, 0o700);
  return withState(flags["state-file"], (state) => {
    getIssue(state, issue).planProbeStaging = probeId;
    return { value: { probeId, dir } };
  });
}

const FINALIZE_ACTIONS = new Set(["planned", "replanned", "noop"]);

async function cmdFinalize(flags, deps = {}) {
  const issue = issueFlag(flags);
  const state = await loadFactoryState(flags["state-file"]);
  const rec = getIssue(state, issue);
  const probeId = rec.planProbeStaging;
  if (!probeId) return { result: "none" };
  rec.planProbeStaging = null;
  const dir = probeDir(flags.root, probeId);
  const discard = async (result, extra = {}) => {
    nodeFs.rmSync(dir, { recursive: true, force: true });
    await saveFactoryState(state, flags["state-file"]);
    return { result, probeId, ...extra };
  };
  if (!FINALIZE_ACTIONS.has(String(flags.action))) return discard("discarded");
  const checksRaw = readText(path.join(dir, "checks.md"));
  if (!checksRaw.trim()) return discard("none");

  const endRejected = async (reason) => {
    Object.assign(rec, {
      planProbeId: probeId,
      planProbeRound: String(num(rec.planProbeRound) + 1),
      planProbeStatus: `rejected:${reason}`,
      planProbeSha: null,
      planProbeMainSha: null,
      planProbeQueuedAt: now(flags).toISOString(),
      planProbeAttempts: null,
      planProbeFoldAttempts: null,
    });
    await saveFactoryState(state, flags["state-file"]);
    return { result: "rejected", reason, probeId, post: true };
  };
  if (num(rec.planProbeRound) >= num(flags["max-rounds"])) return endRejected("cap");
  const checks = validateChecks(checksRaw);
  if (!checks.ok) return endRejected("checks");

  const notes = [];
  const headersRaw = readText(path.join(dir, "headers.txt"));
  let headerPaths = [];
  const hv = validateHeaderPaths(headersRaw);
  if (hv.ok) headerPaths = hv.paths;
  else notes.push(`The headers file was ignored (${hv.reason}).`);

  const git = deps.git ?? defaultGit(flags["repo-root"]);
  const mainSha = String(flags["main-sha"] ?? "");
  if (!SHA_RE.test(mainSha)) throw new UsageError(`invalid --main-sha: ${mainSha}`);
  const spikeRaw = collectSpike(dir, deps);
  let spike = { kept: false, reason: null, files: [] };
  if (spikeRaw.present && (spikeRaw.files.length || spikeRaw.violations.length)) {
    if (flags.spike !== "1") spike = { kept: false, reason: "spike-off", files: [] };
    else spike = judgeSpike(spikeRaw, (p) => contentAt(git, mainSha, p));
    if (spike.reason)
      notes.push(`The spike was dropped (${spike.reason}); the probe runs on main.`);
  }

  // Nothing the planner wrote leaves the Mac mini unscanned, kept or not.
  const secrets = loadSecrets(
    {
      accountFile: flags["account-file"],
      signinKeyFile: flags["signin-key-file"],
      bypassFile: flags["bypass-file"],
      secretsDir: flags["secrets-dir"],
    },
    deps,
  );
  // A scan that couldn't load every secret can't vouch for anything.
  if (secrets.problems.length > 0) return endRejected("secret-scan");
  const texts = [checksRaw, headersRaw, ...spikeRaw.files.map((f) => `${f.path}\n${f.content}`)];
  if (texts.some((t) => scanText(t, secrets).length > 0)) return endRejected("secret");

  const probe = {
    probeId,
    issue,
    mainSha,
    headerPaths,
    notes,
    spike: { kept: spike.kept, reason: spike.reason, summary: spike.summary ?? [] },
  };
  writePrivate(path.join(dir, "probe.json"), JSON.stringify(probe, null, 2) + "\n");
  if (flags["dry-run"] === "1") return { result: "dry-run", probeId, probe };

  const sha = buildCommit({ git, mainSha, issue, probeId, files: spike.kept ? spike.files : [] });
  const ref = probeRef(issue);
  const current = remoteRefSha(git, ref);
  const pushed = current !== null && pushRef(git, ref, sha, current);
  Object.assign(rec, {
    planProbeId: probeId,
    planProbeRound: String(num(rec.planProbeRound) + 1),
    planProbeStatus: pushed ? "queued" : "failed:push",
    planProbeSha: pushed ? sha : null,
    planProbeMainSha: mainSha,
    planProbeQueuedAt: now(flags).toISOString(),
    planProbeAttempts: null,
    planProbeFoldAttempts: null,
  });
  await saveFactoryState(state, flags["state-file"]);
  return pushed
    ? { result: "queued", probeId, sha, spike: spike.kept }
    : { result: "failed", reason: "push", probeId, post: true };
}

function cmdCandidates(flags) {
  return withState(flags["state-file"], (state) => ({
    save: false,
    value: Object.entries(state.issues ?? {})
      .filter(
        ([, r]) => r?.planProbeStatus === "queued" && SHA_RE.test(String(r.planProbeSha ?? "")),
      )
      .map(([issue, r]) => ({
        issue,
        probeId: r.planProbeId,
        sha: r.planProbeSha,
        queuedAt: r.planProbeQueuedAt,
        round: num(r.planProbeRound),
      }))
      .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt))),
  }));
}

async function cmdPreviewState(flags, deps = {}) {
  const issue = issueFlag(flags);
  const state = await loadFactoryState(flags["state-file"]);
  const r = state.issues?.[issue] ?? {};
  const waited = (now(flags).getTime() - Date.parse(r.planProbeQueuedAt ?? "")) / 60000;
  const out = previewStateForSha(r.planProbeSha, deps);
  return { ...out, waitedMin: Number.isFinite(waited) ? Math.floor(waited) : null };
}

async function cmdCaptureHeaders(flags, deps = {}) {
  const issue = issueFlag(flags);
  const state = await loadFactoryState(flags["state-file"]);
  const r = state.issues?.[issue] ?? {};
  const dir = probeDir(flags.root, r.planProbeId);
  const probe = readJson(path.join(dir, "probe.json"), {});
  const paths = Array.isArray(probe.headerPaths) ? probe.headerPaths : [];
  if (paths.length === 0) return { captured: 0 };
  const out = captureHeaders(
    { origin: flags.origin, paths, bypassFile: flags["bypass-file"] },
    deps,
  );
  writePrivate(path.join(dir, "headers.json"), JSON.stringify(out, null, 2) + "\n");
  return { captured: out.captured.length, note: out.note };
}

function cmdAttempt(flags) {
  const issue = issueFlag(flags);
  return withState(flags["state-file"], (state) => {
    const r = getIssue(state, issue);
    const sha = String(r.planProbeSha ?? "");
    let n = keyedCount(r.planProbeAttempts, sha);
    n = flags.op === "refund" ? Math.max(0, n - 1) : n + 1;
    r.planProbeAttempts = `${sha}:${n}`;
    return { value: { attempts: n } };
  });
}

const END_STATUS_RE = /^(reported|failed:[a-z-]+|cancelled:[a-z-]+)$/;

async function cmdEnd(flags, deps = {}) {
  const issue = issueFlag(flags);
  const status = String(flags.status ?? "");
  if (!END_STATUS_RE.test(status)) throw new UsageError(`invalid --status: ${status}`);
  const state = await loadFactoryState(flags["state-file"]);
  const r = getIssue(state, issue);
  if (!r.planProbeId) return { status: null };
  const dir = probeDir(flags.root, r.planProbeId);
  let deleted = null;
  if (SHA_RE.test(String(r.planProbeSha ?? ""))) {
    const git = deps.git ?? defaultGit(flags["repo-root"]);
    deleted = deleteRef(git, probeRef(issue), r.planProbeSha);
  }
  const result = {
    status,
    browser: flags.browser ?? (status === "reported" ? "none" : null),
    verdict: flags.verdict ?? null,
    runDir: flags["run-dir"] ?? null,
    deleted,
  };
  if (nodeFs.existsSync(dir)) {
    writePrivate(path.join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
    if (flags.section && nodeFs.existsSync(flags.section)) {
      writePrivate(path.join(dir, "section.md"), nodeFs.readFileSync(flags.section, "utf8"));
    }
  }
  r.planProbeStatus = status;
  await saveFactoryState(state, flags["state-file"]);
  return { status, deleted: deleted === true, post: !status.startsWith("cancelled:") };
}

async function cmdCompose(flags) {
  const issue = issueFlag(flags);
  const state = await loadFactoryState(flags["state-file"]);
  const record = state.issues?.[issue] ?? {};
  const dir = probeDir(flags.root, record.planProbeId);
  const result = readJson(path.join(dir, "result.json"), {});
  const { body, withheld, hits } = composeReport({
    issue,
    record,
    probe: readJson(path.join(dir, "probe.json"), {}),
    headers: readJson(path.join(dir, "headers.json"), null),
    section: readText(path.join(dir, "section.md")) || null,
    result,
    checks: readText(path.join(dir, "checks.md")).trim(),
    secrets: loadSecrets({
      accountFile: flags["account-file"],
      signinKeyFile: flags["signin-key-file"],
      bypassFile: flags["bypass-file"],
      secretsDir: flags["secrets-dir"],
    }),
    runDir: result.runDir ?? null,
  });
  writePrivate(flags.out, body);
  // The planner's copy for the fold, without the marker.
  writePrivate(
    path.join(dir, "report.md"),
    body.replace(reportMarker(record.planProbeId), "").trim() + "\n",
  );
  return { withheld, hits };
}

function readComments(file) {
  const parsed = readJson(file, null);
  if (!Array.isArray(parsed)) throw new Error("comments file is not a JSON array");
  return parsed;
}

async function cmdFoldDue(flags) {
  const issue = issueFlag(flags);
  const state = await loadFactoryState(flags["state-file"]);
  const r = state.issues?.[issue] ?? {};
  const id = r.planProbeId;
  if (!id || !AWAITING_FOLD_RE.test(String(r.planProbeStatus ?? ""))) return { due: false };
  if (keyedCount(r.planProbeFoldAttempts, id) >= num(flags["max-folds"]))
    return { due: false, reason: "cap" };
  if (planAcks(readComments(flags["comments-file"]), id)) return { due: false, reason: "acked" };
  const dir = probeDir(flags.root, id);
  return {
    due: true,
    results: {
      probeId: id,
      round: num(r.planProbeRound),
      status: r.planProbeStatus,
      ackMarker: ackMarker(id),
      report: readText(path.join(dir, "report.md")).slice(0, COMMENT_MAX_CHARS),
    },
  };
}

function cmdFoldBegin(flags) {
  const issue = issueFlag(flags);
  return withState(flags["state-file"], (state) => {
    const r = getIssue(state, issue);
    const n = keyedCount(r.planProbeFoldAttempts, r.planProbeId) + 1;
    r.planProbeFoldAttempts = `${r.planProbeId}:${n}`;
    return { value: { foldAttempts: n } };
  });
}

async function cmdFoldEnd(flags) {
  const issue = issueFlag(flags);
  const probeId = String(flags["probe-id"] ?? "");
  const comments = readComments(flags["comments-file"]);
  return withState(flags["state-file"], (state) => {
    const r = getIssue(state, issue);
    // A round queued by this same replan replaced the record: the old round
    // is folded by definition (the planner just read it).
    if (r.planProbeId !== probeId || !AWAITING_FOLD_RE.test(String(r.planProbeStatus ?? ""))) {
      return { save: false, value: { folded: false, why: "not-awaiting" } };
    }
    if (planAcks(comments, probeId)) {
      r.planProbeStatus = "folded";
      return { value: { folded: true, why: "acked" } };
    }
    if (keyedCount(r.planProbeFoldAttempts, probeId) >= num(flags["max-folds"])) {
      r.planProbeStatus = "folded:gave-up";
      return { value: { folded: true, why: "gave-up" } };
    }
    return { save: false, value: { folded: false, why: "no-ack" } };
  });
}

function csvSet(v) {
  return new Set(
    String(v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Run once per --plan tick, before anything else. Ends what can't go on and
 * reaps what nothing owns:
 *   - a staging left by a killed planner run: dropped (no round is spent);
 *   - a queued probe whose card left Plan Review (not Planning: that is an
 *     orphan the rescue sweep restores), or with the probe switched off:
 *     cancelled, its branch deleted;
 *   - a queued probe past PROBE_DEADLINE_MIN: failed:expired;
 *   - a result awaiting its fold on a card that left Plan Review: folded;
 *   - a probe branch on GitHub that no queued probe owns: deleted;
 *   - probe dirs past retention.
 * Returns the actions; bash posts the report for each `post`.
 */
async function cmdHousekeeping(flags, deps = {}) {
  const t = now(flags);
  const boardsOk = flags["boards-ok"] !== "0";
  const planReview = csvSet(flags["plan-review"]);
  const planning = csvSet(flags.planning);
  const enabled = flags.enabled === "1";
  const git = deps.git ?? defaultGit(flags["repo-root"]);
  const actions = [];
  const state = await loadFactoryState(flags["state-file"]);
  const deletes = [];
  for (const [issue, r] of Object.entries(state.issues ?? {})) {
    if (!r || typeof r !== "object") continue;
    if (r.planProbeStaging) {
      // A killed planner run: nothing was pushed and no round spent. The card
      // is in Planning, which the rescue sweep settles (a fresh plan, or the
      // plan it already posted); a probe it wanted is requested again then.
      const id = r.planProbeStaging;
      r.planProbeStaging = null;
      try {
        nodeFs.rmSync(probeDir(flags.root, id), { recursive: true, force: true });
      } catch {
        // An id that isn't one names no dir to remove.
      }
      actions.push({ issue, action: "staging-dropped", post: false });
    }
    const status = String(r.planProbeStatus ?? "");
    const inReview = planReview.has(issue);
    const inPlanning = planning.has(issue);
    if (status === "queued") {
      let end = null;
      if (!enabled) end = "cancelled:off";
      else if (boardsOk && !inReview && !inPlanning) end = "cancelled:left-plan-review";
      else if ((t.getTime() - Date.parse(r.planProbeQueuedAt ?? "")) / 60000 > PROBE_DEADLINE_MIN) {
        end = "failed:expired";
      }
      if (end) {
        if (SHA_RE.test(String(r.planProbeSha ?? ""))) deletes.push({ issue, sha: r.planProbeSha });
        r.planProbeStatus = end;
        actions.push({ issue, action: end, post: !end.startsWith("cancelled:") });
      }
    } else if (AWAITING_FOLD_RE.test(status) && boardsOk && !inReview && !inPlanning) {
      r.planProbeStatus = "folded:left-plan-review";
      actions.push({ issue, action: "folded:left-plan-review", post: false });
    }
  }
  await saveFactoryState(state, flags["state-file"]);
  for (const d of deletes) deleteRef(git, probeRef(d.issue), d.sha);

  // Orphans: a branch no queued probe points at. Leased on what we saw, so a
  // push between the listing and the delete wins.
  const refs = listProbeRefs(git);
  if (refs) {
    for (const ref of refs) {
      const r = state.issues?.[ref.issue];
      if (r?.planProbeStatus === "queued" && r.planProbeSha === ref.sha) continue;
      if (deleteRef(git, ref.ref, ref.sha))
        actions.push({ issue: ref.issue, action: "orphan-deleted", post: false });
    }
  }

  // Retention: dirs no record names, past the cutoff.
  const keep = new Set(
    Object.values(state.issues ?? {}).flatMap((r) =>
      [r?.planProbeId, r?.planProbeStaging].filter(Boolean),
    ),
  );
  const cutoff = t.getTime() - PROBE_DIR_RETENTION_DAYS * 86_400_000;
  let names = [];
  try {
    names = nodeFs.readdirSync(flags.root);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!PROBE_ID_RE.test(name) || keep.has(name)) continue;
    const epoch = Number(PROBE_ID_RE.exec(name)[2]) * 1000;
    if (epoch < cutoff)
      nodeFs.rmSync(path.join(flags.root, name), { recursive: true, force: true });
  }
  return { actions };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

class UsageError extends Error {}

const COMMANDS = {
  availability: cmdAvailability,
  stage: cmdStage,
  finalize: cmdFinalize,
  candidates: cmdCandidates,
  "preview-state": cmdPreviewState,
  "capture-headers": cmdCaptureHeaders,
  attempt: cmdAttempt,
  end: cmdEnd,
  compose: cmdCompose,
  "fold-due": cmdFoldDue,
  "fold-begin": cmdFoldBegin,
  "fold-end": cmdFoldEnd,
  housekeeping: cmdHousekeeping,
};

export async function main(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  const fn = COMMANDS[cmd];
  if (!fn)
    throw new UsageError(`usage: plan-probe.mjs <${Object.keys(COMMANDS).join("|")}> [flags]`);
  const { flags } = parseFlags(rest);
  if (!flags["state-file"]) throw new UsageError("--state-file required");
  return fn(flags, deps);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((out) => {
      process.stdout.write(JSON.stringify(out ?? null) + "\n");
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(err instanceof UsageError || /^Missing value for --/.test(err.message) ? 2 : 1);
    });
}
