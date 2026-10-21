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
//      No lane runs a device yet, so the last two are manual (macOS notes the
//      shell lane's --preflight results).
//   3. Assessment: each reported lane's Summary, then the shell lane's
//      Assessment paragraph.
//   4. Steps for you to do manually (deduplicated, at most MANUAL_MAX): the
//      shell lane's MANUAL steps, the browser's FAIL and SKIP rows, one line
//      per scenario section (iOS / Android and macOS ones on the beta when one
//      was dispatched), one line per affected platform the scenario has no
//      section for, and "run the Web steps by hand" when the browser lane
//      didn't report. The platform and Web lines, and the pointer to a
//      withheld lane's local report, are never cut by the cap.
//   5. Coverage gaps: --gaps, every lane that didn't report or was withheld,
//      then --cr-note.
//   6. Each lane's full report in <details>; the body stays within
//      COMMENT_MAX_CHARS by truncating these first, pointing at the local file.
//   7. The local evidence paths (they stay on the Mac mini; the repo is public).
//   8. The two markers below, exactly once, as the last two lines.
//
// Secrets, per lane: the lane's whole output is scanned with browser-report's
// patterns, VERIFY_SECRET_PATTERNS, and three literals — the test account's
// password (--account-file, FACTORY_BROWSER_PASSWORD), the bypass secret
// (--bypass-file, VERCEL_AUTOMATION_BYPASS_SECRET) and the dev service-role
// key (--signin-key-file, DEV_SUPABASE_SERVICE_ROLE_KEY). A hit withholds only
// that lane's text, naming the pattern and never echoing the match. A secret
// file that can't be read withholds the lanes it guards (fail closed): the
// password guards both lanes, the bypass secret and the service-role key the
// shell lane. Passing a file flag as "" says the lanes were never given that
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
//        --scenario-file <f|""> --platforms '{"web":…,"mobile":…,"desktop":…}'
//        --beta-lanes <csv> --shell-state <state> --shell-dir <dir|"">
//        --browser-state <state> --browser-dir <dir|"">
//        --gaps '[{"lane":…,"reason":…}]' --cr-note <text|"">
//        --account-file <f|""> --bypass-file <f|""> --signin-key-file <f|"">
//        --out <body-file>
//     Writes the comment body to --out and prints one JSON line
//     {verdict, withheld: {shell, browser}, secretHits}: verdict is
//     pass|warn|fail|incomplete; secretHits lists "<lane>:<pattern>" for each
//     match and "<lane>:<file>-unreadable" for each fail-closed file
//     ("body:<pattern>" when the final check tripped). --issue is validated
//     but not rendered: the comment is posted on that issue. A missing lane
//     output or scenario file is a coverage gap, not an error. Exit 0; 1 on
//     an I/O error writing --out; 2 on a usage error.

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
import { extractScenarioSections } from "./factory-bundle.mjs";
import { isMainModule } from "./is-main.mjs";
import { FENCE_LINE, closeFences, fenceStep } from "./markdown-fence.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const VERIFY_REPORT_MARKER = "<!-- drafto-factory-verify-report -->";
export const VERIFY_SHA_MARKER_PREFIX = "drafto-factory-verify-sha:";
export const SHELL_OUTPUT_FILE = "shell-output.txt";
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
const MOBILE_HEADING = /\b(ios|android|mobile|iphone|ipad)\b/i;
const DESKTOP_HEADING = /\b(macos|mac|desktop)\b/i;
// Scenario sections that are notes, not steps.
const NOT_STEPS_HEADING = /(\bnot|n't)\s+(manually\s+)?testable\b|\buntestable\b/i;

export function verifyShaMarker(sha) {
  return `<!-- ${VERIFY_SHA_MARKER_PREFIX}${sha} -->`;
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
  "not-web": "the PR's diff doesn't touch the web app (apps/web/)",
  "browser-off":
    "the browser runner's verify kind is switched off (FACTORY_BROWSER, FACTORY_BROWSER_KINDS)",
  "already-run": "the browser runner already handled this commit (see its comment on the issue)",
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

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

const RESULT_WORD = /\b(PASS(?:ED)?|FAIL(?:ED|URE)?|WARN(?:ING)?|SKIP(?:PED)?)\b/i;

// Rows of every Markdown table in <markdown> that has a Result column:
// [{ num, step, result, evidence }], result one of PASS|FAIL|WARN|SKIP or null.
export function parseResultTable(markdown) {
  const rows = [];
  let header = null;
  for (const raw of String(markdown ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      header = null;
      continue;
    }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!header) {
      const names = cells.map((c) => c.replace(/[*_`]/g, "").trim().toLowerCase());
      header = {
        result: names.indexOf("result"),
        step: names.indexOf("step"),
        num: names.indexOf("#"),
        evidence: names.indexOf("evidence"),
      };
      continue;
    }
    if (header.result === -1) continue;
    const m = RESULT_WORD.exec(cells[header.result] ?? "");
    const stepIdx =
      header.step !== -1
        ? header.step
        : cells.findIndex((_, i) => i !== header.result && i !== header.num);
    rows.push({
      num: header.num !== -1 ? (cells[header.num] ?? "") : "",
      step: cells[stepIdx] ?? "",
      result: m ? m[1].slice(0, 4).toUpperCase() : null,
      evidence: header.evidence !== -1 ? (cells[header.evidence] ?? "") : "",
    });
  }
  return rows;
}

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
  for (const key of ["bypass", "signinKey"]) {
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

// ── body sections ───────────────────────────────────────────────────────────

function platformHow(platform, betaLanes) {
  const name = platform === "mobile" ? "iOS / Android" : "macOS";
  return betaLanes.includes(platform)
    ? `on the ${name} beta for this commit (a follow-up comment gives the build number)`
    : "on a build of this branch (no beta was dispatched; the scenario says how to get one)";
}

function laneTable(shell, browser, platforms, betaLanes) {
  const rows = [];
  for (const lane of [shell, browser]) {
    const verdict = lane.effective ? lane.effective.toUpperCase() : "—";
    let note;
    if (lane.withheld) note = `report withheld (${withheldWhy(lane)})`;
    else if (lane.notNeeded) note = "no web changes and no Web steps";
    else if (lane.gap) note = lane.gap;
    else if (lane.parsed?.report) note = "full report below";
    else note = "";
    rows.push([lane.meta.label, lane.status, verdict, note]);
  }

  const mobileNote = betaLanes.includes("mobile")
    ? "beta dispatched for this commit; run the iOS / Android steps on it"
    : "no beta was dispatched; the scenario says how to get a build";
  rows.push(
    platforms.mobile
      ? ["iOS / Android", "manual", "—", mobileNote]
      : ["iOS / Android", "not affected", "—", "no mobile changes"],
  );

  const macNotes = [];
  if (platforms.desktop) {
    macNotes.push(
      betaLanes.includes("desktop")
        ? "beta dispatched for this commit; run the macOS steps on it"
        : "no beta was dispatched; the scenario says how to get a build",
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
    ...rows.map(([a, b, c, d]) => `| ${a} | ${b} | ${c} | ${cell(d, 400)} |`),
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

function assessment(shell, browser) {
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

function manualSteps({ shell, browser, sections, platforms, betaLanes }) {
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

  if (browser.text != null) {
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
  for (const s of sections) {
    if (s.heading === "Web" || NOT_STEPS_HEADING.test(s.heading)) continue;
    const h = plainLabel(s.heading);
    if (MOBILE_HEADING.test(s.heading)) {
      hasMobile = true;
      add(`Run the **${h}** steps in the test scenario ${platformHow("mobile", betaLanes)}.`, {
        reserved: true,
      });
    } else if (DESKTOP_HEADING.test(s.heading)) {
      hasDesktop = true;
      add(`Run the **${h}** steps in the test scenario ${platformHow("desktop", betaLanes)}.`, {
        reserved: true,
      });
    } else {
      add(`Go through the **${h}** section of the test scenario.`);
    }
  }
  if (platforms.mobile && !hasMobile) {
    add(
      `Test the iOS / Android changes by hand ${platformHow("mobile", betaLanes)}: ` +
        "the test scenario has no iOS / Android section.",
      { reserved: true },
    );
  }
  if (platforms.desktop && !hasDesktop) {
    add(
      `Test the macOS changes by hand ${platformHow("desktop", betaLanes)}: ` +
        "the test scenario has no macOS section.",
      { reserved: true },
    );
  }

  const hasWebSection = sections.some((s) => s.heading === "Web");
  const browserRan = browser.reported && browser.runStatus !== "blocked";
  if (!browserRan && (hasWebSection || platforms.web)) {
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
function coverageGaps({ shell, browser, gaps, crNote, scenarioMissing }) {
  const items = [];
  let notRun = 0;
  let withheld = 0;
  for (const raw of gaps) {
    const g = typeof raw === "string" ? { lane: "", reason: raw } : raw;
    const lane = own(LANES, String(g?.lane ?? ""))?.label ?? plainLabel(g?.lane ?? "", 40);
    const reason = inline(g?.reason ?? "", 300);
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

function detailsBlock(lane, content) {
  const title = lane.reported ? "full report" : "output";
  return [
    "<details>",
    `<summary>${lane.meta.label.replace(/&/g, "&amp;")}: ${title}</summary>`,
    "",
    content,
    "",
    "</details>",
  ].join("\n");
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

function normalisePlatforms(p) {
  return { web: Boolean(p?.web), mobile: Boolean(p?.mobile), desktop: Boolean(p?.desktop) };
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
 * @param {{web?:boolean,mobile?:boolean,desktop?:boolean}} o.platforms
 * @param {string[]|string} o.betaLanes dispatched beta lane ids (mobile, desktop)
 * @param {string|null} o.scenario the scenario comment body, or null
 * @param {{state:string,dir?:string,text?:string|null}} o.shell
 * @param {{state:string,dir?:string,text?:string|null}} o.browser
 * @param {({lane:string,reason:string}|string)[]} o.gaps
 * @param {string} o.crNote
 * @param {{password?:string|null,bypass?:string|null,signinKey?:string|null}} o.secrets
 *   each secret's literal value; "" when the lanes were never given it; null
 *   (or absent) when its file couldn't be read, which fails closed
 * @returns {{body:string,verdict:string,withheld:{shell:boolean,browser:boolean},secretHits:string[]}}
 */
export function composeVerifyReport({
  sha,
  pr,
  platforms: rawPlatforms,
  betaLanes: rawBetaLanes,
  scenario = null,
  shell: shellInput,
  browser: browserInput,
  gaps = [],
  crNote = "",
  secrets = {},
} = {}) {
  if (!FULL_SHA.test(String(sha ?? ""))) throw new Error(`invalid sha: ${sha}`);
  const platforms = normalisePlatforms(rawPlatforms);
  const betaLanes = normaliseBetaLanes(rawBetaLanes);
  const scenarioBody = typeof scenario === "string" && scenario.trim() ? scenario : null;
  const sections = scenarioBody ? extractScenarioSections(scenarioBody) : [];
  const hasWebSection = sections.some((s) => s.heading === "Web");

  const shell = buildLane("shell", shellInput, secrets);
  const browser = buildLane("browser", browserInput, secrets, {
    notNeeded: !platforms.web && !hasWebSection,
  });

  const verdict = worst([shell.effective, browser.effective]) ?? "incomplete";
  const gapInfo = coverageGaps({
    shell,
    browser,
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

  const evidenceDirs = [shell, browser]
    .filter((l) => l.dir)
    .map((l) => `${l.meta.short} \`${pathText(l.dir)}\``);
  const footer = [
    ...(evidenceDirs.length
      ? [
          `<sub>Local evidence stays on the Mac mini (the repo is public): ${evidenceDirs.join(" · ")}.</sub>`,
          "",
        ]
      : []),
    VERIFY_REPORT_MARKER,
    verifyShaMarker(sha),
  ];

  const head = [
    HEADER,
    "",
    headline,
    "",
    EVIDENCE_LINE,
    "",
    ...laneTable(shell, browser, platforms, betaLanes),
    "",
    "**Assessment**",
    "",
    ...assessment(shell, browser),
    "",
    "**Steps for you to do manually**",
    "",
    ...manualSteps({ shell, browser, sections, platforms, betaLanes }),
    "",
    "**Coverage gaps**",
    "",
    ...(gapInfo.lines.length ? gapInfo.lines : ["_None._"]),
    "",
  ];

  const entries = [shell, browser]
    .map((lane) => ({ lane, content: detailsText(lane) }))
    .filter((e) => e.content != null);
  const assemble = (contents) =>
    [
      ...head,
      ...entries.flatMap((e, i) => [detailsBlock(e.lane, contents[i]), ""]),
      ...footer,
    ].join("\n");

  const empty = assemble(entries.map(() => ""));
  let body = assemble(fitDetails(entries, COMMENT_MAX_CHARS - empty.length));
  if (body.length > COMMENT_MAX_CHARS) {
    // Every other section is capped, so this needs a pathological input; the
    // details go first, then the middle, but the markers always survive.
    body = [...head, ...footer].join("\n");
    if (body.length > COMMENT_MAX_CHARS) {
      const tail = `\n\n_…report truncated._\n\n${footer.join("\n")}`;
      body = cutWithin(head.join("\n"), COMMENT_MAX_CHARS - tail.length) + tail;
    }
  }

  const secretHits = [];
  for (const lane of [shell, browser]) {
    for (const k of lane.unreadable) secretHits.push(`${lane.key}:${SECRET_SOURCES[k].unreadable}`);
    for (const h of lane.hits) secretHits.push(`${lane.key}:${h}`);
  }
  const withheld = { shell: shell.withheld, browser: browser.withheld };

  // Last check: lane text is already scanned, but scenario headings, gap
  // reasons and the CR note aren't. A hit anywhere replaces the body.
  const bodyHits = scanLaneText(body, secrets);
  if (bodyHits.length > 0) {
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
      ...footer,
    ].join("\n");
    withheld.shell = withheld.shell || shell.text != null;
    withheld.browser = withheld.browser || browser.text != null;
  }

  return { body, verdict, withheld, secretHits };
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
    scenario: readOptional(flags["scenario-file"]),
    shell: lane("shell"),
    browser: lane("browser"),
    gaps,
    crNote: flags["cr-note"] ?? "",
    secrets: {
      password: secretFlag(flags, "account-file", "FACTORY_BROWSER_PASSWORD"),
      bypass: secretFlag(flags, "bypass-file", "VERCEL_AUTOMATION_BYPASS_SECRET"),
      signinKey: secretFlag(flags, "signin-key-file", "DEV_SUPABASE_SERVICE_ROLE_KEY"),
    },
  });
  writeFileSync(out, result.body);
  return { verdict: result.verdict, withheld: result.withheld, secretHits: result.secretHits };
}

const USAGE =
  "Usage: verify-report.mjs render --issue <n> --pr <n> --sha <40-hex> --scenario-file <f> " +
  "--platforms <json> --beta-lanes <csv> --shell-state <state> --shell-dir <dir> " +
  "--browser-state <state> --browser-dir <dir> --gaps <json> --cr-note <text> " +
  "--account-file <f> --bypass-file <f> --signin-key-file <f> --out <body-file>\n";

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
