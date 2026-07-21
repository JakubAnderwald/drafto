#!/usr/bin/env node
// Detect a Claude subscription session/usage-limit failure from the claude
// CLI's own session transcript.
//
// Why this exists: 2026-07-21 — issue #463 burned its whole 5-attempt
// implement retry budget in 41 minutes because the shared subscription hit
// its 5-hour session limit. On that failure `claude -p` exits 1 with NOTHING
// on stdout or stderr; the only evidence is the last assistant record of the
// session transcript under ~/.claude/projects/<cwd-slug>/<uuid>.jsonl:
//
//   {"type":"assistant","isApiErrorMessage":true,
//    "timestamp":"2026-07-21T07:11:15.878Z",
//    "message":{"role":"assistant","content":[{"type":"text",
//      "text":"You've hit your session limit · resets 10:30am (Europe/Warsaw)"}]}}
//
// factory-agent.sh calls `check` after a non-zero claude exit; on a hit it
// pauses the whole factory until the stated reset time instead of bumping
// the per-issue attempts counter (see check_session_limit there).
//
// CLI (bash-friendly, mirrors state-cli's `factory:paused?` exit-code style):
//   node session-limit.mjs check --cwd <path> [--projects-dir <dir>]
//        [--since <iso>] [--now <iso>] [--fallback-min <n>]
//
//   Exit 0  — the newest transcript for <cwd> ends in a session-limit API
//             error (newer than --since when given). Prints one JSON line:
//             {"limited":true,"resetAt":"<iso>","reason":"…",
//              "source":"parsed"|"fallback","transcript":"<path>"}
//             When the reset time can't be parsed from the message, resetAt
//             is now + --fallback-min minutes (default 30) with
//             source:"fallback" — the caller re-checks after that.
//   Exit 1  — anything else: not limited, transcript dir absent, or any
//             detection error. Deliberately fail-open: the caller falls
//             through to its normal retry/bump-attempts path.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFlags } from "./parse-flags.mjs";
import { isMainModule } from "./is-main.mjs";

export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const DEFAULT_FALLBACK_MIN = 30;

// Same-machine clocks wrote both the transcript timestamp and the caller's
// --since capture, but the two reads straddle a claude spawn — allow a little
// skew so a record stamped a moment "before" the capture still counts.
const SINCE_SLACK_MS = 10_000;

// Backstop against a misparse. The furthest a legitimate clause can land is
// an explicit "resets tomorrow 11:59pm" evaluated just after midnight (~48h);
// anything beyond that is garbage, so fall back to the fixed delay rather than
// park the factory on a misread.
const MAX_RESET_HORIZON_MS = 49 * 60 * 60 * 1000;

// Matches the limit-error family ("You've hit your session limit · resets…",
// "Claude AI usage limit reached…", weekly/N-hour variants) while NOT
// matching the other isApiErrorMessage texts seen in real transcripts
// (401 auth failures, "Connection closed mid-response", "Please run /login").
// Deliberately not anchored on the "·" (U+00B7) separator — phrasing drifts.
const LIMIT_RE = /\b(?:session|usage|weekly|\d+\s*-?\s*hour)\s+limit\b/i;

const RESET_RE =
  /resets\s+(?:(tomorrow)\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?/i;

// The claude CLI names each cwd's transcript dir by replacing every
// non-alphanumeric character with "-" (verified against real dirs, e.g.
// /Users/x/code/repo → -Users-x-code-repo).
export function projectSlugForCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

// Newest .jsonl (by mtime) in <projectsDir>/<slug-of-cwd>, or null when the
// dir is missing/empty. Each `claude -p` run writes its own transcript file,
// so newest-by-mtime is the run the caller just observed failing.
export async function findLatestTranscript(projectsDir, cwd) {
  const dir = path.join(projectsDir, projectSlugForCwd(cwd));
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -Infinity;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (st.isFile() && st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = p;
      }
    } catch {
      // Raced deletion — skip.
    }
  }
  return best;
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

// Wall-clock components of <date> as observed in <timeZone>.
function wallClockInZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) parts[type] = value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some ICU builds render midnight as "24" under hour12:false.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// UTC instant at which <timeZone> shows the given wall-clock. Two correction
// passes converge for any fixed offset and across DST transitions (inside a
// DST gap the result is off by at most the gap — acceptable here, see the
// caller's fail-open contract).
function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const want = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = want;
  for (let i = 0; i < 2; i++) {
    const wc = wallClockInZone(new Date(ts), timeZone);
    const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
    ts += want - asUtc;
  }
  return ts;
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Parse "resets 10:30am (Europe/Warsaw)" / "resets 4pm" / "resets tomorrow
// 10am (…)" into the next matching UTC instant after <now>, plus a 2-minute
// safety margin. Returns null on any doubt — the caller then applies its
// fixed fallback delay instead.
export function parseResetTime(text, now = new Date()) {
  const m = String(text).match(RESET_RE);
  if (!m) return null;
  const tomorrow = Boolean(m[1]);
  const hour12 = Number.parseInt(m[2], 10);
  const minute = m[3] == null ? 0 : Number.parseInt(m[3], 10);
  const meridiem = m[4].toLowerCase();
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute > 59) return null;
  const hour = meridiem === "am" ? hour12 % 12 : (hour12 % 12) + 12;

  // The transcript was written on this same machine, so the host zone is the
  // right fallback when the zone is absent or unknown to ICU.
  const zoneRaw = m[5]?.trim();
  const timeZone =
    zoneRaw && isValidTimeZone(zoneRaw)
      ? zoneRaw
      : Intl.DateTimeFormat().resolvedOptions().timeZone;

  const today = wallClockInZone(now, timeZone);
  let ts = zonedTimeToUtc(
    { year: today.year, month: today.month, day: today.day + (tomorrow ? 1 : 0), hour, minute },
    timeZone,
  );
  if (!tomorrow && ts <= now.getTime()) {
    ts = zonedTimeToUtc(
      { year: today.year, month: today.month, day: today.day + 1, hour, minute },
      timeZone,
    );
  }
  ts += 2 * 60 * 1000;
  if (ts - now.getTime() > MAX_RESET_HORIZON_MS) return null;
  return new Date(ts);
}

// Pure core. Scans transcript JSONL text; the session ended limited iff the
// LAST assistant record is a limit-flavoured API error (a limit error the
// session later recovered from doesn't count) stamped no earlier than
// <since> (when given). Unparseable lines are skipped, not fatal.
export function detectSessionLimit(jsonlText, { now = new Date(), since = null } = {}) {
  const none = { limited: false, reason: null, resetAt: null };
  let last = null;
  for (const line of String(jsonlText).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && record.type === "assistant") last = record;
  }
  if (!last || last.isApiErrorMessage !== true) return none;
  const text = textOf(last.message);
  if (!LIMIT_RE.test(text)) return none;
  if (since != null) {
    const recordMs = typeof last.timestamp === "string" ? Date.parse(last.timestamp) : NaN;
    const sinceMs = Date.parse(since);
    // No usable timestamps → can't prove the record belongs to this run;
    // fail-open (not limited) rather than pause on a stale transcript.
    if (Number.isNaN(recordMs) || Number.isNaN(sinceMs)) return none;
    if (recordMs < sinceMs - SINCE_SLACK_MS) return none;
  }
  return {
    limited: true,
    reason: text.replace(/\s+/g, " ").trim().slice(0, 200),
    resetAt: parseResetTime(text, now),
  };
}

function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    process.stdout.write(
      "Usage: session-limit.mjs check --cwd <path> [--projects-dir <dir>] " +
        "[--since <iso>] [--now <iso>] [--fallback-min <n>]\n" +
        "Exit 0 + JSON line when the newest claude transcript for <cwd> ended " +
        "in a session-limit error; exit 1 otherwise.\n",
    );
    process.exit(1);
  }
  if (sub !== "check") throw new Error(`Unknown subcommand: ${sub}`);
  const { flags } = parseFlags(rest);
  const cwd = flags.cwd;
  if (!cwd) throw new Error("check requires --cwd <path>");
  const now = flags.now == null ? new Date() : new Date(flags.now);
  if (Number.isNaN(now.getTime())) throw new Error(`invalid --now: ${flags.now}`);
  if (flags.since != null && Number.isNaN(Date.parse(flags.since))) {
    throw new Error(`invalid --since: ${flags.since}`);
  }
  const fallbackMin = parsePositiveInt(flags["fallback-min"], DEFAULT_FALLBACK_MIN);

  const transcript = await findLatestTranscript(flags["projects-dir"] ?? DEFAULT_PROJECTS_DIR, cwd);
  if (!transcript) process.exit(1);
  const result = detectSessionLimit(await fs.readFile(transcript, "utf8"), {
    now,
    since: flags.since ?? null,
  });
  if (!result.limited) process.exit(1);
  const resetAt = result.resetAt ?? new Date(now.getTime() + fallbackMin * 60 * 1000);
  process.stdout.write(
    JSON.stringify({
      limited: true,
      resetAt: resetAt.toISOString(),
      reason: result.reason,
      source: result.resetAt ? "parsed" : "fallback",
      transcript,
    }) + "\n",
  );
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
    process.exit(1);
  });
}
