#!/usr/bin/env node
// Guard for the factory's locked-down browser runner (Claude in Chrome).
//
// Why this exists: the factory's browser runner drives the repo owner's own,
// signed-in Chrome profile on the Mac mini, unattended. That profile is logged
// in to drafto.eu (prod), Vercel, GitHub and everything else, and the pages the
// runner reads are untrusted input. The extension's own site permissions did
// not stop navigation to an arbitrary site in `-p --chrome` mode (Wave 0 spike),
// so the hooks below are the real boundary:
//
//   - SessionStart writes a canary record. `claude -p` SILENTLY ignores a
//     settings file that fails validation and runs with no hooks at all, so
//     bash runs `verify` afterwards and turns the browser off if the canary is
//     missing.
//   - PreToolUse decides every Chrome call (decidePre). It fails closed: any
//     exception, unreadable payload, missing config or corrupt state exits 2,
//     and the hook command itself ends in `|| exit 2` so a missing node or
//     guard file blocks too. Claude Code treats ONLY exit 2 as a block; any
//     other non-zero status waves the call through.
//   - PostToolUse learns what the call did (applyPost): that the pinned
//     browser was selected, which tabs are in this session's tab group and
//     what URL each one is on now, and where a screenshot was saved. The tab
//     URLs come from the "Tab Context" block the extension appends to every
//     tab tool's response, which is how a tab that a click took off the
//     allowed origin gets quarantined.
//
// Two facts measured on the Mac mini on 2026-10-17 (claude 2.1.302) shape the
// hooks:
//
//   (a) A PreToolUse hook that exceeds its `timeout` is treated as ALLOW: the
//       tool call runs and PostToolUse fires. A hung guard would therefore
//       wave every call through. So the pre command runs under a perl
//       `alarm` (PRE_ALARM_SEC) well inside the hook timeout: SIGALRM kills
//       the guard, perl's exit 142 hits `|| exit 2`, and the call is blocked
//       long before Claude Code would give up and allow it.
//   (b) A Chrome call that returns an error (get_page_text with a bad tabId:
//       "Couldn't determine which page…") fires NEITHER PostToolUse NOR
//       PostToolUseFailure, though PreToolUse fired. So pre can never require
//       that post ran for the previous call; an errored call's side effects
//       (a click that navigated, then failed) show up only in the Tab Context
//       of the next call that succeeds. What pre CAN rely on is a post that
//       started: each post marks itself in flight
//       (<stateDir>/<sid>.post-<tool_use_id>.inflight) before touching state
//       and clears the marker only after the state is written or the session
//       is poisoned. A marker that is still there means a post is running or
//       died mid-update (killed by its own timeout), and its quarantine may be
//       missing, so pre denies every call while one exists. There is no
//       staleness timeout on purpose: a leftover marker stops the session.
//
// Rules decidePre applies, in this order:
//   1. a non-Chrome tool is not this guard's business (the matcher only sends
//      Chrome tools here anyway);
//   2. ALWAYS_DENY tools are denied (they are also in permissions.deny);
//   3. a Chrome tool that is not in RUNNER_TOOLS is denied, so a tool a new
//      extension version adds stays off until someone reviews it;
//   4. list_connected_browsers is allowed; select_browser only for the pinned
//      device;
//   5. nothing else runs until a select_browser of the pinned device has
//      succeeded. Without this gate the extension picks a lone connected
//      browser by itself, which could be the MacBook;
//   6. tabs_context_mcp and tabs_create_mcp are allowed;
//   7. navigate needs a tab this session owns and a URL on the allowed origin
//      (exact scheme + host + port; no back/forward, no credentials);
//   8. every other tab tool needs an owned tab that is still on the allowed
//      origin (or on a blank/new-tab page). An owned tab that drifted away is
//      quarantined: only tabs_close_mcp, or a navigate back to the allowed
//      origin, works on it.
//
// Residual risk the guard cannot close: the Tab Context in a click's response
// can be captured before the navigation it started has committed, so ONE more
// call can land on the new page before the next response reveals it. The
// runner has no tools besides these and its only output is stdout, which
// bash scans for secrets before posting anything.
//
// The decision log never carries tool_input values that can hold a secret
// (form_input's value, computer's text): it records the tool, the tabId, the
// navigate URL (query and fragment redacted) and the verdict.
//
// Decision record: ADR-0051 (docs/adr/0051-factory-browser-runner.md).
//
// CLI:
//   node browser-guard.mjs config --out <cfg.json> --device <uuid>
//        --allow-origin <origin> [--allow-origin …] --log-dir <dir>
//        --state-dir <dir> --evidence-dir <dir>
//   node browser-guard.mjs settings --config <cfg.json> --out <settings.json>
//        [--perl <path>]   (default /usr/bin/perl; exit 1 if it is not executable)
//   node browser-guard.mjs hook <session-start|pre|post> --config <cfg.json>
//        (stdin = hook payload; pre exits 0 to allow, 2 + stderr reason to deny;
//        session-start and post always exit 0 and log their errors)
//   node browser-guard.mjs verify --config <cfg.json> --session <uuid>
//        (prints {sessionStart, pre, denied, post}; exit 0 iff sessionStart)
//   node browser-guard.mjs allowed-tools   (prints the --allowedTools value)

import { randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
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

export const CHROME_PREFIX = "mcp__claude-in-chrome__";

// Short names. Each one either reaches outside the session's own tab (switch
// browser, keyboard shortcuts that act on the browser), runs code or moves
// files the guard cannot inspect (javascript_tool, file_upload, upload_image),
// or bundles several calls into one the guard would only see as a whole
// (browser_batch). gif_creator writes recordings nobody asked for.
export const ALWAYS_DENY = Object.freeze([
  "switch_browser",
  "javascript_tool",
  "file_upload",
  "upload_image",
  "shortcuts_execute",
  "shortcuts_list",
  "gif_creator",
  "browser_batch",
]);

export const RUNNER_TOOLS = Object.freeze([
  "list_connected_browsers",
  "select_browser",
  "tabs_context_mcp",
  "tabs_create_mcp",
  "tabs_close_mcp",
  "navigate",
  "computer",
  "read_page",
  "find",
  "form_input",
  "get_page_text",
  "read_console_messages",
  "read_network_requests",
  "resize_window",
]);

// Pages a tab may sit on without being quarantined. They hold nothing, but
// they are not navigation targets either: navigate accepts only the allowed
// origin.
export const NEUTRAL_URLS = Object.freeze(["", "about:blank", "chrome://newtab/"]);

// Stand-in URLs for a tab whose current page the guard could not confirm.
// Neither parses as an allowed origin nor is neutral, so the tab is
// quarantined until a navigate back to the allowed origin reports where it is.
export const UNKNOWN_URL = "guard:unknown";
export const AMBIGUOUS_URL = "guard:ambiguous";

export const HOOK_MATCHER = `${CHROME_PREFIX}.*`;
export const HOOK_TIMEOUTS = Object.freeze({ sessionStart: 10, pre: 30, post: 15 });

// The pre guard's own deadline, enforced by perl's alarm. It must stay well
// below HOOK_TIMEOUTS.pre, because a timeout that Claude Code enforces itself
// is an allow (fact (a) above). A normal pre run takes ~50 ms.
export const PRE_ALARM_SEC = 20;
export const DEFAULT_PERL_PATH = "/usr/bin/perl";

// `alarm shift` arms SIGALRM, which survives exec, and `exec @ARGV` becomes
// the guard. If exec itself fails (a missing or unexecutable node), perl would
// fall off the end of the script and exit 0, which reads as an allow, so a
// failed exec exits 2 instead.
export const PERL_ALARM_SCRIPT = "alarm shift; exec @ARGV or exit 2";

export const INFLIGHT_REASON =
  "an earlier browser call's result is still being processed; make one browser call at a time";

// Tools whose tab listing may bring a tab into this session's ownership. The
// listing in every other tool's response only updates or drops tabs the
// session already owns, so a page-reading tool can never introduce a tab.
const ADOPTING_TOOLS = new Set(["tabs_context_mcp", "tabs_create_mcp"]);

// Tools that act on one tab and must name it.
const TAB_TOOLS = new Set(
  RUNNER_TOOLS.filter(
    (t) =>
      ![
        "list_connected_browsers",
        "select_browser",
        "tabs_context_mcp",
        "tabs_create_mcp",
      ].includes(t),
  ),
);

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Plain http is for the repro kind's local dev server only. `localhost` is
// deliberately absent: 127.0.0.1 is a different cookie host, which keeps the
// owner's own localhost:3000 session out of reach.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

// Never an allowed origin, whatever bash passes: the owner is signed in to
// prod on drafto.eu and to the Vercel account on vercel.com. Preview hosts are
// on vercel.app, which this does not touch.
const NEVER_ALLOW_DOMAINS = ["drafto.eu", "vercel.com"];

const MAX_URL_LENGTH = 8192;
const MAX_PRE_PAYLOAD_BYTES = 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10_000;

// The extension prefixes https:// to anything that does not start with
// http:// or https:// (case-insensitive) — mirror that exactly, so the guard
// judges the URL the extension will actually load.
const HAS_HTTP_SCHEME = /^https?:\/\//i;
const OTHER_SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i;
// Whitespace, control characters and backslashes are where URL parsers
// disagree (WHATWG strips tabs/newlines anywhere and reads `\` as `/`).
// Nothing legitimate needs them unencoded, so refuse them outright.
const UNSAFE_URL_CHARS = /[\u0000-\u0020\u007f\\]/;

// One tab line of the extension's Tab Context block. Title and URL are
// JSON.stringify'd by the extension, so a page title cannot smuggle in a quote
// or a newline; anything that does not parse as a JSON string literal makes
// the whole block untrusted.
const TAB_LINE_RE = /^\s*•\s*tabId\s+(\d+):\s*("(?:[^"\\]|\\.)*")\s*\(("(?:[^"\\]|\\.)*")\)\s*$/;
const EXECUTED_ON_RE = /^- Executed on tabId: \d+$/;

// Claude Code writes save_to_disk screenshots into a 0700 mkdtemp directory
// under os.tmpdir() named claude-chrome-screenshots-XXXXXX, as
// screenshot-<ms>-<n>.<ext>, and reports it in a text block of its own.
const SCREENSHOT_BLOCK_RE = /^Screenshot saved to: (.+)$/;
const SCREENSHOT_NAME_RE = /^screenshot-\d+-\d+\.(?:jpg|png)$/;
const SCREENSHOT_DIR_PREFIX = "claude-chrome-screenshots-";

// ── Tool names and the generated settings ──────────────────────────────────

export function fullToolName(short) {
  return `${CHROME_PREFIX}${short}`;
}

export function allowedToolsArg() {
  return RUNNER_TOOLS.map(fullToolName).join(",");
}

// Claude Code runs hook commands through a shell. Single quotes make every
// character literal except the quote itself, so a path containing one is
// refused rather than escaped: there is no reason for these paths to have
// one, and an escaping bug here would be a command injection.
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
 * The --settings object for the runner. One function, so the shape the
 * Wave 0 spike validated is the only shape that ships: absolute node, guard
 * and perl paths (launchd's PATH is not the shell's), a timeout on every hook,
 * the pre guard under its own shorter alarm, hooks explicitly enabled, and
 * the always-denied tools removed from the session through permissions.deny
 * on top of being left out of --allowedTools.
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
    permissions: { deny: ALWAYS_DENY.map(fullToolName) },
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
              // Exit 142 (the alarm), 127 (no perl) or 1 (a crash) would
              // each read as "allow".
              command: `${alarmed} || exit 2`,
              timeout: HOOK_TIMEOUTS.pre,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: HOOK_MATCHER,
          hooks: [{ type: "command", command: command("post"), timeout: HOOK_TIMEOUTS.post }],
        },
      ],
    },
  };
}

// ── URLs ────────────────────────────────────────────────────────────────────

function candidateUrl(raw) {
  return HAS_HTTP_SCHEME.test(raw) ? raw : `https://${raw}`;
}

/**
 * The origin (scheme + host + port) a URL would load, or null when it is not
 * an http(s) URL the guard can reason about: unparsable, carrying userinfo
 * (even an empty `@`), or containing characters parsers disagree on. A URL
 * without a scheme is read as https://, as the extension reads it.
 */
export function normaliseOrigin(url) {
  if (typeof url !== "string" || url === "" || url.length > MAX_URL_LENGTH) return null;
  if (UNSAFE_URL_CHARS.test(url)) return null;
  const candidate = candidateUrl(url);
  const authority = candidate.slice(candidate.indexOf("//") + 2).split(/[/?#]/, 1)[0];
  if (authority.includes("@")) return null;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed.origin;
}

function normaliseAllowList(allowOrigins) {
  if (!Array.isArray(allowOrigins)) return [];
  return [...new Set(allowOrigins.map(normaliseOrigin).filter(Boolean))];
}

function verdict(ok, reason) {
  return { ok, reason };
}

/**
 * Why a navigation target is (not) acceptable. Comparing URL().origin
 * handles IDN and punycode look-alikes, trailing dots, ports and schemes:
 * each yields a different origin string. On top of that the URL must be
 * written literally as the allowed origin followed by `/`, `?`, `#` or
 * nothing, so a percent-encoded or numeric host that one parser decodes and
 * another does not is refused instead of trusted.
 */
export function navigationVerdict(url, allowOrigins) {
  if (typeof url !== "string" || url === "") return verdict(false, "navigate needs a url");
  if (/^(back|forward)$/i.test(url.trim())) {
    return verdict(
      false,
      "history navigation (back/forward) is not allowed; navigate to an explicit URL",
    );
  }
  if (url.length > MAX_URL_LENGTH) return verdict(false, "the URL is too long");
  if (UNSAFE_URL_CHARS.test(url)) {
    return verdict(false, "the URL contains whitespace, control characters or a backslash");
  }
  const scheme = OTHER_SCHEME.exec(url)?.[1];
  if (scheme && !HAS_HTTP_SCHEME.test(url)) {
    return verdict(
      false,
      `only http:// and https:// URLs are allowed, not ${scheme.toLowerCase()}:`,
    );
  }
  const origin = normaliseOrigin(url);
  if (!origin) {
    return verdict(
      false,
      "the URL is not an http(s) URL without credentials that the guard can parse",
    );
  }
  const allowed = normaliseAllowList(allowOrigins);
  if (!allowed.includes(origin)) {
    return verdict(
      false,
      `${origin} is not this run's allowed origin (${allowed.join(", ") || "none configured"})`,
    );
  }
  const literal = candidateUrl(url).toLowerCase();
  if (!literal.startsWith(origin) || !["", "/", "?", "#"].includes(literal.charAt(origin.length))) {
    return verdict(false, `write the URL in canonical form, starting exactly with ${origin}`);
  }
  return verdict(true, `on ${origin}`);
}

export function isAllowedNavigation(url, allowOrigins) {
  return navigationVerdict(url, allowOrigins).ok;
}

export function isNeutralUrl(url) {
  return NEUTRAL_URLS.includes(url);
}

function isQuarantinedUrl(url, allowOrigins) {
  return !isNeutralUrl(url) && !isAllowedNavigation(url, allowOrigins);
}

/** A URL fit for the decision log: query and fragment are replaced by markers. */
export function redactUrl(url) {
  if (typeof url !== "string") return null;
  const cut = url.search(/[?#]/);
  const head = (cut === -1 ? url : url.slice(0, cut)).slice(0, 300);
  if (cut === -1) return head;
  return `${head}${url.includes("?") ? "?…" : ""}${url.includes("#") ? "#…" : ""}`;
}

// ── Config and state ────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isTabId(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isNeverAllowedHost(hostname) {
  return NEVER_ALLOW_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

/**
 * Validate one configured allow origin. Stricter than normaliseOrigin: the
 * value must already BE an origin in canonical form (no path, query, IDN or
 * percent-encoding), http only for loopback, and never a host the owner is
 * signed in to for real. A bash bug then fails at config time, loudly.
 */
export function parseAllowOrigin(value) {
  if (typeof value !== "string" || value === "") throw new Error("allow origin must be a string");
  if (UNSAFE_URL_CHARS.test(value)) throw new Error(`allow origin has unsafe characters: ${value}`);
  if (!HAS_HTTP_SCHEME.test(value)) {
    throw new Error(`allow origin must start with http:// or https://: ${value}`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`allow origin is not a URL: ${value}`);
  }
  if (parsed.username || parsed.password || value.includes("@")) {
    throw new Error(`allow origin must not carry credentials: ${value}`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`allow origin must be a bare origin (no path, query or fragment): ${value}`);
  }
  if (value.toLowerCase().replace(/\/$/, "") !== parsed.origin) {
    throw new Error(`allow origin is not in canonical form (expected ${parsed.origin}): ${value}`);
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`plain http is only allowed for 127.0.0.1 or [::1]: ${value}`);
  }
  if (isNeverAllowedHost(parsed.hostname)) {
    throw new Error(`allow origin is a host the owner is signed in to for real: ${value}`);
  }
  return parsed.origin;
}

function absoluteDir(label, v) {
  if (typeof v !== "string" || v === "") throw new Error(`${label} is required`);
  if (!path.isAbsolute(v)) throw new Error(`${label} must be an absolute path: ${v}`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${label} has control characters`);
  return path.normalize(v);
}

/** Validate a config object; returns the normalised copy or throws. */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) throw new Error("config must be a JSON object");
  if (typeof raw.deviceId !== "string" || !DEVICE_ID_RE.test(raw.deviceId)) {
    throw new Error("config.deviceId must be a UUID");
  }
  if (!Array.isArray(raw.allowOrigins) || raw.allowOrigins.length === 0) {
    throw new Error("config.allowOrigins must be a non-empty array");
  }
  return {
    deviceId: raw.deviceId,
    allowOrigins: [...new Set(raw.allowOrigins.map(parseAllowOrigin))],
    logDir: absoluteDir("config.logDir", raw.logDir),
    stateDir: absoluteDir("config.stateDir", raw.stateDir),
    evidenceDir: absoluteDir("config.evidenceDir", raw.evidenceDir),
  };
}

export function emptyState() {
  return { selected: false, tabs: {} };
}

/** Validate a state object read from disk; throws on anything unexpected. */
export function validateState(raw) {
  if (!isPlainObject(raw)) throw new Error("state must be a JSON object");
  if (typeof raw.selected !== "boolean") throw new Error("state.selected must be a boolean");
  if (!isPlainObject(raw.tabs)) throw new Error("state.tabs must be an object");
  const tabs = {};
  for (const [id, url] of Object.entries(raw.tabs)) {
    if (!/^\d{1,16}$/.test(id) || typeof url !== "string") {
      throw new Error("state.tabs must map numeric tab ids to URLs");
    }
    tabs[id] = url;
  }
  const out = { selected: raw.selected, tabs };
  if (raw.updatedAt !== undefined) {
    if (typeof raw.updatedAt !== "string") throw new Error("state.updatedAt must be a string");
    out.updatedAt = raw.updatedAt;
  }
  return out;
}

// ── PreToolUse ──────────────────────────────────────────────────────────────

function allow(reason) {
  return { allow: true, reason };
}

function deny(reason) {
  return { allow: false, reason };
}

function owns(state, tabId) {
  return Object.hasOwn(state.tabs, String(tabId));
}

/**
 * Decide one PreToolUse call. Pure. Never throws: anything unexpected — a
 * missing config, a malformed state — is a denial.
 */
export function decidePre({ tool, input, config, state }) {
  try {
    return decide({ tool, input, config, state });
  } catch (err) {
    return deny(`the guard failed to evaluate this call (${err.message})`);
  }
}

function decide({ tool, input, config, state }) {
  if (typeof tool !== "string") return deny("the hook payload names no tool");
  if (!tool.startsWith(CHROME_PREFIX)) return allow("not a Claude in Chrome tool");
  const name = tool.slice(CHROME_PREFIX.length);
  if (ALWAYS_DENY.includes(name))
    return deny(`${name} is never allowed for the factory browser runner`);
  if (!RUNNER_TOOLS.includes(name)) {
    return deny(
      `${name} is not on the browser runner's tool list (new tools stay off until reviewed)`,
    );
  }

  if (!isPlainObject(config) || typeof config.deviceId !== "string" || !config.deviceId) {
    return deny("the guard has no pinned device configured");
  }
  const origins = normaliseAllowList(config.allowOrigins);
  if (origins.length === 0) return deny("the guard has no allowed origin configured");
  const st = validateState(state ?? emptyState());
  const args = isPlainObject(input) ? input : {};

  if (name === "list_connected_browsers") return allow("listing browsers");
  if (name === "select_browser") {
    return args.deviceId === config.deviceId
      ? allow("the pinned device")
      : deny(`select_browser is allowed only for the pinned device ${config.deviceId}`);
  }

  if (!st.selected) {
    return deny(
      `select the pinned browser first: call list_connected_browsers, then select_browser ` +
        `with deviceId ${config.deviceId}`,
    );
  }

  if (name === "tabs_context_mcp") return allow("tab context");
  if (name === "tabs_create_mcp") return allow("new tab in this session's group");

  const tabId = args.tabId;
  if (!isTabId(tabId)) {
    return deny(`${name} needs the numeric tabId of a tab this session opened`);
  }
  if (!owns(st, tabId)) {
    return deny(
      `tab ${tabId} is not one this session opened; use tabs_create_mcp or ` +
        `tabs_context_mcp and work only in your own tab`,
    );
  }

  if (name === "navigate") {
    const v = navigationVerdict(args.url, origins);
    return v.ok ? allow(v.reason) : deny(v.reason);
  }

  const current = st.tabs[String(tabId)];
  if (name !== "tabs_close_mcp" && isQuarantinedUrl(current, origins)) {
    const where =
      current === UNKNOWN_URL || current === AMBIGUOUS_URL
        ? "the guard could not confirm which page it is on"
        : `it is now on ${normaliseOrigin(current) ?? "a page outside the allowed origin"}`;
    return deny(
      `tab ${tabId} has left the allowed origin (${where}); only tabs_close_mcp, or a ` +
        `navigate back to ${origins.join(" or ")}, is allowed on it`,
    );
  }
  return allow(`tab ${tabId}`);
}

// ── PostToolUse ─────────────────────────────────────────────────────────────

/** tool_response as an array of content blocks, whichever shape it came in. */
function normaliseBlocks(response) {
  if (typeof response === "string") return [{ type: "text", text: response }];
  if (Array.isArray(response)) return response;
  if (isPlainObject(response) && Array.isArray(response.content)) return response.content;
  return [];
}

function recordUrl(map, id, url) {
  if (map.has(id) && map.get(id) !== url) map.set(id, AMBIGUOUS_URL);
  else if (!map.has(id)) map.set(id, url);
}

/**
 * Parse one text block as the extension's Tab Context block:
 *
 *   \n\nTab Context:
 *   - Executed on tabId: 1264169916
 *   - Available tabs:
 *     • tabId 1264169916: "Log in — Drafto" ("https://…vercel.app/login")
 *
 * Returns Map(tabId → url) or null. The block must match line for line; a
 * block that does not is not trusted at all, so a change in the format
 * quarantines tabs instead of leaving stale URLs in place.
 */
export function parseTabContextBlock(text) {
  if (typeof text !== "string") return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  if (lines[i]?.trim() !== "Tab Context:") return null;
  const tabs = new Map();
  let listing = false;
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!listing && EXECUTED_ON_RE.test(trimmed)) continue;
    if (!listing && trimmed === "- Available tabs:") {
      listing = true;
      continue;
    }
    const m = listing ? TAB_LINE_RE.exec(line) : null;
    if (!m) return null;
    let url;
    try {
      JSON.parse(m[2]);
      url = JSON.parse(m[3]);
    } catch {
      return null;
    }
    const id = Number(m[1]);
    if (!isTabId(id) || typeof url !== "string") return null;
    recordUrl(tabs, String(id), url);
  }
  return listing ? tabs : null;
}

/** tabs_context_mcp's first text block: {"availableTabs":[{tabId,title,url}],…}. */
export function parseAvailableTabsJson(text) {
  if (typeof text !== "string" || !text.trim().startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.availableTabs)) return null;
  const tabs = new Map();
  for (const t of parsed.availableTabs) {
    if (!isPlainObject(t) || !isTabId(t.tabId)) return null;
    recordUrl(tabs, String(t.tabId), typeof t.url === "string" ? t.url : AMBIGUOUS_URL);
  }
  return tabs;
}

/**
 * Syntactic check of a "Screenshot saved to:" path; null when acceptable.
 * The CLI re-checks on disk (real path, owner, mode, no symlinks) before it
 * copies anything.
 */
export function screenshotSourceProblem(p, { tmpRoots = defaultTmpRoots() } = {}) {
  if (typeof p !== "string" || p === "") return "no path";
  if (/[\u0000-\u001f\u007f]/.test(p)) return "the path has control characters";
  if (!path.isAbsolute(p)) return "the path is not absolute";
  if (path.normalize(p) !== p) return "the path is not normalised";
  if (!SCREENSHOT_NAME_RE.test(path.basename(p))) return "unexpected file name";
  const dir = path.dirname(p);
  if (!path.basename(dir).startsWith(SCREENSHOT_DIR_PREFIX)) return "unexpected directory";
  if (!tmpRoots.some((root) => isStrictlyUnder(dir, root))) return "not under the temp directory";
  return null;
}

function isStrictlyUnder(child, root) {
  if (typeof root !== "string" || !root) return false;
  const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return child.startsWith(base) && child.length > base.length;
}

export function defaultTmpRoots() {
  return [...new Set([os.tmpdir(), "/var/folders", "/private/var/folders"])];
}

/**
 * Fold one PostToolUse call into the session state. Pure: returns a new
 * state and the events the CLI acts on (`{copy: path}` for a screenshot) or
 * logs. Unknown and failed shapes always move toward less access.
 */
export function applyPost({
  tool,
  input,
  responseBlocks,
  config,
  state,
  now = new Date().toISOString(),
  tmpRoots,
}) {
  const prev = validateState(state ?? emptyState());
  const next = { selected: prev.selected, tabs: { ...prev.tabs }, updatedAt: now };
  const events = [];
  if (typeof tool !== "string" || !tool.startsWith(CHROME_PREFIX)) return { state: next, events };
  const name = tool.slice(CHROME_PREFIX.length);
  const args = isPlainObject(input) ? input : {};
  const texts = normaliseBlocks(responseBlocks)
    .filter((b) => isPlainObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
  const origins = normaliseAllowList(config?.allowOrigins);
  const quarantinedBefore = new Set(
    Object.keys(next.tabs).filter((id) => isQuarantinedUrl(next.tabs[id], origins)),
  );

  if (name === "select_browser") {
    // Any outcome but a clean select of the pinned device closes the gate.
    const ok =
      typeof config?.deviceId === "string" &&
      args.deviceId === config.deviceId &&
      texts.some((t) => t.trimStart().startsWith("Selected browser"));
    next.selected = ok;
    events.push({ selected: ok });
  }

  // Every listing in one response describes the same tab group at the same
  // moment, so two that disagree about a tab mean one of them is not the
  // extension's: the tab becomes ambiguous (quarantined).
  const listings = texts.map(parseTabContextBlock).filter(Boolean);
  if (name === "tabs_context_mcp") {
    listings.push(...texts.map(parseAvailableTabsJson).filter(Boolean));
  }
  const observed = new Map();
  for (const listing of listings) {
    for (const [id, url] of listing) recordUrl(observed, id, url);
  }

  if (listings.length > 0) {
    // The listing is the whole group: an owned tab missing from it has been
    // closed or moved out, and is no longer this session's.
    for (const id of Object.keys(next.tabs)) {
      if (!observed.has(id)) {
        delete next.tabs[id];
        events.push({ gone: Number(id) });
      }
    }
    for (const [id, url] of observed) {
      if (Object.hasOwn(next.tabs, id)) {
        next.tabs[id] = url;
      } else if (ADOPTING_TOOLS.has(name)) {
        next.tabs[id] = url;
        events.push({ adopted: Number(id) });
      }
      if (url === AMBIGUOUS_URL && Object.hasOwn(next.tabs, id)) {
        events.push({ ambiguous: Number(id) });
      }
    }
  } else if (TAB_TOOLS.has(name) && isTabId(args.tabId) && owns(next, args.tabId)) {
    // A successful tab tool always reports the tab's page. When it did not,
    // the guard no longer knows where the tab is.
    next.tabs[String(args.tabId)] = UNKNOWN_URL;
    events.push({ unknown: args.tabId });
  }

  if (name === "tabs_close_mcp" && isTabId(args.tabId)) {
    const closed = new RegExp(`^Closed tab ${args.tabId}\\.`);
    if (texts.some((t) => closed.test(t.trim())) && owns(next, args.tabId)) {
      delete next.tabs[String(args.tabId)];
      events.push({ closed: args.tabId });
    }
  }

  // Only computer saves screenshots; a page-reading tool's response is page
  // text, and a page could print a look-alike line.
  if (name === "computer") {
    for (const t of texts) {
      const m = SCREENSHOT_BLOCK_RE.exec(t.trim());
      if (!m) continue;
      const problem = screenshotSourceProblem(m[1], tmpRoots ? { tmpRoots } : undefined);
      events.push(problem ? { screenshotRejected: problem } : { copy: m[1] });
    }
  }

  for (const id of Object.keys(next.tabs)) {
    if (!quarantinedBefore.has(id) && isQuarantinedUrl(next.tabs[id], origins)) {
      events.push({ quarantined: Number(id) });
    }
  }
  return { state: next, events };
}

// ── Files ───────────────────────────────────────────────────────────────────

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

export function sessionPaths(config, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error("the hook payload has no valid session_id");
  }
  return {
    state: path.join(config.stateDir, `${sessionId}.json`),
    poison: path.join(config.stateDir, `${sessionId}.poisoned`),
    lock: path.join(config.stateDir, `${sessionId}.lock`),
    log: path.join(config.logDir, `${sessionId}.jsonl`),
    // In-flight post markers: <sid>.post-<tool_use_id>.inflight. The session
    // id cannot contain a dot, so this prefix never matches another session.
    inflightPrefix: `${sessionId}.post-`,
    inflight: (toolUseId) =>
      path.join(config.stateDir, `${sessionId}.post-${inflightToken(toolUseId)}.inflight`),
  };
}

/** tool_use_id reduced to [A-Za-z0-9_-]; a random token when there is none. */
export function inflightToken(toolUseId) {
  const clean = typeof toolUseId === "string" ? toolUseId.replace(/[^A-Za-z0-9_-]/g, "") : "";
  return clean ? clean.slice(0, 128) : `anon-${randomBytes(8).toString("hex")}`;
}

/** The in-flight post markers that exist for this session right now. */
export function inflightPosts(config, sessionId) {
  const { inflightPrefix } = sessionPaths(config, sessionId);
  let names;
  try {
    names = readdirSync(config.stateDir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => n.startsWith(inflightPrefix) && n.endsWith(".inflight"));
}

/** A missing state file is a fresh session; an unreadable one is an error. */
export function readState(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return emptyState();
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the session state file is not valid JSON");
  }
  return validateState(raw);
}

function appendLog(file, record) {
  ensureDir(path.dirname(file));
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Parallel tool calls run their PostToolUse hooks concurrently, and a lost
// read-modify-write could drop the update that quarantines a tab. mkdir is
// atomic, so it doubles as the lock; one left by a killed hook goes stale.
function withLock(lockPath, fn) {
  ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the session state lock");
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/**
 * Copy (never move) a screenshot into the evidence directory. Re-checks on
 * disk what screenshotSourceProblem checked on paper: the directory really is
 * under the temp root, is ours and 0700 (as Claude Code creates it), and the
 * file is a regular file of ours, opened without following symlinks. Returns
 * the destination path.
 */
export function copyEvidence(src, evidenceDir, { tmpRoots = defaultTmpRoots() } = {}) {
  const problem = screenshotSourceProblem(src, { tmpRoots });
  if (problem) throw new Error(`screenshot path rejected: ${problem}`);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const dir = path.dirname(src);
  const realDir = realpathSync(dir);
  const realRoots = tmpRoots.flatMap((r) => {
    try {
      return [realpathSync(r)];
    } catch {
      return [];
    }
  });
  if (!realRoots.some((root) => isStrictlyUnder(realDir, root))) {
    throw new Error("screenshot directory resolves outside the temp directory");
  }
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory()) throw new Error("screenshot directory is not a directory");
  if ((uid !== null && dirStat.uid !== uid) || (dirStat.mode & 0o777) !== 0o700) {
    throw new Error("screenshot directory is not a private directory of this user");
  }
  const fd = openSync(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let data;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("screenshot is not a regular file");
    if (uid !== null && st.uid !== uid) throw new Error("screenshot is not owned by this user");
    if (st.size > MAX_SCREENSHOT_BYTES) throw new Error("screenshot is too large");
    data = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  ensureDir(evidenceDir);
  const ext = path.extname(src);
  const stem = path.basename(src, ext);
  for (let n = 0; n < 100; n += 1) {
    const dest = path.join(evidenceDir, n === 0 ? `${stem}${ext}` : `${stem}-${n}${ext}`);
    try {
      writeFileSync(dest, data, { mode: 0o600, flag: "wx" });
      return dest;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new Error("too many screenshots with the same name");
}

// ── Hooks ───────────────────────────────────────────────────────────────────

// Fixed message on purpose: JSON.parse errors quote the input, and the input
// holds tool_input (a form_input value can be a password).
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

function logFields(payload) {
  const input = isPlainObject(payload.tool_input) ? payload.tool_input : {};
  const tool = typeof payload.tool_name === "string" ? payload.tool_name.slice(0, 200) : null;
  const fields = { tool };
  if (isTabId(input.tabId)) fields.tabId = input.tabId;
  if (tool === fullToolName("navigate")) fields.url = redactUrl(input.url);
  return fields;
}

/** PreToolUse: {code: 0} allows, {code: 2, stderr} blocks. Never throws. */
export function runPreHook({ configPath, stdin, now = new Date().toISOString() }) {
  try {
    if (Buffer.byteLength(stdin ?? "") > MAX_PRE_PAYLOAD_BYTES) {
      throw new Error("the hook payload is too large");
    }
    const config = loadConfig(configPath);
    const payload = parsePayload(stdin);
    const paths = sessionPaths(config, payload.session_id);
    let decision;
    if (existsSync(paths.poison)) {
      decision = deny(
        "the guard lost track of this session's tabs after a failed post-call update; " +
          "the browser is off for the rest of this run",
      );
    } else if (inflightPosts(config, payload.session_id).length > 0) {
      // A post that is running, or that died before it recorded what its call
      // did (fact (b) in the header comment).
      decision = deny(INFLIGHT_REASON);
    } else {
      decision = decidePre({
        tool: payload.tool_name,
        input: payload.tool_input,
        config,
        state: readState(paths.state),
      });
    }
    // An unlogged decision is a failed decision.
    appendLog(paths.log, {
      at: now,
      event: "pre",
      ...logFields(payload),
      allow: decision.allow,
      reason: decision.reason,
    });
    if (decision.allow) return { code: 0, stderr: "" };
    return { code: 2, stderr: `Blocked by the factory browser guard: ${decision.reason}.\n` };
  } catch (err) {
    return {
      code: 2,
      stderr: `Blocked: the factory browser guard could not evaluate this call (${err.message}).\n`,
    };
  }
}

/** SessionStart: the canary record bash checks with `verify`. Always exit 0. */
export function runSessionStartHook({ configPath, stdin, now = new Date().toISOString() }) {
  try {
    const config = loadConfig(configPath);
    const payload = parsePayload(stdin);
    const paths = sessionPaths(config, payload.session_id);
    const source =
      typeof payload.source === "string" && /^[a-z_]{1,32}$/.test(payload.source)
        ? payload.source
        : "unknown";
    // A fresh session starts with nothing selected, no tabs, no poison and no
    // in-flight posts. A resume or compaction keeps what the session had.
    if (source === "startup") {
      writeFileAtomic(paths.state, `${JSON.stringify({ ...emptyState(), updatedAt: now })}\n`);
      rmSync(paths.poison, { force: true });
      for (const name of inflightPosts(config, payload.session_id)) {
        rmSync(path.join(config.stateDir, name), { force: true });
      }
    }
    appendLog(paths.log, {
      at: now,
      event: "session-start",
      tool: null,
      allow: null,
      reason: `source=${source}`,
    });
    return { code: 0, stderr: "" };
  } catch (err) {
    return { code: 0, stderr: `browser-guard session-start: ${err.message}\n` };
  }
}

/**
 * PostToolUse: update the session state under its lock, then copy any
 * screenshot into the evidence dir. Always exit 0 — the call already ran.
 * If the state could not be updated, the session is poisoned so every later
 * pre denies: a quarantine the guard failed to record must not be lost. The
 * in-flight marker covers the case where this process never gets to the
 * catch at all (killed by its timeout): it is left behind, and pre denies.
 */
export function runPostHook({ configPath, stdin, now = new Date().toISOString(), tmpRoots }) {
  let config;
  let payload;
  let paths;
  try {
    config = loadConfig(configPath);
    payload = parsePayload(stdin);
    paths = sessionPaths(config, payload.session_id);
  } catch (err) {
    return { code: 0, stderr: `browser-guard post: ${err.message}\n` };
  }
  const record = { at: now, event: "post", ...logFields(payload), allow: null, reason: "ok" };
  let stderr = "";
  let events = [];
  let inflight = null;
  try {
    // First, before anything can fail or hang: mark this post in flight.
    inflight = paths.inflight(payload.tool_use_id);
    ensureDir(path.dirname(inflight));
    writeFileSync(inflight, `${now} ${record.tool ?? "?"}\n`, { mode: 0o600 });
    withLock(paths.lock, () => {
      const result = applyPost({
        tool: payload.tool_name,
        input: payload.tool_input,
        responseBlocks: payload.tool_response,
        config,
        state: readState(paths.state),
        now,
        tmpRoots,
      });
      writeFileAtomic(paths.state, `${JSON.stringify(result.state)}\n`);
      events = result.events;
    });
  } catch (err) {
    record.reason = `state update failed, session poisoned: ${err.message}`;
    try {
      writeFileSync(paths.poison, `${now} ${err.message}\n`, { mode: 0o600 });
    } catch (poisonErr) {
      // Leave the in-flight marker in place: with no poison written it is the
      // only thing that still stops the session.
      inflight = null;
      stderr += `browser-guard post: could not poison the session: ${poisonErr.message}\n`;
    }
  } finally {
    if (inflight) rmSync(inflight, { force: true });
  }
  const logged = [];
  for (const e of events) {
    if (!e.copy) {
      logged.push(e);
      continue;
    }
    try {
      logged.push({
        copied: path.basename(copyEvidence(e.copy, config.evidenceDir, { tmpRoots })),
      });
    } catch (err) {
      logged.push({ copyFailed: err.message });
    }
  }
  if (logged.length) record.events = logged;
  try {
    appendLog(paths.log, record);
  } catch (err) {
    stderr += `browser-guard post: could not write the decision log: ${err.message}\n`;
  }
  return { code: 0, stderr };
}

/** Counts from a session's decision log. sessionStart false = hooks never loaded. */
export function verifySession({ configPath, session }) {
  const config = loadConfig(configPath);
  const file = sessionPaths(config, session).log;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const counts = { sessionStart: false, pre: 0, denied: 0, post: 0 };
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
    } else if (r?.event === "post") counts.post += 1;
  }
  return counts;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  browser-guard.mjs config --out <cfg.json> --device <uuid> --allow-origin <origin> [--allow-origin …]
                           --log-dir <dir> --state-dir <dir> --evidence-dir <dir>
  browser-guard.mjs settings --config <cfg.json> --out <settings.json> [--perl <path>]
  browser-guard.mjs hook <session-start|pre|post> --config <cfg.json>   (payload on stdin)
  browser-guard.mjs verify --config <cfg.json> --session <uuid>
  browser-guard.mjs allowed-tools
`;

const CLI_OPTIONS = {
  config: { type: "string" },
  out: { type: "string" },
  device: { type: "string" },
  "allow-origin": { type: "string", multiple: true },
  "log-dir": { type: "string" },
  "state-dir": { type: "string" },
  "evidence-dir": { type: "string" },
  session: { type: "string" },
  perl: { type: "string" },
};

function required(values, key) {
  const v = values[key];
  if (typeof v !== "string" || v === "") throw new Error(`--${key} is required`);
  return v;
}

function assertExecutable(label, p) {
  if (!path.isAbsolute(p)) throw new Error(`${label} must be an absolute path: ${p}`);
  try {
    if (!statSync(p).isFile()) throw new Error("not a file");
    accessSync(p, fsConstants.X_OK);
  } catch {
    throw new Error(`${label} is not an executable file at ${p}`);
  }
}

function ownPath() {
  return realpathSync(fileURLToPath(import.meta.url));
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Run the CLI. Returns the exit code; output goes through the injected
 * streams. A `hook pre` invocation exits 2 on ANY failure, usage errors
 * included.
 */
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
        deviceId: required(values, "device"),
        allowOrigins: values["allow-origin"] ?? [],
        logDir: path.resolve(required(values, "log-dir")),
        stateDir: path.resolve(required(values, "state-dir")),
        evidenceDir: path.resolve(required(values, "evidence-dir")),
      });
      writeFileAtomic(
        path.resolve(required(values, "out")),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      return 0;
    }

    if (cmd === "settings") {
      const configPath = path.resolve(required(values, "config"));
      loadConfig(configPath); // a broken config fails here, not at hook time
      // The pre hook only fails closed on a hang through perl's alarm, so the
      // runner must not start with a settings file whose wrapper is missing.
      const perlPath = values.perl ?? DEFAULT_PERL_PATH;
      assertExecutable("perl", perlPath);
      const settings = buildGuardSettings({
        nodePath: process.execPath,
        guardPath: ownPath(),
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
      const run = { pre: runPreHook, post: runPostHook, "session-start": runSessionStartHook }[
        mode
      ];
      if (!run || positionals.length !== 1)
        throw new Error("hook needs one of session-start, pre, post");
      const configPath = path.resolve(required(values, "config"));
      const result = run({ configPath, stdin: await readAll(stdin) });
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
      stderr.write(`Blocked: the factory browser guard could not run (${err.message}).\n`);
      return 2;
    }
    stderr.write(`browser-guard: ${err.message}\n`);
    // A broken session-start/post hook must not fail the tool call; the
    // missing log records are what bash acts on.
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
      process.stderr.write(`browser-guard: ${err?.message ?? err}\n`);
      process.exitCode = isPre ? 2 : 1;
    },
  );
}
