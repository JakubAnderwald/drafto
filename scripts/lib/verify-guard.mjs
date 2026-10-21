#!/usr/bin/env node
// Guard for the verification stage's shell lane (ADR-0053).
//
// Why this exists: the shell lane (verify-lane.mjs) is an unattended claude
// session with Bash, in a fresh detached worktree of a PR's head, on the
// factory's Mac mini. The PR, its issue and its scenario are untrusted text,
// and the machine holds the factory's secrets (~/drafto-secrets, the gh and
// Vercel logins, other cards' worktrees with .env files). The real boundaries
// are elsewhere: the session's environment is an allowlist with no tokens,
// gh points at an empty config dir, the Vercel bypass secret and the preview
// session cookie live in a mode-600 curl config the model reaches only through
// the `preview-curl` wrapper, and the report composer scans the lane's output
// for every secret it could have seen. This hook is defense in depth on top:
// it denies the commands and paths a prompt-injected session would reach for
// first. A shell is Turing-complete and a pattern guard can't follow a script
// the model writes to a file and runs, so this is not, and doesn't claim to
// be, a sandbox.
//
// Shape, copied from browser-guard.mjs (ADR-0051):
//   - SessionStart writes a canary record. `claude -p` SILENTLY ignores a
//     settings file that fails validation and runs with no hooks at all, so
//     the supervisor checks the canary afterwards (verifySession) and the lane
//     reports `unavailable:guard` (and pauses itself) when it is missing.
//   - PreToolUse decides every call (decidePre). It fails closed: any
//     exception, unreadable payload or missing config exits 2, and the hook
//     command ends in `|| exit 2`, so a missing node or guard file blocks too.
//     Claude Code treats ONLY exit 2 as a block. A PreToolUse hook that runs
//     past its timeout is treated as ALLOW (measured for browser-guard on
//     2026-10-17), so the pre command runs under a perl alarm well inside it.
//
// What decidePre denies:
//   - any tool but Bash, Read, Grep and Glob (the session gets only those);
//   - Read / Grep / Glob on protected paths (protectedPathReason): the
//     factory's secrets, the run's private/ dir, .env files, the gh / ssh /
//     Claude / keychain / browser-profile dirs under $HOME, the factory's
//     logs/ (state file, other runs' outputs);
//   - in a Bash command, after shell-ish tokenising (splitCommands), each
//     simple command: gh, claude, vercel, supabase, fastlane, sudo, osascript,
//     launchctl, security, env, printenv, npx and the other DENY_COMMANDS;
//     git verbs that write or reach the network (only READ_ONLY_GIT_VERBS
//     pass); pnpm/npm install|add|release|version|publish|dlx and release-like
//     scripts; `node scripts/…` (the factory's own CLIs) except `node --test`;
//     a shell reading its script from stdin; curl to anything but loopback
//     (`preview-curl` is the only way to the preview); an interpreter one-liner
//     with a non-loopback URL; any reference to e2e/in-test/scenarios/ that
//     isn't a `… --preflight` run (ADR-0043: agents run the read-only
//     preflight only);
//   - anywhere in the command text: the protected paths above, `drafto.eu`
//     (production), `.config/gh`, the curl config's file names.
// Wrappers (nice, nohup, time, timeout, command, exec, xargs, find -exec,
// pnpm exec, bash -c …) are unwrapped and the inner command is checked too.
// Text that can't be tokenised (an unbalanced quote) is denied.
//
// The decision log is <logDir>/<session>.jsonl. Commands are logged truncated
// and with Drafto API keys and bearer tokens redacted.
//
// CLI:
//   node verify-guard.mjs config --out <cfg.json> --run-dir <dir> --worktree <dir>
//        --repo-root <dir> [--home <dir>]
//   node verify-guard.mjs settings --config <cfg.json> --out <settings.json> [--perl <path>]
//   node verify-guard.mjs hook <session-start|pre> --config <cfg.json>
//        (stdin = hook payload; pre exits 0 to allow, 2 + stderr reason to deny;
//        session-start always exits 0)
//   node verify-guard.mjs verify --config <cfg.json> --session <uuid>
//        (prints {sessionStart, pre, denied}; exit 0 iff sessionStart)
//   node verify-guard.mjs allowed-tools   (prints the --tools / --allowedTools value)

import { randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isMainModule } from "./is-main.mjs";

export const LANE_TOOLS = Object.freeze(["Bash", "Read", "Grep", "Glob"]);

// Removed from the session through permissions.deny on top of being left out
// of --tools. Only names every supported claude version knows: a settings file
// that fails validation is dropped silently, hooks and all.
export const ALWAYS_DENY_TOOLS = Object.freeze([
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
]);

export const HOOK_MATCHER = "*";
export const HOOK_TIMEOUTS = Object.freeze({ sessionStart: 10, pre: 30 });
export const PRE_ALARM_SEC = 20;
export const DEFAULT_PERL_PATH = "/usr/bin/perl";
// See browser-guard.mjs: SIGALRM survives exec, and a failed exec exits 2.
export const PERL_ALARM_SCRIPT = "alarm shift; exec @ARGV or exit 2";

// The run dir's subdirectory holding the curl config (bypass header, cookie
// jar). Shared with verify-lane.mjs, which creates it.
export const PRIVATE_DIRNAME = "private";
export const BIN_DIRNAME = "bin";
const PRIVATE_FILE_NAMES = ["curl.cfg", "cookies.txt", "signin.cfg"];

// Command words a lane session never runs, whatever their arguments.
export const DENY_COMMANDS = Object.freeze([
  // The factory's own reach: GitHub, Claude, Vercel, Supabase, store uploads.
  "gh",
  "claude",
  "vercel",
  "vc",
  "supabase",
  "fastlane",
  "xcrun",
  "xcodebuild",
  "altool",
  "gradle",
  "gradlew",
  "adb",
  "emulator",
  "maestro",
  "docker",
  // The host: privileges, launchd, the keychain, AppleScript, the clipboard.
  "sudo",
  "su",
  "doas",
  "osascript",
  "launchctl",
  "security",
  "defaults",
  "dscl",
  "crontab",
  "at",
  "open",
  "pbpaste",
  "pbcopy",
  "pkill",
  "killall",
  "shutdown",
  "reboot",
  "halt",
  "diskutil",
  "networksetup",
  "scutil",
  // The environment (it is an allowlist anyway; printing it is still refused).
  "env",
  "printenv",
  // Package runners that fetch and run code.
  "npx",
  "pnpx",
  "bunx",
  "bun",
  "yarn",
  "deno",
  // Network clients other than curl (preview-curl is the way out).
  "wget",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "sftp",
  "ssh",
  "scp",
  "rsync",
  "socat",
  // Code the guard can't read.
  "eval",
]);

// git verbs that neither write nor reach the network.
export const READ_ONLY_GIT_VERBS = Object.freeze([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "blame",
  "grep",
  "cat-file",
  "describe",
  "merge-base",
  "shortlog",
  "rev-list",
  "name-rev",
  "diff-tree",
  "show-ref",
  "help",
  "version",
]);

// pnpm / npm subcommands that install, publish, release or run fetched code.
const PNPM_DENY = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "un",
  "update",
  "up",
  "upgrade",
  "link",
  "ln",
  "unlink",
  "import",
  "patch",
  "patch-commit",
  "patch-remove",
  "setup",
  "self-update",
  "env",
  "dlx",
  "create",
  "init",
  "publish",
  "pack",
  "deploy",
  "release",
  "version",
  "login",
  "logout",
  "adduser",
  "fetch",
  "store",
  "config",
  "set",
  "server",
  "rebuild",
  "rb",
  "approve-builds",
  "ci",
  "x",
  "unpublish",
  "deprecate",
  "dist-tag",
  "owner",
  "access",
  "token",
  "dedupe",
]);
// Workspace scripts that ship, publish or reach a live service.
const DENY_SCRIPT =
  /(^|[:_-])(release|publish|deploy|promote|version|submit|upload|beta|prod|production|vercel|supabase|fastlane)([:_-]|$)/i;
// pnpm / npm options that take a value (so the value isn't read as the subcommand).
const PNPM_VALUE_OPTS = new Set([
  "--filter",
  "-F",
  "--filter-prod",
  "-C",
  "--dir",
  "--reporter",
  "--workspace-concurrency",
  "--test-pattern",
  "--changed-files-ignore-pattern",
  "--loglevel",
  "--prefix",
  "-w",
  "--workspace",
]);

// Wrappers whose real command follows: options to skip, and how many plain
// arguments they take before it.
const WRAPPERS = {
  nice: { valueOpts: ["-n"], positionalBefore: 0 },
  nohup: { valueOpts: [], positionalBefore: 0 },
  time: { valueOpts: [], positionalBefore: 0 },
  command: { valueOpts: [], positionalBefore: 0 },
  builtin: { valueOpts: [], positionalBefore: 0 },
  exec: { valueOpts: ["-a"], positionalBefore: 0 },
  stdbuf: { valueOpts: ["-i", "-o", "-e"], positionalBefore: 0 },
  caffeinate: { valueOpts: ["-t", "-w"], positionalBefore: 0 },
  timeout: { valueOpts: ["-s", "--signal", "-k", "--kill-after"], positionalBefore: 1 },
  gtimeout: { valueOpts: ["-s", "--signal", "-k", "--kill-after"], positionalBefore: 1 },
  xargs: {
    valueOpts: ["-I", "-i", "-L", "-l", "-n", "-P", "-s", "-E", "-e", "-d", "-J", "-R", "-a"],
    positionalBefore: 0,
  },
};

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set(["node", "python", "python3", "ruby", "perl", "php", "swift", "lua"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

// curl options that would route around the loopback rule, and the ones that
// take a value (so a JSON body isn't read as a host).
const CURL_DENY_OPTS = new Set([
  "-K",
  "--config",
  "-x",
  "--proxy",
  "--preproxy",
  "--connect-to",
  "--resolve",
  "--unix-socket",
  "--abstract-unix-socket",
  "--doh-url",
  "--socks4",
  "--socks4a",
  "--socks5",
  "--socks5-hostname",
]);
const CURL_VALUE_OPTS = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--data-ascii",
  "--json",
  "-H",
  "--header",
  "-X",
  "--request",
  "-o",
  "--output",
  "-w",
  "--write-out",
  "-u",
  "--user",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-b",
  "--cookie",
  "-c",
  "--cookie-jar",
  "-m",
  "--max-time",
  "--connect-timeout",
  "-F",
  "--form",
  "--form-string",
  "-T",
  "--upload-file",
  "-r",
  "--range",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--max-redirs",
  "--max-filesize",
  "--limit-rate",
  "-y",
  "--speed-time",
  "-Y",
  "--speed-limit",
  "-z",
  "--time-cond",
  "--cacert",
  "--capath",
  "-E",
  "--cert",
  "--key",
  "--url-query",
  "--variable",
]);

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_PRE_PAYLOAD_BYTES = 1024 * 1024;
const MAX_LOGGED_COMMAND = 400;

// ── Settings ────────────────────────────────────────────────────────────────

export function allowedToolsArg() {
  return LANE_TOOLS.join(",");
}

// See browser-guard.mjs: hook commands run through a shell, so a path that
// needs escaping is refused rather than escaped.
function shellQuotePath(label, p) {
  if (typeof p !== "string" || p === "") throw new Error(`${label} is required`);
  if (!path.isAbsolute(p)) throw new Error(`${label} must be an absolute path: ${p}`);
  if (p.includes("'")) throw new Error(`${label} must not contain a single quote: ${p}`);
  if (/[\u0000-\u001f\u007f]/.test(p)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return `'${p}'`;
}

/**
 * The --settings object for the lane. One function, so the shape the tests
 * pin is the only shape that ships: absolute node, guard and perl paths (the
 * supervisor's PATH is not the shell's), a timeout on every hook, the pre
 * guard under its own shorter alarm, hooks explicitly enabled, and the tools
 * the lane never gets removed through permissions.deny.
 */
export function buildGuardSettings({
  nodePath,
  guardPath,
  configPath,
  perlPath = DEFAULT_PERL_PATH,
}) {
  const node = shellQuotePath("nodePath", nodePath);
  const guard = shellQuotePath("guardPath", guardPath);
  const cfg = shellQuotePath("configPath", configPath);
  const perl = shellQuotePath("perlPath", perlPath);
  const command = (mode) => `${node} ${guard} hook ${mode} --config ${cfg}`;
  const alarmed = `${perl} -e '${PERL_ALARM_SCRIPT}' ${PRE_ALARM_SEC} ${command("pre")}`;
  return {
    disableAllHooks: false,
    permissions: { deny: [...ALWAYS_DENY_TOOLS] },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: command("session-start"),
              timeout: HOOK_TIMEOUTS.sessionStart,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: HOOK_MATCHER,
          hooks: [
            {
              type: "command",
              // Exit 142 (the alarm), 127 (no perl) or 1 (a crash) would each
              // read as "allow".
              command: `${alarmed} || exit 2`,
              timeout: HOOK_TIMEOUTS.pre,
            },
          ],
        },
      ],
    },
  };
}

// ── Config ──────────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function absoluteDir(label, v) {
  if (typeof v !== "string" || v === "") throw new Error(`${label} is required`);
  if (!path.isAbsolute(v)) throw new Error(`${label} must be an absolute path: ${v}`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${label} has control characters`);
  return path.normalize(v).replace(/\/+$/, "") || "/";
}

/** Validate a config object; returns the normalised copy or throws. */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) throw new Error("config must be a JSON object");
  const runDir = absoluteDir("config.runDir", raw.runDir);
  return {
    runDir,
    privateDir: path.join(runDir, PRIVATE_DIRNAME),
    binDir: path.join(runDir, BIN_DIRNAME),
    logDir: absoluteDir("config.logDir", raw.logDir ?? path.join(runDir, "guard")),
    worktree: absoluteDir("config.worktree", raw.worktree),
    repoRoot: absoluteDir("config.repoRoot", raw.repoRoot),
    home: absoluteDir("config.home", raw.home),
  };
}

export function loadConfig(file) {
  if (typeof file !== "string" || file === "") throw new Error("--config is required");
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read config ${file}: ${err.code ?? "not valid JSON"}`);
  }
  return validateConfig(raw);
}

// ── Paths ───────────────────────────────────────────────────────────────────

function isUnder(child, root) {
  return child === root || child.startsWith(root.endsWith("/") ? root : `${root}/`);
}

// $HOME-relative directories the lane has no business in.
const HOME_DENY = [
  "drafto-secrets",
  ".config",
  ".ssh",
  ".gnupg",
  ".aws",
  ".claude",
  ".docker",
  ".kube",
  ".vercel",
  ".supabase",
  ".fastlane",
  ".gem/credentials",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Application Support",
  "Library/LaunchAgents",
  "Library/Containers",
  "Library/Group Containers",
  "Library/Logs/drafto-in-test",
];

// File names that hold credentials wherever they are. `.env.example`-style
// templates are fine.
function isSecretFileName(base) {
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) return true;
  if (PRIVATE_FILE_NAMES.includes(base)) return true;
  if (
    [
      ".npmrc",
      ".netrc",
      ".git-credentials",
      ".pgpass",
      ".zsh_history",
      ".bash_history",
      "factory-state.json",
      "support-state.json",
      "support-release-state.json",
      "zoho-oauth.json",
      "google-play-service-account.json",
    ].includes(base)
  ) {
    return true;
  }
  return (
    /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/.test(base) || /\.(p8|p12|mobileprovision)$/.test(base)
  );
}

/** Expand ~ / $HOME / ${HOME} at the start of a word. */
export function expandHome(word, home) {
  return String(word)
    .replace(/^~(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^\$HOME(?=\/|$)/, home);
}

/**
 * Why <p> (resolved against <cwd>) is off limits, or null. Checks the path as
 * written and, when it exists, its real path, so a symlink to a protected
 * directory doesn't get through.
 */
export function protectedPathReason(p, config, cwd = config.worktree) {
  if (typeof p !== "string" || p === "") return null;
  const expanded = expandHome(p, config.home);
  const abs = path.resolve(cwd, expanded);
  const candidates = [abs];
  try {
    candidates.push(realpathSync(abs));
  } catch {
    /* doesn't exist (yet): the written path is all there is */
  }
  for (const c of candidates) {
    const why = protectedAbsReason(c, config) ?? protectedAbsReason(c, realConfig(config));
    if (why) return why;
  }
  return null;
}

// The config with its roots resolved through symlinks (macOS: /var →
// /private/var, /tmp → /private/tmp), so a real path is compared with real
// roots. Roots that don't exist stay as written.
const realConfigs = new WeakMap();
function realConfig(config) {
  let real = realConfigs.get(config);
  if (!real) {
    const r = (p) => safeRealpath(p) ?? p;
    const runDir = r(config.runDir);
    real = {
      ...config,
      runDir,
      privateDir: path.join(runDir, PRIVATE_DIRNAME),
      binDir: path.join(runDir, BIN_DIRNAME),
      repoRoot: r(config.repoRoot),
      home: r(config.home),
    };
    realConfigs.set(config, real);
  }
  return real;
}

function protectedAbsReason(abs, config) {
  if (isUnder(abs, config.privateDir)) return "the run's private directory holds the curl config";
  // The run's own bin/ (preview-curl) is the one place under logs/ it may name.
  if (isUnder(abs, config.binDir)) return null;
  if (isUnder(abs, path.join(config.repoRoot, "logs"))) {
    return "the factory's logs and state are off limits";
  }
  for (const rel of HOME_DENY) {
    if (isUnder(abs, path.join(config.home, rel))) {
      return `~/${rel} is off limits`;
    }
  }
  const base = path.basename(abs);
  if (isSecretFileName(base)) return `${base} holds credentials`;
  return null;
}

// ── Text rules ──────────────────────────────────────────────────────────────

/** Why the raw text of a command (or a Grep/Glob pattern) is denied, or null. */
export function protectedTextReason(text, config) {
  const s = String(text ?? "");
  const lower = s.toLowerCase();
  if (lower.includes("drafto-secrets")) return "~/drafto-secrets is off limits";
  if (/drafto\.eu\b/i.test(s))
    return "production (drafto.eu) is off limits; the preview is the only target";
  if (lower.includes(".config/gh")) return "the gh config is off limits";
  for (const name of PRIVATE_FILE_NAMES) {
    if (s.includes(name)) return "the run's curl config is off limits";
  }
  for (const root of [config.privateDir, safeRealpath(config.privateDir)]) {
    if (root && s.includes(root)) return "the run's private directory holds the curl config";
  }
  // A relative private/ path (from the run dir). /private/var and /private/tmp
  // are macOS system paths and stay allowed: they are preceded by a slash.
  if (/(^|[\s'"=:(<>|;&])private\//.test(s)) {
    return "the run's private directory holds the curl config";
  }
  if (/factory-state\.json|support-state\.json|logs\/factory\b/.test(s)) {
    return "the factory's logs and state are off limits";
  }
  return null;
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// ── Tokenising ──────────────────────────────────────────────────────────────

class ParseError extends Error {}

// The command substitution starting at src[i] ("$(" or "`"): returns its inner
// text and the index just past it. Quotes inside are skipped; "$(" nests.
function readSubstitution(src, i) {
  if (src[i] === "`") {
    let j = i + 1;
    let inner = "";
    while (j < src.length && src[j] !== "`") {
      if (src[j] === "\\" && j + 1 < src.length) {
        inner += src[j + 1];
        j += 2;
        continue;
      }
      inner += src[j];
      j++;
    }
    if (j >= src.length) throw new ParseError("unterminated backtick substitution");
    return { inner, end: j + 1 };
  }
  // "$(" — find the matching ")".
  let depth = 1;
  let j = i + 2;
  let quote = null;
  while (j < src.length) {
    const c = src[j];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (quote === '"') {
      if (c === "\\") j++;
      else if (c === '"') quote = null;
    } else if (c === "\\") {
      j++;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return { inner: src.slice(i + 2, j), end: j + 1 };
    }
    j++;
  }
  throw new ParseError("unterminated $( substitution");
}

/**
 * Split shell text into simple commands: [{ words, targets }, …] (targets:
 * redirection targets, kept apart so `>f gh …` still reads as gh), quotes removed and
 * command substitutions (`$(…)`, backticks, `<(…)`) split out as commands of
 * their own. Heredoc bodies are data: they are returned in `heredocs`, and
 * an unquoted one's command substitutions are split out too. Throws
 * ParseError on an unbalanced quote or substitution.
 */
export function splitCommands(src, depth = 0) {
  if (depth > 8) throw new ParseError("command nesting is too deep to check");
  const text = String(src ?? "");
  const commands = [];
  const heredocs = [];
  let cur = { words: [], targets: [] };
  let word = null; // null = no word in progress
  let pendingHeredocs = []; // [{ delim, expand, strip }]
  let expectHeredocDelim = null; // { strip }
  let expectTarget = false; // the next word is a redirection's target
  let i = 0;

  const pushWord = () => {
    if (word === null) return;
    if (expectHeredocDelim) {
      const quoted = /['"\\]/.test(word.raw);
      pendingHeredocs.push({ delim: word.value, expand: !quoted, strip: expectHeredocDelim.strip });
      expectHeredocDelim = null;
    } else if (expectTarget) {
      cur.targets.push(word.value);
      expectTarget = false;
    } else {
      cur.words.push(word.value);
    }
    word = null;
  };
  const endCommand = () => {
    pushWord();
    if (cur.words.length || cur.targets.length) commands.push(cur);
    cur = { words: [], targets: [] };
    expectTarget = false;
  };
  const addChar = (c, raw = c) => {
    if (word === null) word = { value: "", raw: "" };
    word.value += c;
    word.raw += raw;
  };
  const substitution = (start) => {
    const { inner, end } = readSubstitution(text, start);
    const sub = splitCommands(inner, depth + 1);
    commands.push(...sub.commands);
    heredocs.push(...sub.heredocs);
    return end;
  };
  const readHeredocBodies = () => {
    // i is just past a newline: each pending heredoc's body follows in order.
    for (const h of pendingHeredocs) {
      const lines = [];
      let closed = false;
      while (i < text.length) {
        const nl = text.indexOf("\n", i);
        const line = nl === -1 ? text.slice(i) : text.slice(i, nl);
        i = nl === -1 ? text.length : nl + 1;
        const cmp = h.strip ? line.replace(/^\t+/, "") : line;
        if (cmp === h.delim) {
          closed = true;
          break;
        }
        lines.push(line);
      }
      if (!closed) throw new ParseError("unterminated heredoc");
      const body = lines.join("\n");
      heredocs.push({ body, expand: h.expand });
      if (h.expand) {
        // Expansion is on: $( … ) and backticks in the body run.
        for (let k = 0; k < body.length; k++) {
          if (body[k] === "\\") {
            k++;
            continue;
          }
          if ((body[k] === "$" && body[k + 1] === "(") || body[k] === "`") {
            const { inner, end } = readSubstitution(body, k);
            const sub = splitCommands(inner, depth + 1);
            commands.push(...sub.commands);
            heredocs.push(...sub.heredocs);
            k = end - 1;
          }
        }
      }
    }
    pendingHeredocs = [];
  };

  while (i < text.length) {
    const c = text[i];
    // Comments: # at the start of a word, outside quotes.
    if (c === "#" && word === null) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "\\") {
      if (text[i + 1] === "\n") {
        i += 2; // line continuation
        continue;
      }
      if (i + 1 < text.length) addChar(text[i + 1], c + text[i + 1]);
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new ParseError("unbalanced single quote");
      if (word === null) word = { value: "", raw: "" };
      word.value += text.slice(i + 1, end);
      word.raw += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      if (word === null) word = { value: "", raw: "" };
      word.raw += '"';
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const d = text[j];
        if (d === "\\" && j + 1 < text.length) {
          word.value += text[j + 1];
          word.raw += d + text[j + 1];
          j += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          break;
        }
        if ((d === "$" && text[j + 1] === "(") || d === "`") {
          const end = substitution(j);
          word.value += text.slice(j, end);
          word.raw += text.slice(j, end);
          j = end;
          continue;
        }
        word.value += d;
        word.raw += d;
        j++;
      }
      if (!closed) throw new ParseError("unbalanced double quote");
      word.raw += '"';
      i = j + 1;
      continue;
    }
    if ((c === "$" && text[i + 1] === "(") || c === "`") {
      const end = substitution(i);
      addChar(text.slice(i, end));
      i = end;
      continue;
    }
    if ((c === "<" || c === ">") && text[i + 1] === "(") {
      // Process substitution: a command of its own.
      pushWord();
      const { inner, end } = readSubstitution(text, i);
      const sub = splitCommands(inner, depth + 1);
      commands.push(...sub.commands);
      heredocs.push(...sub.heredocs);
      i = end;
      continue;
    }
    if (c === "\n") {
      endCommand();
      i++;
      if (pendingHeredocs.length) readHeredocBodies();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      i++;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      // `&>` and `>&` are redirections, not separators.
      if (c === "&" && text[i + 1] === ">") {
        pushWord();
        i += text[i + 2] === ">" ? 3 : 2;
        expectTarget = true;
        continue;
      }
      endCommand();
      i += c === "|" && text[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      // Heredoc: the next word is its delimiter.
      pushWord();
      const strip = text[i + 2] === "-";
      i += strip ? 3 : 2;
      expectHeredocDelim = { strip };
      continue;
    }
    if (c === "<" || c === ">") {
      // A redirection: dropped from the words (the target, a path, is the next
      // word and stays, so path rules still see it). A digit word right
      // before it ("2>") is its fd, not an argument.
      if (word !== null && /^\d+$/.test(word.raw)) word = null;
      else pushWord();
      let j = i + 1;
      while (text[j] === "<" || text[j] === ">" || text[j] === "&" || text[j] === "|") j++;
      // `>&2` / `2>&1`: an fd, not a path.
      const fd = /^\d+|^-/.exec(text.slice(j));
      if (text[j - 1] === "&" && fd) j += fd[0].length;
      else expectTarget = true;
      i = j;
      continue;
    }
    addChar(c);
    i++;
  }
  endCommand();
  if (expectHeredocDelim) throw new ParseError("heredoc without a delimiter");
  if (pendingHeredocs.length) throw new ParseError("unterminated heredoc");
  return { commands, heredocs };
}

// ── Decisions ───────────────────────────────────────────────────────────────

function allow(reason) {
  return { allow: true, reason };
}

function deny(reason) {
  return { allow: false, reason };
}

function base(word) {
  return path.basename(String(word ?? ""));
}

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

// The host of a URL-ish word, or null when it isn't one. Schemeless
// "host.tld/…" counts (curl defaults to http for those).
function urlHost(word) {
  const w = String(word);
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/@\s]*@)?(\[[^\]]*\]|[^/:?#\s]*)/.exec(w);
  if (m) return m[1].toLowerCase();
  const bare = /^(\[[^\]]*\]|[A-Za-z0-9.-]+)(?::\d+)?(?:[/?#]|$)/.exec(w);
  if (bare && (/\.[A-Za-z]{2,}$/.test(bare[1]) || LOOPBACK_HOSTS.has(bare[1].toLowerCase()))) {
    return bare[1].toLowerCase();
  }
  return null;
}

// A scheme curl may not use here: anything but http(s). file:// has an empty
// host, so the loopback rule alone would let curl read any file the factory
// user can. "file:/path" (one slash) is a file URL to curl too.
function nonHttpScheme(word) {
  const w = String(word);
  if (/^file:/i.test(w)) return "file";
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(w);
  return m && !/^https?$/i.test(m[1]) ? m[1].toLowerCase() : null;
}

function curlSchemeDenial(scheme) {
  return deny(`curl may only fetch http(s) from localhost, not ${scheme}:; read files with Read`);
}

function isLoopback(host) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

// Every non-loopback URL inside a word (an interpreter one-liner).
function remoteUrlIn(text) {
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"`)]+/g)) {
    const host = urlHost(m[0]);
    if (host && !isLoopback(host)) return m[0];
  }
  return null;
}

// Skip a wrapper's options and fixed arguments; the rest is the inner command.
function unwrap(name, args) {
  const spec = WRAPPERS[name];
  let k = 0;
  let positional = 0;
  while (k < args.length) {
    const a = args[k];
    if (name === "xargs" && a === "--") {
      k++;
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      const opt = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      k += spec.valueOpts.includes(opt) && !a.includes("=") && a.length === opt.length ? 2 : 1;
      continue;
    }
    if (positional < spec.positionalBefore) {
      positional++;
      k++;
      continue;
    }
    break;
  }
  return args.slice(k);
}

function checkGit(args) {
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) {
    const a = args[k];
    if (a === "-c" || a.startsWith("--exec-path") || a.startsWith("--config-env")) {
      return deny("git -c / --exec-path can run arbitrary commands");
    }
    k += ["-C", "--git-dir", "--work-tree", "--namespace"].includes(a) ? 2 : 1;
  }
  const verb = args[k];
  if (verb == null) return allow("git with no verb");
  const rest = args.slice(k + 1);
  if (verb === "branch") {
    const listing = new Set([
      "-a",
      "-r",
      "--all",
      "--remotes",
      "--list",
      "-l",
      "--show-current",
      "-v",
      "-vv",
    ]);
    const filters = new Set(["--contains", "--merged", "--no-merged", "--points-at"]);
    let ok = true;
    for (let j = 0; j < rest.length; j++) {
      if (listing.has(rest[j])) continue;
      if (filters.has(rest[j])) {
        j++; // its commit
        continue;
      }
      ok = false; // a name to create, -d / -D / -m / -c …
      break;
    }
    return ok ? allow("git branch (listing)") : deny("git branch may only list branches");
  }
  if (verb === "worktree") {
    return rest[0] === "list" ? allow("git worktree list") : deny("git worktree may only list");
  }
  if (!READ_ONLY_GIT_VERBS.includes(verb)) {
    return deny(
      `git ${verb} writes or reaches the network; only read-only git commands are allowed`,
    );
  }
  if (
    verb === "grep" &&
    rest.some((a) => a.startsWith("-O") || a.startsWith("--open-files-in-pager"))
  ) {
    return deny("git grep -O runs a pager command");
  }
  return allow(`git ${verb}`);
}

// turbo run <task…> (or the `turbo <task>` shorthand): no release-like task.
function checkTurbo(args) {
  const words = args.filter((a) => !a.startsWith("-"));
  const tasks = words[0] === "run" ? words.slice(1) : words.slice(0, 1);
  const bad = tasks.find((t) => DENY_SCRIPT.test(t));
  return bad ? deny(`the ${bad} task ships, publishes or reaches a live service`) : allow("turbo");
}

// pnpm / npm: the subcommand (or script) after the global options.
function checkPackageManager(name, args, ctx) {
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) {
    const a = args[k];
    const opt = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    const takesValue = PNPM_VALUE_OPTS.has(opt) && !(opt === "-w" && name === "pnpm");
    k += takesValue && !a.includes("=") ? 2 : 1;
  }
  const sub = args[k];
  if (sub == null) return allow(`${name} with no subcommand`);
  if (PNPM_DENY.has(sub)) {
    return deny(
      `${name} ${sub} installs, publishes or releases; dependencies are already installed`,
    );
  }
  if (sub === "exec") {
    let inner = args.slice(k + 1);
    if (inner[0] === "--") inner = inner.slice(1);
    return inner.length ? checkSimple(inner, ctx) : allow(`${name} exec`);
  }
  if (sub === "turbo") return checkTurbo(args.slice(k + 1));
  let script = sub;
  if (sub === "run" || sub === "run-script") {
    script = args.slice(k + 1).find((a) => !a.startsWith("-"));
    if (script == null) return allow(`${name} run (listing scripts)`);
  }
  if (DENY_SCRIPT.test(script)) {
    return deny(`the ${script} script ships, publishes or reaches a live service`);
  }
  return allow(`${name} ${sub}`);
}

function isRepoScriptPath(word, ctx) {
  const w = String(word);
  if (/^(\.\/)?scripts\//.test(w)) return true;
  for (const root of [ctx.config.worktree, ctx.config.repoRoot]) {
    if (w.startsWith(`${root}/scripts/`)) return true;
  }
  return false;
}

const SCENARIOS_PATH = "e2e/in-test/scenarios/";
const NODE_VALUE_OPTS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--input-type",
  "--conditions",
  "-C",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
]);

function checkNode(args, ctx) {
  if (args.some((a) => a.startsWith("--env-file"))) return deny("--env-file reads an env file");
  const url = remoteUrlIn(args.join(" "));
  if (url) return deny(`network access goes through preview-curl only (${url})`);
  if (args.includes("--test")) return allow("node --test");
  if (args.some((a) => ["-e", "--eval", "-p", "--print"].includes(a)))
    return allow("node one-liner");
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) {
    k += NODE_VALUE_OPTS.has(args[k]) ? 2 : 1;
  }
  const script = args[k];
  if (script != null && isRepoScriptPath(script, ctx)) {
    return deny("node scripts/… runs the factory's own CLIs; only node --test is allowed there");
  }
  return allow("node");
}

function checkShell(name, args, ctx) {
  const cIdx = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
  if (cIdx !== -1) {
    if (args[cIdx + 1] == null) return deny(`${name} -c with no command`);
    return checkText(args[cIdx + 1], ctx);
  }
  const script = args.find((a) => !a.startsWith("-"));
  if (script == null || args.includes("-s")) {
    return deny(`${name} reading its script from stdin can't be checked; run the command directly`);
  }
  if (script.includes(SCENARIOS_PATH)) return checkScenario([name, ...args]);
  if (isRepoScriptPath(script, ctx)) {
    return deny("the factory's own scripts don't run in a verification lane");
  }
  return allow(`${name} script`);
}

function checkCurl(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const opt = a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    // -K / -x also inside a bundle of short flags (-sx).
    if (CURL_DENY_OPTS.has(opt) || (/^-[a-zA-Z]*[Kx]/.test(a) && !a.startsWith("--"))) {
      return deny(`curl ${opt} can reach past loopback; use preview-curl for the preview`);
    }
    if (opt === "--url") {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++k];
      const scheme = nonHttpScheme(v ?? "");
      if (scheme) return curlSchemeDenial(scheme);
      const host = urlHost(v ?? "");
      if (!host || !isLoopback(host)) {
        return deny("curl may only reach localhost; use preview-curl for the preview");
      }
      continue;
    }
    if (CURL_VALUE_OPTS.has(opt)) {
      if (!a.includes("=")) k++;
      continue;
    }
    if (a.startsWith("-")) continue;
    const scheme = nonHttpScheme(a);
    if (scheme) return curlSchemeDenial(scheme);
    // An empty host ("http:///x") isn't loopback either.
    const host = urlHost(a);
    if (host !== null && !isLoopback(host)) {
      return deny(
        `curl may only reach localhost (${host || "no host"}); use preview-curl for the preview`,
      );
    }
  }
  return allow("curl to loopback");
}

function checkScenario(words) {
  // ADR-0043: agents may run a macOS scenario's read-only preflight only.
  const last = words[words.length - 1];
  const runner = base(words[0]);
  const direct = String(words[0]).includes(SCENARIOS_PATH);
  if (last === "--preflight" && (direct || SHELLS.has(runner))) {
    return allow("macOS scenario --preflight (ADR-0043)");
  }
  return deny(
    "a macOS in-test scenario may only be run with --preflight (ADR-0043); read it with Read",
  );
}

// Shell keywords that start a compound command: the real command follows.
const LEADING_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
]);
// Words that make a line a loop header or a terminator, with no command in it.
const NON_COMMANDS = new Set(["for", "select", "case", "esac", "fi", "done", "in", "function"]);

// One simple command, quotes removed.
function checkSimple(words, ctx, targets = []) {
  for (const word of [...words, ...targets]) {
    const why =
      protectedPathReason(word, ctx.config, ctx.config.worktree) ??
      protectedTextReason(word, ctx.config);
    if (why) return deny(why);
  }
  let w = words.filter((x) => x !== "");
  while (w.length && (isAssignment(w[0]) || LEADING_KEYWORDS.has(w[0]))) w = w.slice(1);
  if (w.length === 0) return allow("no command");
  if (NON_COMMANDS.has(w[0]) || w[0] === "[[" || w[0] === "[" || w[0] === "test") {
    return allow("not a command");
  }
  if (w.some((x) => x.includes(SCENARIOS_PATH))) {
    const r = checkScenario(w);
    if (!r.allow) return r;
  }
  const cmd = w[0];
  const name = base(cmd);
  const args = w.slice(1);
  if (DENY_COMMANDS.includes(name)) return deny(`${name} isn't available in a verification lane`);
  if (name === "set" && args.length === 0) return deny("printing the environment is not allowed");
  if (["export", "declare", "typeset"].includes(name) && !args.some((a) => a.includes("="))) {
    if (args.length === 0 || args.some((a) => /^-[a-zA-Z]*[px]/.test(a))) {
      return deny("printing the environment is not allowed");
    }
  }
  if (cmd.includes("/") && isRepoScriptPath(cmd, ctx)) {
    return deny("the factory's own scripts don't run in a verification lane");
  }
  if (Object.hasOwn(WRAPPERS, name)) {
    const inner = unwrap(name, args);
    if (inner.length === 0) return allow(name);
    return checkSimple(inner, ctx);
  }
  if (name === "find") {
    for (let k = 0; k < args.length; k++) {
      if (["-exec", "-execdir", "-ok", "-okdir"].includes(args[k])) {
        const end = args.findIndex((a, idx) => idx > k && (a === ";" || a === "+"));
        const r = checkSimple(args.slice(k + 1, end === -1 ? args.length : end), ctx);
        if (!r.allow) return r;
      }
    }
    return allow("find");
  }
  if (name === "git") return checkGit(args);
  if (name === "pnpm" || name === "npm") return checkPackageManager(name, args, ctx);
  if (name === "turbo") return checkTurbo(args);
  if (name === "node") return checkNode(args, ctx);
  if (SHELLS.has(name)) return checkShell(name, args, ctx);
  if (name === "curl") return checkCurl(args);
  if (INTERPRETERS.has(name)) {
    const url = remoteUrlIn(args.join(" "));
    if (url) return deny(`network access goes through preview-curl only (${url})`);
  }
  return allow(name);
}

// A whole Bash command string.
function checkText(text, ctx) {
  if (ctx.depth > 8) return deny("command nesting is too deep to check");
  // The run's own preview-curl may be named by its full path; nothing else
  // under logs/ may.
  const named = String(text).split(`${ctx.config.binDir}/preview-curl`).join("preview-curl");
  const normalised = named.replace(/\$\{HOME\}|\$HOME|(^|[\s'"=:])~(?=\/)/g, (m, pre) =>
    pre === undefined ? ctx.config.home : `${pre}${ctx.config.home}`,
  );
  const why = protectedTextReason(normalised, ctx.config);
  if (why) return deny(why);
  let parsed;
  try {
    parsed = splitCommands(named, ctx.depth);
  } catch (err) {
    return deny(`the guard couldn't parse this command (${err.message}); simplify it`);
  }
  for (const { words, targets } of parsed.commands) {
    const r = checkSimple(words, { ...ctx, depth: ctx.depth + 1 }, targets);
    if (!r.allow) return r;
  }
  for (const h of parsed.heredocs) {
    const hw = protectedTextReason(h.body, ctx.config);
    if (hw) return deny(hw);
  }
  return allow("command checked");
}

function pathInputs(tool, input) {
  if (tool === "Read") return [input.file_path];
  if (tool === "Grep") return [input.path, input.glob];
  if (tool === "Glob") return [input.path, input.pattern];
  return [];
}

// The fixed part of a glob, up to its first wildcard.
function globPrefix(p) {
  const s = String(p);
  const i = s.search(/[*?[{]/);
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Decide one PreToolUse call. Pure but for realpath lookups. Never throws:
 * anything unexpected is a denial.
 */
export function decidePre({ tool, input, config }) {
  try {
    if (typeof tool !== "string") return deny("the hook payload names no tool");
    if (!LANE_TOOLS.includes(tool)) return deny(`${tool} isn't available in a verification lane`);
    const args = isPlainObject(input) ? input : {};
    if (tool === "Bash") {
      if (typeof args.command !== "string" || args.command.trim() === "") {
        return deny("the Bash call has no command");
      }
      return checkText(args.command, { config, depth: 0 });
    }
    for (const p of pathInputs(tool, args)) {
      if (p == null || p === "") continue;
      if (typeof p !== "string") return deny(`${tool} got a path that isn't a string`);
      const why =
        protectedTextReason(p, config) ??
        protectedPathReason(globPrefix(p) || ".", config) ??
        protectedPathReason(p, config);
      if (why) return deny(why);
    }
    return allow(`${tool} outside protected paths`);
  } catch (err) {
    return deny(`the guard failed to evaluate this call (${err.message})`);
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** temp file + rename, mode 0600, in a 0700 directory. */
export function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function sessionLogPath(config, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error("the hook payload has no valid session_id");
  }
  return path.join(config.logDir, `${sessionId}.jsonl`);
}

function parsePayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("the hook payload is not valid JSON");
  }
  if (!isPlainObject(payload)) throw new Error("the hook payload is not a JSON object");
  return payload;
}

/** A command as it may be logged: truncated, keys and bearer tokens redacted. */
export function redactForLog(text) {
  let s = String(text ?? "")
    .replace(/\bdk_[0-9a-f]{8,}/gi, "dk_[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*)?/g, "[jwt redacted]");
  if (s.length > MAX_LOGGED_COMMAND) s = `${s.slice(0, MAX_LOGGED_COMMAND)}…`;
  return s;
}

function logFields(payload) {
  const input = isPlainObject(payload.tool_input) ? payload.tool_input : {};
  const tool = typeof payload.tool_name === "string" ? payload.tool_name.slice(0, 100) : null;
  const fields = { tool };
  if (tool === "Bash" && typeof input.command === "string")
    fields.command = redactForLog(input.command);
  for (const key of ["file_path", "path", "pattern", "glob"]) {
    if (typeof input[key] === "string") fields[key] = redactForLog(input[key]);
  }
  return fields;
}

function appendLog(file, record) {
  ensureDir(path.dirname(file));
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** PreToolUse: {code: 0} allows, {code: 2, stderr} blocks. Never throws. */
export function runPreHook({ configPath, stdin, now = new Date().toISOString() }) {
  try {
    if (Buffer.byteLength(stdin ?? "") > MAX_PRE_PAYLOAD_BYTES) {
      throw new Error("the hook payload is too large");
    }
    const config = loadConfig(configPath);
    const payload = parsePayload(stdin);
    const log = sessionLogPath(config, payload.session_id);
    const decision = decidePre({ tool: payload.tool_name, input: payload.tool_input, config });
    // An unlogged decision is a failed decision.
    appendLog(log, {
      at: now,
      event: "pre",
      ...logFields(payload),
      allow: decision.allow,
      reason: decision.reason,
    });
    if (decision.allow) return { code: 0, stderr: "" };
    return { code: 2, stderr: `Blocked by the factory verify guard: ${decision.reason}.\n` };
  } catch (err) {
    return {
      code: 2,
      stderr: `Blocked: the factory verify guard could not evaluate this call (${err.message}).\n`,
    };
  }
}

/** SessionStart: the canary record the supervisor checks with verifySession. */
export function runSessionStartHook({ configPath, stdin, now = new Date().toISOString() }) {
  try {
    const config = loadConfig(configPath);
    const payload = parsePayload(stdin);
    const source =
      typeof payload.source === "string" && /^[a-z_]{1,32}$/.test(payload.source)
        ? payload.source
        : "unknown";
    appendLog(sessionLogPath(config, payload.session_id), {
      at: now,
      event: "session-start",
      tool: null,
      allow: null,
      reason: `source=${source}`,
    });
    return { code: 0, stderr: "" };
  } catch (err) {
    return { code: 0, stderr: `verify-guard session-start: ${err.message}\n` };
  }
}

/** Counts from a session's decision log. sessionStart false = hooks never loaded. */
export function verifySession({ configPath, session }) {
  const config = loadConfig(configPath);
  let text = "";
  try {
    text = readFileSync(sessionLogPath(config, session), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const counts = { sessionStart: false, pre: 0, denied: 0 };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.event === "session-start") counts.sessionStart = true;
    else if (r?.event === "pre") {
      counts.pre += 1;
      if (r.allow === false) counts.denied += 1;
    }
  }
  return counts;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  verify-guard.mjs config --out <cfg.json> --run-dir <dir> --worktree <dir> --repo-root <dir> [--home <dir>]
  verify-guard.mjs settings --config <cfg.json> --out <settings.json> [--perl <path>]
  verify-guard.mjs hook <session-start|pre> --config <cfg.json>   (payload on stdin)
  verify-guard.mjs verify --config <cfg.json> --session <uuid>
  verify-guard.mjs allowed-tools
`;

const CLI_OPTIONS = {
  config: { type: "string" },
  out: { type: "string" },
  "run-dir": { type: "string" },
  worktree: { type: "string" },
  "repo-root": { type: "string" },
  home: { type: "string" },
  session: { type: "string" },
  perl: { type: "string" },
};

function required(values, key) {
  const v = values[key];
  if (typeof v !== "string" || v === "") throw new Error(`--${key} is required`);
  return v;
}

export function assertExecutable(label, p) {
  if (!path.isAbsolute(p)) throw new Error(`${label} must be an absolute path: ${p}`);
  try {
    if (!statSync(p).isFile()) throw new Error("not a file");
    accessSync(p, fsConstants.X_OK);
  } catch {
    throw new Error(`${label} is not an executable file at ${p}`);
  }
}

export function guardModulePath() {
  return realpathSync(fileURLToPath(import.meta.url));
}

/**
 * Write the guard's config and settings files for one run. Shared by the CLI
 * and verify-lane.mjs start. Returns their paths.
 */
export function writeGuardFiles({
  runDir,
  worktree,
  repoRoot,
  home = os.homedir(),
  perlPath = DEFAULT_PERL_PATH,
  nodePath = process.execPath,
}) {
  const config = validateConfig({
    runDir,
    worktree,
    repoRoot,
    home,
    logDir: path.join(runDir, "guard"),
  });
  const configPath = path.join(runDir, "guard-config.json");
  const settingsPath = path.join(runDir, "guard-settings.json");
  writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  // The pre hook only fails closed on a hang through perl's alarm, so the lane
  // must not start with a settings file whose wrapper is missing.
  assertExecutable("perl", perlPath);
  const settings = buildGuardSettings({
    nodePath,
    guardPath: guardModulePath(),
    configPath,
    perlPath,
  });
  writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { configPath, settingsPath, logDir: config.logDir };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Run the CLI. Returns the exit code. `hook pre` exits 2 on ANY failure. */
export async function main(
  argv,
  { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {},
) {
  const [cmd, ...rest] = argv;
  const isPre = cmd === "hook" && rest[0] === "pre";
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: CLI_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    if (cmd === "config") {
      const config = validateConfig({
        runDir: path.resolve(required(values, "run-dir")),
        worktree: path.resolve(required(values, "worktree")),
        repoRoot: path.resolve(required(values, "repo-root")),
        home: values.home ? path.resolve(values.home) : os.homedir(),
      });
      writeFileAtomic(
        path.resolve(required(values, "out")),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      return 0;
    }
    if (cmd === "settings") {
      const configPath = path.resolve(required(values, "config"));
      loadConfig(configPath);
      const perlPath = values.perl ?? DEFAULT_PERL_PATH;
      assertExecutable("perl", perlPath);
      const settings = buildGuardSettings({
        nodePath: process.execPath,
        guardPath: guardModulePath(),
        configPath,
        perlPath,
      });
      writeFileAtomic(
        path.resolve(required(values, "out")),
        `${JSON.stringify(settings, null, 2)}\n`,
      );
      return 0;
    }
    if (cmd === "hook") {
      const mode = positionals[0];
      const run = { pre: runPreHook, "session-start": runSessionStartHook }[mode];
      if (!run || positionals.length !== 1) throw new Error("hook needs one of session-start, pre");
      const result = run({
        configPath: path.resolve(required(values, "config")),
        stdin: await readAll(stdin),
      });
      if (result.stderr) stderr.write(result.stderr);
      return result.code;
    }
    if (cmd === "verify") {
      const counts = verifySession({
        configPath: path.resolve(required(values, "config")),
        session: required(values, "session"),
      });
      stdout.write(`${JSON.stringify(counts)}\n`);
      return counts.sessionStart ? 0 : 1;
    }
    if (cmd === "allowed-tools") {
      stdout.write(`${allowedToolsArg()}\n`);
      return 0;
    }
    stderr.write(USAGE);
    return isPre ? 2 : 1;
  } catch (err) {
    if (isPre) {
      stderr.write(`Blocked: the factory verify guard could not run (${err.message}).\n`);
      return 2;
    }
    stderr.write(`verify-guard: ${err.message}\n`);
    return cmd === "hook" ? 0 : 1;
  }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const isPre = argv[0] === "hook" && argv[1] === "pre";
  main(argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`verify-guard: ${err?.message ?? err}\n`);
      process.exitCode = isPre ? 2 : 1;
    },
  );
}
