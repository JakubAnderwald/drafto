#!/usr/bin/env node
// The verification stage's shell lane — the IO half. See ADR-0053.
//
// When a card sits in the Testing column (factory-agent.sh's verify_sweep),
// this lane runs the card's test scenario from a terminal: targeted tests for
// the changed files, the scenario's command-type steps, the macOS --preflight
// (ADR-0043), and API / MCP checks against the commit's own Vercel preview.
// The claude session that does it is locked down:
//   - `--no-chrome --strict-mcp-config --setting-sources ""`, a guard hook
//     (verify-guard.mjs) through `--settings`, `--permission-mode dontAsk`,
//     and Bash, Read, Grep and Glob only. Never --dangerously-skip-permissions
//     and never --chrome: there is still exactly one Chrome call in the
//     factory (ADR-0051). buildClaudeArgs() builds the flags and
//     assertSafeClaudeArgs() re-checks them right before the spawn.
//   - a fresh detached worktree of the PR's head, never the card's slot
//     worktree (which holds .env.production files), with no env file copied;
//   - an allowlisted environment: no GH / Vercel / Supabase tokens (the
//     factory loop sources support secrets into its own env), GH_CONFIG_DIR
//     pointing at an empty directory;
//   - the preview reachable only through `preview-curl <path>`, a wrapper
//     (bin/preview-curl → `verify-lane.mjs preview-curl`) that pins the
//     preview origin and reads the Vercel protection-bypass header and the
//     test account's session cookie from a mode-600 curl config in the run's
//     private/ dir. The secret is never text the model sees. `vercel curl` is
//     never used: it mints a bypass secret of its own, silently.
//
// Why detached: a run takes minutes (an install, tests, a claude session) and
// --watch runs every 5 minutes under one mutex (ADR-0036). So, like the
// CodeRabbit CLI lane (coderabbit-cli.mjs), `start` reserves the lane's single
// in-flight slot, prepares a worktree and a run dir, and spawns `_supervise`
// detached under `nice -n 10`; `housekeeping` collects it on a later tick. The
// supervisor never touches git, gh or factory-state.json; every state write
// happens inside a tick (factory-state.mjs's single-writer rule), and the
// supervisor path never imports factory-state.mjs.
//
// Subcommands (each prints exactly ONE JSON line on stdout and exits 0; exit 1
// only on bad argv — except `preview-curl`, which is curl, and `bypass-check`,
// which exits 2 when the file isn't usable):
//
//   start --issue N --pr P --sha S --platforms '<json>' --state-file F
//         --repo-root R --run-root D [--prompt-file F] [--account-file F]
//         [--signin-key-file F] [--bypass-file F] [--effort E]
//         [--install-timeout-sec N] [--min-free-disk-gb N] [--dry-run 0|1] [--now ISO]
//       → {started: true, runId, runDir, worktree, deadlineAt, attempt, preview, bypass}
//         or {started: false, reason, …}. Refusal reasons: off, factory-paused,
//         lane-paused, running (this card's run is in flight), busy (another
//         card's), attempts, no-round, scenario-wait, hold-cap, hold-cap-near, memory, disk,
//         prompt-missing, <bin>-missing, pr-unreadable, head-moved,
//         preview-wait, dry-run, start-failed, abandoned. factory-agent.sh
//         maps each to a lane state or leaves it to retry (verify_shell_work).
//   housekeeping --state-file F --repo-root R --run-root D [--dry-run 0|1] [--now ISO]
//       → collects a finished (or dead) run: parses its output, records
//         verifyShell = "<sha>:<state>[:<verdict>]" and verifyShellRunDir,
//         releases the slot, removes the worktree. Kills a run whose PR head
//         moved, whose PR closed or whose card left Testing, and a run past
//         its deadline. A run that ended on a Claude session limit refunds its
//         attempt and returns {sessionLimit: {resetAt, reason}} so bash pauses
//         the factory (pause_for_session_limit). Reaps verify-* worktrees and
//         run dirs older than 30 days, and the private/ dir of any run whose
//         supervisor is gone.
//   stop --issue N [--sha S] [--reason R] --state-file F --repo-root R --run-root D
//       → stops this card's run (the card is leaving Testing): SIGTERM to the
//         supervisor's process group, worktree removed, slot released, attempt
//         refunded. {state: "stopped"|"idle"}.
//   gaps --run-dir D
//       → {gaps: [{lane, reason}], bypassUsed}: coverage gaps the run's own
//         facts show (no bypass secret, no preview, no session, unconfirmed
//         key revocation) for the report, and whether the run was given the
//         bypass secret (verify_compose_report then scans for it even if the
//         file has gone since).
//   bypass-check [--file F]
//       → {ok, file, problem}: is the bypass file usable (exists, a regular
//         file, mode 600 or stricter, VERCEL_AUTOMATION_BYPASS_SECRET present
//         and well-formed)? Never prints the value. Exit 0 when ok, 2 when not.
//   preview-curl --run-dir D -- <curl args…>   (internal; bin/preview-curl)
//   _supervise --run-dir D                     (internal; spawned detached by start)
//
// Kill switch: FACTORY_VERIFY (validated and exported by factory-agent.sh).
// Anything but "1" and `start` refuses; housekeeping still runs, but only to
// wind down a run started before the flip.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const REPO = "JakubAnderwald/drafto";

// What every process this lane starts may see, and nothing more. No GH_TOKEN,
// no support-agent secrets: the factory loop sources those into its own env.
export const ENV_ALLOWLIST = Object.freeze([
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "SHELL",
  "TERM",
  "CLAUDE_CONFIG_DIR",
]);
export const SUPERVISED_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export const PREVIEW_ORIGIN_RE =
  /^https:\/\/drafto-[a-z0-9-]+-jakubanderwalds-projects\.vercel\.app$/;
// Every API key the lane creates carries this prefix in its name (the run's
// qaTag, unique per run). After a run, its own keys are revoked, and so are
// lane keys created before it started: those were left by a run that was
// killed before its own cleanup. Keys newer than the run belong to a run that
// started after it, and are left alone.
export const QA_TAG_PREFIX = "factory-shell-";
export const BYPASS_KEY = "VERCEL_AUTOMATION_BYPASS_SECRET";
export const BYPASS_HEADER = "x-vercel-protection-bypass";
export const LANE_TOOL_LIST = "Bash,Read,Grep,Glob";
export const EFFORTS = Object.freeze(["ultracode", "max", "xhigh", "high", "medium", "low"]);

const THIS_FILE = fileURLToPath(import.meta.url);
const LIB_DIR = path.dirname(THIS_FILE);
const DEFAULT_PROMPT_FILE = path.resolve(LIB_DIR, "..", "factory-verify-prompt.md");
const RUN_CLAUDE = path.join(LIB_DIR, "run-claude.mjs");
const SHA40 = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_ID_RE = /^\d+-[0-9a-f]{12}-\d{8}T\d{6}Z$/;
const MINUTE_MS = 60_000;
// One tick: a live start finishes reserve → attach in seconds.
const UNATTACHED_LOST_MS = 5 * MINUTE_MS;
// Past its deadline the supervisor should already have stopped claude and
// exited. Ten more minutes means it is wedged: SIGTERM its group, and SIGKILL
// it once another ten have gone by.
const OVERDUE_GRACE_MS = 10 * MINUTE_MS;
const OVERDUE_KILL_MS = 20 * MINUTE_MS;
const RUN_DIR_RETENTION_MS = 30 * 24 * 60 * MINUTE_MS;
// The claude call ends this long before the run's deadline, leaving time to
// revoke keys and clean up.
const CLEANUP_RESERVE_SEC = 120;
const KILL_GRACE_MS = 10_000;
const CURL_TIMEOUT_MS = 45_000;
// A lane whose guard didn't load is off until the operator looks
// (factory:verify-resume); the next try would most likely fail the same way.
const GUARD_PAUSE_MIN = 24 * 60;
const MAX_OUTPUT_BYTES = 1024 * 1024;
// The least time worth starting a run with: an install and a short session.
const MIN_RUN_MIN = 10;

let libsPromise = null;
async function libs() {
  libsPromise ??= Promise.all([
    import("./factory-state.mjs"),
    import("./factory-bundle.mjs"),
    import("./verify-guard.mjs"),
  ]).then(([S, B, G]) => ({ S, B, G }));
  return libsPromise;
}

// ── knobs ───────────────────────────────────────────────────────────────────

function positiveInt(raw, fallback) {
  return typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : fallback;
}

function nonNegativeInt(raw, fallback) {
  return typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : fallback;
}

function expandTilde(p, home) {
  return typeof p === "string" && p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

// Read once per command, flags over the environment. A garbage value falls
// back to the default rather than disabling a guard.
export function readKnobs(env = process.env, flags = {}) {
  const home = env.HOME || os.homedir();
  const pick = (flag, envKey) => flags[flag] ?? env[envKey];
  const effort = pick("effort", "FACTORY_PLAN_EFFORT");
  return {
    timeoutMin: positiveInt(env.FACTORY_VERIFY_SHELL_TIMEOUT_MIN, 30),
    maxAttempts: positiveInt(env.FACTORY_VERIFY_MAX_ATTEMPTS, 2),
    holdMaxMin: positiveInt(env.FACTORY_VERIFY_HOLD_MAX_MIN, 60),
    previewWaitMin: positiveInt(env.FACTORY_VERIFY_PREVIEW_WAIT_MIN, 10),
    installTimeoutSec: positiveInt(pick("install-timeout-sec", "FACTORY_INSTALL_TIMEOUT_SEC"), 600),
    minFreeDiskGb: nonNegativeInt(pick("min-free-disk-gb", "FACTORY_MIN_FREE_DISK_GB"), 3),
    limitFallbackMin: positiveInt(env.FACTORY_LIMIT_FALLBACK_MIN, 30),
    effort: EFFORTS.includes(effort) ? effort : "xhigh",
    bypassFile: expandTilde(
      pick("bypass-file", "FACTORY_VERIFY_BYPASS_FILE") ||
        path.join(home, "drafto-secrets", "vercel-bypass.env"),
      home,
    ),
    accountFile: expandTilde(
      pick("account-file", "FACTORY_BROWSER_ACCOUNT_FILE") ||
        path.join(home, "drafto-secrets", "browser-account.env"),
      home,
    ),
    signinKeyFile: expandTilde(
      pick("signin-key-file", "FACTORY_BROWSER_SIGNIN_KEY_FILE") ||
        path.join(home, "drafto-secrets", "dev-supabase-admin.env"),
      home,
    ),
  };
}

// ── small helpers ───────────────────────────────────────────────────────────

// Seconds precision: factory-agent.sh's iso_age_min only parses YYYY-MM-DDTHH:MM:SSZ.
export function isoSeconds(iso) {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addMinutes(iso, minutes) {
  return isoSeconds(new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString());
}

export function makeRunId(issue, sha, now) {
  return `${issue}-${String(sha).slice(0, 12)}-${isoSeconds(now).replace(/[-:]/g, "")}`;
}

export function worktreePathFor(repoRoot, issue, sha) {
  return path.join(repoRoot, "worktrees", `verify-${issue}-${String(sha).slice(0, 12)}`);
}

// Unique per run (the run id's time, HHMMSS): a run on the same commit after
// a hand-back must never match an earlier run's own-tag revocation.
export function qaTagFor(issue, sha, runId = "") {
  const stamp = /T(\d{6})Z$/.exec(String(runId))?.[1];
  return `${QA_TAG_PREFIX}${issue}-${String(sha).slice(0, 7)}${stamp ? `-${stamp}` : ""}`;
}

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readText(fs, file, maxBytes = Infinity) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  } catch {
    return "";
  }
}

function writeJsonAtomic(fs, file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function rmQuiet(fs, p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* reaped on a later tick */
  }
}

// ── environment ─────────────────────────────────────────────────────────────

export function supervisedEnv(env = process.env) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof env[key] === "string") out[key] = env[key];
  }
  out.PATH = SUPERVISED_PATH;
  return out;
}

/**
 * The environment of everything the supervisor runs (pnpm, claude and the
 * commands claude runs): the allowlist, a PATH with the run's bin/ first (for
 * preview-curl) and the claude / node dirs (claude lives in ~/.local/bin,
 * which the supervisor's PATH doesn't have), gh pointed at an empty config.
 */
export function laneEnv(env, { binDirs = [], ghConfigDir = null, extra = {} } = {}) {
  const out = supervisedEnv(env);
  const dirs = [...new Set(binDirs.filter(Boolean))];
  out.PATH = [...dirs, SUPERVISED_PATH].join(":");
  if (ghConfigDir) out.GH_CONFIG_DIR = ghConfigDir;
  Object.assign(out, extra);
  return out;
}

// ── claude flags ────────────────────────────────────────────────────────────

/** The one argument list the lane's claude call ever gets (via run-claude.mjs). */
export function buildClaudeArgs({ settingsPath, sessionId, effort }) {
  if (typeof settingsPath !== "string" || !path.isAbsolute(settingsPath)) {
    throw new Error("buildClaudeArgs: settingsPath must be absolute");
  }
  if (!UUID_RE.test(String(sessionId)))
    throw new Error("buildClaudeArgs: sessionId must be a UUID");
  if (!EFFORTS.includes(effort)) throw new Error(`buildClaudeArgs: invalid effort ${effort}`);
  return [
    "-p",
    "--no-chrome",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--settings",
    settingsPath,
    "--permission-mode",
    "dontAsk",
    "--tools",
    LANE_TOOL_LIST,
    "--allowedTools",
    LANE_TOOL_LIST,
    "--session-id",
    sessionId,
    "--effort",
    effort,
  ];
}

const FORBIDDEN_CLAUDE_FLAGS = [
  "--chrome",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--mcp-config",
  "--add-dir",
  "--plugin-dir",
  "--plugin-url",
];

/** Throws unless <args> is exactly the locked-down shape buildClaudeArgs makes. */
export function assertSafeClaudeArgs(args) {
  if (!Array.isArray(args)) throw new Error("claude args must be an array");
  for (const a of args) {
    const flag = String(a).split("=")[0];
    if (FORBIDDEN_CLAUDE_FLAGS.includes(flag)) throw new Error(`refusing claude flag ${flag}`);
    if (/bypassPermissions/i.test(String(a))) throw new Error("refusing bypassPermissions");
  }
  const at = (flag) => args[args.indexOf(flag) + 1];
  if (!args.includes("--no-chrome") || !args.includes("--strict-mcp-config")) {
    throw new Error("claude args must carry --no-chrome --strict-mcp-config");
  }
  if (at("--permission-mode") !== "dontAsk") throw new Error("claude args must use dontAsk");
  if (at("--setting-sources") !== "") throw new Error('claude args must pass --setting-sources ""');
  if (at("--tools") !== LANE_TOOL_LIST || at("--allowedTools") !== LANE_TOOL_LIST) {
    throw new Error(`claude tools must be exactly ${LANE_TOOL_LIST}`);
  }
  if (!args.includes("--settings")) throw new Error("claude args must load the guard settings");
}

// ── bypass secret ───────────────────────────────────────────────────────────

// Vercel's automation bypass secrets are short URL-safe tokens. Anything else
// can't go into a curl config header line safely.
const BYPASS_VALUE_RE = /^[A-Za-z0-9._~+/=-]{16,256}$/;

function parseEnvFile(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const q = /^(["'])(.*)\1$/.exec(value);
    if (q) value = q[2];
    out[m[1]] = value;
  }
  return out;
}

/** Why the bypass file can't be used, or null. Never returns or logs the value. */
export function bypassFileProblem(file, fs = nodeFs) {
  if (typeof file !== "string" || file === "") return "missing";
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "not-a-file";
  if ((st.mode & 0o077) !== 0) return "mode";
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "unreadable";
  }
  const values = parseEnvFile(text);
  if (!(BYPASS_KEY in values)) return "no-key";
  if (values[BYPASS_KEY] === "") return "empty";
  if (!BYPASS_VALUE_RE.test(values[BYPASS_KEY])) return "malformed";
  return null;
}

function readBypassSecret(file, fs = nodeFs) {
  if (bypassFileProblem(file, fs)) throw new Error("bypass file not usable");
  return parseEnvFile(fs.readFileSync(file, "utf8"))[BYPASS_KEY];
}

// ── preview-curl ────────────────────────────────────────────────────────────
// The model's only way to the preview. An allowlist of curl options, one path
// on the pinned origin, and a config file it can't read for the secret and
// the session. Everything that could print headers (-i, -v, -D, -I, --trace),
// follow a redirect elsewhere (-L), read another config or a file (-K, @file),
// pick another host (a URL, --url, --connect-to, --resolve, a proxy) or write
// a file (-o, -c) is refused.

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const FLAG_OPTS = new Set([
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-f",
  "--fail",
  "--fail-with-body",
  "-G",
  "--get",
  "--compressed",
]);
const DENY_HEADER_NAME =
  /^(x-vercel|x-verified|x-middleware|x-forwarded|cookie$|host$|forwarded$)/i;
const WRITE_OUT_VARS = new Set([
  "http_code",
  "response_code",
  "content_type",
  "time_total",
  "size_download",
  "num_redirects",
]);

function writeOutProblem(fmt) {
  // curl reads the format from a file when it starts with "@", and prints it:
  // that would read private/curl.cfg or the cookie jar back to the model.
  if (String(fmt).startsWith("@")) return "-w @file isn't allowed";
  const stripped = String(fmt).replace(/%\{([a-z_]+)\}/g, (m, v) =>
    WRITE_OUT_VARS.has(v) ? "" : m,
  );
  return /%/.test(stripped)
    ? "only %{http_code}, %{content_type}, %{time_total}, %{size_download} may be written out"
    : null;
}

/**
 * Validate the model's preview-curl arguments. Returns {ok: true, args, url}
 * (the curl arguments after the config, and the full URL) or {ok: false, reason}.
 */
export function buildPreviewCurlArgs(argv, { origin }) {
  if (!PREVIEW_ORIGIN_RE.test(String(origin ?? ""))) {
    return { ok: false, reason: "there is no preview for this run" };
  }
  const out = [];
  let target = null;
  const value = (i, opt) => {
    if (i + 1 >= argv.length) throw new Error(`${opt} needs a value`);
    return argv[i + 1];
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const raw = String(argv[i]);
      const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
      const opt = eq === -1 ? raw : raw.slice(0, eq);
      const inline = eq === -1 ? null : raw.slice(eq + 1);
      const take = () => {
        if (inline !== null) return inline;
        const v = value(i, opt);
        i++;
        return v;
      };
      if (FLAG_OPTS.has(opt)) {
        out.push(opt);
        continue;
      }
      if (/^-[sSfG]{2,}$/.test(raw)) {
        out.push(raw);
        continue;
      }
      if (opt === "-X" || opt === "--request") {
        const m = take().toUpperCase();
        if (!METHODS.has(m)) return { ok: false, reason: `method ${m} isn't allowed` };
        out.push("-X", m);
        continue;
      }
      if (opt === "-H" || opt === "--header") {
        const h = take();
        const m = /^([A-Za-z0-9-]+):(.*)$/.exec(h);
        if (!m) return { ok: false, reason: "a header must look like 'Name: value'" };
        if (DENY_HEADER_NAME.test(m[1]))
          return { ok: false, reason: `header ${m[1]} isn't allowed` };
        if (/[\r\n]/.test(h) || h.includes("://")) {
          return { ok: false, reason: "header values may not contain newlines or URLs" };
        }
        out.push("-H", h);
        continue;
      }
      if (["-d", "--data", "--data-binary", "--json", "--data-ascii"].includes(opt)) {
        const d = take();
        if (d.startsWith("@")) {
          return { ok: false, reason: `${opt} @file isn't allowed; use --data-raw "$(cat file)"` };
        }
        out.push(opt, d);
        continue;
      }
      if (opt === "--data-raw") {
        out.push(opt, take());
        continue;
      }
      if (opt === "--data-urlencode") {
        const d = take();
        if (/^[^=]*@/.test(d))
          return { ok: false, reason: "--data-urlencode name@file isn't allowed" };
        out.push(opt, d);
        continue;
      }
      if (opt === "-o" || opt === "--output") {
        // Only to discard the body (`-s -o /dev/null -w '%{http_code}'`):
        // writing a response anywhere else isn't the wrapper's business.
        if (take() !== "/dev/null") return { ok: false, reason: "-o may only be /dev/null" };
        out.push("-o", "/dev/null");
        continue;
      }
      if (opt === "-w" || opt === "--write-out") {
        const f = take();
        const why = writeOutProblem(f);
        if (why) return { ok: false, reason: why };
        out.push("-w", f);
        continue;
      }
      if (raw.startsWith("-")) {
        return { ok: false, reason: `curl option ${opt} isn't allowed through preview-curl` };
      }
      if (target !== null) return { ok: false, reason: "give exactly one path" };
      target = raw;
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (target === null) return { ok: false, reason: "give the path to request, e.g. /api/health" };
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("://")) {
    return { ok: false, reason: "give a path on the preview (starting with /), not a URL" };
  }
  if (/[\s\\\u0000-\u001f\u007f]/.test(target)) {
    return {
      ok: false,
      reason: "the path may not contain spaces, backslashes or control characters",
    };
  }
  let url;
  try {
    url = new URL(target, origin);
  } catch {
    return { ok: false, reason: "the path doesn't form a valid URL" };
  }
  if (url.origin !== origin) return { ok: false, reason: "the path leaves the preview origin" };
  return { ok: true, args: out, url: url.toString() };
}

export function previewCurlScript({ nodePath, modulePath, runDir }) {
  for (const [label, p] of [
    ["node", nodePath],
    ["module", modulePath],
    ["run dir", runDir],
  ]) {
    if (!path.isAbsolute(p) || p.includes("'") || /[\u0000-\u001f]/.test(p)) {
      throw new Error(`preview-curl: unusable ${label} path`);
    }
  }
  return [
    "#!/bin/sh",
    "# The verification lane's only way to the preview (verify-lane.mjs preview-curl).",
    `exec '${nodePath}' '${modulePath}' preview-curl --run-dir '${runDir}' -- "$@"`,
    "",
  ].join("\n");
}

/** The curl config: the bypass header (when the run has it), the cookie jar, https only. */
export function curlConfigText({ bypassSecret = null, cookieJar }) {
  const lines = [
    "# Written by verify-lane.mjs for one verification run. Mode 600; removed when the run ends.",
    'proto = "=https"',
    "max-time = 30",
    `cookie = "${cookieJar}"`,
    `cookie-jar = "${cookieJar}"`,
  ];
  if (bypassSecret) {
    if (!BYPASS_VALUE_RE.test(bypassSecret)) throw new Error("bypass secret is malformed");
    lines.push(`header = "${BYPASS_HEADER}: ${bypassSecret}"`);
  }
  return lines.join("\n") + "\n";
}

// preview-curl runs while the model's session is live, so it trusts nothing
// the model could have edited for its binary: meta.json sits in a directory
// the session can write to. The system curl is always there on macOS.
export const PREVIEW_CURL_BIN = "/usr/bin/curl";

export async function runPreviewCurl(
  { runDir, argv },
  { fs = nodeFs, stderr = process.stderr, spawnFn = spawn } = {},
) {
  const meta = parseJson(readText(fs, path.join(runDir, "meta.json")), null);
  const cfg = path.join(runDir, "private", "curl.cfg");
  if (!meta || !fs.existsSync(cfg)) {
    stderr.write(
      "preview-curl: this run has no preview session (the run is over or never had a preview)\n",
    );
    return 2;
  }
  const built = buildPreviewCurlArgs(argv, { origin: meta.previewOrigin });
  if (!built.ok) {
    stderr.write(`preview-curl: ${built.reason}\n`);
    return 2;
  }
  // -q first: no ~/.curlrc. Then the run's config, the checked options, the URL.
  const args = ["-q", "-K", cfg, ...built.args, "--url", built.url];
  return new Promise((resolve) => {
    const child = spawnFn(PREVIEW_CURL_BIN, args, { stdio: "inherit" });
    child.once("error", (err) => {
      stderr.write(`preview-curl: ${err.message}\n`);
      resolve(127);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

// ── real dependencies ───────────────────────────────────────────────────────

function runCommand(command, args, { cwd, input, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ?? process.env,
        stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: err.message, timedOut: false });
      return;
    }
    const out = [];
    const errOut = [];
    let timedOut = false;
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, timeoutMs);
      timer.unref();
    }
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => errOut.push(d));
    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: err.message, timedOut });
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : (code ?? (signal ? 128 : 1)),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errOut).toString("utf8"),
        timedOut,
      });
    });
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

// Only a confirmed 'spawn' counts as started (dispatch-release.mjs pattern).
async function realSpawnDetached(command, args, { cwd, logPath, env }) {
  let out = "ignore";
  try {
    out = nodeFs.openSync(logPath, "a", 0o600);
  } catch {
    out = "ignore";
  }
  const closeOut = () => {
    if (typeof out === "number") {
      try {
        nodeFs.closeSync(out);
      } catch {
        /* already closed */
      }
    }
  };
  let child;
  try {
    child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", out, out], env });
  } catch (err) {
    closeOut();
    return { ok: false, reason: err.message };
  }
  const outcome = await new Promise((resolve) => {
    child.once("spawn", () => resolve({ ok: true }));
    child.once("error", (err) => resolve({ ok: false, reason: err.message }));
  });
  child.on("error", () => {});
  closeOut();
  if (!outcome.ok) return outcome;
  child.unref();
  return { ok: true, pid: child.pid };
}

function realIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function realIsExecutable(file) {
  try {
    nodeFs.accessSync(file, nodeFs.constants.X_OK);
    return nodeFs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function createDeps() {
  return {
    env: process.env,
    now: () => new Date().toISOString(),
    fs: nodeFs,
    uuid: () => randomUUID(),
    gh: (args) => runCommand("gh", args),
    git: (args, { cwd } = {}) => runCommand("git", args, { cwd }),
    spawnDetached: realSpawnDetached,
    isPidAlive: realIsPidAlive,
    isExecutable: realIsExecutable,
    psCommand: async (pid) => {
      const r = await runCommand("ps", ["-o", "command=", "-p", String(pid)]);
      return r.code === 0 ? r.stdout.trim() : "";
    },
    // Every process as {pid, command}, or null when ps fails. `ww` so a long
    // `--run-dir` path is never cut off before the run id.
    listProcesses: async () => {
      const r = await runCommand("ps", ["-axww", "-o", "pid=,command="]);
      if (r.code !== 0) return null;
      return r.stdout
        .split("\n")
        .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
        .filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), command: m[2] }));
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },
    // macOS: 1 normal, 2 warn, 4 critical. null when it can't be read (fail open).
    memoryPressure: async () => {
      const r = await runCommand("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
      const n = Number(r.stdout.trim());
      return r.code === 0 && Number.isInteger(n) ? n : null;
    },
    // Whole GiB free on <dir>'s volume, or null.
    freeDiskGb: async (dir) => {
      const r = await runCommand("df", ["-Pk", dir]);
      const row = r.code === 0 ? r.stdout.trim().split("\n")[1] : "";
      const kb = Number(row?.split(/\s+/)[3]);
      return Number.isFinite(kb) ? Math.floor(kb / 1024 / 1024) : null;
    },
  };
}

// Absolute paths of the binaries the supervisor needs: launchd's PATH is
// minimal and the supervisor's is SUPERVISED_PATH, so they're resolved here,
// in the tick, where the factory's PATH (with ~/.local/bin) is in force.
export function resolveBins({ env = process.env, isExecutable }) {
  const home = env.HOME || os.homedir();
  const find = (name, extra = [], override = null) => {
    if (override) return isExecutable(override) ? override : null;
    const candidates = [
      ...(env.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((d) => path.join(d, name)),
      ...extra,
    ];
    return candidates.find((p) => path.isAbsolute(p) && isExecutable(p)) ?? null;
  };
  return {
    claude: find(
      "claude",
      [path.join(home, ".local", "bin", "claude")],
      env.FACTORY_CLAUDE_BIN || null,
    ),
    pnpm: find("pnpm", ["/opt/homebrew/bin/pnpm", "/usr/local/bin/pnpm"]),
    curl: find("curl", ["/usr/bin/curl"]),
    perl: isExecutable("/usr/bin/perl") ? "/usr/bin/perl" : find("perl"),
    nice: isExecutable("/usr/bin/nice") ? "/usr/bin/nice" : find("nice"),
    cp: isExecutable("/bin/cp") ? "/bin/cp" : find("cp"),
    node: process.execPath,
  };
}

// ── GitHub reads (in-tick only) ─────────────────────────────────────────────

async function readPrView(pr, deps, fields = "state,headRefOid") {
  const r = await deps.gh(["pr", "view", String(pr), "--repo", REPO, "--json", fields]);
  const view = r.code === 0 ? parseJson(r.stdout) : null;
  if (!view || typeof view.state !== "string" || typeof view.headRefOid !== "string") return null;
  return view;
}

async function readIssueLabels(issue, deps) {
  const r = await deps.gh([
    "issue",
    "view",
    String(issue),
    "--repo",
    REPO,
    "--json",
    "state,labels",
  ]);
  const view = r.code === 0 ? parseJson(r.stdout) : null;
  if (!view || !Array.isArray(view.labels)) return null;
  return { state: view.state, labels: view.labels.map((l) => l?.name).filter(Boolean) };
}

async function readIssueTitle(issue, deps) {
  const r = await deps.gh([
    "issue",
    "view",
    String(issue),
    "--repo",
    REPO,
    "--json",
    "number,title",
  ]);
  const view = r.code === 0 ? parseJson(r.stdout) : null;
  return typeof view?.title === "string" ? view.title : "";
}

async function readIssueComments(issue, deps) {
  const r = await deps.gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${REPO}/issues/${issue}/comments?per_page=100`,
  ]);
  const pages = r.code === 0 ? parseJson(r.stdout) : null;
  if (!Array.isArray(pages)) throw new Error("couldn't read the issue's comments");
  return pages.flat().map((c) => ({
    id: c?.id ?? null,
    body: typeof c?.body === "string" ? c.body : "",
    createdAt: c?.created_at ?? "",
    authorAssociation: c?.author_association ?? "NONE",
  }));
}

// The per-commit preview, from the Deployments API, as preview_url_for_sha in
// factory-agent.sh does: the exact deployment of this commit, never the
// branch alias. "" when there is none yet.
export async function previewOriginForSha(sha, deps) {
  const deps1 = await deps.gh([
    "api",
    `repos/${REPO}/deployments?sha=${sha}&environment=Preview`,
    "--jq",
    '[.[] | select(.creator.login == "vercel[bot]")][0].id // empty',
  ]);
  const id = deps1.code === 0 ? deps1.stdout.trim() : "";
  if (!/^\d+$/.test(id)) return "";
  const st = await deps.gh([
    "api",
    `repos/${REPO}/deployments/${id}/statuses`,
    "--jq",
    '[.[] | select(.state == "success")][0].environment_url // empty',
  ]);
  const url = st.code === 0 ? st.stdout.trim().replace(/\/+$/, "") : "";
  return PREVIEW_ORIGIN_RE.test(url) ? url : "";
}

// ── state helpers ───────────────────────────────────────────────────────────

// Reload → mutate → save with nothing awaited in between (coderabbit-cli.mjs).
// `fn` must be synchronous; returning false skips the save.
export async function mutateState(S, stateFile, fn) {
  const fresh = await S.loadFactoryState(stateFile);
  const out = fn(fresh);
  if (out && typeof out.then === "function") {
    throw new Error("mutateState: fn must be synchronous");
  }
  if (out !== false) await S.saveFactoryState(fresh, stateFile);
  return out;
}

// Release the run, applying its outcome writes in the same save. Skipped when
// the ledger no longer holds it (an operator's factory:verify-finish won).
async function finishRun(S, stateFile, runId, { refund, writes = [] }) {
  const out = await mutateState(S, stateFile, (s) => {
    if (S.getVerify(s).inFlight?.runId !== runId) return false;
    for (const write of writes) write(s);
    S.finishVerifyRun(s, runId, { refund });
    return true;
  });
  return out === true;
}

function pauseLaneAtLeast(S, state, { until, reason, now }) {
  const current = Date.parse(S.getVerify(state).pausedUntil ?? "");
  if (S.isVerifyPaused(state, now) && current >= Date.parse(until)) return;
  S.pauseVerify(state, { until, reason });
}

// ── worktrees ───────────────────────────────────────────────────────────────

async function gitOrThrow(deps, args, cwd, what) {
  const r = await deps.git(args, { cwd });
  if (r.code !== 0) {
    throw new Error(`${what} failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`);
  }
  return r.stdout.trim();
}

// Its own detached worktree: not $REPO_ROOT (reset to origin/main every tick)
// and not the card's slot worktree (its .env.production files, and the fix
// loop edits it). No env file is copied in.
async function prepareWorktree({ repoRoot, pr, sha, worktree }, deps) {
  await gitOrThrow(
    deps,
    ["fetch", "--quiet", "origin", `pull/${pr}/head`],
    repoRoot,
    "fetch PR head",
  );
  if (deps.fs.existsSync(worktree)) await removeWorktree(repoRoot, worktree, deps);
  await gitOrThrow(deps, ["worktree", "add", "--detach", worktree, sha], repoRoot, "worktree add");
  const head = await gitOrThrow(deps, ["rev-parse", "HEAD"], worktree, "rev-parse");
  if (head !== sha) throw new Error(`worktree HEAD ${head} != ${sha}`);
}

async function removeWorktree(repoRoot, worktree, deps) {
  if (!worktree) return;
  await deps.git(["worktree", "remove", "--force", worktree], { cwd: repoRoot });
  if (deps.fs.existsSync(worktree)) rmQuiet(deps.fs, worktree);
  await deps.git(["worktree", "prune"], { cwd: repoRoot });
}

// macOS scenario scripts the lane may run with --preflight: the ones named for
// this issue and any the PR touches.
function findPreflightScripts(worktree, issue, files, fs) {
  const rel = "apps/desktop/e2e/in-test/scenarios";
  let names = [];
  try {
    names = fs.readdirSync(path.join(worktree, rel));
  } catch {
    return [];
  }
  const touched = new Set(files);
  return names
    .filter((n) => /^[A-Za-z0-9._-]+\.sh$/.test(n))
    .map((n) => `${rel}/${n}`)
    .filter((p) => path.basename(p).startsWith(`${issue}-`) || touched.has(p))
    .sort();
}

// ── start ───────────────────────────────────────────────────────────────────

export async function runStart(opts, deps) {
  const { S, B, G } = await libs();
  const { issue, pr, sha, stateFile, repoRoot, runRoot } = opts;
  const now = opts.now ?? deps.now();
  const knobs = readKnobs(deps.env, opts.flags ?? {});
  const promptFile = opts.promptFile ?? DEFAULT_PROMPT_FILE;
  const refuse = (reason, extra = {}) => ({ started: false, reason, ...extra });

  if (deps.env?.FACTORY_VERIFY !== "1") return refuse("off");

  // A snapshot for DECISIONS only, never saved: writes go through mutateState.
  const snapshot = await S.loadFactoryState(stateFile);
  S.clearExpiredVerifyPause(snapshot, now);
  if (S.isFactoryPaused(snapshot, now)) return refuse("factory-paused");
  if (S.isVerifyPaused(snapshot, now)) {
    return refuse("lane-paused", { pausedReason: S.getVerify(snapshot).pausedReason });
  }
  const inFlight = S.getVerify(snapshot).inFlight;
  if (inFlight) {
    const mine = inFlight.issue === String(issue) && inFlight.sha === sha;
    return refuse(mine ? "running" : "busy", { runId: inFlight.runId, busyIssue: inFlight.issue });
  }
  const rec = S.getIssue(snapshot, issue);
  const used = S.shaKeyedCount(rec.verifyShellAttempts, sha);
  if (used >= knobs.maxAttempts) return refuse("attempts", { attempts: used });
  // The sweep starts a round before it works the lanes; the scenario is written
  // when the round starts. Both are for this exact head, or there's nothing to
  // run yet.
  if (rec.verifySha !== sha) return refuse("no-round");
  if (rec.intestCommentSha !== sha) return refuse("scenario-wait");
  const startedMs = Date.parse(rec.verifyStartedAt ?? "");
  const roundAgeMin = Number.isFinite(startedMs)
    ? (Date.parse(now) - startedMs) / MINUTE_MS
    : Infinity;
  // The sweep promotes at the cap whatever runs, and stops what is still
  // running. A run gets until the cap at most (its deadline is cut to it), and
  // none starts with less than MIN_RUN_MIN left: an install and a session
  // that can only be killed would cost a claude session and hide the previous
  // attempt's outcome behind "the hold cap was reached first".
  const holdLeftMin = knobs.holdMaxMin - roundAgeMin;
  if (holdLeftMin <= 0) return refuse("hold-cap");
  if (holdLeftMin < MIN_RUN_MIN)
    return refuse("hold-cap-near", { minutesLeft: Math.floor(holdLeftMin) });
  const pressure = await deps.memoryPressure();
  if (Number.isInteger(pressure) && pressure >= 2) return refuse("memory", { pressure });
  const freeGb = await deps.freeDiskGb(repoRoot);
  if (Number.isInteger(freeGb) && freeGb < knobs.minFreeDiskGb) return refuse("disk", { freeGb });
  if (!deps.fs.existsSync(promptFile)) return refuse("prompt-missing");
  const bins = resolveBins({ env: deps.env, isExecutable: deps.isExecutable });
  for (const name of ["claude", "pnpm", "curl", "perl", "nice"]) {
    if (!bins[name]) return refuse(`${name}-missing`);
  }

  const view = await readPrView(pr, deps, "state,headRefOid,files");
  if (!view) return refuse("pr-unreadable");
  if (view.state !== "OPEN" || view.headRefOid !== sha) {
    return refuse("head-moved", { headSha: view.headRefOid, prState: view.state });
  }
  const files = (Array.isArray(view.files) ? view.files : []).map((f) => f?.path).filter(Boolean);
  const previewOrigin = await previewOriginForSha(sha, deps);
  if (!previewOrigin && roundAgeMin < knobs.previewWaitMin) return refuse("preview-wait");
  let platforms = {};
  try {
    platforms = JSON.parse(opts.platforms || "{}") ?? {};
  } catch {
    platforms = {};
  }
  if (opts.dryRun) return refuse("dry-run", { preview: Boolean(previewOrigin) });

  // Reserve on a fresh copy BEFORE any side effect, re-checking what the
  // snapshot decided on. A tick that dies from here on leaves a pid-null
  // reservation that housekeeping declares lost and refunds.
  const runId = makeRunId(issue, sha, now);
  let refused = null;
  let reservation = null;
  await mutateState(S, stateFile, (s) => {
    if (S.isFactoryPaused(s, now)) refused = "factory-paused";
    else if (S.isVerifyPaused(s, now)) refused = "lane-paused";
    else if (S.getVerify(s).inFlight) refused = "busy";
    if (refused) return false;
    reservation = S.reserveVerifyRun(s, {
      issue,
      sha,
      pr,
      runId,
      maxAttempts: knobs.maxAttempts,
      now,
    });
    return reservation.ok;
  });
  if (refused) return refuse(refused);
  if (!reservation.ok) return refuse(reservation.reason);

  const worktree = worktreePathFor(repoRoot, issue, sha);
  const runDir = path.join(runRoot, runId);
  let spawned = null;
  try {
    await prepareWorktree({ repoRoot, pr, sha, worktree }, deps);
    const [title, comments] = await Promise.all([
      readIssueTitle(issue, deps),
      readIssueComments(issue, deps),
    ]);
    const qaTag = qaTagFor(issue, sha, runId);
    const bundle = B.buildFactoryVerifyShellBundle({
      issue: { number: Number(issue), title },
      comments,
      headSha: sha,
      prNumber: Number(pr),
      platforms,
      files,
      previewOrigin,
      qaTag,
      preflightScripts: findPreflightScripts(worktree, issue, files, deps.fs),
      timeLimitMin: Math.min(knobs.timeoutMin, Math.floor(holdLeftMin)),
      nowIso: now,
    });
    deps.fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    deps.fs.chmodSync(runDir, 0o700);
    deps.fs.writeFileSync(
      path.join(runDir, "prompt.md"),
      deps.fs.readFileSync(promptFile, "utf8"),
      { mode: 0o600 },
    );
    writeJsonAtomic(deps.fs, path.join(runDir, "bundle.json"), bundle);
    const home = deps.env.HOME || os.homedir();
    const guard = G.writeGuardFiles({
      runDir,
      worktree,
      repoRoot,
      home,
      perlPath: bins.perl,
      nodePath: bins.node,
    });
    const bypassProblem = bypassFileProblem(knobs.bypassFile, deps.fs);
    const deadlineAt = addMinutes(now, Math.min(knobs.timeoutMin, Math.floor(holdLeftMin)));
    // Paths and facts only: never a secret's value. The supervisor reads the
    // secret files itself, at the moment it needs them.
    const meta = {
      runId,
      issue: String(issue),
      pr: String(pr),
      sha,
      worktree,
      runDir,
      repoRoot,
      startedAt: isoSeconds(now),
      deadlineAt,
      sessionId: deps.uuid(),
      effort: knobs.effort,
      installTimeoutSec: knobs.installTimeoutSec,
      previewOrigin,
      qaTag,
      bins,
      paths: {
        prompt: path.join(runDir, "prompt.md"),
        bundle: path.join(runDir, "bundle.json"),
        guardConfig: guard.configPath,
        guardSettings: guard.settingsPath,
        runClaude: RUN_CLAUDE,
        module: THIS_FILE,
        bypassFile: bypassProblem ? null : knobs.bypassFile,
        accountFile: knobs.accountFile,
        signinKeyFile: knobs.signinKeyFile,
      },
      laneFacts: { bypass: bypassProblem ?? "ok" },
    };
    writeJsonAtomic(deps.fs, path.join(runDir, "meta.json"), meta);
    // The run id rides on the supervisor's command line: factory:verify-finish
    // and housekeeping identify the live process by it (a reused pid never
    // carries it). nice execs node, so the pid is the supervisor's.
    spawned = await deps.spawnDetached(
      bins.nice,
      ["-n", "10", bins.node, THIS_FILE, "_supervise", "--run-dir", runDir],
      { cwd: runDir, logPath: path.join(runDir, "supervisor.log"), env: supervisedEnv(deps.env) },
    );
    if (!spawned.ok) throw new Error(`supervisor failed to start: ${spawned.reason}`);
    const attached = await mutateState(S, stateFile, (s) => {
      const ok = S.attachVerifyRun(s, runId, { pid: spawned.pid, deadlineAt, runDir, worktree });
      if (!ok) return false;
      S.setIssueField(s, issue, "verifyShell", `${sha}:running`);
      S.setIssueField(s, issue, "verifyShellRunDir", runDir);
      return true;
    });
    if (!attached) {
      // Released while we prepared (an operator's factory:verify-finish).
      // Nothing accounts for this supervisor any more: stop it now.
      deps.kill(-spawned.pid, "SIGTERM");
      await removeWorktree(repoRoot, worktree, deps);
      return refuse("abandoned", { runId });
    }
    return {
      started: true,
      runId,
      runDir,
      worktree,
      deadlineAt,
      attempt: reservation.attempt,
      preview: Boolean(previewOrigin),
      bypass: bypassProblem ?? "ok",
    };
  } catch (err) {
    // A supervisor that did start (the attach write threw) is stopped first.
    if (spawned?.ok) deps.kill(-spawned.pid, "SIGTERM");
    // The run never got going: give the attempt back.
    await mutateState(S, stateFile, (s) => S.finishVerifyRun(s, runId, { refund: "attempt" }).ok);
    await removeWorktree(repoRoot, worktree, deps);
    return refuse("start-failed", { error: err.message });
  }
}

// ── supervisor (detached) ───────────────────────────────────────────────────

function appendLog(file, line) {
  try {
    nodeFs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
  } catch {
    /* logging must never fail the run */
  }
}

// Spawn and wait. stdout/stderr go to files (or are captured); never throws.
function runStep(
  command,
  args,
  {
    cwd,
    env,
    timeoutMs,
    input = null,
    stdoutFile = null,
    stderrFile = null,
    capture = false,
    onChild,
  },
) {
  return new Promise((resolve) => {
    const open = (f) => (f ? nodeFs.openSync(f, "a", 0o600) : capture ? "pipe" : "ignore");
    let outFd;
    let errFd;
    let child;
    try {
      outFd = open(stdoutFile);
      errFd = open(stderrFile);
      child = spawn(command, args, {
        cwd,
        env,
        stdio: [input == null ? "ignore" : "pipe", outFd, errFd],
      });
    } catch (err) {
      resolve({ code: 127, timedOut: false, stdout: "", error: err.message });
      return;
    }
    for (const fd of [outFd, errFd]) {
      if (typeof fd === "number") nodeFs.closeSync(fd);
    }
    if (onChild) onChild(child);
    const chunks = [];
    if (capture && child.stdout) child.stdout.on("data", (d) => chunks.push(d));
    if (capture && child.stderr) child.stderr.on("data", () => {});
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
        }, timeoutMs)
      : null;
    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, timedOut, stdout: "", error: err.message });
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : (code ?? (signal ? 128 : 1)),
        signal: signal ?? null,
        timedOut,
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    });
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

// node_modules from the factory checkout by clonefile (cp -c), as
// seed_worktree_node_modules does for slot worktrees: the install that follows
// is then a near-instant offline reconcile. Best effort.
async function seedNodeModules(meta, logFile, stopped = () => false) {
  const src = meta.repoRoot;
  const dst = meta.worktree;
  const rels = ["node_modules"];
  for (const group of ["apps", "packages"]) {
    let names = [];
    try {
      names = nodeFs.readdirSync(path.join(src, group));
    } catch {
      names = [];
    }
    for (const n of names) rels.push(path.join(group, n, "node_modules"));
  }
  for (const rel of rels) {
    if (stopped()) return;
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    if (!nodeFs.existsSync(from) || nodeFs.existsSync(to)) continue;
    try {
      nodeFs.mkdirSync(path.dirname(to), { recursive: true });
    } catch {
      continue;
    }
    const r = await runStep(meta.bins.cp || "/bin/cp", ["-c", "-R", from, to], {
      cwd: dst,
      env: supervisedEnv(process.env),
    });
    if (r.code !== 0) {
      appendLog(
        logFile,
        `clonefile seed of ${rel} failed (exit ${r.code}); pnpm install repopulates it`,
      );
      rmQuiet(nodeFs, to);
    }
  }
}

/**
 * Sign the run's cookie jar in as the dev test account: mint the one-time
 * link (browser-signin.mjs) and open it with curl through the run's config.
 * Returns the session fact: signed-in, mint-failed, signin-failed (the branch
 * predates the route, or the account is gone), protected (Vercel's SSO: no
 * usable bypass secret), or failed-<code>.
 */
export async function signInPreview(meta, { cfg, privateDir, env, logFile, mint = null }) {
  let link;
  try {
    const mintFn = mint ?? (await import("./browser-signin.mjs")).mint;
    link = await mintFn({
      keyFile: meta.paths.signinKeyFile,
      accountFile: meta.paths.accountFile,
      origin: meta.previewOrigin,
    });
  } catch (err) {
    // browser-signin's messages name what failed, never a key or token.
    appendLog(logFile, `minting the preview sign-in link failed: ${err.message}`);
    return "mint-failed";
  }
  // The link is a login token: it goes in a mode-600 config, never on argv.
  const linkCfg = path.join(privateDir, "signin.cfg");
  nodeFs.writeFileSync(linkCfg, `url = "${link}"\n`, { mode: 0o600 });
  const r = await runStep(
    meta.bins.curl,
    ["-q", "-K", cfg, "-K", linkCfg, "-s", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}"],
    { cwd: privateDir, env, timeoutMs: CURL_TIMEOUT_MS, capture: true },
  );
  rmQuiet(nodeFs, linkCfg);
  const [code, redirect = ""] = r.stdout.trim().split(/\s+/);
  if (r.code === 0 && /^30[1278]$/.test(code ?? "") && redirect === `${meta.previewOrigin}/`) {
    return "signed-in";
  }
  if (redirect.includes("/login")) return "signin-failed";
  if (/vercel\.com/.test(redirect) || code === "401" || code === "403") return "protected";
  return `failed-${/^\d{3}$/.test(code ?? "") ? code : `curl-${r.code}`}`;
}

// Revoke the API keys this run may have made (named with its qaTag), plus any
// lane key (QA_TAG_PREFIX) created before this run started: leftovers of a run
// that was killed before its own cleanup. A key created after this run started
// with another tag belongs to a newer run that may already hold the slot (this
// cleanup can outlive the slot after a stop), so it is never touched.
export async function revokeLaneKeys(meta, { cfg, env, cwd }) {
  const list = await runStep(
    meta.bins.curl,
    ["-q", "-K", cfg, "-s", "-w", "\n%{http_code}", "--url", `${meta.previewOrigin}/api/api-keys`],
    { cwd, env, timeoutMs: CURL_TIMEOUT_MS, capture: true },
  );
  const lines = list.stdout.split("\n");
  const code = lines.pop()?.trim();
  const keys = code === "200" ? parseJson(lines.join("\n"), null) : null;
  if (!Array.isArray(keys)) return { revoked: 0, failed: true };
  let revoked = 0;
  let failed = false;
  const startedMs = Date.parse(meta.startedAt ?? "");
  const mine = (k) =>
    typeof meta.qaTag === "string" && meta.qaTag !== "" && k.name.includes(meta.qaTag);
  const leftover = (k) => {
    const created = Date.parse(k.created_at ?? "");
    return Number.isFinite(created) && Number.isFinite(startedMs) && created < startedMs;
  };
  for (const k of keys) {
    if (typeof k?.name !== "string" || !k.name.includes(QA_TAG_PREFIX) || k.revoked_at) continue;
    if (!mine(k) && !leftover(k)) continue;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(k.id ?? ""))) {
      failed = true;
      continue;
    }
    const del = await runStep(
      meta.bins.curl,
      [
        "-q",
        "-K",
        cfg,
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-X",
        "DELETE",
        "--url",
        `${meta.previewOrigin}/api/api-keys/${k.id}`,
      ],
      { cwd, env, timeoutMs: CURL_TIMEOUT_MS, capture: true },
    );
    if (del.stdout.trim() === "200") revoked++;
    else failed = true;
  }
  return { revoked, failed };
}

/** Find <sessionId>.jsonl under the claude projects dir, or null. */
export function findTranscript(sessionId, { env = process.env, fs = nodeFs } = {}) {
  if (!UUID_RE.test(String(sessionId))) return null;
  const root = path.join(
    env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude"),
    "projects",
  );
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Did the guard cover the session? The canary proves the settings loaded; pre
 * records prove the matcher fired. A session that used tools with no pre
 * record ran unguarded. Null when the guard's log can't be read at all.
 */
export async function checkGuard(meta, { env = process.env, fs = nodeFs } = {}) {
  try {
    const { verifySession } = await import("./verify-guard.mjs");
    const counts = verifySession({ configPath: meta.paths.guardConfig, session: meta.sessionId });
    const transcript = findTranscript(meta.sessionId, { env, fs });
    const toolUses = transcript
      ? countToolUses(readText(fs, transcript, 16 * MAX_OUTPUT_BYTES))
      : 0;
    return {
      ...counts,
      transcript: Boolean(transcript),
      toolUses,
      ok: counts.sessionStart && !(toolUses > 0 && counts.pre === 0),
    };
  } catch {
    return null;
  }
}

/** How many tool calls the session's transcript records. */
export function countToolUses(jsonlText) {
  let n = 0;
  for (const line of String(jsonlText ?? "").split("\n")) {
    if (!line.trim()) continue;
    const r = parseJson(line, null);
    if (r?.type === "assistant" && Array.isArray(r.message?.content)) {
      n += r.message.content.filter((c) => c?.type === "tool_use").length;
    }
  }
  return n;
}

function composeInput(meta, facts) {
  const prompt = nodeFs.readFileSync(meta.paths.prompt, "utf8");
  const bundle = nodeFs.readFileSync(meta.paths.bundle, "utf8");
  const deadlineMs = Date.parse(meta.deadlineAt);
  const runtime = {
    preview: meta.previewOrigin
      ? {
          origin: meta.previewOrigin,
          session: facts.session,
          bypass: facts.bypass,
          client: "preview-curl",
        }
      : null,
    install: facts.install,
    qaTag: meta.qaTag,
    minutesLeft: Math.max(
      1,
      Math.floor((deadlineMs - Date.now()) / MINUTE_MS - CLEANUP_RESERVE_SEC / 60),
    ),
  };
  return [
    prompt.trimEnd(),
    "",
    "## Context bundle for this run",
    "",
    "```json",
    bundle.trimEnd(),
    "```",
    "",
    "## Run-time facts",
    "",
    "```json",
    JSON.stringify(runtime, null, 2),
    "```",
    "",
  ].join("\n");
}

export async function runSupervise({ runDir }, { env = process.env } = {}) {
  const meta = JSON.parse(nodeFs.readFileSync(path.join(runDir, "meta.json"), "utf8"));
  const logFile = path.join(runDir, "supervisor.log");
  const privateDir = path.join(runDir, "private");
  const cfg = path.join(privateDir, "curl.cfg");
  const ghEmpty = path.join(runDir, "gh-empty");
  const binDir = path.join(runDir, "bin");
  const facts = {
    install: null,
    session: meta.previewOrigin ? null : "no-preview",
    bypass: meta.laneFacts?.bypass ?? "unknown",
  };
  const status = { terminated: false, timedOut: false, child: null };
  let exitCode = null;
  let signal = null;
  let error = null;
  let stage = "start";
  let guard = null;
  let revoke = { revoked: 0, failed: false, skipped: true };

  const stopped = () => status.terminated || status.timedOut;
  // Housekeeping (or factory:verify-finish) SIGTERMs the whole process group;
  // so does the deadline below. Either way: stop the current step, then still
  // revoke keys, drop private/ and write exit.json.
  const onSignal = () => {
    if (!status.timedOut) status.terminated = true;
    appendLog(logFile, "stop signal received");
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  const deadlineMs = Math.max(0, Date.parse(meta.deadlineAt) - Date.now());
  // A backstop: run-claude.mjs ends the claude call CLEANUP_RESERVE_SEC before
  // this. The whole process group is signalled (claude, the commands it ran,
  // run-claude), not just the direct child, so nothing it started outlives
  // the run; onSignal absorbs the copy this process gets. Started detached,
  // the supervisor leads its group; if it doesn't, kill(-pid) is ESRCH and
  // only the child is signalled.
  const deadline = setTimeout(() => {
    status.timedOut = true;
    appendLog(logFile, "deadline reached; stopping the run");
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      status.child?.kill("SIGTERM");
    }
    setTimeout(() => status.child?.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }, deadlineMs);
  deadline.unref();
  const track = (child) => {
    status.child = child;
  };

  try {
    const baseEnv = laneEnv(env, {
      binDirs: [path.dirname(meta.bins.node)],
      ghConfigDir: ghEmpty,
    });
    nodeFs.mkdirSync(ghEmpty, { recursive: true, mode: 0o700 });

    stage = "install";
    if (!stopped()) await seedNodeModules(meta, logFile, stopped);
    if (!stopped()) {
      const r = await runStep(
        meta.bins.pnpm,
        ["install", "--frozen-lockfile", "--prefer-offline"],
        {
          cwd: meta.worktree,
          env: baseEnv,
          timeoutMs: meta.installTimeoutSec * 1000,
          stdoutFile: path.join(runDir, "install.log"),
          stderrFile: path.join(runDir, "install.log"),
          onChild: track,
        },
      );
      facts.install = r.code === 0 ? "ok" : r.timedOut ? "timeout" : "failed";
    }
    if (facts.install !== "ok") {
      if (!stopped()) error = "install";
      return;
    }

    stage = "session";
    nodeFs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    nodeFs.chmodSync(privateDir, 0o700);
    let bypassSecret = null;
    if (meta.paths.bypassFile) {
      try {
        bypassSecret = readBypassSecret(meta.paths.bypassFile);
      } catch {
        facts.bypass = "unreadable";
      }
    }
    nodeFs.writeFileSync(
      cfg,
      curlConfigText({ bypassSecret, cookieJar: path.join(privateDir, "cookies.txt") }),
      { mode: 0o600 },
    );
    bypassSecret = null;
    if (meta.previewOrigin && !stopped()) {
      facts.session = await signInPreview(meta, { cfg, privateDir, env: baseEnv, logFile });
    }
    nodeFs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    nodeFs.writeFileSync(
      path.join(binDir, "preview-curl"),
      previewCurlScript({ nodePath: meta.bins.node, modulePath: meta.paths.module, runDir }),
      { mode: 0o700 },
    );

    stage = "claude";
    if (stopped()) return;
    const remainingSec =
      Math.floor((Date.parse(meta.deadlineAt) - Date.now()) / 1000) - CLEANUP_RESERVE_SEC;
    const args = buildClaudeArgs({
      settingsPath: meta.paths.guardSettings,
      sessionId: meta.sessionId,
      effort: meta.effort,
    });
    // meta.json is a file on disk by now, not the array start built: the guard
    // on the flags belongs at the one place claude is started.
    assertSafeClaudeArgs(args);
    const claudeEnv = laneEnv(env, {
      binDirs: [binDir, path.dirname(meta.bins.claude), path.dirname(meta.bins.node)],
      ghConfigDir: ghEmpty,
      extra: { CLAUDE_CALL_TIMEOUT_SEC: String(Math.max(60, remainingSec)) },
    });
    appendLog(
      logFile,
      `claude session ${meta.sessionId} starting (cap ${Math.max(60, remainingSec)}s, session=${facts.session}, bypass=${facts.bypass})`,
    );
    const r = await runStep(meta.bins.node, [meta.paths.runClaude, ...args], {
      cwd: meta.worktree,
      env: claudeEnv,
      input: composeInput(meta, facts),
      stdoutFile: path.join(runDir, "shell-output.txt"),
      stderrFile: path.join(runDir, "claude-stderr.log"),
      onChild: track,
    });
    exitCode = r.code;
    signal = r.signal ?? null;
    if (r.code === 124) status.timedOut = true;
    stage = "guard-check";
    guard = await checkGuard(meta, { env, fs: nodeFs });
  } catch (err) {
    error = error ?? err.message;
  } finally {
    clearTimeout(deadline);
    try {
      if (facts.session === "signed-in" && nodeFs.existsSync(cfg)) {
        revoke = await revokeLaneKeys(meta, {
          cfg,
          env: laneEnv(env, { ghConfigDir: ghEmpty }),
          cwd: runDir,
        });
      }
    } catch (err) {
      revoke = { revoked: 0, failed: true, error: err.message };
    }
    rmQuiet(nodeFs, privateDir);
    rmQuiet(nodeFs, ghEmpty);
    writeJsonAtomic(nodeFs, path.join(runDir, "exit.json"), {
      exitCode,
      signal,
      timedOut: status.timedOut,
      terminated: status.terminated,
      stage,
      error,
      facts,
      guard,
      revoked: revoke.revoked ?? 0,
      revokeFailed: Boolean(revoke.failed),
      endedAt: isoSeconds(new Date().toISOString()),
    });
    appendLog(
      logFile,
      `run ended (stage=${stage}, exit=${exitCode}, error=${error ?? "none"}, revoked=${revoke.revoked ?? 0})`,
    );
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
  }
}

// ── housekeeping ────────────────────────────────────────────────────────────

/**
 * What a finished (or dead) run means for the card. Pure. <parsed> is
 * verify-report.mjs's parseShellOutput() of the lane's output: the report
 * composer and this decision read the status line the same way.
 *   laneState: what to record after "<sha>:" (null: nothing new); a `retry:*`
 *              state is non-terminal, so the sweep starts another attempt.
 *   refund:    "attempt" when the run's failure wasn't the card's.
 */
export function classifyRun({
  exit,
  parsed,
  sessionLimit = null,
  attemptsUsed = 1,
  maxAttempts = 2,
  pastDeadline = false,
  guard = null,
}) {
  if (!parsed || typeof parsed.status !== "string")
    parsed = { status: "malformed", verdict: "none" };
  const valid = parsed.status !== "malformed";
  const retryOr = (outcome, terminal) => ({
    outcome,
    laneState: attemptsUsed < maxAttempts ? `retry:${outcome}` : terminal,
    refund: "none",
  });
  const unguarded = {
    outcome: "guard",
    laneState: "unavailable:guard",
    refund: "none",
    pauseLane: { minutes: GUARD_PAUSE_MIN, reason: "guard-not-loaded" },
  };
  if (!exit) {
    // The supervisor died without exit.json. Its output only counts when the
    // guard's log vouches for the session (housekeeping checks it: <guard>).
    if (valid) {
      if (guard?.ok)
        return { outcome: "salvaged", laneState: `reported:${parsed.verdict}`, refund: "none" };
      if (guard) return unguarded;
      return retryOr("lost", "unavailable:lost");
    }
    // Killed after its deadline (housekeeping's overdue SIGKILL leaves no
    // exit.json): that is a timeout, not a supervisor that died early.
    if (pastDeadline) return { outcome: "timeout", laneState: "timeout", refund: "none" };
    return retryOr("lost", "unavailable:lost");
  }
  if (exit.error === "install")
    return { outcome: "install", laneState: "unavailable:install", refund: "none" };
  // Fail closed: once claude was started (exitCode set) and the session left
  // evidence it ran (a transcript or a report), its output counts only when
  // the guard vouches for it. No canary, tool calls with no pre record, or a
  // guard check that couldn't run (guard null) all mean "ran unguarded". The
  // canary doesn't depend on the transcript being found.
  const ran = exit.exitCode != null && (Boolean(exit.guard?.transcript) || valid);
  if (ran && !exit.guard?.ok) return unguarded;
  if (sessionLimit)
    return { outcome: "session-limit", laneState: "deferred:session-limit", refund: "attempt" };
  // A valid status line means the session finished its report, however the
  // supervisor ended afterwards.
  if (parsed.status !== "malformed") {
    return { outcome: "reported", laneState: `reported:${parsed.verdict}`, refund: "none" };
  }
  if (exit.timedOut) return { outcome: "timeout", laneState: "timeout", refund: "none" };
  // Stopped from outside without housekeeping knowing why (an operator's
  // factory:verify-finish, a reboot): not the card's doing.
  if (exit.terminated)
    return { outcome: "terminated", laneState: "retry:terminated", refund: "attempt" };
  if (exit.exitCode === 0) return retryOr("no-result", "unavailable:no-result");
  return retryOr("error", "unavailable:error");
}

export async function pollRun(inFlight, { now }, deps) {
  const exitFile = inFlight.runDir ? path.join(inFlight.runDir, "exit.json") : null;
  if (exitFile && deps.fs.existsSync(exitFile)) {
    const exit = parseJson(readText(deps.fs, exitFile), null);
    if (exit) return { state: "done", exit };
  }
  if (inFlight.pid == null) {
    const age = Date.parse(now) - Date.parse(inFlight.startedAt ?? now);
    return age >= UNATTACHED_LOST_MS ? { state: "lost", unattached: true } : { state: "starting" };
  }
  if (deps.isPidAlive(inFlight.pid)) {
    // pid reuse: only a live pid whose command line carries this run id.
    const command = await deps.psCommand(inFlight.pid);
    if (command.includes(inFlight.runId)) {
      const pastDeadline = Date.parse(now) - Date.parse(inFlight.deadlineAt ?? now);
      if (pastDeadline >= OVERDUE_GRACE_MS) {
        return {
          state: "overdue",
          signal: pastDeadline >= OVERDUE_KILL_MS ? "SIGKILL" : "SIGTERM",
        };
      }
      return { state: "running" };
    }
  }
  return { state: "lost" };
}

// Why a still-running run should stop now, or null. An unreadable PR or issue
// changes nothing.
async function stopReason(inFlight, deps) {
  if (inFlight.pr) {
    const view = await readPrView(inFlight.pr, deps);
    if (view && view.state !== "OPEN") return "pr-closed";
    if (view && view.headRefOid !== inFlight.sha) return "head-moved";
  }
  const issue = await readIssueLabels(inFlight.issue, deps);
  if (issue && (issue.state === "CLOSED" || !issue.labels.includes("status:testing"))) {
    return "left-testing";
  }
  return null;
}

async function detectLimit(meta, inFlight, { now, knobs }, deps) {
  if (!meta?.sessionId) return null;
  const transcript = findTranscript(meta.sessionId, { env: deps.env, fs: deps.fs });
  if (!transcript) return null;
  const { detectSessionLimit } = await import("./session-limit.mjs");
  const r = detectSessionLimit(readText(deps.fs, transcript, 16 * MAX_OUTPUT_BYTES), {
    now: new Date(now),
    since: inFlight.startedAt ?? null,
  });
  if (!r.limited) return null;
  const resetAt = r.resetAt
    ? r.resetAt.toISOString()
    : new Date(Date.parse(now) + knobs.limitFallbackMin * MINUTE_MS).toISOString();
  return { resetAt, reason: r.reason ?? "session limit" };
}

export async function runHousekeeping(opts, deps) {
  const { S } = await libs();
  const { stateFile, repoRoot, runRoot } = opts;
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now ?? deps.now();
  const knobs = readKnobs(deps.env);
  const laneOn = deps.env?.FACTORY_VERIFY === "1";

  const snapshot = await S.loadFactoryState(stateFile);
  const inFlight = S.getVerify(snapshot).inFlight;
  if (!inFlight) {
    const reaped = dryRun
      ? { worktrees: [], runDirs: [], privateDirs: [] }
      : await reap({ repoRoot, runRoot, inFlight: null, now }, deps);
    return { state: "idle", reaped };
  }
  const base = { runId: inFlight.runId, issue: inFlight.issue, sha: inFlight.sha };
  const worktree = inFlight.worktree ?? worktreePathFor(repoRoot, inFlight.issue, inFlight.sha);
  const poll = await pollRun(inFlight, { now }, deps);
  const live = poll.state === "running" || poll.state === "overdue";

  // The kill switch: wind down whatever is left, record nothing. The card is
  // drained with "verification off" by the sweep anyway.
  if (!laneOn) {
    const result = { ...base, state: poll.state, discarded: "lane-off" };
    if (dryRun) return { ...result, dryRun: true };
    if (live) deps.kill(-inFlight.pid, poll.signal ?? "SIGTERM");
    await removeWorktree(repoRoot, worktree, deps);
    const finished = await finishRun(S, stateFile, inFlight.runId, { refund: "attempt" });
    return { ...result, refund: "attempt", ...(finished ? {} : { finishedElsewhere: true }) };
  }

  if (live && !dryRun) {
    const why = await stopReason(inFlight, deps);
    if (why) {
      const signal = poll.signal ?? "SIGTERM";
      deps.kill(-inFlight.pid, signal);
      await removeWorktree(repoRoot, worktree, deps);
      // A push or a closed PR wasn't the card's doing; a card that left
      // Testing keeps the attempt spent, so a label that disagrees with the
      // board can't loop start → kill forever.
      const refund = why === "left-testing" ? "none" : "attempt";
      const finished = await finishRun(S, stateFile, inFlight.runId, {
        refund,
        writes: [
          (s) => {
            if (S.getIssue(s, inFlight.issue).verifyShell === `${inFlight.sha}:running`) {
              S.setIssueField(s, inFlight.issue, "verifyShell", `${inFlight.sha}:retry:stopped`);
            }
          },
        ],
      });
      const reaped = await reap({ repoRoot, runRoot, inFlight: null, now }, deps);
      return {
        ...base,
        state: "terminated",
        reason: why,
        signal,
        refund,
        ...(finished ? {} : { finishedElsewhere: true }),
        reaped,
      };
    }
  }
  if (poll.state === "starting" || poll.state === "running") {
    if (!dryRun) await reap({ repoRoot, runRoot, inFlight, now }, deps);
    return { ...base, state: poll.state };
  }
  if (poll.state === "overdue") {
    if (!dryRun) deps.kill(-inFlight.pid, poll.signal);
    return { ...base, state: "overdue", signal: poll.signal };
  }
  if (poll.unattached) {
    // The tick that reserved this died between the spawn and the attach: a
    // supervisor may be running that nothing tracks. Find it by its run id
    // (it leads its own group) and stop it before the slot is freed, or a
    // second run could start beside it. No process table, no release.
    const procs = await deps.listProcesses();
    if (!Array.isArray(procs)) {
      return { ...base, state: "lost", outcome: "unattached", deferred: "ps-failed" };
    }
    const orphans = procs
      .filter((p) => p.command.includes(inFlight.runId) && p.command.includes("_supervise"))
      .map((p) => p.pid);
    if (dryRun) return { ...base, state: "lost", outcome: "unattached", orphans, dryRun: true };
    for (const pid of orphans) deps.kill(-pid, "SIGTERM");
    await removeWorktree(repoRoot, worktree, deps);
    const finished = await finishRun(S, stateFile, inFlight.runId, { refund: "attempt" });
    return {
      ...base,
      state: "lost",
      outcome: "unattached",
      refund: "attempt",
      ...(orphans.length ? { killed: orphans } : {}),
      ...(finished ? {} : { finishedElsewhere: true }),
    };
  }

  // done, or lost (the supervisor died without writing exit.json).
  const runDir = typeof inFlight.runDir === "string" && inFlight.runDir ? inFlight.runDir : null;
  const exit = poll.exit ?? null;
  const outputText = runDir
    ? readText(deps.fs, path.join(runDir, "shell-output.txt"), MAX_OUTPUT_BYTES)
    : "";
  const meta = runDir ? parseJson(readText(deps.fs, path.join(runDir, "meta.json")), null) : null;
  const sessionLimit =
    exit && !exit.timedOut && exit.exitCode !== 0 && exit.exitCode != null
      ? await detectLimit(meta, inFlight, { now, knobs }, deps)
      : null;
  const attemptsUsed = S.shaKeyedCount(
    S.getIssue(snapshot, inFlight.issue).verifyShellAttempts,
    inFlight.sha,
  );
  const { parseShellOutput } = await import("./verify-report.mjs");
  const parsed = parseShellOutput(outputText);
  const c = classifyRun({
    exit,
    parsed,
    sessionLimit,
    attemptsUsed,
    maxAttempts: knobs.maxAttempts,
    pastDeadline: Date.parse(now) >= Date.parse(inFlight.deadlineAt ?? ""),
    // No exit.json: ask the guard's log ourselves before trusting any output.
    guard: !exit && parsed.status !== "malformed" && meta ? await checkGuard(meta, deps) : null,
  });
  const result = { ...base, state: poll.state, outcome: c.outcome, laneState: c.laneState };
  if (dryRun) return { ...result, dryRun: true };

  const writes = [];
  if (c.laneState) {
    writes.push((s) => {
      S.setIssueField(s, inFlight.issue, "verifyShell", `${inFlight.sha}:${c.laneState}`);
      if (runDir) S.setIssueField(s, inFlight.issue, "verifyShellRunDir", runDir);
    });
  }
  if (c.pauseLane) {
    const until = addMinutes(now, c.pauseLane.minutes);
    writes.push((s) => pauseLaneAtLeast(S, s, { until, reason: c.pauseLane.reason, now }));
  }
  await removeWorktree(repoRoot, worktree, deps);
  const finished = await finishRun(S, stateFile, inFlight.runId, { refund: c.refund, writes });
  const reaped = await reap({ repoRoot, runRoot, inFlight: null, now }, deps);
  return {
    ...result,
    refund: c.refund,
    ...(exit ? { revoked: exit.revoked ?? 0, revokeFailed: Boolean(exit.revokeFailed) } : {}),
    ...(sessionLimit ? { sessionLimit } : {}),
    ...(c.pauseLane ? { lanePaused: c.pauseLane.reason } : {}),
    ...(finished ? {} : { finishedElsewhere: true }),
    reaped,
  };
}

// ── stop ────────────────────────────────────────────────────────────────────

export async function runStop(opts, deps) {
  const { S } = await libs();
  const { issue, stateFile, repoRoot } = opts;
  const dryRun = Boolean(opts.dryRun);
  const snapshot = await S.loadFactoryState(stateFile);
  const inFlight = S.getVerify(snapshot).inFlight;
  // Any run of this card: the card is leaving Testing, whatever head it was for.
  if (!inFlight || inFlight.issue !== String(issue)) return { state: "idle" };
  const base = {
    runId: inFlight.runId,
    issue: inFlight.issue,
    sha: inFlight.sha,
    reason: opts.reason ?? "stop",
  };
  if (dryRun) return { ...base, state: "would-stop", dryRun: true };
  let signalled = false;
  if (Number.isInteger(inFlight.pid) && deps.isPidAlive(inFlight.pid)) {
    // Only the process that is this run (pid reuse after a reboot).
    if ((await deps.psCommand(inFlight.pid)).includes(inFlight.runId)) {
      signalled = deps.kill(-inFlight.pid, "SIGTERM");
    }
  }
  await removeWorktree(
    repoRoot,
    inFlight.worktree ?? worktreePathFor(repoRoot, inFlight.issue, inFlight.sha),
    deps,
  );
  const finished = await finishRun(S, stateFile, inFlight.runId, {
    refund: "attempt",
    writes: [
      (s) => {
        if (S.getIssue(s, inFlight.issue).verifyShell === `${inFlight.sha}:running`) {
          S.setIssueField(s, inFlight.issue, "verifyShell", `${inFlight.sha}:retry:stopped`);
        }
      },
    ],
  });
  return {
    ...base,
    state: "stopped",
    signalled,
    refund: "attempt",
    ...(finished ? {} : { finishedElsewhere: true }),
  };
}

// ── reaping ─────────────────────────────────────────────────────────────────

async function reap({ repoRoot, runRoot, inFlight, now }, deps) {
  const reaped = { worktrees: [], runDirs: [], privateDirs: [] };
  const wtRoot = path.join(repoRoot, "worktrees");
  const list = (dir) => {
    try {
      return deps.fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  const runs = list(runRoot).filter((n) => RUN_ID_RE.test(n));
  const keep = new Set();
  if (inFlight) {
    if (inFlight.worktree) keep.add(inFlight.worktree);
    keep.add(worktreePathFor(repoRoot, inFlight.issue, inFlight.sha));
  }
  const candidates = list(wtRoot)
    .filter((n) => n.startsWith("verify-"))
    .map((n) => path.join(wtRoot, n))
    .filter((full) => !keep.has(full));
  const withPrivate = runs.filter(
    (n) =>
      path.join(runRoot, n) !== inFlight?.runDir &&
      deps.fs.existsSync(path.join(runRoot, n, "private")),
  );
  // One process-table read for both checks: a run dir's supervisor is live
  // while some command line carries its run id. Unreadable → keep everything.
  const procs = candidates.length || withPrivate.length ? await deps.listProcesses() : [];
  const commands = Array.isArray(procs) ? procs.map((p) => p.command) : null;
  const isLive = (runId) => !Array.isArray(commands) || commands.some((c) => c.includes(runId));

  const liveWorktrees = new Set();
  for (const name of candidates.length ? runs : []) {
    const meta = parseJson(readText(deps.fs, path.join(runRoot, name, "meta.json")), null);
    if (typeof meta?.worktree === "string" && isLive(meta.runId || name)) {
      liveWorktrees.add(path.resolve(meta.worktree));
    }
  }
  for (const full of candidates) {
    if (liveWorktrees.has(path.resolve(full)) || !Array.isArray(commands)) continue;
    await removeWorktree(repoRoot, full, deps);
    reaped.worktrees.push(full);
  }
  // Old run dirs first: removing a private/ below bumps its run dir's mtime.
  const gone = new Set();
  for (const name of runs) {
    const full = path.join(runRoot, name);
    if (inFlight?.runDir === full) continue;
    try {
      const age = Date.parse(now) - deps.fs.statSync(full).mtimeMs;
      if (age > RUN_DIR_RETENTION_MS && !isLive(name)) {
        rmQuiet(deps.fs, full);
        reaped.runDirs.push(full);
        gone.add(name);
      }
    } catch {
      /* vanished mid-scan */
    }
  }
  // A supervisor that was SIGKILLed never removed its private/ (the curl
  // config with the bypass secret and the session cookie).
  for (const name of withPrivate) {
    if (gone.has(name) || isLive(name)) continue;
    rmQuiet(deps.fs, path.join(runRoot, name, "private"));
    reaped.privateDirs.push(path.join(runRoot, name));
  }
  return reaped;
}

// ── report helpers ──────────────────────────────────────────────────────────

const BYPASS_PROBLEM_TEXT = {
  missing: "isn't set up",
  "not-a-file": "isn't a regular file",
  mode: "is readable by others (it must be mode 600)",
  "no-key": `has no ${BYPASS_KEY}`,
  empty: "is empty",
  malformed: "doesn't hold a well-formed secret",
  unreadable: "couldn't be read",
};

/** Coverage gaps the run's own facts show, and whether it had the bypass secret. */
export function runGaps({ runDir }, { fs = nodeFs } = {}) {
  const meta = parseJson(readText(fs, path.join(runDir, "meta.json")), null);
  const exit = parseJson(readText(fs, path.join(runDir, "exit.json")), null);
  const gaps = [];
  if (!meta) return { gaps, bypassUsed: false };
  const bypass = exit?.facts?.bypass ?? meta.laneFacts?.bypass ?? "unknown";
  const bypassUsed = Boolean(meta.paths?.bypassFile) && bypass !== "unreadable";
  if (!meta.previewOrigin) {
    gaps.push({
      lane: "shell",
      reason:
        "no Vercel preview was ready when the lane started, so it ran no API checks against one",
    });
  } else if (bypass !== "ok") {
    const why = Object.hasOwn(BYPASS_PROBLEM_TEXT, bypass)
      ? BYPASS_PROBLEM_TEXT[bypass]
      : "isn't usable";
    gaps.push({
      lane: "shell",
      reason: `the Vercel protection-bypass secret ${why}, so the lane couldn't reach the preview's API (runbook: Pre-In-Test verification)`,
    });
  } else if (exit?.facts?.session && exit.facts.session !== "signed-in") {
    gaps.push({
      lane: "shell",
      reason: `the lane couldn't sign in on the preview (${String(exit.facts.session).slice(0, 40)}), so signed-in API checks didn't run`,
    });
  }
  if (exit?.revokeFailed) {
    gaps.push({
      lane: "shell",
      reason:
        "the lane couldn't confirm its test API keys were revoked; check the dev test account's keys",
    });
  }
  return { gaps, bypassUsed };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE =
  "usage: verify-lane.mjs <start --issue N --pr P --sha S --platforms J --state-file F --repo-root R --run-root D|" +
  "housekeeping --state-file F --repo-root R --run-root D|" +
  "stop --issue N [--sha S] [--reason R] --state-file F --repo-root R --run-root D|" +
  "gaps --run-dir D|bypass-check [--file F]|preview-curl --run-dir D -- <args>|_supervise --run-dir D> " +
  "[--dry-run 0|1] [--now ISO]";

class UsageError extends Error {}

function required(flags, names) {
  for (const name of names) {
    if (!flags[name]) throw new UsageError(`missing --${name}`);
  }
}

export async function main(argv, deps = createDeps()) {
  const [sub, ...rest] = argv;
  if (sub === "preview-curl") {
    // curl's own arguments follow "--"; they are not this module's flags.
    const sep = rest.indexOf("--");
    const own = sep === -1 ? rest : rest.slice(0, sep);
    const { flags } = parseFlags(own);
    required(flags, ["run-dir"]);
    return {
      exitCode: await runPreviewCurl({
        runDir: flags["run-dir"],
        argv: sep === -1 ? [] : rest.slice(sep + 1),
      }),
    };
  }
  const { flags } = parseFlags(rest);
  const dryRun = flags["dry-run"] === "1" || flags["dry-run"] === "true";
  const common = {
    stateFile: flags["state-file"],
    repoRoot: flags["repo-root"],
    runRoot: flags["run-root"],
    dryRun,
    now: flags.now,
  };
  switch (sub) {
    case "start":
      required(flags, ["issue", "pr", "sha", "state-file", "repo-root", "run-root"]);
      if (!SHA40.test(flags.sha)) throw new UsageError(`--sha must be a 40-hex SHA: ${flags.sha}`);
      if (!/^\d+$/.test(flags.issue) || !/^\d+$/.test(flags.pr)) {
        throw new UsageError("--issue and --pr must be numbers");
      }
      try {
        return await runStart(
          {
            ...common,
            issue: flags.issue,
            pr: flags.pr,
            sha: flags.sha,
            platforms: flags.platforms,
            promptFile: flags["prompt-file"],
            flags,
          },
          deps,
        );
      } catch (err) {
        return { started: false, reason: "error", error: err.message };
      }
    case "housekeeping":
      required(flags, ["state-file", "repo-root", "run-root"]);
      try {
        return await runHousekeeping(common, deps);
      } catch (err) {
        return { state: "error", error: err.message };
      }
    case "stop":
      required(flags, ["issue", "state-file", "repo-root", "run-root"]);
      try {
        return await runStop(
          { ...common, issue: flags.issue, sha: flags.sha, reason: flags.reason },
          deps,
        );
      } catch (err) {
        return { state: "error", error: err.message };
      }
    case "gaps":
      required(flags, ["run-dir"]);
      return runGaps({ runDir: flags["run-dir"] }, { fs: deps.fs });
    case "bypass-check": {
      const file = readKnobs(deps.env, { "bypass-file": flags.file }).bypassFile;
      const problem = bypassFileProblem(file, deps.fs);
      return { ok: problem === null, file, problem, exitCode: problem === null ? 0 : 2 };
    }
    case "_supervise":
      required(flags, ["run-dir"]);
      await runSupervise({ runDir: flags["run-dir"] });
      return null;
    default:
      throw new UsageError(sub ? `unknown subcommand: ${sub}` : "missing subcommand");
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out == null) return;
      const { exitCode, ...rest } = out;
      // preview-curl is curl: its output is the response, never a JSON line.
      if (process.argv[2] !== "preview-curl") process.stdout.write(JSON.stringify(rest) + "\n");
      if (Number.isInteger(exitCode) && exitCode !== 0) process.exitCode = exitCode;
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message, usage: USAGE }) + "\n");
      process.exit(1);
    },
  );
}
