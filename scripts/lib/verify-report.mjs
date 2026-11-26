#!/usr/bin/env node
// Composes the verification report the factory posts when a card leaves the
// Testing column for In Test: one issue comment that merges what the
// verification lanes found into a verdict, an assessment and the steps the
// human still has to do by hand.
//
// Why this exists: the pre-In-Test Testing stage runs the card's test
// scenario in two locked-down lanes that can't post anything themselves: the
// shell lane (verify-lane.mjs, a --no-chrome claude session that runs
// targeted tests, curl checks against the preview and the macOS --preflight)
// and the browser lane (the `verify` kind of the Chrome runner, ADR-0051).
// Their stdout is all they hand back, and it can carry things that must never
// reach a public repo: the test account's password, the Vercel
// protection-bypass secret, the dev service-role key. This module is
// deterministic (no claude call, so composing can't fail on a session limit),
// and every byte of lane text it posts has been scanned and defanged.
// Verification is evidence, never a gate: the card is In Test whatever the
// report says (ADR-0053). factory-agent.sh's verify_promote is the caller; it
// composes the report before moving the card and posts it once afterwards.
//
// Lane output (each lane's status line comes last, outside any block;
// parseBlocks() in browser-report.mjs reads both formats):
//
//   <shell-dir>/shell-output.txt
//     <<<REPORT
//     …a markdown table, a **Summary:** line, an **Assessment:** paragraph…
//     REPORT>>>
//     <<<MANUAL
//     1. …a step for the human, with its expected result…
//     MANUAL>>>
//     shell=<ok|partial|blocked> verdict=<pass|warn|fail|none>
//
//   <browser-dir>/runner-output.txt — the browser runner's format: a REPORT
//     block whose table has a Result column (PASS / FAIL / WARN / SKIP) and a
//     **Summary:** line, then `browser=<…> verdict=<…>`.
//
// Lane states (bash passes them from the state file, the SHA already
// stripped): `reported[:<verdict>]`, `timeout`, `unavailable:<reason>`,
// `stale-branch`, `no-preview`, `skipped:<reason>`, `none`. A lane counts as
// reported only when its state says so AND its output ends in a valid status
// line: the verdict comes from that line (the state's own verdict is not
// used), and output without one is no result, as in browser-report.mjs.
// Reasons are free tokens; the common ones read as sentences (see REASONS),
// any other is shown as it is.
//
// The comment, in order:
//   1. Header and headline: PASS / WARN / FAIL — the worst verdict among the
//      lanes that reported (a `blocked` lane counts as at least WARN) — or
//      INCOMPLETE when none reported a verdict; "partial" when some checks
//      didn't run; "Evidence, not a gate: the card is now In Test."
//   2. A lane table: Repo & API (shell), Web (browser), iOS / Android, macOS.
//      The iOS / Android row is manual, and macOS is (it notes the shell
//      lane's --preflight results). When the device lane (ADR-0106) left a
//      device-output.json (--device-out), the iOS / Android row becomes an
//      "Android (emulator)" and an "iOS (simulator)" row with the lane's state,
//      verdict and a short note; a platform it didn't cover keeps the manual
//      text, and a platform still running reads "running — results follow in
//      a separate comment". With platforms.webViaShared (the
//      verification variant: web reached only through packages/shared/) the
//      Web row says so, since the PR has no apps/web/ files.
//   3. Assessment: each reported lane's Summary, then the shell lane's
//      Assessment paragraph.
//   4. Steps for you to do manually (deduplicated, at most MANUAL_MAX): the
//      shell lane's MANUAL steps, the browser's FAIL and SKIP rows when it
//      reported (one that didn't tried none of its steps), one line
//      per scenario section (iOS / Android and macOS ones on the beta when one
//      was dispatched; `### API` only when the shell lane didn't report or
//      stopped early, since it is that lane's), one line per affected platform the scenario has no
//      section for (a mobile line notes the device lane's verdict when it
//      ran that platform), and "run the Web steps by hand" when the browser lane
//      didn't report (for `skipped:already-run`, a pointer to the In Test
//      run's Browser run comment instead). The platform and Web lines, and the pointer to a
//      withheld lane's local report, are never cut by the cap.
//   5. Coverage gaps: --gaps (a {lane, token} entry reads as the token's
//      REASONS sentence; a {lane, reason} one as it is), every lane that
//      didn't report or was withheld, then --cr-note.
//   6. Each lane's full report in <details>; the body stays within
//      COMMENT_MAX_CHARS by truncating these first, pointing at the local file.
//      The Web lane's screenshots, when --browser-images gives its upload
//      record (evidence-upload.mjs, ADR-0096), go inside its <details> under
//      the steps that took them (evidence-embed.mjs); they are never cut, the
//      lane text is. Only a lane that reported and wasn't withheld shows any,
//      and the shell lane never does. The device lane's go inside its own
//      <details> (--device-images), by platform and flow.
//   7. The local evidence paths (they stay on the Mac mini; the repo is
//      public), for every lane that had nothing embedded, with why the Web
//      screenshots weren't published when an upload was tried; a lane whose
//      screenshots are embedded says so on a line of its own.
//   8. The two markers below, exactly once, as the last two lines.
//
// The device lane's follow-up comment (--kind device, composeDeviceReport): a
// run that ends after the card left Testing posts its rows, flows and
// screenshots on their own, under DEVICE_REPORT_MARKER and
// deviceShaMarker(<sha>, <runId>), so the feedback detectors skip it.
//
// Secrets, per lane: the lane's whole output is scanned with browser-report's
// patterns, VERIFY_SECRET_PATTERNS, and three literals — the test account's
// password (--account-file, FACTORY_BROWSER_PASSWORD), the bypass secret
// (--bypass-file, VERCEL_AUTOMATION_BYPASS_SECRET) and the dev service-role
// key (--signin-key-file, DEV_SUPABASE_SERVICE_ROLE_KEY). A hit withholds only
// that lane's text, naming the pattern and never echoing the match. A secret
// file that can't be read withholds the lanes it guards (fail closed): the
// password guards both lanes, the bypass secret and the service-role key the
// shell lane. The device lane's text is scanned for its own account's password
// (--device-account-file, E2E_TEST_PASSWORD), which guards only that lane.
// Passing a file flag as "" says the lanes were never given that
// secret (e.g. no bypass secret is set up), so there is nothing of it to scan
// for; a flag left out entirely fails closed like an unreadable file. Every
// piece of lane, scenario and gap text is defanged, so nothing but this module
// can put a factory marker in the comment, and lane text can't open or close
// a <details> element or leave a code fence open. As a last check the
// finished body is scanned again, and a hit there replaces it with a minimal
// notice.
//
// CLI:
//   node verify-report.mjs render --issue <n> --pr <n> --sha <40-hex>
//        --scenario-file <f|""> --platforms '{"web":…,"mobile":…,"desktop":…[,"webViaShared":…]}'
//        --beta-lanes <csv> [--beta-reused '[{"id":…,"fromSha":…,"builds":[…]}]']
//        --shell-state <state> --shell-dir <dir|"">
//        --browser-state <state> --browser-dir <dir|"">
//        --gaps '[{"lane":…,"reason":…} | {"lane":…,"token":…}]' --cr-note <text|"">
//        --account-file <f|""> --bypass-file <f|""> --signin-key-file <f|"">
//        [--browser-images <upload.json|"">]
//        [--device-out <device-output.json|""> --device-account-file <f|"">
//         [--device-images <upload.json|"">]] --out <body-file>
//     Writes the comment body to --out and prints one JSON line
//     {verdict, withheld: {shell, browser[, device]}, secretHits,
//     images: {browser[, device]}} (the device keys only with --device-out;
//     images: how many screenshots the body embeds, per lane): verdict is
//     pass|warn|fail|incomplete; secretHits lists "<lane>:<pattern>" for each
//     match and "<lane>:<file>-unreadable" for each fail-closed file
//     ("body:<pattern>" when the final check tripped). --issue is validated
//     but not rendered: the comment is posted on that issue. A missing lane
//     output or scenario file is a coverage gap, not an error. Exit 0; 1 on
//     an I/O error writing --out; 2 on a usage error.
//   node verify-report.mjs render --kind device --issue <n> --pr <n> --sha <40-hex>
//        --device-out <device-output.json> --device-account-file <f|"">
//        [--device-images <upload.json|"">] --out <body-file>
//     The device lane's follow-up comment. Prints {verdict, withheld: {device},
//     secretHits, images: {device}}. Exit 1 when --device-out can't be read
//     or is for another commit.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  COMMENT_MAX_CHARS,
  MIN_PASSWORD_SCAN_LENGTH,
  RUNNER_OUTPUT_FILE,
  defangReport,
  lastBlock,
  literalForms,
  parseBlocks,
  parseEnvValues,
  parseRunnerOutput,
  scanForSecrets,
} from "./browser-report.mjs";
import {
  DEVICE_PLATFORMS,
  deviceEvidenceRunId,
  evidenceSection,
  readUpload,
  reasonSentence,
} from "./evidence-embed.mjs";
import {
  extractScenarioSections,
  reusedBetaNote,
  reusedBuildsText,
  shapePlatforms,
  shapeReusedBetas,
} from "./factory-bundle.mjs";
import { isMainModule } from "./is-main.mjs";
import { FENCE_LINE, closeFences, fenceStep } from "./markdown-fence.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { parseResultTable, splitRow } from "./result-table.mjs";

export { parseResultTable, splitRow };

export const VERIFY_REPORT_MARKER = "<!-- drafto-factory-verify-report -->";
export const VERIFY_SHA_MARKER_PREFIX = "drafto-factory-verify-sha:";
export const SHELL_OUTPUT_FILE = "shell-output.txt";
export const DEVICE_OUTPUT_FILE = "device-output.json";
export const DEVICE_REPORT_MARKER = "<!-- drafto-factory-device-report -->";
export const DEVICE_SHA_MARKER_PREFIX = "drafto-factory-device-sha:";
export const BROWSER_OUTPUT_FILE = RUNNER_OUTPUT_FILE;
export const MANUAL_MAX = 25;
export { COMMENT_MAX_CHARS };

const HEADER = "🏭 **Verification before In Test**";
const EVIDENCE_LINE = "Evidence, not a gate: the card is now In Test.";
const FULL_SHA = /^[0-9a-f]{40}$/;
const POSITIVE_INT = /^[1-9][0-9]*$/;
const SHELL_STATUS_LINE = /^shell=(ok|partial|blocked) verdict=(pass|warn|fail|none)$/;
const VERDICT_RANK = { pass: 1, warn: 2, fail: 3 };
const SUMMARY_MAX = 600;
const ASSESSMENT_MAX = 2000;
const GAPS_MAX = 20;
const MANUAL_ITEM_MAX = 1000;
export const MOBILE_HEADING = /\b(ios|android|mobile|iphone|ipad)\b/i;
const DESKTOP_HEADING = /\b(macos|mac|desktop)\b/i;
// The scenario's API-response checks, which the shell lane runs (ADR-0053).
// Matched on the plain label, so `### **API**` or `### API checks` count too.
const API_HEADING = /^api\b/i;
// ADR-0073's scenario sections: the runner's files, and the shell lane's live tests.
const FIXTURES_HEADING = /^fixtures\s*$/i;
const LIVE_TESTS_HEADING = /^live tests\s*$/i;
// Scenario sections that are notes, not steps.
const NOT_STEPS_HEADING = /(\bnot|n't)\s+(manually\s+)?testable\b|\buntestable\b/i;

export function verifyShaMarker(sha) {
  return `<!-- ${VERIFY_SHA_MARKER_PREFIX}${sha} -->`;
}

export function deviceShaMarker(sha, runId) {
  return `<!-- ${DEVICE_SHA_MARKER_PREFIX}${sha}:${runId} -->`;
}

const LANES = {
  shell: {
    label: "Repo & API (shell)",
    short: "Repo & API",
    file: SHELL_OUTPUT_FILE,
    guardedBy: ["password", "bypass", "signinKey"],
  },
  browser: {
    label: "Web (browser)",
    short: "Web",
    file: BROWSER_OUTPUT_FILE,
    guardedBy: ["password"],
  },
  // ADR-0106: Maestro on an Android emulator and an iOS simulator, run by a
  // supervisor (no claude session), signed in to its own dev account.
  device: {
    label: "Devices (Maestro)",
    short: "Devices",
    file: DEVICE_OUTPUT_FILE,
    guardedBy: ["devicePassword"],
  },
};

// Each secret file: its literal's hit name, and how an unreadable one reads.
const SECRET_SOURCES = {
  password: { hit: "password", unreadable: "account-file-unreadable", file: "account file" },
  bypass: {
    hit: "bypass-secret",
    unreadable: "bypass-file-unreadable",
    file: "bypass secret file",
  },
  signinKey: {
    hit: "service-role-key",
    unreadable: "signin-key-file-unreadable",
    file: "sign-in key file",
  },
  devicePassword: {
    hit: "device-password",
    unreadable: "device-account-file-unreadable",
    file: "device account file",
  },
};

// On top of browser-report's SECRET_PATTERNS: the shell lane runs a terminal,
// so it can also print a header dump (it holds the Vercel bypass secret in a
// curl config), a new-format Supabase secret key, a Sentry or GitHub token,
// or an env assignment.
export const VERIFY_SECRET_PATTERNS = Object.freeze([
  ["bypass-header", /x-vercel-protection-bypass/i],
  ["bypass-cookie-header", /x-vercel-set-bypass-cookie/i],
  ["supabase-secret-key", /\bsb_secret_[A-Za-z0-9_-]{8,}/],
  ["sentry-token", /\bsntry[su]_[A-Za-z0-9+/=_-]{16,}/],
  ["github-token", /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  [
    "env-secret",
    /\b[A-Z][A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|SERVICE_ROLE_KEY|AUTH_KEY)[A-Z0-9_]*\s*=\s*["']?[^\s"'$]{6,}/,
  ],
]);

// Reason tokens that read better as a sentence; any other is shown as is.
const REASONS = {
  memory: "deferred under memory pressure",
  disk: "deferred: low disk space",
  paused: "the factory was paused",
  off: "the lane is switched off",
  "hold-cap": "the hold cap was reached first",
  attempts: "out of attempts",
  "session-limit": "the Claude session limit was reached",
  chrome: "this Mac mini's Chrome wasn't connected to Claude in Chrome",
  "auth-expired": "the Vercel sign-in in the Mac mini's Chrome has expired",
  "signin-failed": "the one-time sign-in link didn't sign the runner in",
  account: "the test account file is missing or unusable",
  "no-bypass-secret": "no Vercel protection-bypass secret is set up",
  guard: "the lane's guard hook didn't load",
  install: "installing dependencies failed",
  "no-scenario": "there was no test scenario for this commit",
  "no-web-steps": "the scenario has no Web steps",
  // The shell lane's own tokens (verify-lane.mjs, factory-agent.sh's
  // verify_shell_work).
  busy: "another card's verification run held the lane",
  "lane-paused": "the verification lane was paused",
  error: "it exited with an error on every attempt",
  "no-result": "it finished without a result on every attempt",
  lost: "its supervisor died before it reported",
  "claude-missing": "the claude CLI wasn't found on the Mac mini",
  "pnpm-missing": "pnpm wasn't found on the Mac mini",
  "curl-missing": "curl wasn't found on the Mac mini",
  "perl-missing": "perl (the guard's timeout wrapper) wasn't found on the Mac mini",
  "nice-missing": "nice wasn't found on the Mac mini",
  "prompt-missing": "the lane's prompt file is missing",
  // A run's own fact, sent as a coverage gap token (verify-lane.mjs's runGaps):
  // the browser runner held the shared sign-in lease past the lane's wait.
  "signin-busy":
    "the browser runner was signing in as the same test account for longer than the lane could wait (the sign-in lease), so the lane had no preview session and its signed-in API checks didn't run",
  // A shell attempt that ended without a result, then the hold cap came
  // before another one (verify-decide.mjs maps retry:<why> to after-<why>).
  "after-error": "its run exited with an error, and the hold cap came before another attempt",
  "after-no-result": "its run ended without a result, and the hold cap came before another attempt",
  "after-lost": "its supervisor died, and the hold cap came before another attempt",
  "after-terminated":
    "its run was stopped from outside, and the hold cap came before another attempt",
  "after-stopped":
    "its run was stopped when the card left Testing, and the hold cap came before another attempt",
  // The Testing sweep's own tokens (factory-agent.sh, verify-decide.mjs).
  "not-built": "this lane isn't built yet",
  "lane-off": "the lane is switched off (FACTORY_VERIFY_LANES)",
  "verification-off": "verification is switched off (FACTORY_VERIFY=0)",
  feedback: "new feedback on the issue cut verification short",
  // The browser lane's own tokens (factory-agent.sh: verify_browser_work and
  // browser_run's verify kind).
  "not-web": "the PR's diff touches neither the web app (apps/web/) nor packages/shared/",
  "browser-off":
    "the browser runner's verify kind is switched off (FACTORY_BROWSER, FACTORY_BROWSER_KINDS)",
  "already-run":
    "the In Test browser run already reported on this commit, so this round didn't run the Web steps again (see its Browser run comment on the issue)",
  "chrome-not-running": "Chrome wasn't running on the Mac mini",
  "runner-disabled":
    "the browser runner is turned off until an operator resets it (factory:browser-reset)",
  "signin-key": "the dev sign-in key file is missing or unusable",
  "signin-mint": "the one-time sign-in link couldn't be minted",
  preflight: "the browser runner's pre-run check failed",
  "runner-start": "the browser runner couldn't be started",
  "runner-error": "the browser runner failed on its last attempt",
  malformed: "the runner's output had no status line, so its result can't be trusted",
};

// ── small text helpers ──────────────────────────────────────────────────────

// obj[key] for the object's own keys only: lane states, reasons and verdicts
// are strings from outside, and "constructor" must not find a prototype member.
function own(obj, key) {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// Untrusted text, made safe to post: no factory markers (defangReport), and no
// <details> / <summary> tag — even a truncated one — that could close a lane's
// collapsed report early or fold the rest of the comment into one of its own.
function defang(text) {
  return defangReport(text).replace(/<(\/?)(details|summary)/gi, "&lt;$1$2");
}

// One line of untrusted text for prose: whitespace collapsed, capped, defanged.
function inline(text, max = 300) {
  let s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${sliceSafe(s, max - 1)}…`;
  return defang(s);
}

// Same, safe inside a table cell.
function cell(text, max) {
  return inline(text, max).replace(/\|/g, "\\|");
}

// Bold-safe: no emphasis or code markers that would break `**…**`.
function plainLabel(text, max = 80) {
  return inline(String(text ?? "").replace(/[*_`]/g, ""), max);
}

// A local path from bash: kept copy-pasteable (the factory checkout's own
// `drafto-factory/` stays intact), but on one line, out of code spans and HTML,
// and unable to spell a marker (`drafto-factory-…`).
function pathText(p) {
  return String(p ?? "")
    .replace(/[\r\n`]/g, "")
    .replace(/</g, "&lt;")
    .replace(/drafto-factory-/gi, (m) => `${m.slice(0, 6)}​${m.slice(6)}`);
}

function reasonText(token) {
  const t = String(token ?? "").trim();
  if (!t) return "";
  return own(REASONS, t) ?? inline(t, 120);
}

function worst(verdicts) {
  let best = null;
  for (const v of verdicts) {
    const rank = own(VERDICT_RANK, v);
    if (rank && (!best || rank > VERDICT_RANK[best])) best = v;
  }
  return best;
}

// The first <n> characters, never ending on half a surrogate pair.
function sliceSafe(text, n) {
  const cut = text.slice(0, Math.max(0, n));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// ── code fences ─────────────────────────────────────────────────────────────
// Lane text is model output: a fence it leaves open would turn the rest of the
// comment into code. markdown-fence.mjs tracks fences by CommonMark's rule.

// <text> cut to at most <max> characters, the closer of a fence the cut left
// open included.
function cutWithin(text, max) {
  let n = Math.max(0, max);
  for (;;) {
    const closed = closeFences(sliceSafe(text, n));
    if (closed.length <= max || n === 0) return closed;
    n -= closed.length - max;
  }
}

// A soft cap for one section: cut to <max> and mark the cut with "…". The
// caller closes fences.
function capText(text, max) {
  if (text.length <= max) return text;
  return `${sliceSafe(text, max - 1).trimEnd()}…`;
}

// ── lane parsing ────────────────────────────────────────────────────────────

export function parseShellOutput(text) {
  const { blocks, status } = parseBlocks(text, {
    blocks: ["REPORT", "MANUAL"],
    statusLine: SHELL_STATUS_LINE,
  });
  return {
    status: status ? status[1] : "malformed",
    verdict: status ? status[2] : "none",
    report: lastBlock(blocks, "REPORT"),
    manual: lastBlock(blocks, "MANUAL"),
  };
}

// "<kind>[:<detail>]" → { kind, detail }. Empty means "none".
export function parseLaneState(raw) {
  const s = String(raw ?? "").trim() || "none";
  const i = s.indexOf(":");
  return {
    kind: (i === -1 ? s : s.slice(0, i)).toLowerCase(),
    detail: i === -1 ? "" : s.slice(i + 1).trim(),
  };
}

// parseResultTable / splitRow live in result-table.mjs, so browser-report.mjs
// can use them without importing this module back (it imports browser-report).

// The paragraph after a `**Label:**` line (the rest of that line included), as
// lines, or null. It ends at a blank line (with multi, blank lines are kept
// and only what follows ends it), the next `**Label:**` line, a heading or a
// table. A list item that starts with a bold label ("- **Step 4:** …") is
// content, not the next label.
function labelled(report, label, { multi = false } = {}) {
  const lines = String(report ?? "").split(/\r?\n/);
  const re = new RegExp(`^\\s*(?:[-*]\\s+)?\\*\\*${label}(?::\\*\\*|\\*\\*:)\\s*(.*)$`, "i");
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return null;
  const out = [];
  const first = re.exec(lines[start])[1].trim();
  if (first) out.push(first);
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) {
      if (!multi && out.length) break;
      if (out.length) out.push("");
      continue;
    }
    if (/^\s*\*\*[^*\n]{1,60}?(?::\*\*|\*\*:)/.test(l)) break;
    if (/^\s*#{1,6}\s/.test(l) || /^\s*\|/.test(l)) break;
    out.push(l.trimEnd());
  }
  while (out.length && !out.at(-1)) out.pop();
  return out.length ? out : null;
}

// A MANUAL block → items [{ first, rest }]. A new item starts at a list
// marker in the first two columns, outside fenced blocks; anything else
// continues the current item.
export function parseManualList(text) {
  const items = [];
  let cur = null;
  let fence = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m =
      fence === null && !FENCE_LINE.test(line) && /^ ?(?:\d+[.)]|[-*+])\s+(.*\S)\s*$/.exec(line);
    fence = fenceStep(fence, line);
    if (m) {
      if (cur) items.push(cur);
      cur = { first: m[1], rest: [] };
    } else if (cur) {
      cur.rest.push(line);
    } else if (line.trim()) {
      cur = { first: line.trim(), rest: [] };
    }
  }
  if (cur) items.push(cur);
  for (const item of items) {
    while (item.rest.length && !item.rest.at(-1).trim()) item.rest.pop();
  }
  return items;
}

// ── secrets ─────────────────────────────────────────────────────────────────

function isSecret(v) {
  return typeof v === "string" && v !== "";
}

// Pattern and literal hits in <text>, by name, never the matched text.
export function scanLaneText(text, secrets = {}) {
  const s = String(text ?? "");
  const hits = scanForSecrets(s, {
    password: isSecret(secrets.password) ? secrets.password : undefined,
  });
  for (const [name, re] of VERIFY_SECRET_PATTERNS) {
    if (re.test(s)) hits.push(name);
  }
  for (const key of ["bypass", "signinKey", "devicePassword"]) {
    const v = secrets[key];
    if (!isSecret(v) || v.length < MIN_PASSWORD_SCAN_LENGTH) continue;
    if (literalForms(v).some((form) => s.includes(form))) hits.push(SECRET_SOURCES[key].hit);
  }
  return hits;
}

// The value of <key> in a KEY=VALUE secret file, or null when the file can't
// be read or has no non-empty value for it. Never throws, never logs a value.
export function readSecretValue(file, key) {
  if (!file) return null;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const v = parseEnvValues(text, [key])[key];
  return isSecret(v) ? v : null;
}

// ── lanes ───────────────────────────────────────────────────────────────────

function describeState(state) {
  switch (state.kind) {
    case "timeout":
      return "timed out before it reported";
    case "unavailable":
      return state.detail ? `unavailable: ${reasonText(state.detail)}` : "unavailable";
    case "stale-branch":
      return "the PR branch predates the preview sign-in route; update the branch from main";
    case "no-preview":
      return "no Vercel preview was ready for this commit";
    case "waiting-preview":
      // Non-terminal (the browser lane's preview wait); verify-decide turns it
      // into skipped:<reason> at promotion, so only a fail-open promotion
      // shows it.
      return "was still waiting for this commit's Vercel preview";
    case "skipped":
      return state.detail ? `skipped: ${reasonText(state.detail)}` : "skipped";
    case "none":
      return "didn't run";
    default:
      return `unrecognised state \`${inline(state.kind, 40).replace(/`/g, "")}\``;
  }
}

const STATE_STATUS = {
  timeout: "timed out",
  unavailable: "unavailable",
  "stale-branch": "skipped",
  "no-preview": "skipped",
  "waiting-preview": "not run",
  skipped: "skipped",
  none: "not run",
};

const RUNNER_STATUS_REASON = {
  unavailable: "chrome",
  "auth-expired": "auth-expired",
  "signin-failed": "signin-failed",
};

// secrets[k]: the literal; "" when the lanes were never given it; null (or
// absent) when its file couldn't be read.
function buildLane(key, input, secrets, { notNeeded = false } = {}) {
  const meta = LANES[key];
  const state = parseLaneState(input?.state);
  const dir = typeof input?.dir === "string" ? input.dir : "";
  // An empty output file is no output: nothing to scan, show or withhold.
  const text = typeof input?.text === "string" && input.text.trim() ? input.text : null;
  const parsed =
    text == null ? null : key === "shell" ? parseShellOutput(text) : parseRunnerOutput(text);
  const localFile = dir ? path.join(dir, meta.file) : "";

  let unreadable = [];
  let hits = [];
  if (text != null) {
    unreadable = meta.guardedBy.filter((k) => secrets[k] !== "" && !isSecret(secrets[k]));
    hits = scanLaneText(text, secrets);
  }

  const lane = {
    key,
    meta,
    state,
    dir,
    localFile,
    text,
    parsed,
    withheld: unreadable.length > 0 || hits.length > 0,
    unreadable,
    hits,
    reported: false,
    notNeeded: false,
    earlierRun: false,
    status: own(STATE_STATUS, state.kind) ?? "unknown",
    runStatus: null,
    verdict: "none",
    effective: null,
    gap: null,
  };

  const runStatus = parsed?.status ?? "malformed";
  const runnerReason = own(RUNNER_STATUS_REASON, runStatus);
  if (state.kind !== "reported") {
    if (notNeeded) {
      lane.notNeeded = true;
      lane.status = "not needed";
    } else {
      lane.gap = describeState(state);
      // The In Test run's report for this commit is on the issue
      // (factory-agent.sh checks for it): still a gap, since its result never
      // reaches here, but the manual step points at it (EARLIER_RUN_STEP).
      lane.earlierRun =
        key === "browser" &&
        state.kind === "skipped" &&
        state.detail.toLowerCase() === "already-run";
    }
  } else if (runnerReason) {
    lane.status = "no result";
    lane.gap = `unavailable: ${reasonText(runnerReason)}`;
  } else if (runStatus === "malformed") {
    // Same rule as browser-report.mjs: no status line, no result.
    lane.status = "no result";
    lane.gap =
      text == null
        ? "its output is missing or empty, so there is no result to trust"
        : "its output has no status line, so its result isn't trusted";
  } else {
    lane.reported = true;
    lane.runStatus = runStatus;
    lane.verdict = parsed.verdict;
    if (runStatus === "partial") {
      lane.status = "ran (partial)";
      lane.gap = "ran only part of its checks; see its report";
    } else if (runStatus === "blocked") {
      lane.status = "stopped (blocked)";
      lane.gap = "stopped early on purpose (it refused a step); see its report";
    } else {
      lane.status = "ran";
    }
    lane.effective =
      runStatus === "blocked" ? worst(["warn", lane.verdict]) : worst([lane.verdict]);
  }
  return lane;
}

function withheldWhy(lane) {
  const parts = [];
  if (lane.hits.length) parts.push(`matched ${lane.hits.join(", ")}`);
  if (lane.unreadable.length) {
    const files = lane.unreadable.map((k) => SECRET_SOURCES[k].file).join(", ");
    parts.push(`couldn't read the ${files}, so the secret scan can't be trusted`);
  }
  return parts.join("; ");
}

function withheldNotice(lane) {
  const where = lane.localFile ? ` The local copy is at \`${pathText(lane.localFile)}\`.` : "";
  return `Withheld: ${withheldWhy(lane)}.${where}`;
}

// ── the device lane (ADR-0106) ──────────────────────────────────────────────
// Its output is device-output.json, written by the lane's supervisor, not a
// model; it is still shaped here field by field, and every string it shows
// (flow names, failure lines, state reasons) is scanned and defanged like the
// other lanes' text.

const DEVICE_VERDICT_RANK = { PASS: "pass", FAIL: "fail", ERROR: "warn" };
const DEVICE_STATUS = {
  done: "ran",
  running: "running",
  unavailable: "unavailable",
  failed: "failed",
  stopped: "stopped",
};
const DEVICE_FLOWS_MAX = 40;
const DEVICE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const DEVICE_RUNNING_NOTE = "running — results follow in a separate comment";

// device-lane.mjs's state reasons (unavailable:<r>, failed:<r>, stopped:<r>).
const DEVICE_REASONS = {
  "no-account": "the device lane's dev account file is missing or unusable",
  java: "the installed JDK isn't one gradle can run on (17–24)",
  "no-simulator": "no iOS simulator is set up for the lane",
  "no-keystore": "the Android debug keystore is missing",
  "no-avd": "the lane's Android emulator (AVD) is missing",
  "artifact-not-dev": "the build wasn't a dev-only build, so nothing was installed",
  "env-not-dev": "the build's env files weren't dev-only, so nothing was built",
  prepare: "preparing the build root failed",
  "install-deps": "installing dependencies failed",
  prebuild: "the native prebuild failed",
  "prebuild-timeout": "the native prebuild timed out",
  pods: "installing CocoaPods failed",
  build: "the build failed",
  "build-timeout": "the build timed out",
  boot: "the device didn't boot",
  "boot-timeout": "the device didn't boot in time",
  install: "installing the app on the device failed",
  timeout: "the run hit its time limit",
  error: "the supervisor hit an unexpected error",
  "beta-build": "a beta build needed the Mac mini",
  memory: "the Mac mini ran short of memory",
  "head-moved": "the PR's head moved",
  "pr-closed": "the PR was closed or merged",
  "left-column": "the card left Testing and In Test",
  stop: "it was stopped by hand",
  signal: "it was stopped",
};

function deviceReason(token) {
  const t = String(token ?? "").trim();
  if (!t) return "";
  return own(DEVICE_REASONS, t) ?? reasonText(t);
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/)[0];
}

function shapeDeviceFlow(raw) {
  const f = raw !== null && typeof raw === "object" ? raw : {};
  return {
    name: typeof f.name === "string" && f.name.trim() ? f.name : "(unnamed flow)",
    status: own(DEVICE_VERDICT_RANK, f.status) ? f.status : "ERROR",
    durationS: Number.isFinite(f.durationS) ? Math.max(0, Math.round(f.durationS)) : null,
    failure: typeof f.failure === "string" && f.failure.trim() ? f.failure : null,
  };
}

function shapeDevicePlatform(v) {
  const { kind, detail } = parseLaneState(typeof v.state === "string" ? v.state : "");
  const b = v.build !== null && typeof v.build === "object" ? v.build : null;
  return {
    kind,
    detail,
    verdict: kind === "done" && own(DEVICE_VERDICT_RANK, v.verdict) ? v.verdict : null,
    build: b
      ? {
          cached: b.cached === true,
          durationS: Number.isFinite(b.durationS) ? Math.round(b.durationS) : null,
        }
      : null,
    flows: Array.isArray(v.flows) ? v.flows.map(shapeDeviceFlow) : [],
  };
}

// A platform that didn't finish: its state, with the reason as a sentence.
function deviceStateText(v, { reason = true } = {}) {
  const status = own(DEVICE_STATUS, v.kind) ?? `unrecognised state ${inline(v.kind, 40)}`;
  return reason && v.detail ? `${status}: ${deviceReason(v.detail)}` : status;
}

/**
 * The device lane from device-output.json. <input>: {output, dir} (dir: the
 * run dir); output null, or not for <sha> (another commit's, or one that
 * names none), is no device output: every row then reads as it did before
 * the lane existed.
 */
function buildDeviceLane(input, secrets, sha) {
  const meta = LANES.device;
  const dir = typeof input?.dir === "string" ? input.dir : "";
  const raw = input?.output;
  const output =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) && raw.sha === sha ? raw : null;
  const platforms = {};
  const src = output?.platforms;
  if (src !== null && typeof src === "object" && !Array.isArray(src)) {
    for (const [p] of DEVICE_PLATFORMS) {
      const v = Object.hasOwn(src, p) ? src[p] : null;
      if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
      // Only a recorded state the lane writes counts as coverage: a record
      // with none (or an unknown one) leaves the platform's manual row.
      const shaped = shapeDevicePlatform(v);
      if (own(DEVICE_STATUS, shaped.kind)) platforms[p] = shaped;
    }
  }
  const covered = Object.keys(platforms).length > 0;
  // Every string a row, a gap or the details can show, for the scan.
  const text = covered
    ? Object.entries(platforms)
        .flatMap(([p, v]) => [
          `${p} ${v.kind}:${v.detail}`,
          ...v.flows.map((f) => `${f.name} ${f.status} ${f.failure ?? ""}`),
        ])
        .join("\n")
    : null;
  const unreadable =
    text == null ? [] : meta.guardedBy.filter((k) => secrets[k] !== "" && !isSecret(secrets[k]));
  const hits = text == null ? [] : scanLaneText(text, secrets);
  const withheld = unreadable.length > 0 || hits.length > 0;
  const done = Object.values(platforms).filter((v) => v.kind === "done");
  // A platform that ended without finishing (failed, stopped, unavailable)
  // counts as at least WARN, and as its worst flow before it ended; one still
  // running counts for nothing yet.
  const verdicts = Object.values(platforms).flatMap((v) => {
    if (v.kind === "done") return [own(DEVICE_VERDICT_RANK, v.verdict)];
    if (v.kind === "running") return [];
    return ["warn", ...v.flows.map((f) => own(DEVICE_VERDICT_RANK, f.status))];
  });
  const gaps = [];
  for (const [p, label] of DEVICE_PLATFORMS) {
    const v = platforms[p];
    if (!v || v.kind === "done" || v.kind === "running") continue;
    gaps.push(`${label} ${deviceStateText(v, { reason: !withheld })}`);
  }
  return {
    key: "device",
    meta,
    sha,
    dir,
    localFile: dir ? path.join(dir, DEVICE_OUTPUT_FILE) : "",
    runId: DEVICE_RUN_ID.test(String(output?.runId ?? "")) ? output.runId : null,
    trigger: output?.trigger === "on-demand" ? "on-demand" : "testing",
    platforms,
    covered,
    text,
    withheld,
    unreadable,
    hits,
    reported: done.length > 0,
    running: Object.values(platforms).some((v) => v.kind === "running"),
    // Some covered platform didn't finish its flows (still running or ended
    // early): the follow-up's headline says partial.
    partial: Object.values(platforms).some((v) => v.kind !== "done"),
    effective: worst(verdicts),
    gaps,
  };
}

function flowCounts(v) {
  return `${v.flows.filter((f) => f.status === "PASS").length}/${v.flows.length} flows passed`;
}

// The build's native step: device-output.json's build.cached says whether the
// native project (expo prebuild, and pods on iOS) was reused. The app itself
// is built either way.
function nativeText(build) {
  return build.cached ? "native project reused" : "native project regenerated";
}

// A covered platform's Note cell: flows passed, the first failure, whether the
// native project was reused. Raw text: the table cell escapes and defangs it.
function deviceNote(lane, v, runningNote) {
  if (lane.withheld) return `report withheld (${withheldWhy(lane)})`;
  if (v.kind === "running") return runningNote;
  const parts = [];
  if (v.kind !== "done") parts.push(deviceStateText(v));
  if (v.flows.length) {
    parts.push(v.kind === "done" ? flowCounts(v) : `${flowCounts(v)} before it ended`);
    const bad = v.flows.find((f) => f.status !== "PASS");
    if (bad) {
      const why = bad.failure ? ` — ${capText(firstLine(bad.failure), 200)}` : "";
      parts.push(`first failure: ${bad.name} (${bad.status})${why}`);
    }
  } else if (v.kind === "done") {
    parts.push("no flow ran");
  }
  if (v.build) parts.push(nativeText(v.build));
  return parts.join("; ");
}

// The table rows for the mobile platforms: [label, status, verdict, note].
// With no device output, today's single "iOS / Android" row (<fallback>: its
// status, verdict and note); a platform the lane didn't cover gets the same
// text under its own label, or no row when <fallback> is null.
function deviceRows(lane, fallback, runningNote = DEVICE_RUNNING_NOTE) {
  if (!lane?.covered) return fallback ? [["iOS / Android", ...fallback]] : [];
  return DEVICE_PLATFORMS.flatMap(([p, label]) => {
    const v = lane.platforms[p];
    if (!v) return fallback ? [[label, ...fallback]] : [];
    const status = own(DEVICE_STATUS, v.kind) ?? "unknown";
    return [[label, status, v.verdict ?? "—", deviceNote(lane, v, runningNote)]];
  });
}

// The lane's <details> text: per platform, its state and each flow's result.
function deviceDetailsText(lane) {
  if (!lane.covered) return null;
  if (lane.withheld) return withheldNotice(lane);
  const lines = [];
  for (const [p, label] of DEVICE_PLATFORMS) {
    const v = lane.platforms[p];
    if (!v) continue;
    const head = [`**${label}**`, inline(deviceStateText(v), 200)];
    if (v.verdict) head.push(v.verdict);
    if (v.build) {
      if (v.build.durationS != null) head.push(`build ${v.build.durationS} s`);
      head.push(nativeText(v.build));
    }
    lines.push(head.join(" · "), "");
    const shown = v.flows.slice(0, DEVICE_FLOWS_MAX);
    for (const f of shown) {
      const secs = f.durationS == null ? "" : ` (${f.durationS} s)`;
      const why = f.failure ? `: ${inline(firstLine(f.failure), 300)}` : "";
      lines.push(`- ${f.status} \`${inline(f.name, 120).replace(/`/g, "")}\`${secs}${why}`);
    }
    if (v.flows.length > shown.length) lines.push(`- …and ${v.flows.length - shown.length} more.`);
    if (!v.flows.length) lines.push("_No flow ran._");
    lines.push("");
  }
  return closeFences(lines.join("\n").trimEnd());
}

// " (the device lane ran: …)" for a mobile manual step whose platforms
// (<heading>'s: iOS, Android, or both) the lane ran, else "".
function deviceRanNote(lane, heading) {
  if (!lane?.covered) return "";
  const h = String(heading ?? "");
  const ios = /\b(ios|iphone|ipad)\b/i.test(h);
  const android = /\bandroid\b/i.test(h);
  const wanted = ios === android ? ["android", "ios"] : ios ? ["ios"] : ["android"];
  const ran = wanted
    .map((p) => [p, lane.platforms[p]])
    .filter(([, v]) => v && (v.kind === "done" || v.kind === "running"));
  if (!ran.length) return "";
  if (ran.every(([, v]) => v.kind === "running")) {
    return " (the device lane is still running; its results follow in a separate comment)";
  }
  const what = (v) => (v.kind === "running" ? "still running" : (v.verdict ?? "no verdict"));
  if (ran.length === 1 && wanted.length === 1) return ` (the device lane ran: ${what(ran[0][1])})`;
  const name = { android: "Android", ios: "iOS" };
  return ` (the device lane ran: ${ran.map(([p, v]) => `${name[p]} ${what(v)}`).join(", ")})`;
}

// ── body sections ───────────────────────────────────────────────────────────

function platformHow(platform, betaLanes, betaReused = []) {
  const name = platform === "mobile" ? "iOS / Android" : "macOS";
  if (betaLanes.includes(platform)) {
    return `on the ${name} beta for this commit (a follow-up comment gives the build number)`;
  }
  // ADR-0081: an earlier commit's beta that nothing since has changed.
  const reused = betaReused.find((r) => r.id === platform);
  if (reused) {
    const builds = reusedBuildsText(reused);
    return (
      `on the ${name} beta built from \`${reused.fromSha.slice(0, 12)}\`` +
      `${builds ? ` (${builds})` : ""}, which nothing since has changed`
    );
  }
  return "on a build of this branch (no beta was dispatched; the scenario says how to get one)";
}

// The manual step for a browser lane that ended `skipped:already-run`: the In
// Test run's report for this commit is on the issue, but its result never
// reaches this composer, so the step says what to do for each way that report
// can read, and for a scenario or environment that changed since it ran.
export const EARLIER_RUN_STEP =
  "Read the earlier **Browser run** comment for this commit on this issue: this round didn't " +
  "run the Web steps again. Re-check by hand the steps it marked FAIL or SKIP, or doesn't list. " +
  "Run all the **Web** steps by hand on the preview if it shows no results (it stopped early, " +
  "or its report was withheld) or if the scenario or the environment changed since it ran.";

// The Web row's note when the web changes come only through packages/shared/:
// why the browser ran on a PR with no apps/web/ files.
export const WEB_VIA_SHARED_NOTE =
  "web changes come through `packages/shared/`, which the web app imports (no `apps/web/` files changed)";

function laneTable(shell, browser, platforms, betaLanes, betaReused = [], device = null) {
  const rows = [];
  for (const lane of [shell, browser]) {
    const verdict = lane.effective ? lane.effective.toUpperCase() : "—";
    let note;
    if (lane.withheld) note = `report withheld (${withheldWhy(lane)})`;
    else if (lane.notNeeded) note = "no web changes and no Web steps";
    else if (lane.gap) note = lane.gap;
    else if (lane.parsed?.report) note = "full report below";
    else note = "";
    if (lane.key === "browser" && platforms.webViaShared) {
      note = note ? `${WEB_VIA_SHARED_NOTE}; ${note}` : WEB_VIA_SHARED_NOTE;
    }
    rows.push([lane.meta.label, lane.status, verdict, note]);
  }

  // A lane reused from an earlier commit's beta (ADR-0081) names that build.
  const reusedNote = (id) => {
    const r = betaReused.find((x) => x.id === id);
    return r ? reusedBetaNote(r) : null;
  };
  const mobileNote = betaLanes.includes("mobile")
    ? "beta dispatched for this commit; run the iOS / Android steps on it"
    : (reusedNote("mobile") ?? "no beta was dispatched; the scenario says how to get a build");
  rows.push(
    ...deviceRows(
      device,
      platforms.mobile ? ["manual", "—", mobileNote] : ["not affected", "—", "no mobile changes"],
    ),
  );

  const macNotes = [];
  if (platforms.desktop) {
    macNotes.push(
      betaLanes.includes("desktop")
        ? "beta dispatched for this commit; run the macOS steps on it"
        : (reusedNote("desktop") ?? "no beta was dispatched; the scenario says how to get a build"),
    );
  }
  if (shell.parsed?.report && !shell.withheld) {
    const results = [
      ...new Set(
        parseResultTable(shell.parsed.report)
          .filter((r) => /preflight/i.test(`${r.step} ${r.evidence}`) && r.result)
          .map((r) => r.result),
      ),
    ];
    if (results.length) macNotes.push(`shell lane's \`--preflight\`: ${results.join(", ")}`);
    else if (/--preflight/.test(shell.parsed.report)) {
      macNotes.push("`--preflight` results in the shell lane's report");
    }
  }
  rows.push(
    platforms.desktop
      ? ["macOS", "manual", "—", macNotes.join("; ")]
      : ["macOS", "not affected", "—", ["no macOS changes", ...macNotes].join("; ")],
  );

  return [
    "| Lane | Status | Verdict | Note |",
    "|---|---|---|---|",
    // Room for a reused mobile beta's note with its Android caveat (ADR-0081).
    ...rows.map(([a, b, c, d]) => `| ${a} | ${b} | ${c} | ${cell(d, 600)} |`),
  ];
}

// Untrusted lines as one list item under <label>: the first line next to the
// label unless it opens a fence (then the label stands alone), the rest
// indented under it, with fences closed before the indentation goes on.
function listItem(label, lines, max) {
  const out = defang(closeFences(capText(lines.join("\n"), max))).split("\n");
  const head = FENCE_LINE.test(out[0]) ? label.trimEnd() : `${label}${out.shift()}`;
  return [head, ...out.map((l) => (l.trim() ? `  ${l}` : ""))];
}

function assessment(shell, browser, device = null) {
  const out = [];
  for (const lane of [shell, browser]) {
    if (!lane.reported) continue;
    const label = `- **${lane.meta.short}:** `;
    if (lane.withheld) {
      out.push(`${label}_withheld (see the lane table)_`);
      continue;
    }
    const summary = labelled(lane.parsed?.report, "Summary");
    out.push(...(summary ? listItem(label, summary, SUMMARY_MAX) : [`${label}_no summary line_`]));
  }
  if (device?.reported) {
    const label = `- **${device.meta.short}:** `;
    const done = DEVICE_PLATFORMS.filter(([p]) => device.platforms[p]?.kind === "done").map(
      ([p, name]) =>
        `${name} ${device.platforms[p].verdict ?? "no verdict"}, ${flowCounts(device.platforms[p])}`,
    );
    out.push(
      device.withheld ? `${label}_withheld (see the lane table)_` : `${label}${done.join("; ")}.`,
    );
  }
  if (shell.reported && !shell.withheld) {
    const para = labelled(shell.parsed?.report, "Assessment", { multi: true });
    if (para) {
      // On its own line under the label, so a paragraph that opens with a
      // fence still renders as one.
      const text = defang(closeFences(capText(para.join("\n"), ASSESSMENT_MAX)));
      out.push("", `**${shell.meta.short} assessment:**`, "", text);
    }
  }
  return out.length ? out : ["_No lane reported a result._"];
}

function normaliseKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

// One untrusted manual item: its first line next to the number (a fence there
// is broken so it reads as text), its continuation lines re-indented under
// it — capped, fences closed and defanged before the indentation goes on.
function renderItem(n, { first, rest }) {
  let head = inline(first, 500);
  if (FENCE_LINE.test(head)) head = `​${head}`;
  const kept = rest.slice(0, 20);
  const indents = kept.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  let body = kept
    .map((l) => (l.trim() ? l.slice(cut).trimEnd() : ""))
    .join("\n")
    .replace(/^\n+/, "");
  if (rest.length > kept.length) body += "\n…";
  body = body ? defang(closeFences(capText(body, MANUAL_ITEM_MAX))) : "";
  const lines = body ? body.split("\n").map((l) => (l.trim() ? `   ${l}` : "")) : [];
  return [`${n}. ${head}`, ...lines].join("\n");
}

function manualSteps({
  shell,
  browser,
  sections,
  platforms,
  betaLanes,
  betaReused,
  device = null,
}) {
  const how = (platform) => platformHow(platform, betaLanes, betaReused);
  // { first, rest, reserved, trusted }: reserved items are never cut by the
  // cap; trusted ones are composed here from safe parts and render as is.
  const all = [];
  const add = (first, { reserved = false } = {}) =>
    all.push({ first, rest: [], reserved, trusted: true });
  const pointer = (lane, what) =>
    add(
      `Read the ${lane.meta.short} lane's local report` +
        (lane.localFile ? ` (\`${pathText(lane.localFile)}\`)` : "") +
        ` for ${what}: its text was withheld from this comment.`,
      { reserved: true },
    );

  if (shell.text != null) {
    if (shell.withheld) pointer(shell, "its manual steps");
    else {
      for (const item of parseManualList(shell.parsed?.manual)) all.push({ ...item });
    }
  }

  // A browser lane with no result (unavailable, no status line) never ran its
  // steps, so its SKIP rows aren't listed one by one as if each had been
  // tried: the single "run the Web steps by hand" line below covers them.
  if (browser.text != null && browser.reported) {
    if (browser.withheld) pointer(browser, "the steps it failed or skipped");
    else {
      for (const row of parseResultTable(browser.parsed?.report)) {
        if (row.result !== "FAIL" && row.result !== "SKIP") continue;
        const num = row.num ? ` ${row.num}` : "";
        const evidence =
          row.result === "FAIL" && row.evidence ? ` (the browser saw: ${row.evidence})` : "";
        all.push({
          first:
            `Re-check by hand — Web step${num}, which the browser marked **${row.result}**: ` +
            `${row.step}${evidence}`,
          rest: [],
        });
      }
    }
  }

  let hasMobile = false;
  let hasDesktop = false;
  // `### API` is the shell lane's section: once that lane has reported, it
  // listed every API step it couldn't run in its own manual block above.
  const shellRan = Boolean(shell.reported) && shell.runStatus !== "blocked";
  for (const s of sections) {
    if (s.heading === "Web" || NOT_STEPS_HEADING.test(s.heading)) continue;
    // ADR-0073: `### Fixtures` lists files for the browser runner, not steps.
    if (FIXTURES_HEADING.test(s.heading)) continue;
    const h = plainLabel(s.heading);
    // `### Live tests` is the shell lane's too: it reports each one, or lists
    // what it couldn't run among its own manual steps.
    if (LIVE_TESTS_HEADING.test(h)) {
      if (!shellRan) {
        add(
          `Run the **${h}** in the test scenario by hand: ` +
            "`pnpm test:live:supabase -- --only <name>` for each, after pushing the PR's " +
            "migration to dev.",
          { reserved: true },
        );
      }
      continue;
    }
    if (API_HEADING.test(h)) {
      if (!shellRan) {
        const why = shell.reported ? "stopped early (blocked)" : "didn't report";
        add(
          `Run the **${h}** steps in the test scenario by hand with \`vercel curl\`: ` +
            `the shell lane ${why}.`,
          { reserved: true },
        );
      }
      continue;
    }
    if (MOBILE_HEADING.test(s.heading)) {
      hasMobile = true;
      add(
        `Run the **${h}** steps in the test scenario ${how("mobile")}${deviceRanNote(device, h)}.`,
        {
          reserved: true,
        },
      );
    } else if (DESKTOP_HEADING.test(s.heading)) {
      hasDesktop = true;
      add(`Run the **${h}** steps in the test scenario ${how("desktop")}.`, {
        reserved: true,
      });
    } else {
      add(`Go through the **${h}** section of the test scenario.`);
    }
  }
  if (platforms.mobile && !hasMobile) {
    add(
      `Test the iOS / Android changes by hand ${how("mobile")}${deviceRanNote(device, "")}: ` +
        "the test scenario has no iOS / Android section.",
      { reserved: true },
    );
  }
  if (platforms.desktop && !hasDesktop) {
    add(
      `Test the macOS changes by hand ${how("desktop")}: ` +
        "the test scenario has no macOS section.",
      { reserved: true },
    );
  }

  const hasWebSection = sections.some((s) => s.heading === "Web");
  const browserRan = browser.reported && browser.runStatus !== "blocked";
  const webToCheck = hasWebSection || platforms.web;
  if (browser.earlierRun && webToCheck) {
    add(EARLIER_RUN_STEP, { reserved: true });
  } else if (!browserRan && webToCheck) {
    const why = browser.reported
      ? "stopped early (blocked)"
      : `didn't report (${browser.gap ?? "no result"})`;
    add(
      hasWebSection
        ? `Run the **Web** steps in the test scenario by hand on the preview: the browser lane ${why}.`
        : `Check the web changes by hand on the preview: the browser lane ${why}, and the scenario has no Web section.`,
      { reserved: true },
    );
  }

  const seen = new Set();
  const unique = all.filter((item) => {
    const k = normaliseKey([item.first, ...item.rest].join(" "));
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const reservedCount = Math.min(MANUAL_MAX, unique.filter((i) => i.reserved).length);
  let free = MANUAL_MAX - reservedCount;
  let reservedLeft = reservedCount;
  const kept = [];
  let dropped = 0;
  for (const item of unique) {
    if (item.reserved ? reservedLeft-- > 0 : free-- > 0) kept.push(item);
    else dropped++;
  }
  if (kept.length === 0) return ["_Nothing beyond the lane reports._"];
  const lines = kept.map((item, i) =>
    item.trusted ? `${i + 1}. ${item.first}` : renderItem(i + 1, item),
  );
  if (dropped > 0) {
    lines.push("", `_…and ${dropped} more; see the lane reports below._`);
  }
  return lines;
}

// { lines, notRun, withheld }: notRun counts the gaps where some check didn't
// run (they make the headline "partial"); withheld counts lanes that ran but
// whose text was withheld.
function coverageGaps({ shell, browser, device = null, gaps, crNote, scenarioMissing }) {
  const items = [];
  let notRun = 0;
  let withheld = 0;
  for (const raw of gaps) {
    const g = typeof raw === "string" ? { lane: "", reason: raw } : raw;
    const lane = own(LANES, String(g?.lane ?? ""))?.label ?? plainLabel(g?.lane ?? "", 40);
    // A token (a run's own fact, e.g. signin-busy) reads as its sentence; a
    // reason is free text, shown as it is even when it spells a token.
    const reason =
      typeof g?.token === "string" && g.token.trim()
        ? reasonText(g.token)
        : inline(g?.reason ?? "", 300);
    if (!reason) continue;
    items.push(lane ? `- **${lane}:** ${reason}` : `- ${reason}`);
    notRun++;
  }
  for (const lane of [shell, browser]) {
    if (lane.gap) {
      items.push(`- **${lane.meta.label}:** ${lane.gap}.`);
      notRun++;
    }
    if (lane.withheld) {
      items.push(`- **${lane.meta.label}:** report withheld; ${withheldWhy(lane)}.`);
      withheld++;
    }
  }
  if (device) {
    for (const g of device.gaps) {
      items.push(`- **${device.meta.label}:** ${g}.`);
      notRun++;
    }
    if (device.withheld) {
      items.push(`- **${device.meta.label}:** report withheld; ${withheldWhy(device)}.`);
      withheld++;
    }
  }
  if (scenarioMissing) {
    items.push(
      "- **Test scenario:** none was available for this commit, so the manual steps don't include its per-platform sections.",
    );
    notRun++;
  }
  const shown = items.slice(0, GAPS_MAX);
  if (items.length > GAPS_MAX) shown.push(`- …and ${items.length - GAPS_MAX} more.`);
  const note = inline(crNote ?? "", 500);
  if (note) shown.push(`- ℹ️ ${note}`);
  return { lines: shown, notRun, withheld };
}

// The text that goes in a lane's <details>: its report (and, for the shell
// lane, its MANUAL block as written), or the withheld notice.
function detailsText(lane) {
  if (lane.key === "device") return deviceDetailsText(lane);
  if (lane.text == null) return null;
  if (lane.withheld) return withheldNotice(lane);
  const parts = [];
  if (lane.parsed?.report) parts.push(lane.parsed.report);
  if (lane.key === "shell" && lane.parsed?.manual) {
    parts.push(`**Manual steps, as the lane wrote them:**\n\n${lane.parsed.manual}`);
  }
  if (!parts.length) return "_The lane printed no report._";
  return closeFences(defang(parts.join("\n\n")));
}

// <extra> (the lane's screenshots) goes after the content and is never cut.
function detailsBlock(lane, content, extra = "") {
  const title = lane.reported ? "full report" : "output";
  return [
    "<details>",
    `<summary>${lane.meta.label.replace(/&/g, "&amp;")}: ${title}</summary>`,
    "",
    content,
    ...(extra ? ["", extra] : []),
    "",
    "</details>",
  ].join("\n");
}

// A lane's screenshots (ADR-0096): {block, embedded, reason, given}. given is
// whether an upload record was passed for the lane at all; with none, nothing
// about screenshots changes in the report. The shell lane never has any; the
// device lane's go by platform and flow (ADR-0106).
function laneShots(lane, upload, secrets) {
  const none = { block: [], embedded: 0, reason: null, given: false };
  // A device run publishes its shots once, after it has finished (its
  // follow-up comment carries them): none while a platform is still running.
  if (lane.key === "device" && lane.running && !lane.withheld) {
    return { ...none, reason: "device-running", given: true };
  }
  if (lane.key === "shell" || upload === undefined || upload === null) return none;
  if (lane.withheld) return { ...none, reason: "withheld", given: true };
  if (lane.key === "device") {
    if (!lane.covered) return { ...none, reason: "not-reported", given: true };
    // A published record embeds only when it is this run's, for this commit:
    // an earlier run's record would put its images under these results.
    const ours =
      upload.ok === true &&
      upload.sha === lane.sha &&
      lane.runId !== null &&
      upload.runId === deviceEvidenceRunId(lane.runId);
    if (upload.ok === true && !ours) return { ...none, reason: "other-run", given: true };
    // A run that ended before any platform finished can still have published
    // the shots of the flows it completed.
    if (!lane.reported && !ours) return { ...none, reason: "not-reported", given: true };
  } else if (!lane.reported) {
    return { ...none, reason: "not-reported", given: true };
  }

  const ev = evidenceSection({
    report: lane.key === "browser" ? (lane.parsed?.report ?? null) : null,
    upload,
    withheld: false,
    evidenceDir: lane.dir,
    mode: lane.key === "device" ? "device" : "report",
    isSafe: (lines) => scanLaneText(lines.join("\n"), secrets).length === 0,
  });
  return { block: ev.block, embedded: ev.embedded, reason: ev.reason, given: true };
}

// Truncate each lane's details so the whole body fits in <room>: lanes are
// filled shortest first, each getting an equal share of what's left. The text
// is already defanged, and a cut can't make a tag or marker of it: defang()
// escapes every `<details` / `<summary` prefix and `<!--`.
function fitDetails(entries, room) {
  const total = entries.reduce((n, e) => n + e.content.length, 0);
  if (total <= room) return entries.map((e) => e.content);
  const out = new Array(entries.length);
  const order = entries
    .map((e, i) => i)
    .sort((a, b) => entries[a].content.length - entries[b].content.length);
  let left = Math.max(0, room);
  let lanesLeft = entries.length;
  for (const i of order) {
    const { content, lane } = entries[i];
    const share = Math.floor(left / lanesLeft);
    lanesLeft--;
    if (content.length <= share) {
      out[i] = content;
      left -= content.length;
      continue;
    }
    const where = lane.localFile
      ? `the full output is at \`${pathText(lane.localFile)}\``
      : "see the lane's run directory";
    const note = (n) => `\n\n_…truncated to ${n} of ${content.length} characters; ${where}._`;
    const cut = cutWithin(content, share - note(content.length).length);
    out[i] = cut + note(cut.length);
    left -= out[i].length;
  }
  return out;
}

// ── compose ─────────────────────────────────────────────────────────────────

// webViaShared (the verification variant, derive-platforms --verify): web is
// true only because the diff changes packages/shared/, which the web app
// imports. shapePlatforms keeps it only beside web, as the bundles do.
function normalisePlatforms(p) {
  return shapePlatforms(p, ["web", "mobile", "desktop"]);
}

function normaliseBetaLanes(lanes) {
  const list = Array.isArray(lanes) ? lanes : String(lanes ?? "").split(",");
  return list.map((l) => String(l).trim().toLowerCase()).filter((l) => /^[a-z0-9-]+$/.test(l));
}

/**
 * Pure core: compose the report body.
 *
 * @param {object} o
 * @param {string} o.sha full 40-hex head SHA (goes into the marker)
 * @param {number|string} o.pr
 * @param {{web?:boolean,mobile?:boolean,desktop?:boolean,webViaShared?:boolean}} o.platforms
 *   the verification variant: webViaShared marks web reached only through
 *   packages/shared/
 * @param {string[]|string} o.betaLanes dispatched beta lane ids (mobile, desktop)
 * @param {object[]} [o.betaReused] lanes reused from an earlier commit's beta
 *   (ADR-0081), [{id, fromSha, builds: [{platform, build}]}]; a dispatched lane wins
 * @param {string|null} o.scenario the scenario comment body, or null
 * @param {{state:string,dir?:string,text?:string|null}} o.shell
 * @param {{state:string,dir?:string,text?:string|null}} o.browser
 * @param {({lane:string,reason?:string,token?:string}|string)[]} o.gaps
 * @param {string} o.crNote
 * @param {{password?:string|null,bypass?:string|null,signinKey?:string|null}} o.secrets
 *   each secret's literal value; "" when the lanes were never given it; null
 *   (or absent) when its file couldn't be read, which fails closed
 * @param {{output:object|null,dir?:string}|null} [o.device] the device lane
 *   (ADR-0106): its parsed device-output.json and run dir; absent or null when
 *   the lane is off, and then the report reads exactly as before
 * @param {{browser?:object|null,device?:object|null}} [o.images] each lane's
 *   upload record (evidence-upload.mjs), by lane key; absent when none was tried
 * @returns {{body:string,verdict:string,withheld:{shell:boolean,browser:boolean,device?:boolean},secretHits:string[],images:{browser:number,device?:number}}}
 */
export function composeVerifyReport({
  sha,
  pr,
  platforms: rawPlatforms,
  betaLanes: rawBetaLanes,
  betaReused: rawBetaReused = [],
  scenario = null,
  shell: shellInput,
  browser: browserInput,
  device: deviceInput = null,
  gaps = [],
  crNote = "",
  secrets = {},
  images = {},
} = {}) {
  if (!FULL_SHA.test(String(sha ?? ""))) throw new Error(`invalid sha: ${sha}`);
  const platforms = normalisePlatforms(rawPlatforms);
  const betaLanes = normaliseBetaLanes(rawBetaLanes);
  const betaReused = shapeReusedBetas(rawBetaReused).filter((r) => !betaLanes.includes(r.id));
  const scenarioBody = typeof scenario === "string" && scenario.trim() ? scenario : null;
  const sections = scenarioBody ? extractScenarioSections(scenarioBody) : [];
  const hasWebSection = sections.some((s) => s.heading === "Web");

  const shell = buildLane("shell", shellInput, secrets);
  const browser = buildLane("browser", browserInput, secrets, {
    notNeeded: !platforms.web && !hasWebSection,
  });

  const device = deviceInput ? buildDeviceLane(deviceInput, secrets, sha) : null;

  const verdict = worst([shell.effective, browser.effective, device?.effective]) ?? "incomplete";
  const gapInfo = coverageGaps({
    shell,
    browser,
    device,
    gaps: Array.isArray(gaps) ? gaps : [],
    crNote,
    scenarioMissing: scenarioBody == null,
  });

  const short = String(sha).slice(0, 12);
  const prText = pr ? ` (PR #${inline(pr, 12)})` : "";
  let qualifier = "";
  if (gapInfo.notRun > 0) qualifier = " Partial: some checks didn't run; see **Coverage gaps**.";
  else if (gapInfo.withheld > 0) {
    qualifier = " A lane's report was withheld from this comment; see **Coverage gaps**.";
  }
  const headline =
    verdict === "incomplete"
      ? `**Verdict: INCOMPLETE** for \`${short}\`${prText}: no verification lane reported a result.`
      : `**Verdict: ${verdict.toUpperCase()}** for \`${short}\`${prText}.${qualifier}`;

  const shots = {
    shell: laneShots(shell, null, secrets),
    browser: laneShots(browser, images?.browser, secrets),
    ...(device ? { device: laneShots(device, images?.device, secrets) } : {}),
  };
  // The lanes with a section of their own: the device lane only when it
  // left output to show.
  const lanes = [shell, browser, ...(device?.covered ? [device] : [])];
  // <showShots>: whether the body shows the lanes' screenshots (the fallback
  // and withheld bodies below don't).
  const buildFooter = (showShots) => {
    const embedded = (lane) => showShots && shots[lane.key].embedded > 0;
    const evidenceDirs = lanes
      .filter((l) => l.dir && !embedded(l))
      .map((l) => `${l.meta.short} \`${pathText(l.dir)}\``);
    const notPublished = (lane, what) => {
      const sh = shots[lane.key];
      return sh.given && !embedded(lane) && sh.reason
        ? ` ${what} screenshots weren't published: ${reasonSentence(sh.reason)}.`
        : "";
    };
    const why =
      notPublished(browser, "Web") + (device?.covered ? notPublished(device, "Device") : "");
    const lines = [];
    if (evidenceDirs.length) {
      lines.push(
        `<sub>Local evidence stays on the Mac mini (the repo is public): ${evidenceDirs.join(" · ")}.${why}</sub>`,
        "",
      );
    } else if (why) {
      lines.push(`<sub>${why.trim()}</sub>`, "");
    }
    if (embedded(browser)) {
      const rest = browser.dir
        ? ` The rest of the Web lane's evidence stays on the Mac mini: \`${pathText(browser.dir)}\`.`
        : "";
      lines.push(
        "<sub>Web screenshots are published in this report (ADR-0096): they show the dev test " +
          `account on dev data.${rest}</sub>`,
        "",
      );
    }
    if (device?.covered && embedded(device)) lines.push(devicePublishedLine(device), "");
    return [...lines, VERIFY_REPORT_MARKER, verifyShaMarker(sha)];
  };
  const footer = buildFooter(true);

  const head = [
    HEADER,
    "",
    headline,
    "",
    EVIDENCE_LINE,
    "",
    ...laneTable(shell, browser, platforms, betaLanes, betaReused, device),
    "",
    "**Assessment**",
    "",
    ...assessment(shell, browser, device),
    "",
    "**Steps for you to do manually**",
    "",
    ...manualSteps({ shell, browser, sections, platforms, betaLanes, betaReused, device }),
    "",
    "**Coverage gaps**",
    "",
    ...(gapInfo.lines.length ? gapInfo.lines : ["_None._"]),
    "",
  ];

  const entries = lanes
    .map((lane) => ({
      lane,
      content: detailsText(lane),
      extra: shots[lane.key].block.join("\n").trim(),
    }))
    .filter((e) => e.content != null);
  const assemble = (contents) =>
    [
      ...head,
      ...entries.flatMap((e, i) => [detailsBlock(e.lane, contents[i], e.extra), ""]),
      ...footer,
    ].join("\n");

  // The room is what's left with every lane's text empty and its screenshots
  // in place: only the text is ever cut.
  const empty = assemble(entries.map(() => ""));
  let body = assemble(fitDetails(entries, COMMENT_MAX_CHARS - empty.length));
  let shotsShown = true;
  if (body.length > COMMENT_MAX_CHARS) {
    // Every other section is capped, so this needs a pathological input; the
    // details go first, then the middle, but the markers always survive.
    shotsShown = false;
    const plainFooter = buildFooter(false);
    body = [...head, ...plainFooter].join("\n");
    if (body.length > COMMENT_MAX_CHARS) {
      const tail = `\n\n_…report truncated._\n\n${plainFooter.join("\n")}`;
      body = cutWithin(head.join("\n"), COMMENT_MAX_CHARS - tail.length) + tail;
    }
  }

  const secretHits = laneSecretHits([shell, browser, ...(device ? [device] : [])]);
  const withheld = {
    shell: shell.withheld,
    browser: browser.withheld,
    // Nothing usable to show (output unreadable, corrupt or another commit's)
    // reads as withheld, so evidence-upload's gate publishes no device shots.
    ...(device ? { device: device.withheld || !device.covered } : {}),
  };

  // Last check: lane text is already scanned, but scenario headings, gap
  // reasons and the CR note aren't. A hit anywhere replaces the body.
  const bodyHits = scanLaneText(body, secrets);
  if (bodyHits.length > 0) {
    shotsShown = false;
    for (const h of bodyHits) secretHits.push(`body:${h}`);
    body = [
      HEADER,
      "",
      headline,
      "",
      EVIDENCE_LINE,
      "",
      `The rest of this report was withheld: the composed comment matched a secret pattern (${bodyHits.join(", ")}).`,
      "",
      // Fixed text and markers only: a lane's local path is text too, and
      // can be what matched.
      WITHHELD_LOCAL_LINE,
      "",
      VERIFY_REPORT_MARKER,
      verifyShaMarker(sha),
    ].join("\n");
    withheld.shell = withheld.shell || shell.text != null;
    withheld.browser = withheld.browser || browser.text != null;
    if (device) withheld.device = withheld.device || device.text != null;
  }

  return {
    body,
    verdict,
    withheld,
    secretHits,
    images: {
      browser: shotsShown ? shots.browser.embedded : 0,
      ...(device ? { device: shotsShown ? shots.device.embedded : 0 } : {}),
    },
  };
}

// A withheld body's pointer to the evidence: no path, since a path can be
// what the scan matched.
const WITHHELD_LOCAL_LINE =
  "<sub>The full report and the local evidence stay on the Mac mini (the repo is public).</sub>";

function laneSecretHits(lanes) {
  const hits = [];
  for (const lane of lanes) {
    for (const k of lane.unreadable) hits.push(`${lane.key}:${SECRET_SOURCES[k].unreadable}`);
    for (const h of lane.hits) hits.push(`${lane.key}:${h}`);
  }
  return hits;
}

function devicePublishedLine(device) {
  const rest = device.dir
    ? ` The rest of the device lane's evidence stays on the Mac mini: \`${pathText(device.dir)}\`.`
    : "";
  return (
    "<sub>Device screenshots are published in this report (ADR-0096, ADR-0106): the lane's " +
    "supervisor captured them on the Android emulator / iOS simulator, signed in to the dev " +
    `device account on dev data.${rest}</sub>`
  );
}

const DEVICE_HEADER = "🏭 **Device lane results**";

/**
 * Pure core of the device lane's follow-up comment (ADR-0106 decision 6): the
 * run ended after the card left Testing, or was asked for with the
 * factory-device-run label, so its results go in a comment of their own. It
 * carries DEVICE_REPORT_MARKER, so the feedback detectors skip it and the card
 * doesn't move.
 *
 * @param {object} o
 * @param {string} o.sha full 40-hex head SHA; the output must name it
 * @param {number|string} [o.pr]
 * @param {object|null} o.output the parsed device-output.json
 * @param {string} [o.dir] the run dir (local paths in the footer)
 * @param {object|null} [o.images] the device lane's upload record; absent or
 *   null when none was tried
 * @param {{devicePassword?:string|null,password?:string,bypass?:string,signinKey?:string}} [o.secrets]
 *   as composeVerifyReport's; devicePassword null (its file unreadable) withholds the text
 * @returns {{body:string,verdict:string,withheld:{device:boolean},secretHits:string[],images:{device:number}}}
 */
export function composeDeviceReport({ sha, pr, output, dir = "", images, secrets = {} } = {}) {
  if (!FULL_SHA.test(String(sha ?? ""))) throw new Error(`invalid sha: ${sha}`);
  if (output?.sha !== sha) {
    throw new Error("the device output is for another commit (or names none)");
  }
  const device = buildDeviceLane({ output, dir }, secrets, sha);
  const verdict = device.effective ?? "incomplete";
  const prText = pr ? ` (PR #${inline(pr, 12)})` : "";
  const head = [
    `${DEVICE_HEADER} for \`${String(sha).slice(0, 12)}\`${prText}`,
    "",
    verdict === "incomplete"
      ? "**Verdict: INCOMPLETE**: no platform finished its flows."
      : `**Verdict: ${verdict.toUpperCase()}**` +
        (device.partial ? ". Partial: a platform didn't finish its flows; see the table." : ""),
    "",
    (device.trigger === "on-demand" ? "Run on request (the `factory-device-run` label). " : "") +
      "Evidence, not a gate: the card stays where it is.",
    "",
  ];
  const table = device.covered
    ? [
        "| Platform | Status | Verdict | Note |",
        "|---|---|---|---|",
        ...deviceRows(device, null, "still running when this comment was posted").map(
          ([a, b, c, d]) => `| ${a} | ${b} | ${c} | ${cell(d, 600)} |`,
        ),
      ]
    : ["_The run recorded no platform results._"];
  const flows = deviceDetailsText(device);
  const shots = laneShots(device, images, secrets);
  const markers = [DEVICE_REPORT_MARKER, deviceShaMarker(sha, device.runId ?? "unknown")];
  const footer = (showShots) => {
    const embedded = showShots && shots.embedded > 0;
    if (embedded) return [devicePublishedLine(device), "", ...markers];
    const why =
      shots.given && shots.reason
        ? ` Device screenshots weren't published: ${reasonSentence(shots.reason)}.`
        : "";
    const where = device.dir
      ? `Local evidence stays on the Mac mini (the repo is public): \`${pathText(device.dir)}\`.${why}`
      : why.trim();
    return [...(where ? [`<sub>${where}</sub>`, ""] : []), ...markers];
  };
  const assemble = (flowLines, shotLines, showShots) =>
    [
      ...head,
      ...table,
      "",
      ...(flowLines ? ["**Flows**", "", flowLines, ""] : []),
      ...(shotLines.length ? [...shotLines, ""] : []),
      ...footer(showShots),
    ].join("\n");

  let shotsShown = true;
  let body = assemble(flows, shots.block, true);
  if (body.length > COMMENT_MAX_CHARS) {
    const where = device.localFile ? `\`${pathText(device.localFile)}\`` : "the run directory";
    body = assemble(
      `_The flow list is too long for this comment; see ${where}._`,
      shots.block,
      true,
    );
  }
  if (body.length > COMMENT_MAX_CHARS) {
    shotsShown = false;
    body = assemble(null, [], false);
  }

  const secretHits = laneSecretHits([device]);
  const withheld = { device: device.withheld || !device.covered };
  const bodyHits = scanLaneText(body, secrets);
  if (bodyHits.length > 0) {
    shotsShown = false;
    for (const h of bodyHits) secretHits.push(`body:${h}`);
    body = [
      head[0],
      "",
      `The rest of this comment was withheld: it matched a secret pattern (${bodyHits.join(", ")}).`,
      "",
      // Fixed text and markers only, as composeVerifyReport's.
      WITHHELD_LOCAL_LINE,
      "",
      ...markers,
    ].join("\n");
    withheld.device = withheld.device || device.text != null;
  }
  return {
    body,
    verdict,
    withheld,
    secretHits,
    images: { device: shotsShown ? shots.embedded : 0 },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

class UsageError extends Error {}

function required(flags, name) {
  const v = flags[name];
  if (v == null || v === "") throw new UsageError(`--${name} required`);
  return v;
}

function readOptional(file) {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function jsonFlag(flags, name, fallback, check) {
  const raw = flags[name];
  if (raw == null || raw === "") return fallback;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new UsageError(`--${name} is not valid JSON`);
  }
  if (!check(v)) throw new UsageError(`--${name} has the wrong shape`);
  return v;
}

// "" (flag given empty) = the lanes never had this secret; otherwise the value,
// or null when the file can't be read or the flag is missing (fail closed).
function secretFlag(flags, name, key) {
  if (flags[name] === "") return "";
  return readSecretValue(flags[name], key);
}

export function render(argv) {
  const { flags } = parseFlags(argv);
  const kind = flags.kind ?? "verify";
  if (kind === "device") return renderDevice(flags);
  if (kind !== "verify") throw new UsageError(`invalid --kind: ${kind}`);
  const issue = required(flags, "issue");
  if (!POSITIVE_INT.test(issue)) throw new UsageError(`invalid --issue: ${issue}`);
  const pr = required(flags, "pr");
  if (!POSITIVE_INT.test(pr)) throw new UsageError(`invalid --pr: ${pr}`);
  const sha = required(flags, "sha");
  if (!FULL_SHA.test(sha)) throw new UsageError(`invalid --sha (40 hex): ${sha}`);
  const out = required(flags, "out");
  const platforms = jsonFlag(
    flags,
    "platforms",
    {},
    (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  );
  const gaps = jsonFlag(flags, "gaps", [], (v) => Array.isArray(v));

  const lane = (key) => {
    const dir = flags[`${key}-dir`] ?? "";
    return {
      state: flags[`${key}-state`] ?? "none",
      dir,
      text: dir ? readOptional(path.join(dir, LANES[key].file)) : null,
    };
  };

  const result = composeVerifyReport({
    sha,
    pr,
    platforms,
    betaLanes: flags["beta-lanes"] ?? "",
    betaReused: jsonFlag(flags, "beta-reused", [], (v) => Array.isArray(v)),
    scenario: readOptional(flags["scenario-file"]),
    shell: lane("shell"),
    browser: lane("browser"),
    device: deviceInput(flags),
    gaps,
    crNote: flags["cr-note"] ?? "",
    secrets: {
      password: secretFlag(flags, "account-file", "FACTORY_BROWSER_PASSWORD"),
      bypass: secretFlag(flags, "bypass-file", "VERCEL_AUTOMATION_BYPASS_SECRET"),
      signinKey: secretFlag(flags, "signin-key-file", "DEV_SUPABASE_SERVICE_ROLE_KEY"),
      devicePassword: secretFlag(flags, "device-account-file", "E2E_TEST_PASSWORD"),
    },
    images: { ...browserImages(flags), ...deviceImages(flags) },
  });
  writeFileSync(out, result.body);
  return {
    verdict: result.verdict,
    withheld: result.withheld,
    secretHits: result.secretHits,
    images: result.images,
  };
}

// The Web lane's upload record. A flag left out or given as "" means no upload
// was tried (the report reads as before); a file that can't be read is a
// failed upload.
function browserImages(flags) {
  const file = flags["browser-images"];
  if (!file) return {};
  return { browser: readUpload(file) ?? { ok: false, reason: "unreadable" } };
}

// The device lane's upload record, read like the Web lane's.
function deviceImages(flags) {
  const file = flags["device-images"];
  if (!file) return {};
  return { device: readUpload(file) ?? { ok: false, reason: "unreadable" } };
}

// The device lane's input: --device-out (its device-output.json) and the run
// dir it sits in. Left out or "": the lane is off. A file that can't be read
// or parsed is no device output, so every row reads as before.
function deviceInput(flags) {
  const file = flags["device-out"];
  if (!file) return null;
  return { output: parseJsonText(readOptional(file)), dir: path.dirname(path.resolve(file)) };
}

function parseJsonText(text) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --kind device: the device lane's follow-up comment.
function renderDevice(flags) {
  const issue = required(flags, "issue");
  if (!POSITIVE_INT.test(issue)) throw new UsageError(`invalid --issue: ${issue}`);
  const pr = required(flags, "pr");
  if (!POSITIVE_INT.test(pr)) throw new UsageError(`invalid --pr: ${pr}`);
  const sha = required(flags, "sha");
  if (!FULL_SHA.test(sha)) throw new UsageError(`invalid --sha (40 hex): ${sha}`);
  const out = required(flags, "out");
  const input = deviceInput({ "device-out": required(flags, "device-out") });
  if (input.output === null) throw new Error("--device-out can't be read as JSON");
  const result = composeDeviceReport({
    sha,
    pr,
    output: input.output,
    dir: input.dir,
    images: deviceImages(flags).device ?? null,
    secrets: { devicePassword: secretFlag(flags, "device-account-file", "E2E_TEST_PASSWORD") },
  });
  writeFileSync(out, result.body);
  return {
    verdict: result.verdict,
    withheld: result.withheld,
    secretHits: result.secretHits,
    images: result.images,
  };
}

const USAGE =
  "Usage: verify-report.mjs render --issue <n> --pr <n> --sha <40-hex> --scenario-file <f> " +
  "--platforms <json> --beta-lanes <csv> [--beta-reused <json>] --shell-state <state> --shell-dir <dir> " +
  "--browser-state <state> --browser-dir <dir> --gaps <json> --cr-note <text> " +
  "--account-file <f> --bypass-file <f> --signin-key-file <f> " +
  "[--browser-images <upload.json>] [--device-out <device-output.json> " +
  "--device-account-file <f> [--device-images <upload.json>]] --out <body-file>\n" +
  "       verify-report.mjs render --kind device --issue <n> --pr <n> --sha <40-hex> " +
  "--device-out <device-output.json> --device-account-file <f> " +
  "[--device-images <upload.json>] --out <body-file>\n";

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "render") {
    process.stdout.write(JSON.stringify(render(rest)) + "\n");
    return 0;
  }
  process.stdout.write(USAGE);
  return cmd && cmd !== "--help" && cmd !== "-h" ? 2 : 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
    // parseFlags' "Missing value for --x" is a usage error too.
    process.exit(err instanceof UsageError || /^Missing value for --/.test(err.message) ? 2 : 1);
  }
}
